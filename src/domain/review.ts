import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

export const ReviewFindingSchema = Type.Object({
  id: Type.String(),
  fingerprint: Type.String(),
  reviewer: Type.String(),
  severity: StringEnum(["blocker", "high", "medium", "low", "info"] as const),
  category: StringEnum([
    "requirements",
    "correctness",
    "architecture",
    "security",
    "tests",
    "performance",
    "documentation",
  ] as const),
  requirementIds: Type.Array(Type.String()),
  message: Type.String(),
  location: Type.Optional(Type.Object({
    path: Type.String(),
    line: Type.Optional(Type.Number()),
  })),
  status: StringEnum(["open", "resolved", "waived"] as const),
});

export type ReviewFinding = Static<typeof ReviewFindingSchema>;
