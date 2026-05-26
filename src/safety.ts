/**
 * Safety policies and command allowlists for the iterative-goal extension.
 *
 * Default-deny risky operations. "Never stop" does not mean
 * "do unsafe things forever."
 */

import type { SafetyCheckResult } from "./types.js";

// ── Blocklist patterns (always blocked) ─────────────────────────────

const BLOCKED_PATTERNS: RegExp[] = [
  /rm\s+-rf/,
  /rm\s+-r\s+\//,
  /DROP\s+TABLE/i,
  /TRUNCATE\s+TABLE/i,
  /DELETE\s+FROM/i,
  /aws\s+s3\s+rm/,
  /aws\s+s3\s+sync(?!.*--dryrun)/,
  /kubectl\s+delete/,
  /terraform\s+apply(?!.*-auto-approve=false)/,
  /terraform\s+destroy/,
  /sudo\s/,
  /chmod\s+777/,
  />\s*\/dev\//,
  /mkfs\./,
  /dd\s+if=/,
  /:\(\)\s*\{/, // fork bomb
];

// ── Destructive patterns (blocked with allowDestructiveOps=false) ───

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\b/,
  /\brmdir\b/,
  /\bmv\b(?!.*--dry-run)/,
  /\bcp\b(?!.*--dry-run)/,
  /\bmkdir\b/,
  /\btouch\b/,
  /\bgit\s+(push|pull|merge|rebase|reset|stash|cherry-pick|revert|tag|init)/i,
  /\bgit\s+branch\s+-[dD]/i,
  /\bgit\s+checkout\s+(?!-b)/i,
  /\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
  /\byarn\s+(add|remove|install|publish)/i,
  /\bpnpm\s+(add|remove|install|publish)/i,
  /\bpip\s+(install|uninstall)/i,
  /\bbrew\s+(install|uninstall|upgrade)/i,
  /\bkill\b/,
  /\bpkill\b/,
  /\bkillall\b/,
];

// ── Safe read-only commands ──────────────────────────────────────────

const SAFE_PATTERNS: RegExp[] = [
  /^\s*cat\b/,
  /^\s*head\b/,
  /^\s*tail\b/,
  /^\s*grep\b/,
  /^\s*find\b/,
  /^\s*ls\b/,
  /^\s*pwd\b/,
  /^\s*echo\b/,
  /^\s*printf\b/,
  /^\s*wc\b/,
  /^\s*sort\b/,
  /^\s*uniq\b/,
  /^\s*diff\b/,
  /^\s*file\b/,
  /^\s*stat\b/,
  /^\s*du\b/,
  /^\s*df\b/,
  /^\s*tree\b/,
  /^\s*which\b/,
  /^\s*whereis\b/,
  /^\s*type\b/,
  /^\s*env\b/,
  /^\s*printenv\b/,
  /^\s*uname\b/,
  /^\s*whoami\b/,
  /^\s*id\b/,
  /^\s*date\b/,
  /^\s*ps\b/,
  /^\s*top\b/,
  /^\s*htop\b/,
  /^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
  /^\s*git\s+ls-/i,
  /^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
  /^\s*yarn\s+(list|info|why|audit)/i,
  /^\s*node\s+--version/i,
  /^\s*python\s+--version/i,
  /^\s*curl\s/i,
  /^\s*wget\s+-O\s*-/i,
  /^\s*jq\b/,
  /^\s*sed\s+-n/i,
  /^\s*awk\b/,
  /^\s*rg\b/,
  /^\s*fd\b/,
  /^\s*bat\b/,
  /^\s*eza\b/,
  /^\s*npx\s/,
  /^\s*go\s+(version|env|tool)/i,
  /^\s*cargo\s+(version|check|clippy|tree|metadata)/i,
  /^\s*cd\s/,
  /^\s*make\s+(-n|--dry-run)/i,
];

// ── Git finalization (allowed when allowGitFinalization=true) ────────

const GIT_FINALIZATION_PATTERNS: RegExp[] = [
  /\bgit\s+add\b(?!\s+-A)/i,
  /\bgit\s+commit\b/i,
  /\bgit\s+checkout\s+-b\b/i,
];

// ── Command classification ──────────────────────────────────────────

export function isAlwaysBlocked(command: string): SafetyCheckResult {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return {
        allowed: false,
        reason: `Command matched always-blocked pattern: ${pattern.source}. This operation cannot be performed by the automated goal loop. Route to external evaluator for operator decision.`,
      };
    }
  }
  return { allowed: true };
}

export function isDestructive(command: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
}

export function isSafeReadOnly(command: string): boolean {
  return SAFE_PATTERNS.some((p) => p.test(command));
}

export function isGitFinalization(command: string): boolean {
  return GIT_FINALIZATION_PATTERNS.some((p) => p.test(command));
}

export function checkCommand(
  command: string,
  allowDestructive: boolean,
  allowGitFinalization: boolean = false,
): SafetyCheckResult {
  const blocked = isAlwaysBlocked(command);
  if (!blocked.allowed) return blocked;

  if (!allowDestructive && isGitFinalization(command)) {
    if (allowGitFinalization) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `Git finalization blocked. Enable allowGitFinalization or produce a patch file instead (git diff > .pi/iterative-goal/final.patch). Command: ${command.slice(0, 100)}`,
    };
  }

  if (!allowDestructive && isDestructive(command)) {
    return {
      allowed: false,
      reason: `Destructive command blocked by safety policy. Enable allowDestructiveOps or route to operator. Command: ${command.slice(0, 100)}`,
    };
  }

  return { allowed: true };
}