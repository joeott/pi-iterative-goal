import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

export const CommandSpecSchema = Type.Object({
  executable: Type.String(),
  argv: Type.Array(Type.String()),
  cwd: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number({ minimum: 1 })),
});

export const VerificationSpecSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  required: Type.Boolean({ default: true }),
  command: Type.Optional(CommandSpecSchema),
});

export const VerificationResultSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  status: StringEnum(["PASS", "FAIL", "NOT_RUN"] as const),
  exitCode: Type.Union([Type.Number(), Type.Null()]),
  artifact: Type.String(),
});

export type CommandSpec = Static<typeof CommandSpecSchema>;
export type VerificationSpec = Static<typeof VerificationSpecSchema>;
export type VerificationResult = Static<typeof VerificationResultSchema>;

export function generateValidationScriptFromSpecs(params: {
  runId: string;
  cycle: number;
  checks: VerificationSpec[];
}): string {
  const artifactDir = `.pi/iterative-goal/runs/${params.runId}/cycles/${params.cycle}/validate`;
  const checksJson = JSON.stringify(params.checks);

  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `export ARTIFACT_DIR=${JSON.stringify(artifactDir)}`,
    'mkdir -p "$ARTIFACT_DIR"',
    `export CHECKS_JSON=${JSON.stringify(checksJson)}`,
    'RESULTS_JSONL="$ARTIFACT_DIR/verification-results.jsonl"',
    ': > "$RESULTS_JSONL"',
    "",
    `echo "=== VALIDATION RUN ${params.runId} / cycle ${params.cycle} ===" | tee "$ARTIFACT_DIR/validation.log"`,
    'echo "Started at: $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a "$ARTIFACT_DIR/validation.log"',
    "",
    'echo "--- Repo State ---" > "$ARTIFACT_DIR/repo-state.txt"',
    "{",
    '  echo "Git status (porcelain):"',
    "  git status --porcelain",
    "  echo",
    '  echo "Full git status:"',
    "  git status",
    "  echo",
    '  echo "Changed files:"',
    "  git diff --name-only",
    "  echo",
    '  echo "Diff stat:"',
    "  git diff --stat",
    "  echo",
    '  echo "Recent log:"',
    "  git log --oneline -5",
    '} >> "$ARTIFACT_DIR/repo-state.txt" 2>&1',
    "",
    "node --input-type=module <<'NODE'",
    "import { spawnSync } from 'node:child_process';",
    "import fs from 'node:fs';",
    "const checks = JSON.parse(process.env.CHECKS_JSON ?? '[]');",
    "const artifactDir = process.env.ARTIFACT_DIR;",
    "const resultsPath = process.env.RESULTS_JSONL;",
    "let overall = 0;",
    "for (const check of checks) {",
    "  const artifact = `${artifactDir}/${check.id}.txt`;",
    "  if (!check.command) {",
    "    const status = check.required === false ? 'NOT_RUN' : 'FAIL';",
    "    fs.writeFileSync(artifact, 'NOT_RUN: no command specified\\n');",
    "    fs.appendFileSync(resultsPath, JSON.stringify({ id: check.id, name: check.name, status, exitCode: null, artifact }) + '\\n');",
    "    if (check.required !== false) overall = 1;",
    "    continue;",
    "  }",
    "  const started = new Date().toISOString();",
    "  const result = spawnSync(check.command.executable, check.command.argv ?? [], { cwd: check.command.cwd, encoding: 'utf8', timeout: check.command.timeoutMs ?? 120000, shell: false });",
    "  const exitCode = typeof result.status === 'number' ? result.status : 124;",
    "  const output = [`Started: ${started}`, `Command: ${check.command.executable} ${(check.command.argv ?? []).join(' ')}`, `Exit code: ${exitCode}`, '', 'STDOUT:', result.stdout ?? '', '', 'STDERR:', result.stderr ?? ''].join('\\n');",
    "  fs.writeFileSync(artifact, output);",
    "  const status = exitCode === 0 ? 'PASS' : 'FAIL';",
    "  fs.appendFileSync(resultsPath, JSON.stringify({ id: check.id, name: check.name, status, exitCode, artifact }) + '\\n');",
    "  if (exitCode !== 0 && check.required !== false) overall = exitCode || 1;",
    "}",
    "process.exit(overall);",
    "NODE",
    "",
    'git diff > "$ARTIFACT_DIR/diff.patch" 2>&1',
    'echo "Patch saved to $ARTIFACT_DIR/diff.patch"',
    'echo "Finished at: $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a "$ARTIFACT_DIR/validation.log"',
  ].join("\n");
}

export function commandSpecFromShellWords(command: string): CommandSpec | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  const parts = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const unquoted = parts.map((part) => part.replace(/^["']|["']$/g, ""));
  const [executable, ...argv] = unquoted;
  if (!executable) return null;
  return { executable, argv };
}

export function verificationSpecsFromLegacyCommands(testCommand: string, gateCommand: string): VerificationSpec[] {
  return [
    { id: "tests", name: "Tests", required: true, command: commandSpecFromShellWords(testCommand) ?? undefined },
    { id: "gates", name: "Gates", required: true, command: commandSpecFromShellWords(gateCommand) ?? undefined },
  ];
}
