/**
 * External evaluator - the ONLY completion oracle.
 *
 * Makes a separate model call to assess whether the goal is met.
 * The loop never stops voluntarily; only the evaluator can return goal_met: true.
 *
 * IMPROVEMENT: Maintains explicit EvaluatorState with heartbeat, not inferred
 * from file existence.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { complete } from "@earendil-works/pi-ai";
import type {
  IterativeGoalState,
  EvaluatorVerdict,
  EvaluatorState,
} from "./types.js";
import { EvaluatorPromptSchema } from "./types.js";
import { parseWithSchema } from "./domain/validate.js";
import { canonicalModelKey, modelKey, normalizeConfiguredModel } from "./domain/models.js";
import { readIterativeGoalSettings } from "./domain/project-settings.js";
import { type StateManagerAPI } from "./state.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { logDebug } from "./logging.js";
import { assertEvaluatorCyberPrereqs } from "./cyber-runtime.js";

function log(msg: string) {
  logDebug("evaluator", msg);
}

/**
 * The standing grading rubric (§7.3) — THE single source for the judge's
 * completion criteria (C4-OUS-010): the system prompt's "Return goal_met=true
 * ONLY if" list below is BUILT from this array, and loadJudgeConfig falls
 * back to it when no custom rubric is configured. Edit here, never in two
 * places.
 */
export const DEFAULT_JUDGE_RUBRIC: readonly string[] = [
  "Every explicit completion criterion is satisfied",
  "Validation evidence is current and verifiable",
  "Safety constraints are preserved",
  "No unresolved critical blockers remain",
  "The state is reproducible from committed/recorded artifacts",
  "The implementation matches what was planned (no allowlist violations)",
  "Durable task-plan items are completed or intentionally cancelled",
  "Applicable project instructions were considered and not violated",
  "DLP, indirect prompt-injection sanitization, and evidence signing controls are available",
  "Validation evidence includes harness-produced signed attestations",
] as const;

// The "Return goal_met=true ONLY if" list is BUILT from DEFAULT_JUDGE_RUBRIC
// (single source, C4-OUS-010) — do not edit the criteria here.
const EVALUATOR_SYSTEM_PROMPT = `You are the outside evaluator for an autonomous Pi iterative-goal loop.
You do not implement. You only judge whether the original goal is fully met.

You operate on evidence provided by the implementer/validator and must be strict.

Return goal_met=true ONLY if:
${DEFAULT_JUDGE_RUBRIC.map((item) => `- ${item}`).join("\n")}

If unsure, return goal_met=false and specify what remains to be done.

You MUST return valid JSON matching this schema:
{
  "goal_met": boolean,
  "confidence": number (0-1),
  "completion_blockers": string[],
  "accepted_evidence": string[],
  "rejected_evidence": string[],
  "remaining_work": [{ "priority": "critical"|"high"|"medium"|"low", "description": string }],
  "next_focus": "research"|"plan"|"implement"|"validate"|"capability_repair"|"external_blocked_complete"|"pending_approval",
  "next_focus_reason": string,
  "safety_notes": string[]
}

EXTERNAL BLOCKED COMPLETION:
If ALL in-harness criteria are satisfied (tests pass, gates pass, implementation matches plan,
safety preserved) BUT external blockers remain that the harness cannot resolve (e.g., git push
permissions, CI/CD pipeline access, operator approval needed, missing credentials), set:
  "goal_met": false,
  "next_focus": "external_blocked_complete",
  "next_focus_reason": "All harness work complete. External blockers: [list them]"
The harness will terminate gracefully and report to the operator.
Do NOT keep requesting implementation cycles when no in-harness work remains.

VOCABULARY:
Use "PASS"/"FAIL" for gates/tests, "BLOCKED_EXTERNAL" for external blockers,
"BLOCKED_HARNESS" for harness policy blocks. Do NOT use "Final" or "complete"
for in-progress states.

No preamble. No markdown. JSON only.`;

// ── Judge independence (§7.3, enforced as configuration — C4) ───────

/**
 * §7.3's mandated safeguard for LLM-as-judge: judge independence + explicit
 * rubric + deterministic checks first. This module is where the rule becomes
 * CONFIGURATION rather than convention (§8.7): the validate-phase judge model
 * is overridable via .pi/settings.json → iterativeGoal.judge, the grading
 * rubric is explicit and injected into the judge's prompt, and the
 * deterministic gates below run before any model invocation (structurally —
 * every early return in runExternalEvaluator precedes complete()).
 */
export interface JudgeConfig {
  /**
   * Validate-phase judge override; null → state.evaluator (the pre-C4
   * default, which mirrors the primary model and therefore FAILS the
   * independence check below — configure judge.model to differ from the
   * implement-phase actor).
   */
  model: { provider: string; model: string } | null;
  /** Explicit grading rubric injected into the judge prompt. */
  rubric: string[];
  /**
   * True when the rubric came from settings rather than the default
   * (C4-OUS-005): the GRADING RUBRIC prompt section is injected only for a
   * configured rubric, so an unconfigured run's judge prompt is identical to
   * the pre-C4 one.
   */
  customRubric: boolean;
}

export function loadJudgeConfig(cwd: string): JudgeConfig {
  // Shared guarded reader (src/domain/project-settings.ts — no per-module copy).
  const judge = readIterativeGoalSettings(cwd).judge;
  const config = judge && typeof judge === "object" ? judge as Record<string, unknown> : {};
  let model: JudgeConfig["model"] = null;
  const rawModel = typeof config.model === "string" ? config.model.trim() : "";
  const rawProvider = typeof config.provider === "string" ? config.provider.trim() : "";
  // C4-ADV-007: an explicit provider field WINS and the model id is kept
  // verbatim even when it contains '/' ({provider:'openrouter',
  // model:'z-ai/glm-5.2'} is openrouter/z-ai/glm-5.2 — splitting here would
  // silently re-parse it as provider 'z-ai'). The "provider/model" shorthand
  // splits only when no provider field is set.
  if (rawProvider && rawModel) {
    model = { provider: rawProvider, model: rawModel };
  } else if (rawModel.includes("/")) {
    const [provider, ...rest] = rawModel.split("/");
    model = { provider, model: rest.join("/") };
  }
  const customRubric = Array.isArray(config.rubric);
  const rubric = customRubric
    ? (config.rubric as unknown[]).filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [...DEFAULT_JUDGE_RUBRIC];
  return { model, rubric, customRubric };
}

/** The effective validate-phase judge model: the configured override when allowed, else state.evaluator. */
export function resolveJudgeModel(
  state: IterativeGoalState,
  judgeConfig: JudgeConfig,
): { provider: string; model: string } {
  if (!judgeConfig.model) return { provider: state.evaluator.provider, model: state.evaluator.model };
  const resolved = normalizeConfiguredModel(
    judgeConfig.model,
    { provider: state.evaluator.provider, model: state.evaluator.model },
  );
  if (resolved.provider !== judgeConfig.model.provider || resolved.model !== judgeConfig.model.model) {
    // Loud fallback (C4-ADV-007): a silently-ignored judge override would
    // leave the actor judging itself while config claims otherwise.
    log(`configured judge model ${judgeConfig.model.provider}/${judgeConfig.model.model} is not in ALLOWED_MODELS — falling back to state.evaluator ${state.evaluator.provider}/${state.evaluator.model}`);
  }
  return resolved;
}

export interface JudgeIndependenceReport {
  /** Effective validate-phase judge (provider/model, as configured). */
  judgeModel: string;
  /** Implement-phase actor (provider/model) — the run's primary model. */
  actorModel: string;
  /** §7.3 independence on CANONICAL identity (C4-ADV-008): zai/, z-ai/, and openrouter/z-ai/ forms of one model id compare equal. */
  independent: boolean;
  /** §7.3 rubric-based grading: an explicit non-empty rubric is configured. */
  rubricConfigured: boolean;
  violations: string[];
}

/**
 * The §7.3 rule as a checkable verdict (the §8.7 acceptance gate asserts it):
 * the validate-phase judge model must differ from the implement-phase actor
 * model (compared on canonical model identity — provider-prefix aliases of
 * the same weights fail the rule), and rubric-based grading must be
 * configured. Deterministic-first is asserted separately by observing that a
 * deterministic gate rejection never reaches the judge invocation.
 */
export function checkJudgeIndependence(state: IterativeGoalState, judgeConfig: JudgeConfig): JudgeIndependenceReport {
  const judge = resolveJudgeModel(state, judgeConfig);
  const judgeModel = modelKey(judge);
  const actorModel = modelKey(state.config.primaryModel);
  const independent = canonicalModelKey(judge) !== canonicalModelKey(state.config.primaryModel);
  const violations: string[] = [];
  if (!independent) {
    violations.push(`validate-phase judge model ${judgeModel} is canonically identical to the implement-phase actor model ${actorModel} — judge self-preference bias control (§7.3) requires a different model, not just a different provider prefix`);
  }
  if (judgeConfig.rubric.length === 0) {
    violations.push("no grading rubric configured — rubric-based grading (§7.3) requires a non-empty iterativeGoal.judge.rubric");
  }
  return {
    judgeModel,
    actorModel,
    independent,
    rubricConfigured: judgeConfig.rubric.length > 0,
    violations,
  };
}

// ── Unfinished-work gate (extended in C4, §6.6 gate part 3) ─────────

export interface UnfinishedWorkItem {
  kind: "task" | "shard";
  id: string;
  status: string;
  description: string;
}

/**
 * The unfinished-work gate as a shared predicate (merge-time evidence and the
 * validate-phase gate read the same source). Pre-C4 semantics are the default:
 * durable task-plan items that are pending / in_progress / blocked.
 *
 * C4 extension (§6.6, flag-guarded on iterativeGoal.mergeBack.enabled): when
 * merge-back is on, ANY shard of the active fan_out plan that is not
 * merge_verified blocks goal_met — only merge_verified shards count toward
 * goal completion (Figure D5).
 *
 * Active-plan selection (C4-ADV-003): the latest fan_out plan FOR THE CURRENT
 * CYCLE — the same cycle guard the scheduler/merge hooks use — so a stale
 * rejected plan from an older cycle cannot block goal_met forever. This
 * deliberately diverges from src/ui/phase-indicator.ts → shardSummary, which
 * DISPLAYS the latest fan_out across cycles: the indicator renders history,
 * the evaluator gates the present. A shard sitting in claimed-with-rejected-
 * merge is named honestly in the blocker text (repair re-dispatch is not
 * automatic in v1).
 */
export function findUnfinishedWork(
  state: IterativeGoalState,
  options: { mergeBackEnabled: boolean },
): UnfinishedWorkItem[] {
  const items: UnfinishedWorkItem[] = state.taskPlan.items
    .filter((item) => item.status === "pending" || item.status === "in_progress" || item.status === "blocked")
    .map((item) => ({
      kind: "task" as const,
      id: item.id,
      status: item.status,
      description: `Task plan item not complete: [${item.status}] ${item.id} ${item.title}`,
    }));

  if (!options.mergeBackEnabled) return items;

  const plans = state.shards?.plans ?? [];
  const active = [...plans].reverse().find(
    (plan) => plan.decision === "fan_out" && plan.shards.length > 0 && plan.cycle === state.cycle,
  );
  if (!active) return items;

  for (const shard of active.shards) {
    const merge = (state.shards?.merges ?? []).find(
      (item) => item.planId === active.id && item.cycle === active.cycle && item.shardId === shard.id,
    );
    if (merge?.status === "verified") continue;
    const claim = (state.shards?.claims ?? []).find(
      (item) => item.planId === active.id && item.cycle === active.cycle && item.shardId === shard.id,
    );
    const status = merge?.status ?? claim?.status ?? "not_claimed";
    // C4-ADV-003(b): a shard the merge gate rejected and returned to claimed
    // has no automatic re-dispatch in v1 — say so in the blocker instead of
    // letting the loop believe normal cycling will repair it.
    const repairNote = merge?.status === "rejected" && claim?.status === "claimed"
      ? " — merge gate rejected this shard and it awaits repair: re-drive it manually or disable merge-back (no automatic re-dispatch in v1)"
      : "";
    items.push({
      kind: "shard",
      id: shard.id,
      status,
      description: `Shard not merge_verified: [${status}] ${shard.id} (plan ${active.id} cycle ${active.cycle})${repairNote}`,
    });
  }
  return items;
}

// ── Fallback evaluator ──────────────────────────────────────────────

function fallbackVerdict(reason: string): EvaluatorVerdict {
  return {
    goal_met: false,
    confidence: 0,
    completion_blockers: [`Evaluator model call failed: ${reason}`],
    accepted_evidence: [],
    rejected_evidence: [],
    remaining_work: [
      {
        priority: "critical",
        description:
          "Evaluator could not assess goal. Verify evaluator model is available and retry.",
      },
    ],
    next_cycle_directive: {
      focus: "capability_repair",
      reason,
    },
    safety_notes: ["Evaluator unavailable; defaulted to goal_met=false."],
  };
}

// ── Parsing ─────────────────────────────────────────────────────────

function parseVerdict(text: string): EvaluatorVerdict | null {
  const trimmed = text.trim();
  const jsonText = trimmed.startsWith("{") && trimmed.endsWith("}")
    ? trimmed
    : (trimmed.match(/\{[\s\S]*\}/)?.[0] ?? "");
  if (!jsonText) return null;
  try {
    const parsed = JSON.parse(jsonText);
    if (parsed.next_cycle_directive && !parsed.next_focus) {
      parsed.next_focus = parsed.next_cycle_directive.focus;
      parsed.next_focus_reason = parsed.next_cycle_directive.reason;
    }
    const raw = parseWithSchema<any>(EvaluatorPromptSchema, parsed, "Evaluator verdict");
    return {
      goal_met: raw.goal_met,
      confidence: raw.confidence,
      completion_blockers: raw.completion_blockers,
      accepted_evidence: raw.accepted_evidence,
      rejected_evidence: raw.rejected_evidence,
      remaining_work: raw.remaining_work,
      next_cycle_directive: {
        focus: raw.next_focus,
        reason: raw.next_focus_reason,
      },
      safety_notes: raw.safety_notes,
    };
  } catch (err) {
    log(`Evaluator schema validation failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ── Heartbeat updater ───────────────────────────────────────────────

function updateEvaluatorHeartbeat(
  stateManager: StateManagerAPI,
  state: IterativeGoalState,
  status: EvaluatorState["status"],
  error?: string,
): void {
  const es: EvaluatorState = {
    runId: state.runId,
    cycle: state.cycle,
    phase: "validate",
    status,
    startedAt: status === "running"
      ? new Date().toISOString()
      : state.evaluatorState?.startedAt ?? null,
    lastHeartbeatAt: new Date().toISOString(),
    verdictPath: `.pi/iterative-goal/runs/${state.runId}/evaluator-verdicts.jsonl`,
    error: error ?? null,
  };
  stateManager.setEvaluatorState(es);
}

function isStaleHeartbeat(lastHeartbeat: string | null): boolean {
  if (!lastHeartbeat) return true;
  const elapsed = Date.now() - new Date(lastHeartbeat).getTime();
  return elapsed > 120_000; // 2 minutes
}

// ── Check for allowlist violations ───────────────────────────────────

function checkAllowlistViolations(
  state: IterativeGoalState,
  _planContent: string,
): { violation: boolean; plannedFiles: string[]; actualFiles: string[]; extraFiles: string[] } {
  // Read from persistent verification file written by the implement phase
  try {
    const verifyPath = `.pi/iterative-goal/runs/${state.runId}/cycles/${state.cycle}/implement/implementation-verification.json`;
    if (fs.existsSync(verifyPath)) {
      const d = JSON.parse(fs.readFileSync(verifyPath, "utf-8"));
      return {
        violation: d.allowlistViolation ?? (d.extraFiles?.length > 0),
        plannedFiles: d.plannedFiles ?? [],
        actualFiles: d.changedFiles ?? [],
        extraFiles: d.extraFiles ?? [],
      };
    }
  } catch { /* file may not exist yet */ }
  return { violation: false, plannedFiles: [], actualFiles: [], extraFiles: [] };
}

// ── Main evaluator call ─────────────────────────────────────────────

export async function runExternalEvaluator(
  pi: ExtensionAPI,
  state: IterativeGoalState,
  ctx: ExtensionContext,
  stateManager: StateManagerAPI,
): Promise<EvaluatorVerdict> {
  log(`Running evaluator for cycle ${state.cycle}`);

  // §7.3 configuration surface (C4): judge model override + explicit rubric.
  // A ctx without cwd (minimal harness callers) degrades to defaults — flag
  // off, default rubric — never a throw. The mergeBack flag is read directly
  // from the shared settings reader (C4-OUS-007 — one boolean, no
  // workspace-layer import).
  const configCwd = typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : null;
  const judgeConfig = configCwd ? loadJudgeConfig(configCwd) : { model: null, rubric: [...DEFAULT_JUDGE_RUBRIC], customRubric: false };
  const mergeBackSettings = configCwd ? readIterativeGoalSettings(configCwd).mergeBack : undefined;
  const mergeBackEnabled = !!(mergeBackSettings && typeof mergeBackSettings === "object"
    && (mergeBackSettings as Record<string, unknown>).enabled === true);

  // Start evaluator state
  updateEvaluatorHeartbeat(stateManager, state, "running");

  // Check if previous evaluator heartbeat is stale
  if (state.evaluatorState && state.evaluatorState.lastHeartbeatAt) {
    if (isStaleHeartbeat(state.evaluatorState.lastHeartbeatAt)) {
      stateManager.setEvaluatorState({
        ...state.evaluatorState,
        status: "stale_heartbeat",
      });
    }
  }

  // Find the validate-phase judge model (§7.3 independence: overridable via
  // iterativeGoal.judge so the judge is not the implement-phase actor).
  const judgeModel = resolveJudgeModel(state, judgeConfig);
  const model = ctx.modelRegistry.find(
    judgeModel.provider,
    judgeModel.model,
  );

  if (!model) {
    log("Evaluator model not found, using fallback");
    updateEvaluatorHeartbeat(stateManager, state, "error", `Model not found: ${judgeModel.provider}/${judgeModel.model}`);
    return fallbackVerdict(
      `No model found for ${judgeModel.provider}/${judgeModel.model}`,
    );
  }

  // Build evaluation prompt
  const evidence = buildEvidenceSummary(state);
  const manifest = buildValidationManifest(state);

  // Check allowlist violations
  const lastPlan = state.artifacts.plans.at(-1);
  const allowlistInfo = lastPlan
    ? checkAllowlistViolations(state, lastPlan.content)
    : { violation: false, plannedFiles: [], actualFiles: [], extraFiles: [] };

  const allowlistBlock = allowlistInfo.plannedFiles.length > 0
    ? [
        "",
        "--- PLAN ALLOWLIST CHECK ---",
        `Planned files: ${allowlistInfo.plannedFiles.join(", ")}`,
        `Allowlist violation: ${allowlistInfo.violation ? "YES - files edited outside plan" : "No"}`,
        allowlistInfo.violation ? "WARNING: Implementation exceeded plan allowlist. This is a safety concern." : "",
      ].join("\n")
    : "";

  const hasAllFourCurrentCycle = state.artifacts.research.some((artifact) => artifact.cycle === state.cycle)
    && state.artifacts.plans.some((artifact) => artifact.cycle === state.cycle)
    && state.artifacts.implementations.some((artifact) => artifact.cycle === state.cycle)
    && state.artifacts.validations.some((artifact) => artifact.cycle === state.cycle);
  const currentCycleAttestations = state.attestations.filter((attestation) => attestation.cycle === state.cycle);
  const cyberBlockers = assertEvaluatorCyberPrereqs({
    hasAllFourCurrentCycle,
    signing: state.signing,
    dlp: state.dlp,
    sanitizer: state.sanitizer,
    attestations: currentCycleAttestations,
  });

  if (cyberBlockers.length > 0) {
    updateEvaluatorHeartbeat(stateManager, state, "failed");
    return {
      goal_met: false,
      confidence: 0,
      completion_blockers: cyberBlockers,
      accepted_evidence: [],
      rejected_evidence: cyberBlockers,
      remaining_work: cyberBlockers.map((description) => ({ priority: "critical" as const, description })),
      next_cycle_directive: {
        focus: cyberBlockers.some((blocker) => /signer|DLP|sanitizer/i.test(blocker))
          ? "capability_repair"
          : "validate",
        reason: "Cyber completion prerequisites are missing.",
      },
      safety_notes: ["Completion blocked by zero-trust evaluator prerequisites."],
    };
  }

  // The unfinished-work gate (§6.6 part 3, extended in C4): deterministic,
  // and deliberately BEFORE any judge invocation — a rejection here never
  // spends a judge call (deterministic-first, §7.3).
  const unfinishedWork = findUnfinishedWork(state, { mergeBackEnabled });
  if (unfinishedWork.length > 0) {
    const blockers = unfinishedWork.map((item) => item.description);
    updateEvaluatorHeartbeat(stateManager, state, "failed");
    return {
      goal_met: false,
      confidence: 0,
      completion_blockers: blockers,
      accepted_evidence: [],
      rejected_evidence: blockers,
      remaining_work: blockers.map((description) => ({
        priority: /blocked|not merge_verified/.test(description) ? "high" as const : "medium" as const,
        description,
      })),
      next_cycle_directive: {
        focus: unfinishedWork.some((item) => item.kind === "task" && item.status === "blocked") ? "research" : "implement",
        reason: mergeBackEnabled && unfinishedWork.some((item) => item.kind === "shard")
          ? "Shard fan-out is not fully merge-verified."
          : "Durable task plan still has unfinished work.",
      },
      safety_notes: unfinishedWork.some((item) => item.kind === "shard")
        ? ["Completion blocked until every fan-out shard is merge_verified."]
        : ["Completion blocked until durable task plan is resolved."],
    };
  }

  const prompt = [
    EVALUATOR_SYSTEM_PROMPT,
    "",
    "--- ORIGINAL GOAL ---",
    state.goal,
    "",
    "--- COMPLETION CRITERION ---",
    state.goalCriterion,
    "",
    // C4-OUS-005: the rubric section exists only when a rubric is actually
    // CONFIGURED — an unconfigured run's judge prompt is identical to pre-C4.
    ...(judgeConfig.customRubric
      ? [
        "--- GRADING RUBRIC (§7.3) ---",
        "Grade against this explicit rubric; every item must hold for goal_met=true:",
        ...judgeConfig.rubric.map((item, index) => `${index + 1}. ${item}`),
        "",
      ]
      : []),
    "--- CYCLE INFORMATION ---",
    `Cycle: ${state.cycle}`,
    `Total research artifacts: ${state.artifacts.research.length}`,
    `Total plans: ${state.artifacts.plans.length}`,
    `Total implementations: ${state.artifacts.implementations.length}`,
    `Total validations: ${state.artifacts.validations.length}`,
    `Previous evaluator reports: ${state.artifacts.evaluatorReports.length}`,
    "",
    "--- EVIDENCE FROM THIS CYCLE ---",
    evidence,
    "",
    "--- PREVIOUS VERDICT ---",
    state.evaluator.lastVerdict
      ? [
          `goal_met: ${state.evaluator.lastVerdict.goal_met}`,
          `confidence: ${state.evaluator.lastVerdict.confidence}`,
          ...state.evaluator.lastVerdict.remaining_work.map(
            (w) => `  [${w.priority}] ${w.description}`,
          ),
        ].join("\n")
      : "No prior verdict.",
    "",
    "--- VALIDATION MANIFEST ---",
    manifest,
    allowlistBlock,
    "",
    "--- PROJECT INSTRUCTIONS ---",
    state.projectInstructions.files.length > 0
      ? state.projectInstructions.files.map((file) =>
          `${file.path} sha256=${file.sha256} truncated=${file.truncated ? "yes" : "no"}`,
        ).join("\n")
      : "No AGENTS.md or CLAUDE.md files discovered.",
    "",
    "--- DURABLE TASK PLAN ---",
    state.taskPlan.items.length > 0
      ? [
          `Updated: ${state.taskPlan.updatedAt ?? "unknown"}`,
          `Rationale: ${state.taskPlan.rationale ?? "none"}`,
          ...state.taskPlan.items.map((item) =>
            `[${item.status}] ${item.id}: ${item.title}${item.detail ? ` - ${item.detail}` : ""}${item.evidence.length > 0 ? ` Evidence: ${item.evidence.join("; ")}` : ""}`,
          ),
        ].join("\n")
      : "No durable task-plan items recorded.",
    "",
    "--- ZERO TRUST CONTROL SUMMARY ---",
    `DLP enabled: ${state.dlp.enabled} scanner=${state.dlp.scannerAvailable} redactions=${state.dlp.redactionCount}`,
    `IPI sanitizer enabled: ${state.sanitizer.enabled} detections=${state.sanitizer.ipiDetections}`,
    `Evidence signer: ${state.signing.available ? "available" : "unavailable"} key=${state.signing.keyId}`,
    `Signed attestations this cycle: ${currentCycleAttestations.length}`,
    `CAS/Unify route: ${state.unifyCasProfile.currentRouteSummary}`,
    "Deprecated current-operation OCR routes: PaddleOCR, CPU/SQS OCR waves, PaddleParse.",
    "",
    "--- ERRORS THIS CYCLE ---",
    state.errors
      .filter((e) => e.cycle === state.cycle)
      .map(
        (e) =>
          `[${e.phase}] ${e.kind}${e.missingTool ? `:${e.missingTool}` : ""} - ${e.recoveryAction}`,
      )
      .join("\n") || "None",
    "",
    "IMPORTANT: Return ONLY valid JSON. No preamble, no markdown.",
    "If the goal is fully met according to the criterion above, return goal_met=true.",
    "Otherwise, return goal_met=false with specific remaining work items.",
  ].join("\n");

  // Get auth
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    const errMsg = !auth.ok ? "auth not ok" : "no API key";
    log(`Auth failed: ${errMsg}`);
    updateEvaluatorHeartbeat(stateManager, state, "error", `Auth failed: ${errMsg}`);
    return fallbackVerdict(`Auth failed: ${errMsg}`);
  }

  try {
    const response = await complete(
      model,
      {
        messages: [
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: prompt }],
            timestamp: Date.now(),
          },
        ],
        systemPrompt: EVALUATOR_SYSTEM_PROMPT,
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        maxTokens: 4096,
        signal: ctx.signal,
      },
    );

    const text = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    log(`Evaluator response: ${text.slice(0, 200)}`);

    const verdict = parseVerdict(text);
    if (verdict) {
      log(
        `Verdict: goal_met=${verdict.goal_met}, confidence=${verdict.confidence}`,
      );
      updateEvaluatorHeartbeat(
        stateManager,
        state,
        verdict.goal_met ? "passed" : "failed",
      );
      return verdict;
    }

    log("Failed to parse evaluator response, defaulting to goal_met=false");
    updateEvaluatorHeartbeat(stateManager, state, "error", "Unparseable response");
    return {
      goal_met: false,
      confidence: 0,
      completion_blockers: ["Evaluator response could not be parsed."],
      accepted_evidence: [],
      rejected_evidence: [],
      remaining_work: [
        {
          priority: "high",
          description:
            "Evaluator produced unparseable output. Retry validation phase.",
        },
      ],
      next_cycle_directive: {
        focus: "validate",
        reason: "Evaluator output unparseable - retry with better formatting.",
      },
      safety_notes: [],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Evaluator error: ${msg}`);
    updateEvaluatorHeartbeat(stateManager, state, "error", msg);
    return fallbackVerdict(msg);
  }
}

// ── Evidence summary ─────────────────────────────────────────────────

function buildEvidenceSummary(state: IterativeGoalState): string {
  const parts: string[] = [];

  const lastResearch = state.artifacts.research.at(-1);
  if (lastResearch) {
    parts.push(
      `## Research (cycle ${lastResearch.cycle})`,
      `Status: ${lastResearch.status}`,
      lastResearch.content.slice(0, 2000),
      "",
    );
  }

  const lastPlan = state.artifacts.plans.at(-1);
  if (lastPlan) {
    parts.push(
      `## Plan (cycle ${lastPlan.cycle})`,
      `Status: ${lastPlan.status}`,
      lastPlan.content.slice(0, 2000),
      "",
    );
  }

  const lastImpl = state.artifacts.implementations.at(-1);
  if (lastImpl) {
    parts.push(
      `## Implementation (cycle ${lastImpl.cycle})`,
      `Status: ${lastImpl.status}`,
      lastImpl.content.slice(0, 2000),
      "",
    );
  }

  const lastValidation = state.artifacts.validations.at(-1);
  if (lastValidation) {
    parts.push(
      `## Validation (cycle ${lastValidation.cycle})`,
      `Status: ${lastValidation.status}`,
      lastValidation.content.slice(0, 4000),
      "",
    );
  }

  return parts.join("\n") || "No evidence collected yet.";
}

function buildValidationManifest(state: IterativeGoalState): string {
  const manifest: Record<string, unknown> = {
    cycle: state.cycle,
    status: state.status,
    evaluatorState: state.evaluatorState,
    artifacts: {
      research: state.artifacts.research.length,
      plans: state.artifacts.plans.length,
      implementations: state.artifacts.implementations.length,
      validations: state.artifacts.validations.length,
      evaluatorReports: state.artifacts.evaluatorReports.length,
    },
    currentCycleArtifacts: Object.fromEntries(
      (["research", "plans", "implementations", "validations"] as const).map(key => [
        key,
        (state.artifacts[key] as Array<{ cycle: number; status: string }>)
          .filter(a => a.cycle === state.cycle)
          .map(a => ({ cycle: a.cycle, status: a.status })),
      ]),
    ),
    unresolvedErrors: state.errors
      .filter(e => !e.resolved)
      .map(e => ({ phase: e.phase, kind: e.kind, cycle: e.cycle })),
    evaluatorHistory: state.artifacts.evaluatorReports.map((v, i) => ({
      report: i + 1,
      goal_met: v.goal_met,
      confidence: v.confidence,
      blockers: v.completion_blockers.length,
      focus: v.next_cycle_directive.focus,
    })),
    externalBlockers: state.evaluator.lastVerdict?.completion_blockers ?? [],
    lock: {
      activeRunId: state.lock.activeRunId,
      phaseStatus: state.lock.phaseStatus,
      queuedPhaseIds: state.lock.queuedPhaseIds,
    },
  };
  return JSON.stringify(manifest, null, 2);
}
