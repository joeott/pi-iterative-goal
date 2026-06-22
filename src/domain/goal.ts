import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { VerificationSpecSchema } from "./verification.js";

export const RequirementSchema = Type.Object({
  id: Type.String(),
  text: Type.String(),
  priority: StringEnum(["required", "recommended", "optional"] as const),
  source: StringEnum(["user", "repository", "issue", "derived"] as const),
  verification: Type.Array(VerificationSpecSchema),
  status: StringEnum(["unverified", "satisfied", "failed", "waived"] as const),
});

export const GoalSpecSchema = Type.Object({
  id: Type.String(),
  statement: Type.String(),
  requirements: Type.Array(RequirementSchema),
  constraints: Type.Array(Type.String()),
  completionPolicy: Type.String(),
});

export type Requirement = Static<typeof RequirementSchema>;
export type GoalSpec = Static<typeof GoalSpecSchema>;
