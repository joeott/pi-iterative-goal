import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { VerificationSpecSchema } from "./verification.js";

export const PathScopeSchema = Type.Object({
  kind: StringEnum(["exact", "glob"] as const),
  value: Type.String(),
});

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

export type PlanTask = Static<typeof PlanTaskSchema>;
export type PlanSpec = Static<typeof PlanSpecSchema>;
