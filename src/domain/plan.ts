import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { StringEnum } from "@earendil-works/pi-ai";
import { VerificationSpecSchema } from "./verification.js";
import { parsePathScope, serializePathScope, type PathScope } from "./path-scope.js";

export const PathScopeSchema = Type.Union([
  Type.Object({ kind: Type.Literal("exact"), path: Type.String() }),
  Type.Object({ kind: Type.Literal("glob"), pattern: Type.String() }),
]);

export const PlanTaskSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  dependsOn: Type.Array(Type.String()),
  satisfies: Type.Array(Type.String()),
  allowedPaths: Type.Array(PathScopeSchema),
  requiredCapabilities: Type.Array(Type.String()),
  checks: Type.Array(VerificationSpecSchema),
  rollback: Type.String(),
  risk: StringEnum(["low", "medium", "high"] as const),
});

export const PlanSpecSchema = Type.Object({
  id: Type.String(),
  version: Type.Number(),
  tasks: Type.Array(PlanTaskSchema),
  createdAt: Type.String(),
});

export const PlanAmendmentSchema = Type.Object({
  type: Type.Literal("PlanAmendment"),
  id: Type.String(),
  status: StringEnum(["proposed", "reviewed", "accepted", "rejected"] as const),
  discovery: Type.String(),
  affectedRequirements: Type.Array(Type.String()),
  newAllowedPaths: Type.Array(Type.String()),
  newCapabilities: Type.Array(Type.String()),
  riskChange: StringEnum(["none", "low", "medium", "high"] as const),
  revisedChecks: Type.Array(VerificationSpecSchema),
  reviewer: Type.String(),
  reviewedAt: Type.String(),
});

export type PlanTask = Static<typeof PlanTaskSchema>;
export type PlanSpec = Static<typeof PlanSpecSchema>;
export type PlanAmendment = Static<typeof PlanAmendmentSchema>;

export function extractAcceptedAmendmentScopes(planContent: string): PathScope[] {
  const scopes = new Map<string, PathScope>();
  for (const candidate of extractJsonObjects(planContent)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!Value.Check(PlanAmendmentSchema, parsed)) continue;
    const amendment = parsed as PlanAmendment;
    if (amendment.status !== "accepted" || !amendment.reviewer.trim() || !amendment.reviewedAt.trim()) continue;
    for (const allowedPath of amendment.newAllowedPaths) {
      try {
        const scope = parsePathScope(allowedPath);
        scopes.set(serializePathScope(scope), scope);
      } catch {
        continue;
      }
    }
  }
  return [...scopes.values()];
}

function extractJsonObjects(text: string): string[] {
  const objects: string[] = [];
  const fencePattern = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g;
  for (const match of text.matchAll(fencePattern)) {
    objects.push(match[1]);
  }
  const inlinePattern = /(\{[^{}]*"type"\s*:\s*"PlanAmendment"[\s\S]*?\})/g;
  for (const match of text.matchAll(inlinePattern)) {
    objects.push(match[1]);
  }
  return objects;
}
