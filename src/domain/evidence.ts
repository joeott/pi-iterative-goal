import { Type, type Static } from "typebox";

export const ActorIdentitySchema = Type.Object({
  kind: Type.String(),
  id: Type.String(),
});

export const EvidenceSchema = Type.Object({
  id: Type.String(),
  requirementIds: Type.Array(Type.String()),
  producer: ActorIdentitySchema,
  capability: Type.String(),
  inputHash: Type.String(),
  outputHash: Type.String(),
  artifactUri: Type.String(),
  exitCode: Type.Optional(Type.Number()),
  startedAt: Type.String(),
  finishedAt: Type.String(),
  provenance: Type.Record(Type.String(), Type.Unknown()),
});

export type Evidence = Static<typeof EvidenceSchema>;
