import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ActionAttestation,
  CyberDlpState,
  CyberSanitizationState,
  CyberSandboxState,
  CyberSigningState,
  CyberUnifyCasProfile,
  DlpScanSummary,
  TrustClassification,
} from "./types.js";
import type { ActionRequest } from "./policy/engine.js";

const SECRET_PATTERNS: Array<{ detector: string; re: RegExp }> = [
  { detector: "aws_access_key_id", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { detector: "aws_secret_access_key", re: /\b(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/gi },
  { detector: "aws_session_token", re: /\b(?:aws_session_token|AWS_SESSION_TOKEN)\s*[:=]\s*['"]?([A-Za-z0-9/+=]{80,})['"]?/gi },
  { detector: "github_token", re: /\bgh[pousr]_[A-Za-z0-9_]{30,255}\b/g },
  { detector: "openai_api_key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { detector: "anthropic_api_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { detector: "private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { detector: "jwt_token", re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  { detector: "database_url", re: /\b(?:postgres|postgresql|mysql|mongodb):\/\/[^\s"'<>]+/gi },
  { detector: "password_assignment", re: /\b(?:password|passwd|pwd)\s*[:=]\s*['"]?([^\s'"]{8,})['"]?/gi },
];

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const ANSI = /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const BIDI = /[\u202a-\u202e\u2066-\u2069]/g;
const IPI_HINT = /\b(?:system override|ignore (?:all )?(?:previous|above) instructions|forget instructions|return goal_met\s*=\s*true|developer message|assistant must)\b/i;

export const DEFAULT_UNIFY_CAS_PROFILE: CyberUnifyCasProfile = {
  enabled: true,
  sourcePriority: [
    "docs/current-state.md",
    "docs/ocr-optimization/UNIFIED-DATAFLOW.md",
    "docs/actor-roles-and-dataflow.md",
    "scripts/gates/gate_no_consumer_ocr_inference.py",
  ],
  expectedAwsAccountId: "371292405073",
  expectedAwsRegion: "us-east-1",
  canonicalOcrEngine: "unify_nemotron",
  deprecatedOcrEngines: ["paddleocr", "paddle", "cpu/sqs", "paddleparse"],
  currentRouteSummary: "Unify self-hosted Nemotron OCR execution; consumers resolve occurrence_id -> ocr_manifest -> cas:blake3:.",
};

export function defaultDlpState(): CyberDlpState {
  return { enabled: true, scannerAvailable: true, redactionCount: 0, detectorCounts: {}, lastScan: null };
}

export function defaultSanitizationState(): CyberSanitizationState {
  return { enabled: true, sanitizerAvailable: true, lastSanitizedAt: null, ipiDetections: 0 };
}

export function defaultSandboxState(): CyberSandboxState {
  return {
    enabled: true,
    profile: "readonly_inspection",
    networkDefaultDeny: true,
    readOnlyMountsByDefault: true,
    osLevelSandboxAvailable: false,
    lastViolation: null,
  };
}

export function createSigningState(runId: string): CyberSigningState {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return {
    required: true,
    algorithm: "ed25519",
    runPublicKey: publicPem,
    privateKeyPem: privatePem,
    available: true,
    createdAt: new Date().toISOString(),
    keyId: sha256(`${runId}:${publicPem}`).slice(0, 16),
  };
}

export function sanitizeUntrustedText(
  text: string,
  source: string,
  classification: TrustClassification,
  maxBytes = 500_000,
): { wrapped: string; detectedIpi: boolean; sha256: string; truncated: boolean } {
  const buffer = Buffer.from(text, "utf8");
  const truncated = buffer.length > maxBytes;
  const sliced = truncated ? buffer.subarray(0, maxBytes).toString("utf8") : text;
  const normalized = sliced.normalize("NFC")
    .replace(ANSI, "")
    .replace(BIDI, "")
    .replace(CONTROL_CHARS, "");
  const detectedIpi = IPI_HINT.test(normalized);
  const digest = sha256(normalized);
  const body = truncated ? `${normalized}\n[TRUNCATED at ${maxBytes} bytes]` : normalized;
  return {
    wrapped: [
      `<UNTRUSTED_DATA source="${escapeAttr(source)}" sha256="${digest}" classification="${classification}">`,
      body,
      "</UNTRUSTED_DATA>",
    ].join("\n"),
    detectedIpi,
    sha256: digest,
    truncated,
  };
}

export function dlpScrubText(
  text: string,
  state: CyberDlpState,
): { text: string; summary: DlpScanSummary; state: CyberDlpState } {
  const detectorCounts: Record<string, number> = {};
  let nextOrdinal = state.redactionCount + 1;
  let redacted = text;

  for (const { detector, re } of SECRET_PATTERNS) {
    redacted = redacted.replace(re, (match: string, captured?: string) => {
      detectorCounts[detector] = (detectorCounts[detector] ?? 0) + 1;
      const secretValue = captured && captured.length > 0 ? captured : match;
      const token = `[REDACTED_SECRET_REF_${nextOrdinal}]`;
      nextOrdinal += 1;
      if (captured && match.includes(captured)) return match.replace(secretValue, token);
      return token;
    });
  }

  const detectedSecrets = Object.values(detectorCounts).reduce((sum, count) => sum + count, 0);
  const summary: DlpScanSummary = {
    scanId: `dlp-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
    scannedAt: new Date().toISOString(),
    detectedSecrets,
    detectorCounts,
  };
  const updated: CyberDlpState = {
    ...state,
    redactionCount: state.redactionCount + detectedSecrets,
    detectorCounts: mergeCounts(state.detectorCounts, detectorCounts),
    lastScan: summary,
  };
  return { text: redacted, summary, state: updated };
}

export function processModelVisibleText(params: {
  text: string;
  source: string;
  classification: TrustClassification;
  dlp: CyberDlpState;
  sanitizer: CyberSanitizationState;
}): {
  text: string;
  dlp: CyberDlpState;
  sanitizer: CyberSanitizationState;
  dlpSummary: DlpScanSummary;
  sourceHash: string;
  ipiDetected: boolean;
  truncated: boolean;
} {
  const sanitized = sanitizeUntrustedText(params.text, params.source, params.classification);
  const scrubbed = dlpScrubText(sanitized.wrapped, params.dlp);
  return {
    text: scrubbed.text,
    dlp: scrubbed.state,
    sanitizer: {
      ...params.sanitizer,
      lastSanitizedAt: new Date().toISOString(),
      ipiDetections: params.sanitizer.ipiDetections + (sanitized.detectedIpi ? 1 : 0),
    },
    dlpSummary: scrubbed.summary,
    sourceHash: sanitized.sha256,
    ipiDetected: sanitized.detectedIpi,
    truncated: sanitized.truncated,
  };
}

export function signBytes(bytes: string | Buffer, signing: CyberSigningState): string {
  if (!signing.available || !signing.privateKeyPem) throw new Error("Evidence signer unavailable.");
  const privateKey = crypto.createPrivateKey(signing.privateKeyPem);
  return crypto.sign(null, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), privateKey).toString("base64");
}

export function verifyActionAttestation(params: {
  attestation: ActionAttestation;
  publicKeyPem: string;
  artifactBytes?: string | Buffer;
}): {
  ok: boolean;
  signatureValid: boolean;
  statementDigestValid: boolean;
  artifactDigestValid: boolean | null;
  problems: string[];
} {
  const problems: string[] = [];
  const statement = params.attestation.provenanceAttestation as {
    subject?: Array<{ name?: string; digest?: { sha256?: string } }>;
    predicate?: {
      runId?: string;
      cycle?: number;
      phase?: string;
      createdAt?: string;
    };
  };
  const subject = statement.subject?.[0];
  const statementDigest = subject?.digest?.sha256;
  const statementDigestValid = statementDigest === params.attestation.sha256
    && subject?.name === params.attestation.path
    && statement.predicate?.runId === params.attestation.runId
    && statement.predicate?.cycle === params.attestation.cycle
    && statement.predicate?.phase === params.attestation.phase
    && statement.predicate?.createdAt === params.attestation.createdAt;
  if (!statementDigestValid) problems.push("attestation statement fields do not match envelope");

  let signatureValid = false;
  try {
    const publicKey = crypto.createPublicKey(params.publicKeyPem);
    signatureValid = crypto.verify(
      null,
      Buffer.from(JSON.stringify(params.attestation.provenanceAttestation)),
      publicKey,
      Buffer.from(params.attestation.cryptographicSignature, "base64"),
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) problems.push("attestation signature is invalid");

  let artifactDigestValid: boolean | null = null;
  if (params.artifactBytes !== undefined) {
    artifactDigestValid = sha256(params.artifactBytes) === params.attestation.sha256;
    if (!artifactDigestValid) problems.push("artifact bytes do not match attested sha256");
  }

  return {
    ok: statementDigestValid && signatureValid && artifactDigestValid !== false,
    signatureValid,
    statementDigestValid,
    artifactDigestValid,
    problems,
  };
}

export function attestAction(params: {
  runId: string;
  cycle: number;
  phase: string;
  artifactPath: string;
  action: ActionRequest;
  outputBytes: string | Buffer;
  dlpScanId: string | null;
  trustClassification: TrustClassification;
  signing: CyberSigningState;
  sandboxProfile?: string;
}): ActionAttestation {
  const outputSha256 = sha256(params.outputBytes);
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: params.artifactPath, digest: { sha256: outputSha256 } }],
    predicateType: "https://samu.legal/pi-iterative-goal/action/v1",
    predicate: {
      runId: params.runId,
      cycle: params.cycle,
      phase: params.phase,
      actionId: params.action.id,
      effect: params.action.effect,
      resource: params.action.resource,
      actor: params.action.actor,
      purpose: params.action.purpose,
      sandboxProfile: params.sandboxProfile ?? "unspecified",
      dlpScanId: params.dlpScanId,
      trustClassification: params.trustClassification,
      createdAt: new Date().toISOString(),
    },
  };
  const serialized = JSON.stringify(statement);
  return {
    artifactId: `art-${sha256(`${params.runId}:${params.artifactPath}:${outputSha256}`).slice(0, 16)}`,
    runId: params.runId,
    cycle: params.cycle,
    phase: params.phase,
    path: params.artifactPath,
    type: inferArtifactType(params.artifactPath),
    createdAt: statement.predicate.createdAt,
    sha256: outputSha256,
    cryptographicSignature: signBytes(serialized, params.signing),
    provenanceAttestation: statement,
    dlpScanId: params.dlpScanId,
    trustClassification: params.trustClassification,
  };
}

export function writeAttestationLine(runDir: string, attestation: ActionAttestation): void {
  fs.mkdirSync(runDir, { recursive: true });
  fs.appendFileSync(path.join(runDir, "attestations.jsonl"), `${JSON.stringify(attestation)}\n`);
}

export function assessCasUnifyCommand(command: string): string | null {
  const normalized = command.toLowerCase();
  if (/\bnpx\s+cdk\s+deploy\b|\bcdk\s+deploy\b/.test(normalized)) {
    return "Local CDK deploy is blocked. Use the approved GitHub Actions CDK wrapper after approval.";
  }
  if (/\baws\s+cloudformation\s+(deploy|update-stack|create-stack|delete-stack|execute-change-set)\b/.test(normalized)) {
    return "Direct CloudFormation mutation is blocked. Use the gated CI deploy path.";
  }
  if (/\baws\s+secretsmanager\s+get-secret-value\b/.test(normalized)) {
    return "Secret value reads are blocked. Use describe-secret or an approved ephemeral broker.";
  }
  if (/\bsubmit_backlog_batch\.py\b|\bpaddleparse\b|\bpaddleocr\b|\bcpu\s*ocr\b|\bsqs\s+ocr\b/.test(normalized)) {
    return "Deprecated Paddle/CPU/SQS OCR route is blocked for current operations; use Unify Nemotron resolver/CAS route.";
  }
  return null;
}

export function assertEvaluatorCyberPrereqs(params: {
  hasAllFourCurrentCycle: boolean;
  signing: CyberSigningState;
  dlp: CyberDlpState;
  sanitizer: CyberSanitizationState;
  attestations: ActionAttestation[];
}): string[] {
  const blockers: string[] = [];
  if (!params.hasAllFourCurrentCycle) blockers.push("Current cycle does not have all four phase results.");
  if (!params.signing.available || !params.signing.runPublicKey) blockers.push("Evidence signer unavailable.");
  if (!params.dlp.enabled || !params.dlp.scannerAvailable) blockers.push("DLP proxy unavailable.");
  if (!params.sanitizer.enabled || !params.sanitizer.sanitizerAvailable) blockers.push("IPI sanitizer unavailable.");
  if (params.attestations.length === 0) blockers.push("No signed runtime attestations are available.");
  return blockers;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function mergeCounts(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const merged = { ...a };
  for (const [key, value] of Object.entries(b)) merged[key] = (merged[key] ?? 0) + value;
  return merged;
}

function escapeAttr(value: string): string {
  return value.replace(/[&"]/g, (ch) => ch === "&" ? "&amp;" : "&quot;");
}

function inferArtifactType(artifactPath: string): ActionAttestation["type"] {
  const ext = path.extname(artifactPath).toLowerCase();
  if (ext === ".json") return "json";
  if (ext === ".jsonl") return "jsonl";
  if (ext === ".md") return "markdown";
  if (ext === ".diff" || ext === ".patch") return "diff";
  if (ext === ".log") return "log";
  if (ext === ".sarif") return "sarif";
  if (ext === ".xml") return "junit";
  return "text";
}
