import type { ApprovalRequest } from "../types.js";

export interface ApprovalValidationContext {
  runId: string;
  cycle: number;
  phaseAttemptId: string;
  command: string;
  cwd: string;
  nowMs?: number;
}

export type ApprovalValidation =
  | { ok: true; request: ApprovalRequest }
  | { ok: false; reason: string };

/** Validate an operator-approved, exact-command, unexpired, single-use token. */
export function validateApprovalForCommand(
  request: ApprovalRequest | null | undefined,
  context: ApprovalValidationContext,
): ApprovalValidation {
  if (!request) return { ok: false, reason: "approval token was not found in this run" };
  if (request.status !== "approved") return { ok: false, reason: `approval status is ${request.status}, not approved` };
  // Legacy approvals without all four scopes are intentionally unusable.
  // A destructive capability must never silently widen during state migration.
  if (!request.runId || typeof request.cycle !== "number" || !request.phaseAttemptId || !request.cwd) {
    return { ok: false, reason: "approval is missing its run, cycle, phase-attempt, or cwd scope" };
  }
  if (request.runId !== context.runId) return { ok: false, reason: "approval is bound to a different run" };
  if (request.cycle !== context.cycle) return { ok: false, reason: "approval is bound to a different cycle" };
  if (request.phaseAttemptId !== context.phaseAttemptId) return { ok: false, reason: "approval is bound to a different phase attempt" };
  if (request.cwd !== context.cwd) return { ok: false, reason: "approval is bound to a different cwd" };
  const nowMs = context.nowMs ?? Date.now();
  const resolvedAt = request.resolvedAt ? Date.parse(request.resolvedAt) : NaN;
  const requestedAt = Date.parse(request.requestedAt);
  if (!Number.isFinite(resolvedAt)
    || resolvedAt > nowMs
    || !Number.isFinite(requestedAt)
    || requestedAt > resolvedAt) {
    return { ok: false, reason: "approval has no valid operator resolution timestamp" };
  }
  if (request.usedAt || request.usedForCommand) {
    return { ok: false, reason: `approval was already consumed${request.usedAt ? ` at ${request.usedAt}` : ""}` };
  }
  if (!request.expiresAt) return { ok: false, reason: "approval has no expiry" };
  const expiresAt = Date.parse(request.expiresAt);
  if (!Number.isFinite(expiresAt) || resolvedAt > expiresAt || expiresAt <= nowMs) return { ok: false, reason: "approval is expired or has an invalid expiry" };
  if (!Array.isArray(request.exactCommands) || request.exactCommands.length === 0 || !request.exactCommands.includes(context.command)) {
    return { ok: false, reason: "approval does not authorize this exact command" };
  }
  return { ok: true, request };
}
