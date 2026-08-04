#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createSigningState } from "../dist/cyber-runtime.js";
import { ensureManagedRoot } from "../dist/logging.js";
import {
  loadTrustedVerificationConfig,
  readTrustedVerificationReceipt,
  runTrustedVerification,
} from "../dist/trusted-verification.js";

function parseArgs(argv) {
  const options = { output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output" && argv[index + 1]) {
      options.output = path.resolve(argv[index + 1]);
      index += 1;
    } else {
      throw new Error("usage: run-trusted-head.mjs [--output <new-json-path>]");
    }
  }
  return options;
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function trustedGit(args, cwd) {
  return execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: os.tmpdir(),
      TMPDIR: os.tmpdir(),
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_NO_REPLACE_OBJECTS: "1",
    },
  });
}

function readBoundedRegularFileNoFollow(filePath, maximumBytes) {
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maximumBytes) {
      throw new Error("trusted verification receipt is not a bounded regular file");
    }
    const chunks = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1 - total));
      const count = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > maximumBytes) throw new Error("trusted verification receipt grew beyond its size limit");
      chunks.push(chunk.subarray(0, count));
    }
    return Buffer.concat(chunks, total);
  } finally {
    fs.closeSync(descriptor);
  }
}

function makeRunId() {
  return `trusted-head-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(4).toString("hex")}`;
}

const options = parseArgs(process.argv.slice(2));
const repositoryRoot = fs.realpathSync(trustedGit(["rev-parse", "--show-toplevel"], process.cwd()).trim());
const runId = makeRunId();
const runDirectory = path.join(repositoryRoot, ".pi", "iterative-goal", "runs", runId);
const state = {
  runId,
  cycle: 1,
  signing: createSigningState(runId),
  sandbox: { profile: "local_build" },
  attestations: [],
};
const stateManager = {
  getRunDir() {
    fs.mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
    return fs.realpathSync(runDirectory);
  },
  recordAttestation(attestation) {
    state.attestations.push(attestation);
  },
};

const config = loadTrustedVerificationConfig(repositoryRoot);
if (!config.enabled) throw new Error("committed trusted-verification policy is not enabled at HEAD");
const receipt = runTrustedVerification({ cwd: repositoryRoot, state, stateManager, config });
if (!receipt?.ok) {
  const summary = {
    ok: receipt?.ok,
    trackedTreeClean: receipt?.trackedTreeClean,
    sourceSha: receipt?.sourceSha,
    sourceShaAfter: receipt?.sourceShaAfter,
    validationSha: receipt?.validationSha,
    validationShaAfter: receipt?.validationShaAfter,
    results: receipt?.results?.map((result) => ({ id: result.id, status: result.status, detail: String(result.detail ?? "").slice(0, 200) })),
  };
  console.error("trusted verification receipt summary:", JSON.stringify(summary, null, 2));
  throw new Error("trusted verification did not certify HEAD");
}
const verifiedReceipt = readTrustedVerificationReceipt(repositoryRoot, state, stateManager);
if (!verifiedReceipt) throw new Error("fresh trusted verification receipt failed independent read-back validation");
const receiptPath = path.join(runDirectory, "cycles", "1", "validate", "trusted-verification-receipt.json");
const receiptBytes = readBoundedRegularFileNoFollow(receiptPath, 2 * 1024 * 1024);
const receiptSha256 = sha256(receiptBytes);
const attestation = state.attestations.find((item) => path.resolve(item.path) === path.resolve(receiptPath)
  && item.sha256 === receiptSha256);
if (!attestation) throw new Error("trusted verification receipt bytes no longer match the recorded attestation");

const proof = {
  schema: "pi-iterative-goal.trusted-head-proof.v1",
  createdAt: new Date().toISOString(),
  runId,
  sourceSha: receipt.sourceSha,
  sourceShaAfter: receipt.sourceShaAfter,
  checksHash: receipt.checksHash,
  resultsHash: receipt.resultsHash,
  sandbox: receipt.sandbox,
  supervisorHelperSha256: receipt.supervisorHelperSha256,
  supervisorRuntimeExecutable: receipt.supervisorRuntimeExecutable,
  dependencyMaterialization: receipt.dependencyMaterialization,
  dependencyBootstrapStatus: receipt.dependencyBootstrap?.status ?? null,
  results: receipt.results.map((result) => ({
    id: result.id,
    status: result.status,
    exitCode: result.exitCode,
    artifactSha256: result.artifactSha256,
    timedOut: result.timedOut,
    processContainment: result.processContainment,
  })),
  receipt: {
    path: path.relative(repositoryRoot, receiptPath),
    sha256: receiptSha256,
    signatureAlgorithm: state.signing.algorithm,
    signerKeyId: state.signing.keyId,
    publicKeySha256: sha256(state.signing.runPublicKey),
    publicKeyPem: state.signing.runPublicKey,
    cryptographicSignature: attestation.cryptographicSignature,
    provenanceAttestation: attestation.provenanceAttestation,
  },
  verifiedReadable: true,
  privateKeyPersisted: false,
};
const outputPath = options.output ?? path.join(
  ensureManagedRoot(repositoryRoot),
  "evidence",
  "trusted-head",
  `${runId}.json`,
);
fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
fs.writeFileSync(outputPath, `${JSON.stringify(proof, null, 2)}\n`, { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({
  status: "PASS",
  sourceSha: proof.sourceSha,
  backend: proof.sandbox.backend,
  results: proof.results.map((result) => `${result.id}:${result.status}`),
  proofPath: outputPath,
  proofSha256: sha256(fs.readFileSync(outputPath)),
}));
