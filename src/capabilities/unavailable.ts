import type { ActionResult } from "./broker.js";

export function providerUnavailable(
  requestId: string,
  providerId: string,
  reason: string,
): ActionResult {
  const now = new Date().toISOString();
  return {
    requestId,
    ok: false,
    error: reason,
    startedAt: now,
    finishedAt: now,
    decision: {
      result: "deny",
      ruleIds: [`provider.${providerId}.unavailable`],
      reason,
    },
  };
}
