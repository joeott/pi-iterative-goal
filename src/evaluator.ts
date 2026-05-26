/**
 * External evaluator - the ONLY completion oracle.
 *
 * Makes a separate model call to assess whether the goal is met.
 * The loop never stops voluntarily; only the evaluator can return goal_met: true.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { complete } from "@mariozechner/pi-ai";
import type { IterativeGoalState, EvaluatorVerdict } from "./types.js";

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
- The implementation matches what was planned

If unsure, return goal_met=false and specify what remains to be done.

You MUST return valid JSON matching this schema:
{
  "goal_met": boolean,
  "confidence": number (0-1),
  "completion_blockers": string[],
  "accepted_evidence": string[],
  "rejected_evidence": string[],
  "remaining_work": [{ "priority": "critical"|"high"|"medium"|"low", "description": string }],
  "next_focus": "research"|"plan"|"implement"|"validate"|"capability_repair",
  "next_focus_reason": string,
  "safety_notes": string[]
}

No preamble. No markdown. JSON only.`;

// ── Fallback evaluator (used when model call fails) ──────────────────

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
  // Try direct JSON
  try {
    const raw = JSON.parse(text);
    return {
      goal_met: Boolean(raw.goal_met),
      confidence: Number(raw.confidence) || 0,
      completion_blockers: Array.isArray(raw.completion_blockers) ? raw.completion_blockers : [],
      accepted_evidence: Array.isArray(raw.accepted_evidence) ? raw.accepted_evidence : [],
      rejected_evidence: Array.isArray(raw.rejected_evidence) ? raw.rejected_evidence : [],
      remaining_work: Array.isArray(raw.remaining_work)
        ? raw.remaining_work.map((w: any) => ({
            priority: w.priority || "medium",
            description: w.description || "",
          }))
        : [],
      next_cycle_directive: {
        focus: raw.next_focus ?? raw.next_cycle_directive?.focus ?? "research",
        reason: raw.next_focus_reason ?? raw.next_cycle_directive?.reason ?? "",
      },
      safety_notes: Array.isArray(raw.safety_notes) ? raw.safety_notes : [],
    };
  } catch {}

  // Try extracting JSON block
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const raw = JSON.parse(jsonMatch[0]);
      return {
        goal_met: Boolean(raw.goal_met),
        confidence: Number(raw.confidence) || 0,
        completion_blockers: Array.isArray(raw.completion_blockers) ? raw.completion_blockers : [],
        accepted_evidence: Array.isArray(raw.accepted_evidence)
          ? raw.accepted_evidence
          : [],
        rejected_evidence: Array.isArray(raw.rejected_evidence)
          ? raw.rejected_evidence
          : [],
        remaining_work: Array.isArray(raw.remaining_work)
          ? raw.remaining_work.map((w: any) => ({
              priority: w.priority || "medium",
              description: w.description || "",
            }))
          : [],
        next_cycle_directive: {
          focus: raw.next_focus ?? raw.next_cycle_directive?.focus ?? "research",
          reason:
            raw.next_focus_reason ?? raw.next_cycle_directive?.reason ?? "",
        },
        safety_notes: Array.isArray(raw.safety_notes) ? raw.safety_notes : [],
      };
    } catch {}
  }

  return null;
}

// ── Evaluator call ──────────────────────────────────────────────────

export async function runExternalEvaluator(
  pi: ExtensionAPI,
  state: IterativeGoalState,
  ctx: ExtensionContext,
): Promise<EvaluatorVerdict> {
  log(`Running evaluator for cycle ${state.cycle}`);

  // Find evaluator model
  const model = ctx.modelRegistry.find(
    state.evaluator.provider,
    state.evaluator.model,
  );

  if (!model) {
    log("Evaluator model not found, using fallback");
    return fallbackVerdict(
      `No model found for ${state.evaluator.provider}/${state.evaluator.model}`,
    );
  }

  // Build evaluation prompt
  const evidence = buildEvidenceSummary(state);
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
      return verdict;
    }

    log("Failed to parse evaluator response, defaulting to goal_met=false");
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
      lastValidation.content.slice(0, 2000),
      "",
    );
  }

  return parts.join("\n") || "No evidence collected yet.";
}
