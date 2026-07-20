#!/usr/bin/env node
/**
 * prod-runtime-confirmation.mjs — scripted PRODUCTION RUNTIME CONFIRMATION for
 * the pi-iterative-goal extension (goal packet: ai_docs/autonomous_kernel_refactor_goal.md
 * §"Production Runtime Confirmation").
 *
 * Drives the BUILT extension (dist/pi-iterative-goal.js) inside the REAL local
 * Pi CLI — not unit tests, not the fake-Pi harness — against a disposable temp
 * repo, exercising:
 *   s1 goal start                      (/goal-start via RPC prompt; run_created event)
 *   s2 typed plan creation             (goal_post_shards accepted; shard_plan_proposed event)
 *   s3 brokered shell execution        (goal_shell allowed + attestation_recorded)
 *   s4 validation gate failure+success (gate verdict transition FAIL→PASS)
 *   s5 adversarial review creation     (goal_subagent "Security reviewer" ledger events)
 *   s6 release-authorization REFUSAL   (/goal-authorize-release denied before gates pass)
 *   s7 release-authorization SUCCESS   (release_authorization_updated after gates pass)
 *   s8 goal_git create_pr dry-run ONLY (never a real PR, never gh, never a push)
 *   s9 no writes outside temp repo; no unrelated Pi settings changed
 *
 * Mechanism (documented per the tasking):
 *   - `pi --mode rpc --no-session --no-extensions -e <abs dist> --model zai/glm-5.2`
 *     spawned with cwd = disposable repo. `--no-extensions` pins the exact build
 *     under test and avoids double registration: this machine's user settings
 *     (~/.pi/agent/settings.json) already register this repo as an extension —
 *     the goal_subagent subprocess relies on that discovery path instead.
 *   - Slash commands (/goal-start, /goal-authorize-release) are sent as RPC
 *     `prompt` commands; extension commands execute immediately, even mid-stream,
 *     and cost ZERO model calls.
 *   - PI RUNTIME QUIRK (verified empirically against pi 0.75.5): a followUp
 *     message queued by an extension agent_end handler is stranded — agent_end
 *     fires only after the agent loop's final followUp drain (pi-agent-core
 *     agent-loop.js), so the harness's next phase prompt sits in the queue until
 *     some new prompt starts a run and drains it. The script therefore NUDGES:
 *     when get_state shows pendingMessageCount>0 and the agent is idle, it sends
 *     a one-word "Continue." prompt; the queued phase prompt is delivered inside
 *     that same run, right after the nudge turn. Each nudge costs 1 model call
 *     and is counted separately.
 *   - Provider: z.ai glm-5.2 for the coordinator and every worker. Feature
 *     profiles configure cerebras/gpt-oss-120b as the independent evaluator,
 *     but their bounded campaign proof may stop before evaluation; the receipt
 *     labels that route as configured-not-executed instead of claiming an
 *     observed judge identity. Only selected credentials enter the child;
 *     worker subprocesses receive only their exact route credential.
 *
 * Bounds: max 2 goal cycles, wall-clock cap (default 18 min), and a final
 * aggregate ceiling of 60 model responses (main-session turns + judge verdicts
 * + subagent turns). Crossing the ceiling fails the receipt; main-session
 * turns are also stopped as soon as they alone consume the full allowance.
 * Writes: the disposable temp repo (removed afterwards) and this repo's .pi/
 * dir (evidence bundle). Never pushes, never creates a real PR, never touches
 * AWS, never edits pi settings.
 *
 * Exit code: 0 iff every scenario PASSes.
 */
import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FEATURE_MATRIX_CALIBRATION_TASK_IDS,
  FEATURE_MATRIX_PLAN_ID,
  FEATURE_MATRIX_REVIEW_TASK_IDS,
  FEATURE_MATRIX_SCHEDULER_TASK_IDS,
  buildFeatureProfileSettings,
  evaluateFeatureProfileEvidence,
  featureProfileBudget,
  featureProfileDepth,
  loadStrictFeatureMatrixInvocations,
  requireFeatureProfile,
} from "./lib/prod-feature-matrix.mjs";
import {
  assertRuntimeProvenanceUnchanged,
  captureRuntimeProvenance,
  gitOutput,
  runGit,
  sanitizedRuntimePath,
} from "./lib/runtime-provenance.mjs";
import {
  MAX_TREE_SNAPSHOT_BYTES,
  MAX_TREE_SNAPSHOT_ENTRIES,
  diffSnapshots,
  snapshotTree,
  summarizeSnapshot,
} from "./lib/bounded-tree-snapshot.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const PI_BIN = path.join(repoRoot, "node_modules", ".bin", "pi");
const EXT_PATH = path.join(repoRoot, "dist", "pi-iterative-goal.js");

// ── CLI options ───────────────────────────────────────────────────────
const opts = {
  maxMinutes: 18,
  maxCycles: 2,
  maxModelCalls: 60,
  keepTemp: false,
  nudgeAfterMs: 7000,
  featureProfile: "off",
};
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === "--max-minutes" && process.argv[i + 1]) { opts.maxMinutes = Number(process.argv[i + 1]); i += 1; }
  else if (process.argv[i] === "--max-cycles" && process.argv[i + 1]) { opts.maxCycles = Number(process.argv[i + 1]); i += 1; }
  else if (process.argv[i] === "--max-model-calls" && process.argv[i + 1]) { opts.maxModelCalls = Number(process.argv[i + 1]); i += 1; }
  else if (process.argv[i] === "--feature-profile" && process.argv[i + 1]) { opts.featureProfile = process.argv[i + 1]; i += 1; }
  else if (process.argv[i] === "--keep-temp") opts.keepTemp = true;
  else throw new Error(`unknown or incomplete option: ${process.argv[i]}`);
}
if (!Number.isFinite(opts.maxMinutes) || opts.maxMinutes <= 0 || opts.maxMinutes > 60) {
  throw new Error("--max-minutes must be greater than 0 and at most 60");
}
if (!Number.isSafeInteger(opts.maxCycles) || opts.maxCycles < 1 || opts.maxCycles > 10) {
  throw new Error("--max-cycles must be an integer from 1 through 10");
}
if (!Number.isSafeInteger(opts.maxModelCalls) || opts.maxModelCalls < 1 || opts.maxModelCalls > 240) {
  throw new Error("--max-model-calls must be an integer from 1 through 240");
}
requireFeatureProfile(opts.featureProfile);
const featureDepth = featureProfileDepth(opts.featureProfile);
const featureSettings = buildFeatureProfileSettings(opts.featureProfile);
const featureMatrixId = typeof process.env.PI_PROD_FEATURE_MATRIX_ID === "string"
  && /^[A-Za-z0-9._-]{1,128}$/.test(process.env.PI_PROD_FEATURE_MATRIX_ID)
  ? process.env.PI_PROD_FEATURE_MATRIX_ID
  : null;
const featureMatrixMode = featureMatrixId !== null;
const offMatrixMode = featureMatrixMode && featureDepth === 0;
const featureEvidenceRequired = featureDepth > 0 || offMatrixMode;
const featureBudget = featureEvidenceRequired ? featureProfileBudget(opts.featureProfile) : null;
const featureToolAllowlist = featureEvidenceRequired ? [
  "goal_repo_context",
  "goal_report_phase_result",
  "goal_update_task_plan",
  ...(featureDepth >= 1 ? ["goal_subagent"] : []),
  ...(featureDepth >= 2 ? ["goal_post_shards"] : []),
] : null;
if (featureBudget && opts.maxMinutes > featureBudget.maxMinutes) {
  throw new Error(`${opts.featureProfile} exceeds its ${featureBudget.maxMinutes}-minute production profile ceiling`);
}
if (featureBudget && opts.maxModelCalls > featureBudget.maxModelResponses) {
  throw new Error(`${opts.featureProfile} exceeds its ${featureBudget.maxModelResponses}-response production profile ceiling`);
}
const DEADLINE = Date.now() + opts.maxMinutes * 60_000;
const MAX_RPC_REQUEST_MS = 30_000;
const MAX_PENDING_RPC_REQUESTS = 64;
const MAX_RECORDED_TOOL_CALLS = 2_000;
const MAX_RECORDED_NOTIFICATIONS = 1_000;
const MAX_RECORDED_EXTENSION_ERRORS = 256;
const MAX_RECORDED_DIALOGS = 256;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_JSONL_BYTES = 16 * 1024 * 1024;
const MAX_JSONL_LINE_BYTES = 128 * 1024;
const MAX_JSONL_RECORDS = 100_000;
if (!fs.existsSync(EXT_PATH)) throw new Error(`built extension missing: ${EXT_PATH} (run npm run build)`);
if (!fs.existsSync(PI_BIN)) throw new Error(`pi CLI missing: ${PI_BIN}`);
const runtimeProvenance = captureRuntimeProvenance(repoRoot, { extensionPath: EXT_PATH, piPath: PI_BIN });
const runtimeProvenanceDigest = crypto.createHash("sha256")
  .update(JSON.stringify(runtimeProvenance))
  .digest("hex");
if (featureMatrixMode
  && process.env.PI_PROD_FEATURE_MATRIX_PROVENANCE_SHA256 !== runtimeProvenanceDigest) {
  throw new Error("production matrix runtime provenance digest mismatch");
}
const {
  appendManagedLog,
  ensureManagedRoot,
  redactLogText,
} = await import("../dist/logging.js");
const { loadModelInvocations } = await import("../dist/model-telemetry.js");
const {
  getManagedLogHealth,
  runManagedLogRetention,
  startManagedLogRetentionLoop,
} = await import("../dist/log-retention.js");
const initialSourceRetention = runManagedLogRetention(repoRoot);
if (initialSourceRetention.blocked) {
  throw new Error(`source managed-log retention is blocked: ${initialSourceRetention.reasons.join("; ")}`);
}
const stopSourceRetentionLoop = startManagedLogRetentionLoop(repoRoot);
let finalSourceRetention = null;
let sourceRetentionViolation = null;

// ── Small utilities ───────────────────────────────────────────────────
const startedAt = new Date().toISOString();
const harnessRunId = `prod-runtime-${startedAt.replace(/[:.]/g, "-")}-${crypto.randomBytes(4).toString("hex")}`;
const managedRoot = ensureManagedRoot(repoRoot);
const evidenceDir = path.join(managedRoot, "evidence", "prod-runtime-confirmation", harnessRunId);
const rawDir = path.join(managedRoot, "runs", harnessRunId, "raw");
fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(rawDir, { recursive: true, mode: 0o700 });
const rawActiveMarker = path.join(path.dirname(rawDir), "ACTIVE");
fs.writeFileSync(rawActiveMarker, `${process.pid}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
const rawLogPaths = {
  script: path.join(rawDir, "script.jsonl"),
  rpc: path.join(rawDir, "rpc-events.jsonl"),
  stderr: path.join(rawDir, "stderr.jsonl"),
};
let rawLogsCompleted = false;

function appendRawLog(stream, message, metadata = undefined, level = "debug") {
  try {
    const stat = fs.lstatSync(rawActiveMarker);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("managed raw ACTIVE marker is not a regular file");
    const now = new Date();
    fs.utimesSync(rawActiveMarker, now, now);
  } catch (error) {
    throw new Error(`managed raw ACTIVE marker is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  appendManagedLog(stream, "prod-runtime-confirmation", message, {
    cwd: repoRoot,
    runId: harnessRunId,
    level,
    metadata,
    required: true,
    path: rawLogPaths[stream],
    rotateBytes: 10 * 1024 * 1024,
    rotations: 3,
  });
}

function completeRawLogs() {
  if (rawLogsCompleted) return;
  rawLogsCompleted = true;
  for (const source of Object.values(rawLogPaths)) {
    try {
      const stat = fs.lstatSync(source);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`raw log is not a regular file: ${source}`);
      const completed = source.replace(/\.jsonl$/, ".completed.jsonl");
      fs.renameSync(source, completed);
      const sourceHead = `${source}.head.json`;
      try {
        const headStat = fs.lstatSync(sourceHead);
        if (headStat.isSymbolicLink() || !headStat.isFile()) throw new Error(`raw chain head is not a regular file: ${sourceHead}`);
        fs.renameSync(sourceHead, `${completed}.head.json`);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        console.error(`raw-log completion warning: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  try { fs.unlinkSync(rawActiveMarker); } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      console.error(`raw ACTIVE marker cleanup warning: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
process.once("exit", completeRawLogs);

function logLine(msg) {
  const safe = redactLogText(String(msg));
  const line = `[${new Date().toISOString()}] ${safe}`;
  console.log(line);
  appendRawLog("script", safe);
}
/** Read only the exact providers selected by this disposable runtime. */
function readSelectedProviderEnv() {
  const envPath = path.join(repoRoot, ".env");
  const out = {};
  const selectedKeys = new Set([
    "ZAI_API_KEY",
    "Z_AI_API_KEY",
  ]);
  for (const key of selectedKeys) {
    const value = process.env[key];
    if (value && value !== "REPLACE_ME" && value !== key) out[key] = value;
  }
  if (!fs.existsSync(envPath)) return out;
  const envStat = fs.lstatSync(envPath);
  if (envStat.isSymbolicLink() || !envStat.isFile() || envStat.size > 1024 * 1024) {
    throw new Error("selected provider env file must be a regular file no larger than 1 MiB");
  }
  for (const raw of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    if (!selectedKeys.has(key) || out[key]) continue;
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!value || value === "REPLACE_ME" || value === key) continue;
    out[key] = value;
  }
  return out;
}
function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  if (!Number.isInteger(fs.constants.O_NOFOLLOW)) throw new Error("O_NOFOLLOW is unavailable for trusted JSONL evidence reads");
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size > MAX_JSONL_BYTES) {
      throw new Error(`JSONL evidence is not a bounded regular file: ${filePath}`);
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const overflow = Buffer.alloc(1);
    const overflowBytes = fs.readSync(descriptor, overflow, 0, 1, null);
    const after = fs.fstatSync(descriptor);
    if (offset !== before.size || overflowBytes !== 0
      || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`JSONL evidence changed during bounded read: ${filePath}`);
    }
    const body = bytes.toString("utf8");
    if (body.length === 0) return [];
    if (!body.endsWith("\n")) throw new Error(`JSONL evidence has an unterminated tail: ${filePath}`);
    const lines = body.split(/\r?\n/);
    lines.pop();
    if (lines.length > MAX_JSONL_RECORDS) throw new Error(`JSONL evidence exceeds ${MAX_JSONL_RECORDS} records: ${filePath}`);
    return lines.map((line, index) => {
      if (!line) throw new Error(`JSONL evidence contains an empty record at line ${index + 1}: ${filePath}`);
      if (Buffer.byteLength(line) > MAX_JSONL_LINE_BYTES) throw new Error(`JSONL evidence line exceeds ${MAX_JSONL_LINE_BYTES} bytes: ${filePath}`);
      try { return JSON.parse(line); }
      catch { throw new Error(`JSONL evidence contains malformed JSON at line ${index + 1}: ${filePath}`); }
    });
  } finally {
    fs.closeSync(descriptor);
  }
}
function readJson(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_JSON_BYTES) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch { return null; }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let stopRequested = false;
let stopRequestLogged = false;
let interruptedSignal = null;
let deadlineExceededAt = null;
function overDeadline(what) {
  if (stopRequested) {
    if (!stopRequestLogged) {
      stopRequestLogged = true;
      logLine(`external stop requested during: ${what}`);
    }
    return true;
  }
  if (Date.now() < DEADLINE) return false;
  if (deadlineExceededAt === null) {
    deadlineExceededAt = what;
    logLine(`DEADLINE exceeded during: ${what}`);
  }
  return true;
}

// ── Scenario bookkeeping ──────────────────────────────────────────────
const scenarios = new Map();
function scenario(id, name) { scenarios.set(id, { id, name, status: "PENDING", evidence: [], notes: [] }); }
function note(id, text) { scenarios.get(id).notes.push(text); logLine(`  [${id}] ${text}`); }
function evid(id, text) { scenarios.get(id).evidence.push(text); logLine(`  [${id}] evidence: ${text}`); }
function pass(id, text) { const s = scenarios.get(id); if (s.status !== "FAIL") s.status = "PASS"; if (text) note(id, text); }
function fail(id, text) { const s = scenarios.get(id); s.status = "FAIL"; note(id, `FAIL: ${text}`); }
for (const [id, name] of [
  ["s1", "goal start (/goal-start in real Pi runtime; run_created + phase attempts)"],
  ["s2", offMatrixMode ? "C2 remains disabled (no typed plan or shard activity)" : "typed plan creation (goal_post_shards accepted; shard_plan_proposed event)"],
  ["s3", "brokered shell execution (goal_shell allowed + attestation_recorded)"],
  ["s4", "validation gate failure AND success (gate verdict transition FAIL→PASS)"],
  ["s5", offMatrixMode ? "C1 remains disabled (no subagent task or worker telemetry)" : "adversarial review creation (goal_subagent Security reviewer findings)"],
  ["s6", "release-authorization REFUSAL before gates pass"],
  ["s7", "release-authorization SUCCESS after gates pass"],
  ["s8", "goal_git create_pr dry-run only (no real PR, no gh, no push)"],
  ["s9", "no writes outside temp repo; no unrelated Pi settings changed"],
]) scenario(id, name);
if (featureEvidenceRequired) {
  scenario("s10", `production-real ${opts.featureProfile} feature profile (cumulative C1-C4 dependency chain)`);
}

// ── Preflight ─────────────────────────────────────────────────────────
logLine(`prod-runtime-confirmation starting ${startedAt}`);
logLine(`evidence dir: ${evidenceDir}`);
logLine(`feature profile: ${opts.featureProfile}${featureMatrixId ? ` (matrix ${featureMatrixId})` : ""}`);
const selectedProviderEnv = readSelectedProviderEnv();
if (!selectedProviderEnv.ZAI_API_KEY && !selectedProviderEnv.Z_AI_API_KEY) { console.error("FATAL: no ZAI_API_KEY in the selected runtime environment"); process.exit(2); }
logLine(`selected provider env keys loaded: ${Object.keys(selectedProviderEnv).sort().join(", ")}`);
const gitSha = runtimeProvenance.headSha;
logLine(`repo HEAD: ${gitSha}`);
logLine(`runtime provenance: tree=${runtimeProvenance.treeSha} extension=${runtimeProvenance.extension.sha256} pi=${runtimeProvenance.pi.sha256} node=${runtimeProvenance.node.sha256}`);

// Snapshot the bounded whole user-level Pi tree. The child uses an isolated
// PI_CODING_AGENT_DIR, so creating any previously absent file is also drift.
const piHome = path.join(os.homedir(), ".pi", "agent");
const piHomeBefore = snapshotTree(piHome);
const piHomeSnapshotSummary = summarizeSnapshot(piHomeBefore);
logLine(`pi home snapshot: ${piHomeSnapshotSummary.entries} entries, ${piHomeSnapshotSummary.regularFiles} regular files, ${piHomeSnapshotSummary.regularFileBytes} file bytes fully SHA-256 hashed (bounds: ${MAX_TREE_SNAPSHOT_ENTRIES} entries/${MAX_TREE_SNAPSHOT_BYTES} bytes)`);

// ── Disposable repo ───────────────────────────────────────────────────
const tempParent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prod-confirm-"));
const repoDir = path.join(tempParent, "repo");
const isolatedHome = path.join(tempParent, "home");
const isolatedPiDir = path.join(tempParent, "pi-agent");
const isolatedTmp = path.join(tempParent, "tmp");
fs.mkdirSync(repoDir, { recursive: true });
fs.mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
fs.mkdirSync(isolatedPiDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(isolatedTmp, { recursive: true, mode: 0o700 });
const parentBefore = snapshotTree(tempParent);
fs.writeFileSync(path.join(repoDir, "README.md"), "# prod-runtime-confirmation seed\n\nTiny disposable repo for the iterative-goal production runtime confirmation.\n");
fs.writeFileSync(path.join(repoDir, ".gitignore"), ".pi/\n");
fs.mkdirSync(path.join(repoDir, ".pi"), { recursive: true });
fs.writeFileSync(path.join(repoDir, ".pi", "settings.json"), JSON.stringify({
  iterativeGoal: {
    ...featureSettings,
    finalization: {
      allowGitFinalization: true,
      allowCommit: true,
      allowPush: false,
      allowPR: true,
      fallback: "patch",
    },
    // Short explicit grading rubric (§7.3 surface): keeps the judge's verdict
    // JSON small enough to survive maxTokens=4096 — run 6's judge response was
    // unparseable against the 10-item default rubric + large evidence.
    judge: {
      ...(featureDepth > 0 ? { provider: "cerebras", model: "gpt-oss-120b" } : {}),
      rubric: offMatrixMode
        ? [
            "README.md remains at the seed commit and contains the production confirmation seed heading",
            "the real read-only README check exited 0 this cycle",
            "no C1-C4 worker, shard, claim, patch, or merge artifacts exist",
          ]
        : featureDepth >= 4
        ? [
            "feature-a.txt exists containing exactly the line: alpha",
            "feature-b.txt exists containing exactly the line: beta",
            "the real checks for both files exited 0 this cycle",
            "the current cycle has phase results and harness-signed attestations",
          ]
        : [
            "hello.txt exists containing exactly the line: ok",
            "the real check (test -f hello.txt and grep -qx ok hello.txt) exited 0 this cycle",
            "the current cycle has phase results and harness-signed attestations",
          ],
    },
  },
}, null, 2));
const gitSeed = (args) => {
  runGit(repoDir, args);
};
gitSeed(["init", "-q", "-b", "main"]);
gitSeed(["add", "-A"]);
gitSeed(["-c", "user.email=prod-confirm@example.invalid", "-c", "user.name=prod-confirm", "commit", "-qm", "seed"]);
const seedHeadSha = gitOutput(repoDir, ["rev-parse", "HEAD"]);
logLine(`disposable repo: ${repoDir}`);

// ── RPC client ────────────────────────────────────────────────────────
const counters = {
  mainTurns: 0,     // each turn_end in the main session == 1 model call
  mainTokens: 0,    // provider-reported totalTokens summed across main-session responses
  mainTokenUsageComplete: true,
  nudges: 0,        // subset of mainTurns (the "Continue." turns)
  judgeVerdicts: 0, // evaluator-verdicts.jsonl entries (model call unless deterministic short-circuit)
  subagentTurns: 0, // from subagent_finished usage
  toolCalls: [],    // {name, isError, args, resultSnippet, details}
  notifications: [],
  extensionErrors: [],
  dialogs: [],
};
let agentRunning = false;
const toolCallArgs = new Map(); // toolCallId → args JSON (from tool_execution_start)
const rpcEventStats = { events: 0, bytes: 0, omittedHighFrequency: 0, byType: {} };
const MAX_RPC_LINE_BYTES = 32 * 1024 * 1024;

// Start the production runtime with an explicit, minimal environment. The
// model/extension under test never receives ambient cloud, GitHub, SSH-agent,
// package-registry, or unrelated provider credentials.
const childEnv = {
  PATH: sanitizedRuntimePath(repoRoot),
  HOME: isolatedHome,
  TMPDIR: isolatedTmp,
  PI_CODING_AGENT_DIR: isolatedPiDir,
  PI_TELEMETRY: "0",
  PI_ITERATIVE_GOAL_ROOT: repoRoot,
  CI: "1",
  NO_COLOR: "1",
  ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
  ...(process.env.LC_ALL ? { LC_ALL: process.env.LC_ALL } : {}),
  ...(process.env.LC_CTYPE ? { LC_CTYPE: process.env.LC_CTYPE } : {}),
  ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
  ...selectedProviderEnv,
};

const piProc = spawn(PI_BIN, [
  "--mode", "rpc",
  "--no-session",
  "--no-extensions",
  "--no-builtin-tools",
  "--no-skills",
  "--no-prompt-templates",
  ...(featureToolAllowlist ? ["--tools", featureToolAllowlist.join(",")] : []),
  "-e", EXT_PATH,
  "--model", "zai/glm-5.2",
  "--thinking", "minimal",
], { cwd: repoDir, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
logLine(`pi spawned pid=${piProc.pid}`);
const piExited = new Promise((resolve) => piProc.once("exit", (code, signal) => resolve({ code, signal })));
let piGracefulSignalSent = false;

function requestGracefulStop(signal) {
  if (stopRequested) return;
  stopRequested = true;
  interruptedSignal = signal;
  logLine(`received ${signal}; forwarding one SIGTERM for graceful shutdown of the exact owned Pi runtime`);
  if (piProc.exitCode === null && piProc.signalCode === null) {
    try { piGracefulSignalSent = piProc.kill("SIGTERM") || piGracefulSignalSent; }
    catch { /* the owned child may already be exiting */ }
  }
}
const onSigint = () => requestGracefulStop("SIGINT");
const onSigterm = () => requestGracefulStop("SIGTERM");
process.once("SIGINT", onSigint);
process.once("SIGTERM", onSigterm);

const pendingResponses = new Map();
let rpcId = 0;
let stdoutBuf = "";
piProc.stdin.on("error", (error) => {
  for (const [id, pending] of pendingResponses) {
    pendingResponses.delete(id);
    clearTimeout(pending.timer);
    pending.resolve({ id, success: false, error: `Pi RPC stdin failed: ${error.message}` });
  }
});

function sendRpc(obj) {
  const id = obj.id ?? `rpc-${++rpcId}`;
  if (stopRequested || piProc.stdin.destroyed || !piProc.stdin.writable) {
    return Promise.resolve({ id, success: false, error: "owned Pi runtime is stopping" });
  }
  if (pendingResponses.size >= MAX_PENDING_RPC_REQUESTS) {
    runtimeLoggingViolation = true;
    return Promise.resolve({ id, success: false, error: "RPC pending-request bound exceeded" });
  }
  return new Promise((resolve) => {
    const remaining = DEADLINE - Date.now();
    if (remaining <= 0) {
      resolve({ id, success: false, error: "production runtime deadline expired before RPC send" });
      return;
    }
    const timer = setTimeout(() => {
      if (!pendingResponses.delete(id)) return;
      resolve({ id, success: false, error: `RPC ${obj.type ?? "unknown"} exceeded ${Math.min(MAX_RPC_REQUEST_MS, remaining)}ms` });
    }, Math.min(MAX_RPC_REQUEST_MS, remaining));
    pendingResponses.set(id, { resolve, requestType: obj.type, timer });
    try {
      piProc.stdin.write(JSON.stringify({ ...obj, id }) + "\n", (error) => {
        if (!error) return;
        const pending = pendingResponses.get(id);
        if (!pending) return;
        pendingResponses.delete(id);
        clearTimeout(pending.timer);
        pending.resolve({ id, success: false, error: error.message });
      });
    } catch (error) {
      const pending = pendingResponses.get(id);
      if (pending) clearTimeout(pending.timer);
      pendingResponses.delete(id);
      resolve({ id, success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
}

function recordRpcEvent(line, ev) {
  const bytes = Buffer.byteLength(line);
  const type = typeof ev?.type === "string" ? ev.type : "non_json";
  rpcEventStats.events += 1;
  rpcEventStats.bytes += bytes;
  rpcEventStats.byType[type] = (rpcEventStats.byType[type] ?? 0) + 1;
  const pending = type === "response" ? pendingResponses.get(ev.id) : null;
  if (type === "message_update" || (type === "response" && pending?.requestType === "get_state")) {
    rpcEventStats.omittedHighFrequency += 1;
    return;
  }
  appendRawLog("rpc", "rpc_event", {
    type,
    bytes,
    sha256: crypto.createHash("sha256").update(line).digest("hex"),
    ...(typeof ev?.id === "string" ? { id: ev.id.slice(0, 128) } : {}),
    ...(pending?.requestType ? { requestType: pending.requestType } : {}),
    ...(typeof ev?.success === "boolean" ? { success: ev.success } : {}),
    ...(typeof ev?.toolName === "string" ? { toolName: ev.toolName.slice(0, 128) } : {}),
    ...(typeof ev?.isError === "boolean" ? { isError: ev.isError } : {}),
    ...(typeof ev?.method === "string" ? { method: ev.method.slice(0, 128) } : {}),
  });
}

function captureToolCallArgs(ev) {
  const args = ev?.args && typeof ev.args === "object" && !Array.isArray(ev.args)
    ? ev.args
    : {};
  if (ev?.toolName === "goal_subagent") {
    const tasks = Array.isArray(args.tasks)
      ? args.tasks.slice(0, 16).map((task) => ({
          ...(typeof task?.id === "string" ? { id: task.id.slice(0, 128) } : {}),
          ...(typeof task?.role === "string" ? { role: task.role.slice(0, 128) } : {}),
          ...(typeof task?.model === "string" ? { model: task.model.slice(0, 128) } : {}),
        }))
      : undefined;
    return JSON.stringify({
      ...(typeof args.mode === "string" ? { mode: args.mode.slice(0, 32) } : {}),
      ...(Number.isSafeInteger(args.concurrency) ? { concurrency: args.concurrency } : {}),
      ...(tasks ? { tasks } : {}),
      ...(!tasks && typeof args.role === "string" ? { role: args.role.slice(0, 128) } : {}),
      ...(!tasks && typeof args.model === "string" ? { model: args.model.slice(0, 128) } : {}),
    });
  }
  return redactLogText(JSON.stringify(args)).slice(0, 500);
}

piProc.stdout.on("data", (chunk) => {
  stdoutBuf += chunk.toString("utf8");
  if (Buffer.byteLength(stdoutBuf) > MAX_RPC_LINE_BYTES && !stdoutBuf.includes("\n")) {
    runtimeLoggingViolation = true;
    appendRawLog("rpc", "rpc_line_limit_exceeded", {
      maximumBytes: MAX_RPC_LINE_BYTES,
      observedBytes: Buffer.byteLength(stdoutBuf),
      sha256Prefix: crypto.createHash("sha256").update(stdoutBuf.slice(0, 1024 * 1024)).digest("hex"),
    }, "error");
    try { piProc.kill("SIGTERM"); } catch { /* already exited */ }
    stdoutBuf = "";
    return;
  }
  let idx;
  while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
    const line = stdoutBuf.slice(0, idx).replace(/\r$/, "");
    stdoutBuf = stdoutBuf.slice(idx + 1);
    if (!line.trim()) continue;
    let ev = null;
    try { ev = JSON.parse(line); } catch {
      recordRpcEvent(line, null);
      continue;
    }
    recordRpcEvent(line, ev);
    handleRpcEvent(ev);
  }
});
piProc.stderr.on("data", (chunk) => {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  appendRawLog("stderr", "pi_stderr_chunk", {
    bytes: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  }, "warn");
});
piProc.on("exit", (code, signal) => {
  agentRunning = false;
  for (const [id, pending] of pendingResponses) {
    clearTimeout(pending.timer);
    pending.resolve({ id, success: false, error: `owned Pi runtime exited (${code ?? signal ?? "unknown"})` });
  }
  pendingResponses.clear();
  logLine(`pi exited code=${code} signal=${signal ?? "none"}`);
});

function handleRpcEvent(ev) {
  if (ev.type === "response") {
    const pending = pendingResponses.get(ev.id);
    if (pending) { pendingResponses.delete(ev.id); clearTimeout(pending.timer); pending.resolve(ev); }
    return;
  }
  switch (ev.type) {
    case "agent_start": agentRunning = true; break;
    case "agent_end": agentRunning = false; break;
    case "turn_end": {
      counters.mainTurns += 1;
      const totalTokens = ev?.message?.usage?.totalTokens;
      if (Number.isSafeInteger(totalTokens) && totalTokens >= 0
        && Number.isSafeInteger(counters.mainTokens + totalTokens)) {
        counters.mainTokens += totalTokens;
      } else {
        counters.mainTokenUsageComplete = false;
      }
      break;
    }
    case "tool_execution_start": {
      // args live ONLY on the start event; end events carry result (no args).
      if (toolCallArgs.size >= MAX_RECORDED_TOOL_CALLS) runtimeLoggingViolation = true;
      else toolCallArgs.set(ev.toolCallId, captureToolCallArgs(ev));
      break;
    }
    case "tool_execution_end": {
      const text = ev.result?.content?.map((c) => c.text ?? "").join("\n") ?? "";
      if (counters.toolCalls.length >= MAX_RECORDED_TOOL_CALLS) {
        runtimeLoggingViolation = true;
        toolCallArgs.delete(ev.toolCallId);
        break;
      }
      counters.toolCalls.push({
        name: ev.toolName,
        isError: !!ev.isError,
        args: toolCallArgs.get(ev.toolCallId) ?? "{}",
        resultSnippet: redactLogText(text).slice(0, 500),
        details: ev.result?.details ? redactLogText(JSON.stringify(ev.result.details)).slice(0, 700) : null,
      });
      toolCallArgs.delete(ev.toolCallId);
      break;
    }
    case "extension_error": {
      const safeError = redactLogText(JSON.stringify(ev));
      if (counters.extensionErrors.length < MAX_RECORDED_EXTENSION_ERRORS) counters.extensionErrors.push(safeError.slice(0, 500));
      else runtimeLoggingViolation = true;
      logLine(`extension_error: ${safeError.slice(0, 300)}`);
      break;
    }
    case "extension_ui_request": {
      if (ev.method === "notify") {
        const safeMessage = redactLogText(String(ev.message ?? ""));
        if (counters.notifications.length < MAX_RECORDED_NOTIFICATIONS) counters.notifications.push(safeMessage);
        else runtimeLoggingViolation = true;
        logLine(`notify: ${safeMessage.split("\n")[0].slice(0, 220)}`);
      } else if (["confirm", "select", "input", "editor"].includes(ev.method)) {
        // Dialog methods block until answered. Safe default: decline/cancel.
        if (counters.dialogs.length < MAX_RECORDED_DIALOGS) counters.dialogs.push(redactLogText(JSON.stringify(ev)).slice(0, 300));
        else runtimeLoggingViolation = true;
        logLine(`DIALOG (auto-declined): ${ev.method} ${redactLogText(String(ev.title ?? "")).slice(0, 120)}`);
        const response = { type: "extension_ui_response", id: ev.id };
        if (ev.method === "confirm") response.confirmed = false;
        else response.cancelled = true;
        piProc.stdin.write(JSON.stringify(response) + "\n");
      }
      break;
    }
    default: break; // message_*, queue_update, compaction_*, etc.
  }
}

async function getState() {
  const res = await sendRpc({ type: "get_state" });
  return res.success ? res.data : null;
}

/** Send a prompt only when the agent is idle; retry through transient "already processing". */
async function sendPromptWhenIdle(text) {
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    if (stopRequested) return false;
    const gs = await getState();
    if (gs && !gs.isStreaming && gs.pendingMessageCount === 0) {
      const res = await sendRpc({ type: "prompt", message: text });
      if (res.success) return true;
      if (!/already processing/i.test(JSON.stringify(res))) {
        logLine(`prompt rejected: ${JSON.stringify(res).slice(0, 200)}`);
        return false;
      }
    }
    await sleep(1500 + attempt * 500);
  }
  logLine(`sendPromptWhenIdle gave up: ${text.slice(0, 80)}`);
  return false;
}

/** Send a prompt, then wait for its agent run to fully stop (or for no run to start). */
async function promptAndWait(text, timeoutMs = 240_000) {
  const sent = await sendPromptWhenIdle(text);
  if (!sent) return false;
  const until = Math.min(Date.now() + timeoutMs, DEADLINE);
  let sawRun = false;
  let quietSince = Date.now();
  while (!stopRequested && Date.now() < until) {
    if (agentRunning) { sawRun = true; quietSince = Date.now(); }
    else {
      if (sawRun && Date.now() - quietSince > 4000) return true;      // run ended and settled
      if (!sawRun && Date.now() - quietSince > 12_000) return true;   // command-like prompt: no run started
    }
    await sleep(500);
  }
  logLine(`promptAndWait timeout: ${text.slice(0, 80)}`);
  return false;
}

/**
 * Wait for a notify that arrives AFTER fromIndex. The index MUST be captured
 * before the triggering sendRpc: extension-command notifies are emitted before
 * the command response, so they are already in the array when sendRpc resolves
 * (run 6 spammed 25 authorize requests matching against a stale index).
 */
async function waitForNotifyFrom(fromIndex, re, timeoutMs) {
  const until = Math.min(Date.now() + timeoutMs, DEADLINE);
  while (!stopRequested && Date.now() < until) {
    const hit = counters.notifications.slice(fromIndex).find((n) => re.test(n));
    if (hit) return hit;
    await sleep(400);
  }
  return null;
}

// ── Goal under test ───────────────────────────────────────────────────
// The typed fixture always names two disjoint exact paths. C2 therefore has a
// real partitionable graph; C3 can run the two Implementers concurrently; C4
// can gate and deliver both captured patches. The all-on goal consumes the
// delivered files directly, so no later model-authored commit can move HEAD
// beyond the exact merge-delivery SHA being certified.
const featureReviewTasksPrompt = [
  {
    id: FEATURE_MATRIX_REVIEW_TASK_IDS[0],
    role: "Security reviewer",
    model: "zai/glm-5.2",
    task: "Adversarially review this tiny repository for security, policy-bypass, unsafe-effect, and path-scope risks. Return the required typed findings JSON.",
  },
  {
    id: FEATURE_MATRIX_REVIEW_TASK_IDS[1],
    role: "Architecture/Ousterhout advisor",
    model: "zai/glm-5.2",
    task: "Independently review this tiny repository for coupling and operational-complexity risks. Return the required typed architecture JSON.",
  },
];
const featureCalibrationTasksPrompt = [
  {
    id: FEATURE_MATRIX_CALIBRATION_TASK_IDS[0],
    role: "Implementer",
    model: "zai/glm-5.2",
    task: "In the isolated worker worktree, create calibration-a.tmp containing exactly one line: calibration-a. Return the required typed implementation result and complete promptly.",
    allowedPaths: ["calibration-a.tmp"],
  },
  {
    id: FEATURE_MATRIX_CALIBRATION_TASK_IDS[1],
    role: "Implementer",
    model: "zai/glm-5.2",
    task: "In the isolated worker worktree, create calibration-b.tmp containing exactly one line: calibration-b. Return the required typed implementation result and complete promptly.",
    allowedPaths: ["calibration-b.tmp"],
  },
];
const featurePlanPrompt = JSON.stringify({
  id: FEATURE_MATRIX_PLAN_ID,
  version: 1,
  createdAt: startedAt,
  tasks: [
    {
      id: "feature-a",
      title: "Create feature-a.txt containing exactly one line: alpha",
      dependsOn: [],
      satisfies: [],
      allowedPaths: [{ kind: "exact", path: "feature-a.txt" }],
      requiredCapabilities: [],
      checks: [{ id: "check-a", name: "feature-a exact content", required: true, command: { executable: "grep", argv: ["-qx", "alpha", "feature-a.txt"] } }],
      rollback: "remove feature-a.txt",
      risk: "low",
    },
    {
      id: "feature-b",
      title: "Create feature-b.txt containing exactly one line: beta",
      dependsOn: [],
      satisfies: [],
      allowedPaths: [{ kind: "exact", path: "feature-b.txt" }],
      requiredCapabilities: [],
      checks: [{ id: "check-b", name: "feature-b exact content", required: true, command: { executable: "grep", argv: ["-qx", "beta", "feature-b.txt"] } }],
      rollback: "remove feature-b.txt",
      risk: "low",
    },
  ],
});

const OFF_MATRIX_GOAL = [
  "Verify the existing seed README without making any tracked repository change while proving that disabled C1-C4 features remain inert.",
  "Work FAST, do exactly the listed actions, and end every phase with goal_report_phase_result whose summary is under 60 words.",
  "research: call goal_repo_context at most once (mode list_files on .), then report.",
  "plan: call goal_update_task_plan once with items",
  "[{\"id\":\"verify-seed\",\"title\":\"Verify the tracked seed README without changing it\",\"status\":\"in_progress\"}];",
  "then report without proposing or dispatching feature work.",
  "The production harness stops at the kernel-observed implement boundary.",
  "Do not call any subagent, shard, shell, write, edit, git, or network tool in any phase.",
  "runId is the [HARNESS_META] runId.",
].join(" ");

const BASE_GOAL = [
  "Create a file hello.txt in the repository root containing exactly one line: ok",
  "Work FAST: do exactly what is listed per phase and nothing more (no extra reads,",
  "NEVER use the write or edit tools — use goal_shell for every command), and always",
  "end each phase with goal_report_phase_result whose summary is UNDER 60 WORDS",
  "(the external judge reads these summaries; keep them tiny and factual).",
  "research: at most one goal_repo_context call (mode list_files on .), then report.",
  ...(featureDepth > 0 ? [
    `plan: (1) call goal_subagent ONCE with mode="parallel", concurrency=2, and tasks=${JSON.stringify(featureReviewTasksPrompt)};`,
    "Do not continue until both parallel tasks return.",
    ...(featureDepth >= 3 ? [
      `(2) call goal_subagent ONCE with mode="parallel", concurrency=2, and tasks=${JSON.stringify(featureCalibrationTasksPrompt)};`,
      "Do not continue until both real Implementer calibration tasks return; their completed usage calibrates HEFT.",
    ] : []),
  ] : ["plan:"]),
  `${featureDepth >= 3 ? "(3)" : featureDepth > 0 ? "(2)" : "(1)"} call goal_update_task_plan once with items`,
  "[{\"id\":\"task-1\",\"title\":\"Create hello.txt with ok\",\"status\":\"in_progress\"},{\"id\":\"task-2\",\"title\":\"Run real check on hello.txt\",\"status\":\"pending\"}];",
  `(${featureDepth >= 3 ? "4" : featureDepth > 0 ? "3" : "2"}) call goal_post_shards ONCE with plan=${featurePlanPrompt};`,
  `(${featureDepth >= 3 ? "5" : featureDepth > 0 ? "4" : "3"}) report.`,
  "implement: (1) goal_shell command: bash -c \"printf 'ok\\n' > hello.txt\" ;",
  "(2) goal_update_task_plan marking task-1 completed and task-2 in_progress; (3) report.",
  "validate: (1) goal_shell command: bash -c \"test -f hello.txt && grep -qx ok hello.txt && echo REAL-CHECK-PASS\" ;",
  "(2) goal_shell: with bash -c and printf, write .pi/iterative-goal/runs/<runId>/cycles/1/validate/verification-results.jsonl",
  "containing exactly two JSON lines: {\"id\":\"tests\",\"name\":\"Tests\",\"status\":\"PASS\",\"exitCode\":0,\"artifact\":\"tests.txt\"}",
  "and {\"id\":\"gates\",\"name\":\"Gates\",\"status\":\"PASS\",\"exitCode\":0,\"artifact\":\"gates.txt\"} (status PASS only because the real check exited 0);",
  "(3) goal_update_task_plan marking task-2 completed; (4) report honestly.",
  "NOTE: goal_shell takes executable-plus-argv (no shell operators like && or > outside bash -c;",
  "runId in paths is the [HARNESS_META] runId). Do NOT attempt the long harness validation script verbatim.",
].join(" ");

const ALL_ON_GOAL = [
  "Deliver feature-a.txt containing exactly alpha and feature-b.txt containing exactly beta through the typed two-shard production path.",
  "Work FAST: do exactly what is listed per phase and nothing more (no extra reads,",
  "NEVER use the write or edit tools in the coordinator — the scheduled isolated Implementers own both writes), and always",
  "end each phase with goal_report_phase_result whose summary is UNDER 60 WORDS.",
  "research: at most one goal_repo_context call (mode list_files on .), then report.",
  `plan: (1) call goal_subagent ONCE with mode="parallel", concurrency=2, and tasks=${JSON.stringify(featureReviewTasksPrompt)};`,
  "Do not continue until both parallel tasks return.",
  `(2) call goal_subagent ONCE with mode="parallel", concurrency=2, and tasks=${JSON.stringify(featureCalibrationTasksPrompt)};`,
  "Do not continue until both real Implementer calibration tasks return; their completed usage calibrates HEFT.",
  "(3) call goal_update_task_plan once with items",
  "[{\"id\":\"feature-a\",\"title\":\"Deliver feature-a.txt with alpha\",\"status\":\"in_progress\"},{\"id\":\"feature-b\",\"title\":\"Deliver feature-b.txt with beta\",\"status\":\"in_progress\"}];",
  `(4) call goal_post_shards ONCE with plan=${featurePlanPrompt};`,
  "(5) report. The enabled runtime sharder, scheduler, and merge-back hooks execute before the implement prompt.",
  "implement: (1) goal_shell command: bash -c \"test -f feature-a.txt && grep -qx alpha feature-a.txt && test -f feature-b.txt && grep -qx beta feature-b.txt && echo DELIVERED-SHARDS-PASS\" ;",
  "(2) only if that real command exits 0, goal_update_task_plan marking feature-a and feature-b completed; (3) report.",
  "validate: (1) repeat the same real goal_shell check;",
  "(2) goal_shell: with bash -c and printf, write .pi/iterative-goal/runs/<runId>/cycles/1/validate/verification-results.jsonl",
  "containing exactly two JSON lines: {\"id\":\"tests\",\"name\":\"Tests\",\"status\":\"PASS\",\"exitCode\":0,\"artifact\":\"tests.txt\"}",
  "and {\"id\":\"gates\",\"name\":\"Gates\",\"status\":\"PASS\",\"exitCode\":0,\"artifact\":\"gates.txt\"} (PASS only because both exact-content checks exited 0);",
  "(3) report honestly. Do not make any tracked write after the merge delivery.",
  "NOTE: goal_shell takes executable-plus-argv; runId is the [HARNESS_META] runId.",
].join(" ");

const GOAL = offMatrixMode ? OFF_MATRIX_GOAL : featureDepth >= 4 ? ALL_ON_GOAL : BASE_GOAL;
const CRITERION = offMatrixMode
  ? "The runtime reaches the implement boundary with README.md unchanged at the seed commit after the requested parallel review is demoted to sequential workers and exactly one typed plan proposal produces no shard, claim, patch, merge, or tracked-file effect."
  : featureDepth >= 4
    ? "feature-a.txt contains exactly the line 'alpha', feature-b.txt contains exactly the line 'beta', and both grep -qx checks exit 0."
    : "hello.txt exists containing exactly the line 'ok' and the command grep -qx ok hello.txt exits 0.";

// ── Run-state helpers ─────────────────────────────────────────────────
const igRoot = path.join(repoDir, ".pi", "iterative-goal");
function activeRunId() {
  const lock = readJson(path.join(igRoot, "active-run.json"));
  return lock?.activeRunId ?? lock?.runId ?? null;
}
function runState() {
  const runId = activeRunId();
  if (!runId) return null;
  const raw = readJson(path.join(igRoot, "runs", runId, "state.json"));
  // state.json is a PersistenceEnvelope { version, state, updatedAt }.
  return raw?.state ?? raw ?? null;
}
function runDir() {
  const runId = activeRunId();
  return runId ? path.join(igRoot, "runs", runId) : null;
}
function validateResults(cycle) {
  const dir = runDir();
  const p = dir ? path.join(dir, "cycles", String(cycle), "validate", "verification-results.jsonl") : "";
  const lines = p ? readJsonl(p) : [];
  return {
    exists: !!p && fs.existsSync(p),
    lines,
    allPass: lines.length > 0 && lines.every((l) => l.status === "PASS"),
    hasFail: lines.some((l) => l.status !== "PASS"),
  };
}

function featureProfileReady(state) {
  if (!state || state.status !== "running") return false;
  if (featureDepth === 0) {
    const featureEventTypes = new Set([
      "subagent_started",
      "subagent_finished",
      "shard_plan_proposed",
      "shard_posted",
      "shard_claimed",
      "shard_completed",
      "shard_failed",
      "merge_proposed",
      "merge_verified",
    ]);
    const dir = runDir();
    const events = dir ? readJsonl(path.join(dir, "events.jsonl")) : [];
    const tasks = state?.swarm?.tasks ?? [];
    return ["implement", "validate"].includes(state?.phase)
      && tasks.length === 0
      && (state?.shards?.plans ?? []).length === 0
      && (state?.shards?.claims ?? []).length === 0
      && (state?.shards?.merges ?? []).length === 0
      && events.every((event) => !featureEventTypes.has(event?.type ?? event?.kind))
      && gitOutput(repoDir, ["rev-parse", "HEAD"]) === seedHeadSha
      && gitOutput(repoDir, ["status", "--porcelain=v1"]) === "";
  }
  const tasks = state?.swarm?.tasks ?? [];
  const expectedTaskIds = [
    ...FEATURE_MATRIX_REVIEW_TASK_IDS,
    ...(featureDepth >= 3 ? FEATURE_MATRIX_CALIBRATION_TASK_IDS : []),
    ...(featureDepth >= 3 ? FEATURE_MATRIX_SCHEDULER_TASK_IDS : []),
  ];
  const observedTaskIds = tasks.map((task) => task?.taskId).filter((taskId) => typeof taskId === "string");
  if (tasks.length !== expectedTaskIds.length
    || new Set(observedTaskIds).size !== expectedTaskIds.length
    || !expectedTaskIds.every((taskId) => observedTaskIds.includes(taskId))
    || tasks.some((task) => task?.status !== "completed" || typeof task?.finishedAt !== "string")) return false;
  if (featureDepth === 1) return true;
  const plan = [...(state?.shards?.plans ?? [])].reverse().find((candidate) => candidate.id === FEATURE_MATRIX_PLAN_ID);
  if (plan?.decision !== "fan_out" || plan?.shards?.length !== 2) return false;
  if (featureDepth === 2) return true;
  const claims = (state?.shards?.claims ?? []).filter((claim) => claim.planId === FEATURE_MATRIX_PLAN_ID);
  const completedClaims = new Map(claims.filter((claim) => claim.status === "completed").map((claim) => [claim.shardId, claim]));
  if (completedClaims.size !== 2 || [...completedClaims.values()].some((claim) => typeof claim.patchArtifactPath !== "string")) return false;
  if (featureDepth === 3) return true;
  const verifiedMerges = (state?.shards?.merges ?? []).filter((merge) => merge.planId === FEATURE_MATRIX_PLAN_ID && merge.status === "verified");
  if (verifiedMerges.length !== 2) return false;
  const finalMerge = verifiedMerges.at(-1);
  const head = gitOutput(repoDir, ["rev-parse", "HEAD"]);
  return typeof finalMerge?.integrationCommitSha === "string" && finalMerge.integrationCommitSha === head;
}

// ── Main sequence ─────────────────────────────────────────────────────
let midRunRefusal = null;   // denial while the evaluator had not accepted (branch A)
let midRunAttempted = false; // one-shot guard for the mid-run authorize attempt
let preFixupRefusal = null; // denial before the commit/regen fix-ups (branch B)
let releaseAuth = null;
let branch = "unknown";
let aggregateBudgetExceeded = false;
let runtimeLoggingViolation = false;
let runtimeProvenanceViolation = null;
let evidenceCaptureViolation = null;
let cycleCapViolation = null;
let featureWorkerTokens = 0;
let featureWorkerTokenUsageComplete = true;
let featureEvidence = null;
let piTermination = null;
let runtimeCommandNames = [];

async function main() {
  // 0. Extension inventory in the real runtime.
  const cmdRes = await sendRpc({ type: "get_commands" });
  const commandNames = (cmdRes.data?.commands ?? []).map((c) => c.name);
  runtimeCommandNames = [...commandNames].sort();
  logLine(`registered commands (${commandNames.length}): ${commandNames.sort().join(", ")}`);
  for (const required of ["goal-start", "goal-status", "goal-authorize-release"]) {
    if (!commandNames.includes(required)) fail("s1", `extension command /${required} not registered in real runtime`);
  }
  evid("s1", `get_commands lists goal-* commands: ${commandNames.filter((n) => n.startsWith("goal-")).sort().join(", ") || "NONE"}`);

  // 1. Goal start.
  logLine("sending /goal-start ...");
  const startRes = await sendRpc({ type: "prompt", message: `/goal-start ${GOAL} #criterion: ${CRITERION}` });
  if (!startRes.success) { fail("s1", `goal-start prompt rejected: ${JSON.stringify(startRes).slice(0, 200)}`); return; }
  const started = await (async () => {
    const until = Math.min(Date.now() + 60_000, DEADLINE);
    while (!stopRequested && Date.now() < until) { const s = runState(); if (s?.runId) return s; await sleep(1000); }
    return null;
  })();
  if (!started) { fail("s1", "no run state appeared after /goal-start"); return; }
  const runId = started.runId;
  logLine(`run started: ${runId}`);
  evid("s1", `run ${runId} created; .pi/iterative-goal/runs/${runId}/ exists in the temp repo`);

  // 2. Drive the loop: nudge stranded followUp phase prompts until the run settles.
  let lastCycle = 1;
  let idleSince = null;
  let driveDone = null;
  while (!overDeadline("drive loop")) {
    const state = runState();
    if (state) {
      if (state.cycle !== lastCycle) { lastCycle = state.cycle; logLine(`cycle advanced to ${lastCycle}`); }
      if (state.cycle > opts.maxCycles) {
        driveDone = `cycle cap ${opts.maxCycles} reached`;
        cycleCapViolation = `observed cycle ${state.cycle} above cap ${opts.maxCycles}`;
        break;
      }
      if (["succeeded", "completed_external_blockers", "paused_by_user", "pending_approval", "blocked_external"].includes(state.status)) {
        driveDone = `status=${state.status}`;
        break;
      }
      if (!agentRunning && featureProfileReady(state)) {
        driveDone = `feature profile ${opts.featureProfile} reached its kernel-owned terminal proof boundary`;
        break;
      }
      // Mid-run release refusal (branch A): evaluator has not accepted yet.
      // One-shot: the denial notify is emitted BEFORE the command response, so
      // capture the notify index before sending (run 6 spammed 25 attempts
      // matching against a post-response index).
      if (!midRunAttempted && (
        (state.phase === "plan" && state.evaluator?.lastVerdict?.goal_met !== true)
        || (state.cycle >= 2 && state.evaluator?.lastVerdict && state.evaluator.lastVerdict.goal_met !== true)
      )) {
        midRunAttempted = true;
        logLine(`requesting /goal-authorize-release mid-run in ${state.phase} (expect refusal)...`);
        const idx = counters.notifications.length;
        await sendRpc({ type: "prompt", message: "/goal-authorize-release" });
        midRunRefusal = await waitForNotifyFrom(idx, /Release authorization denied|Release authorized/i, 10_000);
        if (midRunRefusal && /denied/i.test(midRunRefusal)) {
          evid("s6", `mid-run /goal-authorize-release at cycle ${state.cycle}: ${midRunRefusal.split("\n").join(" | ").slice(0, 300)}`);
        } else if (midRunRefusal) {
          note("s6", `mid-run authorize unexpectedly succeeded: ${midRunRefusal.split("\n")[0]}`);
        } else note("s6", "mid-run authorize produced no notify within 10s");
      }
    }
    if (counters.mainTurns >= opts.maxModelCalls) {
      aggregateBudgetExceeded = true;
      driveDone = `active run exhausted the main-session response ceiling ${opts.maxModelCalls}`;
      logLine(`${driveDone}; terminating the exact owned Pi process`);
      try { piProc.kill("SIGTERM"); } catch { /* already exited */ }
      break;
    }
    if (agentRunning) {
      idleSince = null;
    } else {
      if (idleSince === null) idleSince = Date.now();
      const idleFor = Date.now() - idleSince;
      if (idleFor > opts.nudgeAfterMs) {
        const gs = await getState();
        if (gs?.isStreaming) {
          idleSince = null; // evaluator or a fresh run started mid-check
        } else if (gs && gs.pendingMessageCount > 0) {
          counters.nudges += 1;
          logLine(`nudge #${counters.nudges}: ${gs.pendingMessageCount} queued message(s) stranded in the followUp queue — sending "Continue." to drain`);
          await sendRpc({ type: "prompt", message: "Continue." });
          idleSince = null;
        } else if (idleFor > 45_000) {
          counters.nudges += 1;
          logLine(`stall nudge #${counters.nudges}: nothing queued but run still active — recovery prompt`);
          await sendRpc({ type: "prompt", message: "Continue." });
          idleSince = null;
        }
      }
    }
    await sleep(1000);
  }
  logLine(`drive loop ended: ${driveDone ?? "deadline"}; cycles seen: ${lastCycle}`);
  const finalState = runState();
  const finalCycle = finalState?.cycle ?? lastCycle;
  branch = finalCycle >= 2 ? "A (multi-cycle: evaluator rejected cycle 1)" : "B (single-cycle)";
  logLine(`branch: ${branch}; final status: ${finalState?.status}`);
  const dir = runDir();
  counters.judgeVerdicts = readJsonl(path.join(dir ?? "", "evaluator-verdicts.jsonl")).length;

  if (featureEvidenceRequired) {
    const eventTypes = [...new Set(readJsonl(path.join(dir ?? "", "events.jsonl"))
      .map((event) => event.type ?? event.kind).filter(Boolean))].sort();
    logLine(`feature-profile event types: ${eventTypes.join(", ")}`);
    fs.writeFileSync(path.join(evidenceDir, "event-types.json"), JSON.stringify(eventTypes, null, 2));
    return;
  }

  // 3. Scenario assertions from the run state (s1/s2/s3 + gate evidence for s4).
  const eventsPath = path.join(dir ?? "", "events.jsonl");
  const events = () => readJsonl(eventsPath);
  const eventTypes = [...new Set(events().map((e) => e.type ?? e.kind).filter(Boolean))].sort();
  logLine(`events.jsonl types: ${eventTypes.join(", ")}`);
  fs.writeFileSync(path.join(evidenceDir, "event-types.json"), JSON.stringify(eventTypes, null, 2));

  if (events().some((e) => e.type === "run_created")) {
    pass("s1", "run_created event present");
    evid("s1", `events.jsonl holds ${events().length} events / ${eventTypes.length} distinct types`);
  } else fail("s1", "run_created event missing from events.jsonl");
  const phasesPrompted = ["research", "plan", "implement", "validate"].filter((p) =>
    events().some((e) => (e.kind === "phase_started" || e.kind === "next_phase_started") && e.phase === p));
  evid("s1", `phase attempts started in the real runtime: ${phasesPrompted.join(" → ") || "none"}`);

  // s2 typed plan.
  const shardEvent = events().find((e) => e.type === "shard_plan_proposed");
  const shardCalls = counters.toolCalls.filter((t) => t.name === "goal_post_shards");
  const shardOk = shardCalls.find((t) => !t.isError && !/REJECTED/i.test(t.resultSnippet));
  if (shardEvent || shardOk) {
    pass("s2", "typed plan posted and accepted");
    if (shardEvent) evid("s2", `shard_plan_proposed event: plan ${shardEvent.entry?.plan?.id ?? "?"} with ${shardEvent.entry?.plan?.tasks?.length ?? "?"} task(s)`);
    if (shardOk) evid("s2", `goal_post_shards tool result: ${shardOk.resultSnippet.split("\n")[0].slice(0, 200)}`);
  } else if (shardCalls.length > 0) {
    fail("s2", `goal_post_shards called ${shardCalls.length}x but every call was rejected: ${shardCalls[0].resultSnippet.slice(0, 200)}`);
  } else fail("s2", "model never called goal_post_shards during the plan phase");
  if (events().some((e) => e.type === "task_plan_updated")) evid("s2", "task_plan_updated event present (durable checklist)");

  // s3 brokered shell.
  const shellOk = counters.toolCalls.filter((t) => t.name === "goal_shell" && !t.isError && !/SAFETY BLOCK/i.test(t.resultSnippet));
  if (shellOk.length > 0) {
    pass("s3", `${shellOk.length} brokered goal_shell execution(s) allowed`);
    evid("s3", `goal_shell allowed, e.g. args: ${shellOk[0].args.slice(0, 140)}`);
  } else fail("s3", "no successful goal_shell execution observed");
  if (events().some((e) => e.type === "attestation_recorded")) evid("s3", "attestation_recorded event present (signed shell evidence)");

  // s4 gate evidence so far.
  const cyclesDir = path.join(dir ?? "", "cycles");
  const cyclesPresent = fs.existsSync(cyclesDir)
    ? fs.readdirSync(cyclesDir).map((d) => Number(d)).filter(Number.isFinite).sort((a, b) => a - b)
    : [];
  for (const c of cyclesPresent) {
    const r = validateResults(c);
    if (r.hasFail) evid("s4", `gate FAILURE evidence: cycle ${c} verification-results.jsonl has non-PASS lines (${r.lines.map((l) => `${l.id}=${l.status}`).join("; ")})`);
    if (r.allPass) evid("s4", `cycle ${c} verification-results.jsonl all-PASS (${r.lines.map((l) => `${l.id}=${l.status}`).join("; ")})`);
  }
  const verdicts = readJsonl(path.join(dir ?? "", "evaluator-verdicts.jsonl"));
  if (verdicts.some((v) => v.goal_met === false)) evid("s4", `evaluator verdict goal_met=false recorded (${verdicts.filter((v) => v.goal_met === false).length}x)`);
  if (finalState?.status === "succeeded" || verdicts.some((v) => v.goal_met === true)) evid("s4", "evaluator verdict goal_met=true recorded");

  // 4. Release authorization attempt #1 — BEFORE any fix-up. In branch B this is
  //    the refusal (dirty tree / FAIL jsonl); in branch A it is bonus evidence.
  if (overDeadline("authorize#1")) return;
  logLine("requesting /goal-authorize-release (pre-fixup; refusal expected)...");
  const idx1 = counters.notifications.length;
  await sendRpc({ type: "prompt", message: "/goal-authorize-release" });
  const first = await waitForNotifyFrom(idx1, /Release authorization denied|Release authorized|Release authorization failed/i, 15_000);
  if (first && /denied/i.test(first)) {
    preFixupRefusal = first;
    evid("s6", `pre-fixup /goal-authorize-release refused: ${first.split("\n").join(" | ").slice(0, 400)}`);
  } else if (first && /authorized/i.test(first)) {
    releaseAuth = runState()?.releaseAuthorization ?? null;
    note("s6", `pre-fixup authorize already succeeded (gates passed earlier than expected): ${first.split("\n")[0]}`);
  } else {
    note("s6", `pre-fixup authorize produced no verdict notify (${first ?? "timeout"})`);
  }

  // 5. Fix-ups for the release gate: all-PASS results + committed tree.
  if (overDeadline("fixups")) return;
  const finalResults = validateResults(finalCycle);
  if (!finalResults.allPass) {
    logLine(`final cycle (${finalCycle}) verification-results.jsonl missing/not-all-PASS — directed regeneration via goal_shell`);
    const recoveryChecks = featureDepth >= 4
      ? "(check id tests: grep -qx alpha feature-a.txt ; check id gates: grep -qx beta feature-b.txt)"
      : "(check id tests: test -f hello.txt ; check id gates: grep -qx ok hello.txt)";
    await promptAndWait([
      "The goal loop has finished; the run is closed. Do exactly this and nothing else, then reply DONE:",
      "using the goal_shell tool with executable bash and argv starting with -c, re-run the two real validation checks",
      `${recoveryChecks} and OVERWRITE the file`,
      `.pi/iterative-goal/runs/${runId}/cycles/${finalCycle}/validate/verification-results.jsonl`,
      "so it contains exactly one JSON line per check, each like",
      `{"id":"tests","name":"Tests","status":"PASS","exitCode":0,"artifact":".pi/iterative-goal/runs/${runId}/cycles/${finalCycle}/validate/tests.txt"}`,
      "with status PASS only when the command exits 0 (otherwise FAIL with the real exit code), and write each check's combined output to its artifact path.",
      "Do not run anything else.",
    ].join(" "), 180_000);
    const regen = validateResults(finalCycle);
    if (regen.allPass) evid("s4", `gate SUCCESS evidence: cycle ${finalCycle} verification-results.jsonl regenerated all-PASS via goal_shell (${regen.lines.map((l) => `${l.id}=${l.status}`).join("; ")})`);
    else note("s4", `regeneration left results: exists=${regen.exists} lines=${regen.lines.map((l) => `${l.id}=${l.status}`).join(";") || "none"}`);
  }
  const porcelain = () => gitOutput(repoDir, ["status", "--porcelain"]);
  if (porcelain() !== "") {
    const trackedGoalPaths = featureDepth >= 4 ? ["feature-a.txt", "feature-b.txt"] : ["hello.txt"];
    logLine(`directed goal_git add+commit of ${trackedGoalPaths.join(", ")} ...`);
    await promptAndWait([
      "Do exactly this and nothing else, then reply DONE: call the goal_git tool with action=\"add\",",
      `paths=${JSON.stringify(trackedGoalPaths)}, purpose="stage smoke goal output"; then call goal_git with action="commit",`,
      `message="test: add ${trackedGoalPaths.join(" and ")} smoke goal output", purpose="commit smoke goal output for the release gate".`,
    ].join(" "), 180_000);
  }
  const treeClean = porcelain() === "";
  logLine(`git tree clean: ${treeClean}`);
  if (!treeClean) note("s7", "working tree still dirty after commit attempt — release gate will refuse");

  // 6. Release authorization attempt #2 — AFTER gates pass. Expect success.
  if (!releaseAuth?.id && !overDeadline("authorize#2")) {
    logLine("requesting /goal-authorize-release (post-fixup; success expected)...");
    const idx2 = counters.notifications.length;
    await sendRpc({ type: "prompt", message: "/goal-authorize-release" });
    const second = await waitForNotifyFrom(idx2, /Release authorization denied|Release authorized|Release authorization failed/i, 15_000);
    if (second && /authorized/i.test(second)) {
      releaseAuth = runState()?.releaseAuthorization ?? null;
      evid("s7", `notify: "${second.split("\n")[0]}"`);
    } else {
      fail("s7", `expected release success, got: ${(second ?? "(no notify)").split("\n").join(" | ").slice(0, 400)}`);
    }
  }
  if (releaseAuth?.id) {
    pass("s7", `release authorization issued: ${releaseAuth.id}`);
    const authEvent = events().find((e) => e.type === "release_authorization_updated" && e.authorization?.id === releaseAuth.id);
    if (authEvent) evid("s7", `release_authorization_updated event present (headSha=${String(releaseAuth.headSha).slice(0, 12)}, allowedAction=${releaseAuth.allowedAction})`);
    else note("s7", "release_authorization_updated event not found in events.jsonl (state.json carries the record)");
  } else if (scenarios.get("s7").status === "PENDING") {
    fail("s7", "no release authorization recorded in state.json");
  }

  // 7. create_pr dry-run ONLY.
  if (releaseAuth?.id && !overDeadline("create_pr dry-run")) {
    const refsBefore = runGit(repoDir, ["show-ref"]).stdout;
    await promptAndWait([
      "Do exactly this and nothing else, then reply DONE: call the goal_git tool once with",
      `action="create_pr", dryRun=true, releaseAuthorizationId="${releaseAuth.id}",`,
      `title="test: ${featureDepth >= 4 ? "two-shard delivery" : "hello.txt smoke goal"}", purpose="production runtime confirmation dry-run PR".`,
      "This is a DRY RUN: never call gh, never push, never open a real PR.",
    ].join(" "), 180_000);
    const prCall = counters.toolCalls.find((t) => t.name === "goal_git" && /create_pr/.test(t.args) && /"dryRun":true/.test(t.args));
    const prText = prCall?.resultSnippet ?? "";
    const refsAfter = runGit(repoDir, ["show-ref"]).stdout;
    const remotes = gitOutput(repoDir, ["remote", "-v"]);
    if (prCall && !prCall.isError && /PR dry-run authorized/i.test(prText)) {
      pass("s8", "create_pr dry-run authorized; gh never invoked (dry-run path returns before gh)");
      evid("s8", `goal_git create_pr returned "${prText.split("\n")[0]}" (details.dryRun=true)`);
    } else {
      fail("s8", `dry-run create_pr failed: ${(prText || "(goal_git create_pr call not observed)").split("\n")[0].slice(0, 240)}`);
    }
    if (refsBefore === refsAfter && remotes === "") evid("s8", "git refs unchanged and no remote configured — nothing pushed, no PR opened");
    else fail("s8", `git refs changed or a remote appeared (remotes: ${remotes || "none"})`);
  } else if (!releaseAuth?.id) note("s8", "skipped: no release authorization id available");

  // 8. Adversarial review creation via the review tooling (reviewer subagent).
  if (!overDeadline("adversarial review")) {
    logLine(`directed goal_subagent Security reviewer dispatch${featureDepth > 0 ? " as a two-worker C1 parallel batch" : ""} ...`);
    const reviewPrompt = featureDepth > 0
      ? [
          "Do exactly this and nothing else, then reply DONE: call goal_subagent ONCE with mode=\"parallel\", concurrency=2, and tasks=",
          JSON.stringify([
            {
              id: FEATURE_MATRIX_REVIEW_TASK_IDS[0],
              role: "Security reviewer",
              model: "zai/glm-5.2",
              task: "Adversarially review this tiny repository and its recent changes for security issues, policy bypasses, unsafe shell usage, and path-scope escapes. Return the required typed findings JSON.",
            },
            {
              id: FEATURE_MATRIX_REVIEW_TASK_IDS[1],
              role: "Architecture/Ousterhout advisor",
              model: "zai/glm-5.2",
              task: "Independently review this tiny repository and recent changes for module-boundary, coupling, and operational-complexity risks. Return the required typed architecture JSON.",
            },
          ]),
          ". Do not call any other tool.",
        ].join(" ")
      : [
          "Do exactly this and nothing else, then reply DONE: call the goal_subagent tool once with a single task:",
          "role=\"Security reviewer\", model=\"zai/glm-5.2\",",
          "task=\"Adversarially review this tiny repository and its recent change (hello.txt containing 'ok') for security issues,",
          "policy bypasses, unsafe shell usage, and path-scope escapes. Return the typed findings JSON required by your output schema.\"",
        ].join(" ");
    await promptAndWait(reviewPrompt, 360_000);
    const started5 = events().find((e) => e.type === "subagent_started"
      && (featureDepth > 0
        ? e.task?.taskId === FEATURE_MATRIX_REVIEW_TASK_IDS[0]
        : /Security reviewer/i.test(JSON.stringify(e.task ?? {}))));
    // The pool may restart a crashed subprocess: subagent_finished then appears
    // once with status=failed (process_restart) and again with status=completed.
    // Judge by the completed record when present (run 7 evidence).
    const finishes5 = events().filter((e) => e.type === "subagent_finished" && e.taskId === started5?.task?.taskId);
    const finished5 = finishes5.find((e) => e.status === "completed") ?? finishes5[0] ?? null;
    const restartedNote = finishes5.length > 1 ? ` (pool recorded ${finishes5.length - 1} prior terminal episode(s))` : "";
    const subCall = counters.toolCalls.find((t) => t.name === "goal_subagent");
    if (started5 && finished5) {
      if (finished5.status === "completed") {
        pass("s5", "Security reviewer subagent dispatched and completed");
        evid("s5", `subagent_started (role=Security reviewer) + subagent_finished (status=completed${finished5.usage?.turns ? `, turns=${finished5.usage.turns}` : ""})${restartedNote} in events.jsonl`);
      } else {
        fail("s5", `reviewer subagent finished with status=${finished5.status}${finished5.error ? ` (${String(finished5.error).slice(0, 160)})` : ""}`);
      }
    } else if (subCall) {
      fail("s5", `goal_subagent called but ledger events missing (started=${!!started5}, finished=${!!finished5}); result: ${subCall.resultSnippet.split("\n")[0].slice(0, 200)}`);
    } else fail("s5", "model never called goal_subagent");
    if (subCall && /findings|verdict/i.test(subCall.resultSnippet)) {
      evid("s5", `reviewer output includes findings/verdict: ${(subCall.resultSnippet.match(/[^\n]*(verdict|findings)[^\n]*/i) ?? [""])[0].slice(0, 200)}`);
    }
  }
}

// ── s6/s4 final evaluation ────────────────────────────────────────────
function finalizeScenarios() {
  const anyDenial = counters.notifications.find((n) => /Release authorization denied/i.test(n));
  const refusal = midRunRefusal ?? preFixupRefusal ?? anyDenial;
  if (scenarios.get("s6").status === "PENDING") {
    if (refusal) {
      pass("s6", "release authorization refused before gates passed");
      if (!scenarios.get("s6").evidence.length) evid("s6", `denial: ${refusal.split("\n").join(" | ").slice(0, 300)}`);
    } else fail("s6", "no release-authorization refusal was observed");
  }
  const s4 = scenarios.get("s4");
  if (s4.status === "PENDING") {
    const failureSide = s4.evidence.some((e) => /FAILURE evidence|goal_met=false/i.test(e)) || !!refusal;
    const successSide = s4.evidence.some((e) => /SUCCESS evidence|all-PASS|goal_met=true/i.test(e)) || scenarios.get("s7").status === "PASS";
    if (refusal) evid("s4", `release gate refusal (failure side): ${refusal.split("\n")[0].slice(0, 200)}`);
    if (failureSide && successSide) pass("s4", "gate observed failing and passing");
    else fail("s4", `incomplete gate transition (failureSide=${failureSide}, successSide=${successSide})`);
  }
}

function refreshSubagentTurnCount() {
  counters.subagentTurns = (runState()?.swarm?.tasks ?? []).reduce((sum, task) => {
    const turns = task?.usage?.turns;
    return sum + (typeof turns === "number" && Number.isFinite(turns) && turns >= 0 ? turns : 0);
  }, 0);
}

function finalizeFeatureProfile() {
  if (!featureEvidenceRequired) return;
  const state = runState() ?? {};
  const dir = runDir();
  const events = dir ? readJsonl(path.join(dir, "events.jsonl")) : [];
  const latestClaimByShard = new Map();
  for (const claim of state?.shards?.claims ?? []) {
    if (claim?.planId === FEATURE_MATRIX_PLAN_ID && typeof claim?.shardId === "string") {
      latestClaimByShard.set(claim.shardId, claim);
    }
  }
  const patchArtifacts = [];
  const patchContents = {};
  for (const [shardId, claim] of latestClaimByShard) {
    if (typeof claim.patchArtifactPath !== "string") continue;
    const absolute = path.resolve(repoDir, claim.patchArtifactPath);
    if (!absolute.startsWith(`${repoDir}${path.sep}`)) continue;
    try {
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 4 * 1024 * 1024) continue;
      const relative = path.relative(repoDir, absolute).replace(/\\/g, "/");
      const content = fs.readFileSync(absolute, "utf8");
      patchArtifacts.push({
        shardId,
        path: relative,
        bytes: stat.size,
        sha256: crypto.createHash("sha256").update(content).digest("hex"),
      });
      patchContents[relative] = content;
    } catch { /* missing/capture failure stays visible as a failed proof check */ }
  }
  patchArtifacts.sort((left, right) => left.shardId.localeCompare(right.shardId));
  const deliveredFiles = {};
  for (const name of ["feature-a.txt", "feature-b.txt"]) {
    const absolute = path.join(repoDir, name);
    try {
      const stat = fs.lstatSync(absolute);
      if (!stat.isSymbolicLink() && stat.isFile() && stat.size <= 1024) {
        deliveredFiles[name] = fs.readFileSync(absolute, "utf8");
      }
    } catch { /* absent files remain absent */ }
  }
  const deliveredHeadSha = gitOutput(repoDir, ["rev-parse", "HEAD"]);
  const commitParents = {};
  for (const merge of state?.shards?.merges ?? []) {
    const commitSha = merge?.status === "verified" ? merge?.integrationCommitSha : null;
    if (typeof commitSha !== "string" || !/^[a-f0-9]{40}$/.test(commitSha) || commitParents[commitSha]) continue;
    const ancestry = runGit(repoDir, ["rev-list", "--parents", "-n", "1", commitSha]);
    const fields = ancestry.stdout.trim().split(/\s+/);
    if (fields[0] === commitSha) commitParents[commitSha] = fields.slice(1);
  }
  const commitTreeProofs = [];
  if (featureDepth >= 4) {
    const plan = [...(state?.shards?.plans ?? [])].reverse()
      .find((candidate) => candidate?.id === FEATURE_MATRIX_PLAN_ID);
    const verifiedByShard = new Map((state?.shards?.merges ?? [])
      .filter((merge) => merge?.planId === FEATURE_MATRIX_PLAN_ID && merge?.status === "verified")
      .map((merge) => [merge.shardId, merge]));
    const artifactByShard = new Map(patchArtifacts.map((artifact) => [artifact.shardId, artifact]));
    let parentSha = seedHeadSha;
    for (const shard of plan?.shards ?? []) {
      const merge = verifiedByShard.get(shard?.id);
      const artifact = artifactByShard.get(shard?.id);
      if (!merge || !artifact || typeof patchContents[artifact.path] !== "string") continue;
      const proof = {
        method: "git-read-tree-apply-cached-write-tree",
        shardId: shard.id,
        parentSha,
        commitSha: merge.integrationCommitSha,
        patchArtifactPath: artifact.path,
        patchSha256: artifact.sha256,
        actualTreeSha: null,
        expectedTreeSha: null,
      };
      const scratchIndexDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ig-commit-tree-"));
      try {
        fs.chmodSync(scratchIndexDir, 0o700);
        const privateIndexEnv = { GIT_INDEX_FILE: path.join(scratchIndexDir, "index") };
        proof.actualTreeSha = gitOutput(repoDir, ["rev-parse", `${proof.commitSha}^{tree}`]);
        runGit(repoDir, ["read-tree", parentSha], { env: privateIndexEnv, stdio: "ignore" });
        runGit(repoDir, ["apply", "--cached", "--whitespace=nowarn", "--"], {
          env: privateIndexEnv,
          input: patchContents[artifact.path],
        });
        proof.expectedTreeSha = gitOutput(repoDir, ["write-tree"], { env: privateIndexEnv });
      } catch (error) {
        proof.error = error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000);
      } finally {
        fs.rmSync(scratchIndexDir, { recursive: true, force: true });
      }
      commitTreeProofs.push(proof);
      parentSha = merge.integrationCommitSha;
    }
  }
  const trackedWorktreeStatus = gitOutput(repoDir, ["status", "--porcelain=v1"]);
  const modelInvocations = typeof state?.runId === "string"
    ? (featureMatrixMode
        ? loadStrictFeatureMatrixInvocations(repoDir, state.runId)
        : loadModelInvocations(repoDir, state.runId))
      .map((invocation) => ({
        invocationId: invocation.invocationId,
        taskId: invocation.taskId,
        role: invocation.role,
        routeId: invocation.routeId,
        provider: invocation.provider,
        requestedModel: invocation.requestedModel,
        responseModel: invocation.responseModel,
        startedAt: invocation.startedAt,
        endedAt: invocation.endedAt,
        inputTokens: invocation.inputTokens,
        outputTokens: invocation.outputTokens,
        cacheReadTokens: invocation.cacheReadTokens,
        cacheWriteTokens: invocation.cacheWriteTokens,
        turns: invocation.turns,
        toolCallCount: invocation.toolCallCount,
        toolErrorCount: invocation.toolErrorCount,
        termination: invocation.termination,
        gateStatus: invocation.gateStatus,
        errorCode: invocation.errorCode,
      }))
    : [];
  const coordinatorInvocations = modelInvocations
    .filter((invocation) => invocation.taskId === null && invocation.role === "Coordinator")
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.invocationId.localeCompare(right.invocationId));
  const workerInvocations = modelInvocations
    .filter((invocation) => typeof invocation.taskId === "string")
    .sort((left, right) => left.taskId.localeCompare(right.taskId) || left.startedAt.localeCompare(right.startedAt));
  featureWorkerTokens = 0;
  featureWorkerTokenUsageComplete = true;
  for (const invocation of workerInvocations) {
    const components = [
      invocation.inputTokens,
      invocation.outputTokens,
      invocation.cacheReadTokens,
      invocation.cacheWriteTokens,
    ];
    const invocationTokens = components.reduce((sum, value) => sum + value, 0);
    if (components.every((value) => Number.isSafeInteger(value) && value >= 0)
      && Number.isSafeInteger(invocationTokens)
      && Number.isSafeInteger(featureWorkerTokens + invocationTokens)) {
      featureWorkerTokens += invocationTokens;
    } else {
      featureWorkerTokenUsageComplete = false;
    }
  }
  const workerTelemetryPath = path.join(evidenceDir, "worker-invocations.json");
  fs.writeFileSync(workerTelemetryPath, `${JSON.stringify({
    schema: "pi-iterative-goal.production-feature-worker-invocations.v1",
    runId: state?.runId ?? null,
    invocations: workerInvocations,
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  const coordinatorTelemetryPath = path.join(evidenceDir, "coordinator-invocations.json");
  fs.writeFileSync(coordinatorTelemetryPath, `${JSON.stringify({
    schema: "pi-iterative-goal.production-feature-coordinator-invocations.v1",
    runId: state?.runId ?? null,
    invocations: coordinatorInvocations,
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  featureEvidence = {
    ...evaluateFeatureProfileEvidence(opts.featureProfile, {
      events,
      state,
      patchArtifacts,
      patchContents,
      workerInvocations,
      coordinatorInvocations,
      mainTurns: counters.mainTurns,
      deliveredFiles,
      deliveredHeadSha,
      seedHeadSha,
      commitParents,
      commitTreeProofs,
      trackedWorktreeStatus,
      runtimeCommands: runtimeCommandNames,
      subagentToolCalls: counters.toolCalls
        .filter((call) => call?.name === "goal_subagent")
        .map((call) => ({ args: call.args, resultSnippet: call.resultSnippet, isError: call.isError })),
    }),
    featureMatrixId,
    seedHeadSha,
    deliveredHeadSha,
    commitParents,
    commitTreeProofs,
    patchArtifacts,
    workerInvocations,
    coordinatorInvocations,
    workerTelemetryPath: path.relative(repoRoot, workerTelemetryPath),
    coordinatorTelemetryPath: path.relative(repoRoot, coordinatorTelemetryPath),
    trackedWorktreeStatus,
    runtimeCommands: runtimeCommandNames,
    sourceProof: {
      headSha: runtimeProvenance.headSha,
      treeSha: runtimeProvenance.treeSha,
      extensionSha256: runtimeProvenance.extension.sha256,
      runtimeProvenanceDigest,
    },
    settings: featureSettings,
    judgeConfiguration: featureDepth > 0 ? {
      provider: "cerebras",
      model: "gpt-oss-120b",
      executionStatus: "NOT_EXECUTED_IN_FEATURE_BOUNDARY_RUN",
    } : null,
  };
  fs.writeFileSync(path.join(evidenceDir, "feature-profile.json"), JSON.stringify(featureEvidence, null, 2));
  if (featureEvidence.status === "PASS") {
    pass("s10", `${opts.featureProfile} cumulative feature profile passed ${featureEvidence.checks.length} kernel-derived checks`);
    for (const check of featureEvidence.checks) evid("s10", `${check.id}: ${check.detail}`);
  } else {
    fail("s10", `${opts.featureProfile} failed: ${featureEvidence.failedCheckIds.join(", ")}`);
    for (const check of featureEvidence.checks.filter((candidate) => !candidate.passed)) {
      note("s10", `FAIL: ${check.id}: ${check.detail}`);
    }
  }
}

// ── s9: outside-write + settings-diff assertions ──────────────────────
let tempParentChecked = false;
function checkTempParent() {
  if (tempParentChecked) return;
  tempParentChecked = true;
  const parentAfter = snapshotTree(tempParent);
  const parentDiff = diffSnapshots(parentBefore, parentAfter);
  const outsideRepoChanges = [...parentDiff.added, ...parentDiff.changed, ...parentDiff.removed]
    .filter((rel) => rel !== "repo" && !rel.startsWith(`repo${path.sep}`));
  if (outsideRepoChanges.length === 0) evid("s9", "temp parent dir contains only the disposable repo — no sibling writes");
  else fail("s9", `writes outside the disposable repo inside temp parent: ${outsideRepoChanges.join(", ")}`);
}
let piHomeStable = null;
function checkPiHome() {
  const diff = diffSnapshots(piHomeBefore, snapshotTree(piHome));
  const changes = [
    ...diff.added.map((entry) => `+${entry}`),
    ...diff.changed.map((entry) => `~${entry}`),
    ...diff.removed.map((entry) => `-${entry}`),
  ];
  piHomeStable = changes.length === 0;
  if (!piHomeStable) fail("s9", `unrelated Pi state changed: ${changes.slice(0, 10).join(", ")}`);
}
function finalizeOutsideWrites() {
  checkTempParent();
  checkPiHome(); // before pi shutdown
  if (piHomeStable) evid("s9", `bounded ~/.pi/agent census byte-identical after SHA-256 hashing every byte of ${piHomeSnapshotSummary.regularFiles} regular files (${piHomeSnapshotSummary.regularFileBytes} bytes); no new, changed, or removed entries`);
  const s9 = scenarios.get("s9");
  if (s9.status === "PENDING" && s9.evidence.length >= 2) pass("s9", "no outside writes, no settings drift");
}
function recheckPiHomeAfterShutdown() {
  checkPiHome(); // after pi shutdown handlers ran (SIGTERM could trigger writes)
  if (!piHomeStable && scenarios.get("s9").status === "PASS") {
    scenarios.get("s9").status = "FAIL";
    note("s9", "FAIL: pi home changed during shutdown");
  }
}

// ── Evidence bundle + cleanup ─────────────────────────────────────────
function saveEvidence() {
  const limits = { files: 0, bytes: 0 };
  const copyBounded = (source, destination) => {
    const descriptor = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error(`evidence source is not a bounded regular file: ${source}`);
      limits.files += 1;
      limits.bytes += stat.size;
      if (limits.files > 512 || limits.bytes > 64 * 1024 * 1024) throw new Error("evidence capture exceeds 512 files or 64 MiB");
      const bytes = fs.readFileSync(descriptor);
      if (bytes.length !== stat.size) throw new Error(`evidence source changed while reading: ${source}`);
      fs.writeFileSync(destination, bytes, { flag: "wx", mode: 0o600 });
    } finally {
      fs.closeSync(descriptor);
    }
  };
  try {
    const dir = runDir();
    if (!dir || !fs.existsSync(dir)) return;
    const dst = path.join(evidenceDir, "goal-state");
    fs.mkdirSync(dst, { recursive: true });
    for (const rel of ["events.jsonl", "state.json", "evaluator-verdicts.jsonl", "task-plan.jsonl", "latest.md"]) {
      const src = path.join(dir, rel);
      if (fs.existsSync(src)) copyBounded(src, path.join(dst, rel));
    }
    const cyclesDir = path.join(dir, "cycles");
    for (const cycleDir of fs.existsSync(cyclesDir) ? fs.readdirSync(cyclesDir) : []) {
      for (const phase of ["validate", "implement"]) {
        const phaseDir = path.join(cyclesDir, cycleDir, phase);
        if (!fs.existsSync(phaseDir)) continue;
        fs.mkdirSync(path.join(dst, "cycles", cycleDir, phase), { recursive: true });
        for (const f of fs.readdirSync(phaseDir)) {
          copyBounded(path.join(phaseDir, f), path.join(dst, "cycles", cycleDir, phase, f));
        }
      }
    }
  } catch (err) {
    evidenceCaptureViolation = err instanceof Error ? err.message : String(err);
    logLine(`evidence copy FAIL: ${evidenceCaptureViolation}`);
  }
}

function featureTokenBudgetSummary() {
  if (!featureBudget) return {
    status: "NOT_APPLICABLE",
    ceiling: null,
    observed: null,
    mainObserved: counters.mainTokens,
    workerObserved: featureWorkerTokens,
    usageComplete: counters.mainTokenUsageComplete && featureWorkerTokenUsageComplete,
  };
  const observed = counters.mainTokens + featureWorkerTokens;
  const usageComplete = counters.mainTokenUsageComplete && featureWorkerTokenUsageComplete;
  return {
    status: usageComplete && Number.isSafeInteger(observed) && observed <= featureBudget.maxTokens ? "PASS" : "FAIL",
    ceiling: featureBudget.maxTokens,
    observed,
    mainObserved: counters.mainTokens,
    workerObserved: featureWorkerTokens,
    usageComplete,
  };
}

function featureToolSurfaceSummary() {
  const observed = [...new Set(counters.toolCalls.map((call) => call?.name).filter((name) => typeof name === "string"))].sort();
  if (!featureToolAllowlist) return { status: "NOT_APPLICABLE", allowed: null, observed, unexpected: [] };
  const unexpected = observed.filter((name) => !featureToolAllowlist.includes(name));
  return {
    status: unexpected.length === 0 ? "PASS" : "FAIL",
    allowed: [...featureToolAllowlist],
    observed,
    unexpected,
  };
}

function printResults() {
  const totalModelCalls = counters.mainTurns + counters.judgeVerdicts + counters.subagentTurns;
  if (totalModelCalls > opts.maxModelCalls) aggregateBudgetExceeded = true;
  const requiredScenarioIds = featureEvidenceRequired ? new Set(["s9", "s10"]) : new Set(scenarios.keys());
  console.log("\n================ SCENARIO RESULTS ================");
  for (const s of scenarios.values()) {
    const label = requiredScenarioIds.has(s.id)
      ? (s.status === "PASS" ? "PASS" : s.status === "FAIL" ? "FAIL" : "PEND")
      : "N/A ";
    console.log(`${label} ${s.id} ${s.name}`);
    for (const e of s.evidence) console.log(`     evidence: ${e}`);
    for (const n of s.notes.filter((n) => n.startsWith("FAIL"))) console.log(`     ${n}`);
  }
  console.log("==================================================");
  console.log(`branch: ${branch}`);
  console.log(`model calls: main-session turns=${counters.mainTurns} (nudge turns=${counters.nudges}) + judge verdicts=${counters.judgeVerdicts} + subagent turns=${counters.subagentTurns} = ${totalModelCalls} total (ceiling: ${opts.maxModelCalls}; ${aggregateBudgetExceeded ? "FAIL" : "PASS"})`);
  console.log(`tool calls observed: ${counters.toolCalls.length}; extension errors: ${counters.extensionErrors.length}; dialogs auto-declined: ${counters.dialogs.length}`);
  const failed = [...scenarios.values()].filter((s) => requiredScenarioIds.has(s.id) && s.status !== "PASS");
  const tokenBudget = featureTokenBudgetSummary();
  const toolSurface = featureToolSurfaceSummary();
  const globalFailures = [
    ...(counters.extensionErrors.length > 0 ? ["extension_errors"] : []),
    ...(scenarios.get("s9")?.status !== "PASS" ? ["outside_write_or_pi_home"] : []),
    ...(piTermination?.status !== "PASS" ? ["owned_process_termination"] : []),
    ...(runtimeProvenanceViolation ? ["runtime_provenance"] : []),
    ...(evidenceCaptureViolation ? ["evidence_capture"] : []),
    ...(sourceRetentionViolation ? ["source_retention"] : []),
    ...(deadlineExceededAt ? [`deadline:${deadlineExceededAt}`] : []),
    ...(cycleCapViolation ? ["cycle_cap"] : []),
    ...(tokenBudget.status === "FAIL" ? ["token_budget"] : []),
    ...(toolSurface.status === "FAIL" ? ["feature_tool_surface"] : []),
  ];
  if (aggregateBudgetExceeded) console.log("BUDGET: FAIL (aggregate model-response ceiling exceeded)");
  if (tokenBudget.status !== "NOT_APPLICABLE") {
    console.log(`TOKENS: ${tokenBudget.status} (${tokenBudget.observed}/${tokenBudget.ceiling}; usageComplete=${tokenBudget.usageComplete})`);
  }
  if (toolSurface.status !== "NOT_APPLICABLE") {
    console.log(`TOOLS: ${toolSurface.status} (allowed=${toolSurface.allowed.join(",")}; unexpected=${toolSurface.unexpected.join(",") || "none"})`);
  }
  if (runtimeLoggingViolation) console.log("LOGGING: FAIL (RPC line exceeded the bounded parser limit)");
  const overallOk = failed.length === 0
    && globalFailures.length === 0
    && !aggregateBudgetExceeded
    && !runtimeLoggingViolation
    && interruptedSignal === null;
  const failureLabels = [
    ...failed.map((scenarioResult) => scenarioResult.id),
    ...(aggregateBudgetExceeded ? ["budget"] : []),
    ...(runtimeLoggingViolation ? ["logging"] : []),
    ...globalFailures,
    ...(interruptedSignal ? [`interrupted:${interruptedSignal}`] : []),
  ];
  console.log(overallOk ? "OVERALL: PASS" : `OVERALL: FAIL (${failureLabels.join(", ")})`);
  console.log(`evidence: ${evidenceDir}`);
  return overallOk;
}

async function shutdown() {
  // Signal only the exact RPC process we spawned. Pi's SIGTERM handler owns
  // shutdown of its tracked detached children and awaits extension teardown;
  // a broad process-name kill here could terminate workers from another repo
  // or operator session.
  let escalatedToKill = false;
  if (piProc.exitCode === null && piProc.signalCode === null) {
    if (!piGracefulSignalSent) {
      try { piGracefulSignalSent = piProc.kill("SIGTERM") || piGracefulSignalSent; }
      catch { /* already exited */ }
    }
    await Promise.race([piExited, sleep(12_000)]);
  }
  if (piProc.exitCode === null && piProc.signalCode === null) {
    escalatedToKill = true;
    try { piProc.kill("SIGKILL"); } catch { /* already exited */ }
    await Promise.race([piExited, sleep(2_000)]);
  }
  piTermination = {
    exitCode: piProc.exitCode,
    signal: piProc.signalCode,
    escalatedToKill,
    status: !escalatedToKill && (piProc.exitCode === 0 || piProc.signalCode === "SIGTERM") ? "PASS" : "FAIL",
  };
  if (!opts.keepTemp) {
    try { fs.rmSync(tempParent, { recursive: true, force: true }); logLine(`temp repo removed: ${tempParent}`); }
    catch (err) { logLine(`temp cleanup warning: ${err instanceof Error ? err.message : String(err)}`); }
  } else logLine(`--keep-temp: ${tempParent}`);
}

try {
  await main();
} catch (err) {
  logLine(`FATAL in main: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
}
refreshSubagentTurnCount();
try { finalizeFeatureProfile(); } catch (err) {
  if (featureEvidenceRequired) fail("s10", `feature evidence derivation failed: ${err instanceof Error ? err.message : String(err)}`);
  logLine(`finalizeFeatureProfile warning: ${err instanceof Error ? err.message : String(err)}`);
}
if (!featureEvidenceRequired) {
  try { finalizeScenarios(); } catch (err) { logLine(`finalizeScenarios warning: ${err instanceof Error ? err.message : String(err)}`); }
}
saveEvidence();
try { finalizeOutsideWrites(); } catch (err) { logLine(`finalizeOutsideWrites warning: ${err instanceof Error ? err.message : String(err)}`); }
await shutdown();
if (featureEvidenceRequired && piTermination?.status !== "PASS") {
  fail("s10", `owned Pi runtime did not stop within the SIGTERM grace period: ${JSON.stringify(piTermination)}`);
}
recheckPiHomeAfterShutdown();
try {
  assertRuntimeProvenanceUnchanged(repoRoot, runtimeProvenance);
} catch (error) {
  runtimeProvenanceViolation = error instanceof Error ? error.message : String(error);
  logLine(`runtime provenance FAIL: ${runtimeProvenanceViolation}`);
}
completeRawLogs();
stopSourceRetentionLoop();
try {
  const loopHealth = getManagedLogHealth();
  if (loopHealth?.blocked) throw new Error(loopHealth.reasons.join("; "));
  finalSourceRetention = runManagedLogRetention(repoRoot);
  if (finalSourceRetention.blocked) throw new Error(finalSourceRetention.reasons.join("; "));
} catch (error) {
  sourceRetentionViolation = error instanceof Error ? error.message : String(error);
  logLine(`source retention FAIL: ${sourceRetentionViolation}`);
}
const exitOk = printResults();
fs.writeFileSync(path.join(evidenceDir, "results.json"), JSON.stringify({
  startedAt,
  finishedAt: new Date().toISOString(),
  gitSha,
  runtimeProvenance,
  runtimeProvenanceDigest,
  runtimeProvenanceStatus: runtimeProvenanceViolation ? "FAIL" : "PASS",
  runtimeProvenanceViolation,
  deadlineExceededAt,
  cycleCapViolation,
  sourceRetention: {
    status: sourceRetentionViolation ? "FAIL" : "PASS",
    violation: sourceRetentionViolation,
    initial: initialSourceRetention,
    final: finalSourceRetention,
  },
  evidenceCaptureStatus: evidenceCaptureViolation ? "FAIL" : "PASS",
  evidenceCaptureViolation,
  branch,
  featureProfile: opts.featureProfile,
  featureMatrixId,
  featureEvidence,
  piTermination,
  interruptedSignal,
  requiredScenarioIds: featureEvidenceRequired ? ["s9", "s10"] : [...scenarios.keys()],
  scenarios: [...scenarios.values()],
  counters: {
    mainTurns: counters.mainTurns,
    nudges: counters.nudges,
    judgeVerdicts: counters.judgeVerdicts,
    subagentTurns: counters.subagentTurns,
    mainTokens: counters.mainTokens,
    mainTokenUsageComplete: counters.mainTokenUsageComplete,
    workerTokens: featureWorkerTokens,
    workerTokenUsageComplete: featureWorkerTokenUsageComplete,
  },
  modelCallBudget: {
    ceiling: opts.maxModelCalls,
    observed: counters.mainTurns + counters.judgeVerdicts + counters.subagentTurns,
    status: aggregateBudgetExceeded ? "FAIL" : "PASS",
  },
  tokenBudget: featureTokenBudgetSummary(),
  featureToolSurface: featureToolSurfaceSummary(),
  piHomeSnapshot: {
    ...piHomeSnapshotSummary,
    maximumEntries: MAX_TREE_SNAPSHOT_ENTRIES,
    maximumRegularFileBytes: MAX_TREE_SNAPSHOT_BYTES,
    stable: piHomeStable,
  },
  logging: {
    status: runtimeLoggingViolation ? "FAIL" : "PASS",
    rawRunPath: path.relative(repoRoot, rawDir),
    rotationBytes: 10 * 1024 * 1024,
    rotations: 3,
    maximumRpcLineBytes: MAX_RPC_LINE_BYTES,
    rpcEventStats,
  },
  launchEnvironmentKeys: Object.keys(childEnv).sort(),
  toolCalls: counters.toolCalls,
  notifications: counters.notifications,
  extensionErrors: counters.extensionErrors,
  overall: exitOk ? "PASS" : "FAIL",
}, null, 2));
process.removeListener("SIGINT", onSigint);
process.removeListener("SIGTERM", onSigterm);
process.exit(exitOk ? 0 : interruptedSignal ? 130 : 1);
