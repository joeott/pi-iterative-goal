import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

export const MANAGED_LOG_SCHEMA = "pi-iterative-goal.log.v1" as const;
export const DEFAULT_LOG_ROTATE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_LOG_ROTATIONS = 3;
const LOG_LOCK_TIMEOUT_MS = 5_000;
const LOG_LOCK_STALE_MS = 60_000;
const MAX_METADATA_BYTES = 64 * 1024;

export interface ManagedLogEventV1 {
  schema: typeof MANAGED_LOG_SCHEMA;
  timestamp: string;
  sequence: number;
  pid: number;
  stream: string;
  scope: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  runId: string | null;
  phaseAttemptId: string | null;
  previousHash: string | null;
  hash: string;
  metadata?: Record<string, unknown>;
}

export interface ManagedLogWriteOptions {
  cwd?: string;
  runId?: string | null;
  phaseAttemptId?: string | null;
  level?: ManagedLogEventV1["level"];
  metadata?: Record<string, unknown>;
  required?: boolean;
  rotateBytes?: number;
  rotations?: number;
  path?: string;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function getManagedRoot(cwd = process.cwd()): string {
  return path.join(path.resolve(cwd), ".pi", "iterative-goal", "managed");
}

export function ensureManagedRoot(cwd = process.cwd()): string {
  const root = getManagedRoot(cwd);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Managed logging root is not a real directory: ${root}`);
  }
  const ownerPath = path.join(root, "owner.json");
  if (!fs.existsSync(ownerPath)) {
    writeAtomic(ownerPath, JSON.stringify({
      schema: "pi-iterative-goal.managed-root.v1",
      owner: "pi-iterative-goal",
      createdAt: new Date().toISOString(),
      repository: path.resolve(cwd),
    }, null, 2));
  }
  const ownerStat = fs.lstatSync(ownerPath);
  if (ownerStat.isSymbolicLink() || !ownerStat.isFile()) {
    throw new Error(`Managed logging owner marker is not a real file: ${ownerPath}`);
  }
  let owner: { schema?: unknown; owner?: unknown; repository?: unknown };
  try {
    owner = JSON.parse(fs.readFileSync(ownerPath, "utf8")) as typeof owner;
  } catch {
    throw new Error(`Managed logging owner marker is invalid: ${ownerPath}`);
  }
  if (owner.schema !== "pi-iterative-goal.managed-root.v1"
    || owner.owner !== "pi-iterative-goal"
    || owner.repository !== path.resolve(cwd)) {
    throw new Error(`Managed logging owner marker does not match this repository: ${ownerPath}`);
  }
  return root;
}

/** Redacts common credential forms and bounds every free-text field. */
export function redactLogText(value: string): string {
  return value
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+\/-]{12,}/gi, "$1 [REDACTED]")
    .replace(/\b((?:ZAI|Z_AI|FIREWORKS|OPENROUTER|CEREBRAS|ANTHROPIC|OPENAI)_API_KEY)\s*[=:]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\b(sk-or-v1-|sk-|fw_)[A-Za-z0-9._-]{12,}/g, "[REDACTED_API_KEY]")
    .replace(/([?&](?:api[_-]?key|token|secret)=)[^&\s]+/gi, "$1[REDACTED]")
    .slice(0, 8192);
}

function sanitizeMetadata(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[MAX_DEPTH]";
  if (typeof value === "string") return redactLogText(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeMetadata(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      // Redact credential/body fields, not observability counters such as
      // inputTokens, outputTokens, reasoningTokens, or sourceSha. Free-form
      // strings still pass through redactLogText below.
      if (/^(?:prompt|request|response|content|body|secret|api[_-]?key|authorization|cookie|credential|password|access[_-]?token|refresh[_-]?token|id[_-]?token|bearer[_-]?token)$/i.test(key)) {
        out[key] = "[REDACTED_FIELD]";
      } else {
        out[key] = sanitizeMetadata(item, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

function writeAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tempPath, content, { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

function readSidecarHead(filePath: string): { sequence: number; hash: string | null } {
  const headPath = `${filePath}.head.json`;
  try {
    const stat = fs.lstatSync(headPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 64 * 1024) {
      throw new Error("invalid chain-head sidecar");
    }
    const head = JSON.parse(fs.readFileSync(headPath, "utf8")) as { sequence?: unknown; hash?: unknown };
    const sequence = typeof head.sequence === "number" && Number.isSafeInteger(head.sequence) ? head.sequence : 0;
    const hash = typeof head.hash === "string" ? head.hash : null;
    return { sequence, hash };
  } catch {
    return { sequence: 0, hash: null };
  }
}

function readTailHead(filePath: string): { sequence: number; hash: string | null } {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0) return { sequence: 0, hash: null };
    const bytes = Math.min(stat.size, 256 * 1024);
    const buffer = Buffer.alloc(bytes);
    const descriptor = fs.openSync(filePath, "r");
    try { fs.readSync(descriptor, buffer, 0, bytes, stat.size - bytes); }
    finally { fs.closeSync(descriptor); }
    let text = buffer.toString("utf8");
    if (bytes < stat.size) text = text.slice(text.indexOf("\n") + 1);
    const line = text.split(/\r?\n/).filter(Boolean).at(-1);
    if (!line) return { sequence: 0, hash: null };
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event.schema !== MANAGED_LOG_SCHEMA
      || !Number.isSafeInteger(event.sequence)
      || Number(event.sequence) <= 0
      || typeof event.hash !== "string") return { sequence: 0, hash: null };
    const { hash, ...base } = event;
    const expected = crypto.createHash("sha256")
      .update(`${typeof base.previousHash === "string" ? base.previousHash : "GENESIS"}\n${JSON.stringify(base)}`)
      .digest("hex");
    if (expected !== hash) throw new Error(`Managed log tail hash is invalid: ${filePath}`);
    return { sequence: Number(event.sequence), hash };
  } catch (error) {
    if (error instanceof Error && /tail hash is invalid/.test(error.message)) throw error;
    return { sequence: 0, hash: null };
  }
}

function readChainHead(filePath: string): { sequence: number; hash: string | null } {
  const sidecar = readSidecarHead(filePath);
  const tail = readTailHead(filePath);
  if (sidecar.sequence === tail.sequence && sidecar.hash && tail.hash && sidecar.hash !== tail.hash) {
    throw new Error(`Managed log head conflicts with its active tail: ${filePath}`);
  }
  // A crash can occur after the append and before the atomic sidecar update;
  // recover from that valid tail while the interprocess lock is held.
  return tail.sequence > sidecar.sequence ? tail : sidecar;
}

function boundedMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizeMetadata(metadata) as Record<string, unknown>;
  const serialized = JSON.stringify(sanitized);
  if (Buffer.byteLength(serialized) <= MAX_METADATA_BYTES) return sanitized;
  return {
    truncated: true,
    originalBytes: Buffer.byteLength(serialized),
    sha256: crypto.createHash("sha256").update(serialized).digest("hex"),
  };
}

function acquireInterprocessLock(filePath: string): () => void {
  const lockPath = `${filePath}.lock`;
  const nonce = crypto.randomBytes(16).toString("hex");
  const started = Date.now();
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    try {
      const descriptor = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, nonce, createdAt: new Date().toISOString() }));
      } finally {
        fs.closeSync(descriptor);
      }
      return () => {
        try {
          const current = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { nonce?: unknown };
          if (current.nonce === nonce) fs.unlinkSync(lockPath);
        } catch { /* a missing/replaced lock is never deleted blindly */ }
      };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(lockPath);
      } catch (statError) {
        // The owner may have released between our EEXIST and lstat. Retry the
        // atomic create instead of turning normal contention into ENOENT.
        if (statError instanceof Error && "code" in statError && statError.code === "ENOENT") continue;
        throw statError;
      }
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Managed log lock is not a real file: ${lockPath}`);
      if (Date.now() - stat.mtimeMs > LOG_LOCK_STALE_MS) {
        let ownerPid: number | null = null;
        let ownerNonce: string | null = null;
        try {
          const owner = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: unknown; nonce?: unknown };
          ownerPid = Number.isSafeInteger(owner.pid) ? Number(owner.pid) : null;
          ownerNonce = typeof owner.nonce === "string" ? owner.nonce : null;
        } catch { /* malformed old lock is recoverable after the stale interval */ }
        let ownerAlive = false;
        if (ownerPid !== null) {
          try { process.kill(ownerPid, 0); ownerAlive = true; }
          catch { ownerAlive = false; }
        }
        if (!ownerAlive) {
          try {
            const current = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { nonce?: unknown };
            // Never unlink a replacement lock installed after the stale
            // snapshot. Malformed stale locks use a null identity and simply
            // fail closed at the bounded acquisition timeout.
            if (ownerNonce !== null && current.nonce === ownerNonce) fs.unlinkSync(lockPath);
          } catch { /* another contender may have recovered it */ }
          continue;
        }
      }
      if (Date.now() - started >= LOG_LOCK_TIMEOUT_MS) throw new Error(`Timed out acquiring managed log lock: ${lockPath}`);
      Atomics.wait(waiter, 0, 0, 10);
    }
  }
}

function ensureManagedTarget(root: string, filePath: string): void {
  const relative = path.relative(root, filePath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Managed log target escapes the owned root: ${filePath}`);
  }
  const realRoot = fs.realpathSync(root);
  const parent = path.dirname(filePath);
  const parentRelative = path.relative(root, parent);
  if (parentRelative.startsWith("..") || path.isAbsolute(parentRelative)) {
    throw new Error(`Managed log parent escapes the owned root: ${parent}`);
  }
  let cursor = root;
  for (const segment of parentRelative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(cursor);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      try {
        fs.mkdirSync(cursor, { mode: 0o700 });
      } catch (mkdirError) {
        // Another writer can create this shared log directory after our
        // lstat and before mkdir. EEXIST is ordinary contention; every other
        // error remains fail-closed. The lstat below still rejects a symlink
        // or non-directory installed by a competing/untrusted process.
        if (!(mkdirError instanceof Error && "code" in mkdirError && mkdirError.code === "EEXIST")) {
          throw mkdirError;
        }
      }
      stat = fs.lstatSync(cursor);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Managed log parent is not a real directory: ${cursor}`);
    }
  }
  const realParent = fs.realpathSync(parent);
  const realRelative = path.relative(realRoot, realParent);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error(`Managed log parent resolves outside the owned root: ${parent}`);
  }
  for (const target of [filePath, `${filePath}.head.json`, `${filePath}.lock`]) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(target);
    } catch (error) {
      // In particular, a healthy lock owner may release the lock between a
      // prior observation and this lstat. Absence is valid for every target
      // here because append/atomic-sidecar/lock creation all create their own
      // regular file; any other lstat failure is a real safety failure.
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Managed log target is not a real file: ${target}`);
    }
  }
}

function rotateManagedFile(filePath: string, rotateBytes: number, rotations: number): void {
  let size = 0;
  try { size = fs.statSync(filePath).size; } catch { return; }
  if (size < rotateBytes) return;
  const oldest = `${filePath}.${rotations}.gz`;
  if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
  for (let generation = rotations - 1; generation >= 1; generation -= 1) {
    const source = `${filePath}.${generation}.gz`;
    if (fs.existsSync(source)) fs.renameSync(source, `${filePath}.${generation + 1}.gz`);
  }
  const compressed = zlib.gzipSync(fs.readFileSync(filePath), { level: zlib.constants.Z_BEST_SPEED });
  fs.writeFileSync(`${filePath}.1.gz`, compressed, { mode: 0o600 });
  fs.truncateSync(filePath, 0);
}

export function appendManagedLog(
  stream: string,
  scope: string,
  message: string,
  options: ManagedLogWriteOptions = {},
): ManagedLogEventV1 {
  const cwd = options.cwd ?? process.cwd();
  const root = ensureManagedRoot(cwd);
  const safeStream = stream.replace(/[^A-Za-z0-9._-]/g, "-") || "events";
  const filePath = path.resolve(options.path ?? path.join(root, "logs", `${safeStream}.jsonl`));
  const required = options.required ?? process.env.PI_ITERATIVE_GOAL_LOG_REQUIRED === "1";
  try {
    ensureManagedTarget(root, filePath);
    const releaseLock = acquireInterprocessLock(filePath);
    try {
      rotateManagedFile(
        filePath,
        options.rotateBytes ?? positiveInteger(process.env.PI_ITERATIVE_GOAL_LOG_ROTATE_BYTES, DEFAULT_LOG_ROTATE_BYTES),
        options.rotations ?? DEFAULT_LOG_ROTATIONS,
      );
      const head = readChainHead(filePath);
      const sequence = head.sequence + 1;
      const base = {
        schema: MANAGED_LOG_SCHEMA,
        timestamp: new Date().toISOString(),
        sequence,
        pid: process.pid,
        stream: safeStream,
        scope: redactLogText(scope),
        level: options.level ?? "debug",
        message: redactLogText(message),
        runId: options.runId ?? process.env.PI_ITERATIVE_GOAL_RUN_ID ?? null,
        phaseAttemptId: options.phaseAttemptId ?? null,
        previousHash: head.hash,
        ...(options.metadata ? { metadata: boundedMetadata(options.metadata) } : {}),
      };
      const hash = crypto.createHash("sha256").update(`${head.hash ?? "GENESIS"}\n${JSON.stringify(base)}`).digest("hex");
      const event: ManagedLogEventV1 = { ...base, hash };
      fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
      writeAtomic(`${filePath}.head.json`, JSON.stringify({ sequence, hash, updatedAt: event.timestamp }));
      return event;
    } finally {
      releaseLock();
    }
  } catch (error) {
    if (required) throw error;
    return {
      schema: MANAGED_LOG_SCHEMA,
      timestamp: new Date().toISOString(),
      sequence: 0,
      pid: process.pid,
      stream: safeStream,
      scope: redactLogText(scope),
      level: options.level ?? "error",
      message: `logging_failed:${redactLogText(error instanceof Error ? error.message : String(error))}`,
      runId: options.runId ?? null,
      phaseAttemptId: options.phaseAttemptId ?? null,
      previousHash: null,
      hash: "",
    };
  }
}

export function logDebug(scope: string, message: string): void {
  appendManagedLog("debug", scope, message);
}
