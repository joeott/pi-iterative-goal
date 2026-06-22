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
import { type StateManagerAPI } from "./state.js";
import * as fs from "node:fs";
import * as path from "node:path";

const LOG_FILE = "/Users/joe/Projects/pi-iterative-goal/debug.log";
function log(msg: string) {
  try {
    const fs = require("node:fs");
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [evaluator] ${msg}\n`);
  } catch {}
}

const EVALUATOR_SYSTEM_PROMPT = `You are the outside evaluator for an autonomous Pi iterative-goal loop.
You do not implement. You only judge whether the original goal is fully met.

You operate on evidence provided by the implementer/validator and must be strict.

Return goal_met=true ONLY if:
- Every explicit completion criterion is satisfied
- Validation evidence is current and verifiable  
- Safety constraints are preserved
- No unresolved critical blockers remain
- The state is reproducible from committed/recorded artifacts
- The implementation matches what was planned (no allowlist violations)

If unsure, return goal_met=false and specify what remains to be done.

You MUST return valid JSON matching this schema:
{
  "goal_met": boolean,
  "confidence": number (0-1),
  "completion_blockers": string[],
  "accepted_evidence": string[],
  "rejected_evidence": string[],
  "remaining_work": [{ "priority": "critical"|"high"|"medium"|"low", "description": string }],
  "next_focus": "research"|"plan"|"implement"|"validate"|"capability_repair"|"external_blocked_complete",
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

  // Find evaluator model
  const model = ctx.modelRegistry.find(
    state.evaluator.provider,
    state.evaluator.model,
  );

  if (!model) {
    log("Evaluator model not found, using fallback");
    updateEvaluatorHeartbeat(stateManager, state, "error", `Model not found: ${state.evaluator.provider}/${state.evaluator.model}`);
    return fallbackVerdict(
      `No model found for ${state.evaluator.provider}/${state.evaluator.model}`,
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

  const prompt = [
    EVALUATOR_SYSTEM_PROMPT,
    "",
    "--- ORIGINAL GOAL ---",
    state.goal,
    "",
    "--- COMPLETION CRITERION ---",
    state.goalCriterion,
    "",
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
