import { Value } from "typebox/value";

export function parseWithSchema<T>(schema: object, value: unknown, label: string): T {
  const parsed = Value.Parse(schema as never, value);
  if (!Value.Check(schema as never, parsed)) {
    throw new Error(`${label} failed runtime schema validation.`);
  }
  return parsed as T;
}
