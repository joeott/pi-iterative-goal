/**
 * Safety policies and command allowlists for the iterative-goal extension.
 *
 * Default-deny risky operations. "Never stop" does not mean
 * "do unsafe things forever."
 */

import type { SafetyCheckResult } from "./types.js";
import { commandSpecFromShellWords } from "./domain/verification.js";

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

const PACKAGE_INSTALL_PATTERNS: RegExp[] = [
  /\bnpm\s+(install|uninstall|update|ci|link|publish)\b/i,
  /\byarn\s+(add|remove|install|publish)\b/i,
  /\bpnpm\s+(add|remove|install|publish)\b/i,
  /\bpip\s+(install|uninstall)\b/i,
  /\bpip3\s+(install|uninstall)\b/i,
  /\bbrew\s+(install|uninstall|upgrade)\b/i,
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
  /^\s*uname\b/,
  /^\s*whoami\b/,
  /^\s*id\b/,
  /^\s*date\b/,
  /^\s*ps\b/,
  /^\s*top\b/,
  /^\s*htop\b/,
  /^\s*git\s+(status|log|diff|show|branch|remote)\b/i,
  /^\s*git\s+config\s+--get(?:\s|$)/i,
  /^\s*git\s+ls-/i,
  /^\s*npm\s+(list|ls|view|info|search|outdated|audit)\b/i,
  /^\s*yarn\s+(list|info|why|audit)\b/i,
  /^\s*node\s+--version\s*$/i,
  /^\s*python3?\s+--version\s*$/i,
  /^\s*jq\b/,
  /^\s*sed\s+-n/i,
  /^\s*rg\b/,
  /^\s*fd\b/,
  /^\s*bat\b/,
  /^\s*eza\b/,
  /^\s*go\s+(version|env|tool)\b/i,
  /^\s*cargo\s+(version|check|clippy|tree|metadata)\b/i,
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
  if (!SAFE_PATTERNS.some((p) => p.test(command))) return false;

  // SAFE_PATTERNS intentionally keeps the top-level allowlist compact, but a
  // matching executable is not sufficient: several nominally read-only tools
  // accept argv that writes files or launches arbitrary processes. Parse the
  // same direct-exec shape goal_shell uses and fail closed on those forms.
  const spec = commandSpecFromShellWords(command);
  if (!spec) return false;
  const executable = spec.executable.toLowerCase();
  const argv = spec.argv;

  if (executable === "find") {
    const sideEffectActions = new Set([
      "-delete",
      "-exec",
      "-execdir",
      "-ok",
      "-okdir",
      "-fls",
      "-fprint",
      "-fprint0",
      "-fprintf",
    ]);
    if (argv.some((arg) => sideEffectActions.has(arg.toLowerCase()))) return false;
  }

  if (executable === "sed") {
    // Covers -i, -i.bak, bundled forms such as -ni, and --in-place[=SUFFIX].
    if (argv.some((arg) => /^--in-place(?:=|$)/i.test(arg) || /^-[^-]*i/i.test(arg))) {
      return false;
    }
  }

  if (executable === "npm" && argv[0]?.toLowerCase() === "audit") {
    if (argv.slice(1).some((arg) => arg.toLowerCase() === "fix" || /^--fix(?:=|$)/i.test(arg))) {
      return false;
    }
  }

  if (executable === "rg") {
    if (argv.some((arg) => arg === "--pre" || arg.startsWith("--pre="))) return false;
  }

  return true;
}

/** Anything outside the narrow direct-exec read allowlist needs a capability. */
export function requiresOperatorApproval(command: string): boolean {
  return isDestructive(command) || !isSafeReadOnly(command);
}

export function isGitFinalization(command: string): boolean {
  return GIT_FINALIZATION_PATTERNS.some((p) => p.test(command));
}

export function isPackageInstallCommand(command: string): boolean {
  return PACKAGE_INSTALL_PATTERNS.some((p) => p.test(command));
}

export function checkCommand(
  command: string,
  allowDestructive: boolean,
  allowGitFinalization: boolean = false,
): SafetyCheckResult {
  const blocked = isAlwaysBlocked(command);
  if (!blocked.allowed) return blocked;

  if (isPackageInstallCommand(command)) {
    return {
      allowed: false,
      reason: `Package installation blocked. Route through an approved package.install capability and plan lockfile effects explicitly. Command: ${command.slice(0, 100)}`,
    };
  }

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
