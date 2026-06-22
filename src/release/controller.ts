import * as crypto from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ReleaseAuthorization } from "../types.js";

export function hashJson(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function git(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string> {
  const result = await pi.exec("git", args, { cwd, timeout: 30_000 });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

export async function createReleaseAuthorization(params: {
  pi: ExtensionAPI;
  ctx: ExtensionContext | ExtensionCommandContext;
  runId: string;
  planHash: string;
  requirementsHash: string;
  gateVerdictHash: string;
  evidenceRootHash: string;
  ttlMs?: number;
}): Promise<ReleaseAuthorization> {
  const cwd = params.ctx.cwd;
  const repositoryId = await git(params.pi, cwd, ["remote", "get-url", "origin"]).catch(() => cwd);
  const headSha = await git(params.pi, cwd, ["rev-parse", "HEAD"]);
  const baseSha = await git(params.pi, cwd, ["merge-base", "HEAD", "origin/main"]).catch(async () => git(params.pi, cwd, ["rev-parse", "HEAD~0"]));
  const issuedAt = new Date();
  const auth: ReleaseAuthorization = {
    id: `rel-${issuedAt.getTime()}-${crypto.randomBytes(4).toString("hex")}`,
    runId: params.runId,
    repositoryId,
    baseSha,
    headSha,
    planHash: params.planHash,
    requirementsHash: params.requirementsHash,
    gateVerdictHash: params.gateVerdictHash,
    evidenceRootHash: params.evidenceRootHash,
    allowedAction: "git.pr.open",
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + (params.ttlMs ?? 10 * 60_000)).toISOString(),
  };
  return auth;
}

export async function validateReleaseAuthorization(params: {
  pi: ExtensionAPI;
  ctx: ExtensionContext | ExtensionCommandContext;
  authorization: ReleaseAuthorization | null | undefined;
  runId: string;
  expected?: {
    planHash: string;
    requirementsHash: string;
    gateVerdictHash: string;
    evidenceRootHash: string;
  };
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const auth = params.authorization;
  if (!auth) return { ok: false, reason: "Missing ReleaseAuthorization." };
  if (auth.runId !== params.runId) return { ok: false, reason: "ReleaseAuthorization runId does not match active run." };
  if (auth.allowedAction !== "git.pr.open") return { ok: false, reason: "ReleaseAuthorization does not allow PR creation." };
  if (new Date(auth.expiresAt).getTime() <= Date.now()) return { ok: false, reason: "ReleaseAuthorization expired." };
  if (params.expected) {
    if (auth.planHash !== params.expected.planHash) return { ok: false, reason: "ReleaseAuthorization plan hash is stale." };
    if (auth.requirementsHash !== params.expected.requirementsHash) return { ok: false, reason: "ReleaseAuthorization requirements hash is stale." };
    if (auth.gateVerdictHash !== params.expected.gateVerdictHash) return { ok: false, reason: "ReleaseAuthorization gate verdict hash is stale." };
    if (auth.evidenceRootHash !== params.expected.evidenceRootHash) return { ok: false, reason: "ReleaseAuthorization evidence hash is stale." };
  }
  const currentRepositoryId = await git(params.pi, params.ctx.cwd, ["remote", "get-url", "origin"]).catch(() => params.ctx.cwd);
  if (currentRepositoryId !== auth.repositoryId) return { ok: false, reason: "ReleaseAuthorization repository does not match current repository." };
  const currentBase = await git(params.pi, params.ctx.cwd, ["merge-base", "HEAD", "origin/main"]).catch(() => auth.baseSha);
  if (currentBase !== auth.baseSha) return { ok: false, reason: "ReleaseAuthorization base SHA is stale." };
  const currentHead = await git(params.pi, params.ctx.cwd, ["rev-parse", "HEAD"]);
  if (currentHead !== auth.headSha) return { ok: false, reason: `ReleaseAuthorization is stale: HEAD is ${currentHead}, authorized ${auth.headSha}.` };
  return { ok: true };
}
