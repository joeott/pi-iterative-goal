# pi-iterative-goal User Guide Sandbox Report

Generated: 2026-08-05T01:12:45.053Z

## Safety Boundary

- Real AWS mutations: no
- Real GitHub PR creation: no
- Cloud writes: no
- Runtime sandboxes: disposable temp repositories and mocked provider calls

## Results

| Check | Status | Summary |
| --- | --- | --- |
| `repo-validate` | PASS | `npm run validate` completed. |
| `html-static` | PASS | Internal anchors resolve and CSS/JS assets are local. |
| `source-inventory` | PASS | Guide command/tool inventory matches source registrations. |
| `extension-load-goal-shell` | PASS | Loaded dist extension and ran goal_shell in a disposable git repo. |
| `mock-aws-cli` | PASS | Mock AWS CLI preflight and read-only STS call used a temp repo and fake exec only. |
| `policy-negative-cases` | PASS | Package install, private URL, and PR without authorization are denied. |
| `provider-contracts` | PASS | Capability manifests validate; browser/MCP/vision fail closed without backends. |
| `stale-phase-write` | PASS | Stale phase output is rejected and recorded as ignored. |
| `visual-artifacts` | PASS | Desktop and mobile screenshots are present. |

## Evidence Notes

### repo-validate

Status: PASS

`npm run validate` completed.

```json
{
  "stdoutTail": "✓ workspace base SHA is immutable and verified\n✓ verified commit SHAs replay and exact attached-ref CAS promotion\n✓ same-SHA source branch switch is fail-closed\n✓ mutable integration-branch tampering cannot bypass ledgered chain proof\n✓ live/ambiguous integration worktree is preserved and refused\n✓ atomic integration lease refuses and preserves concurrent owner\n✓ scoped recovery reclaims a provably dead integration lease\n✓ exact dead-owner lease nonce permits safe fresh-worktree recovery\n\nWorkspace hardening smoke passed. ✓\n✓ lifecycle session_start/reload is attempt- and prompt-idempotent\n✓ repeated synthetic capture failure durably pauses and /goal-resume recovers\n✓ monitor traces rich run state and marks the 24-minute supervisor wake on tick four\n✓ private tmux monitor start/stop is idempotent, exact-owned, and never contacts default tmux\n\nLong-session lifecycle tests passed. ✓\n✓ hard agent budgets enforce turns/tokens/time, reject unpriced USD limits, preserve identity, and classify telemetry\nworker-containment: PASS (scoped custom tools, exact model, selected credential, tracked snapshots, no shell)\nmemory-budget: PASS (cmux contract, safe NODE_OPTIONS, pressure concurrency)\n"
}
```

### html-static

Status: PASS

Internal anchors resolve and CSS/JS assets are local.

```json
{
  "anchors": 13,
  "assetRefs": [
    "assets/guide.css",
    "assets/guide.js"
  ]
}
```

### source-inventory

Status: PASS

Guide command/tool inventory matches source registrations.

```json
{
  "commands": [
    "goal-start",
    "goal-status",
    "goal-pause",
    "goal-resume",
    "goal-repair-capabilities",
    "goal-finalize",
    "goal-reset",
    "goal-authorize-release",
    "goal-audit",
    "goal-replay",
    "goal-trace",
    "goal-dashboard"
  ],
  "tools": [
    "goal_shell",
    "goal_aws_cli",
    "goal_git",
    "goal_subagent",
    "goal_report_phase_result",
    "goal_record_blocker",
    "goal_request_capability_repair",
    "goal_checkpoint",
    "goal_launch"
  ]
}
```

### extension-load-goal-shell

Status: PASS

Loaded dist extension and ran goal_shell in a disposable git repo.

```json
{
  "registeredTools": [
    "cyber_checkpoint",
    "cyber_record_blocker",
    "cyber_report_phase_result",
    "cyber_request_approval",
    "goal_aws_cli",
    "goal_checkpoint",
    "goal_git",
    "goal_launch",
    "goal_post_shards",
    "goal_record_blocker",
    "goal_repo_context",
    "goal_report_phase_result",
    "goal_request_capability_repair",
    "goal_shell",
    "goal_subagent",
    "goal_update_task_plan"
  ],
  "registeredCommands": [
    "goal-approve",
    "goal-audit",
    "goal-authorize-release",
    "goal-dashboard",
    "goal-deny",
    "goal-finalize",
    "goal-log-purge",
    "goal-models",
    "goal-pause",
    "goal-repair-capabilities",
    "goal-replay",
    "goal-reset",
    "goal-resume",
    "goal-start",
    "goal-status",
    "goal-swarm-cancel",
    "goal-telemetry-status",
    "goal-trace",
    "harness-dashboard",
    "harness-doctor",
    "harness-mode",
    "security-review-start",
    "security-review-status"
  ],
  "tempRepo": "/var/folders/7w/4nb4hqg947b4lgfjp19mm2ww0000gn/T/pi-ig-guide-shell-CjMdcs",
  "output": "## No commits yet on main\n?? README.md\n"
}
```

### mock-aws-cli

Status: PASS

Mock AWS CLI preflight and read-only STS call used a temp repo and fake exec only.

```json
{
  "profile": "mock-profile",
  "region": "us-east-1",
  "policyRuleIds": [
    "policy.process.no-shell-strings"
  ]
}
```

### policy-negative-cases

Status: PASS

Package install, private URL, and PR without authorization are denied.

```json
{
  "packageInstall": {
    "result": "deny",
    "ruleIds": [
      "policy.package.install"
    ],
    "reason": "Package installation must use an approved package.install capability with planned lockfile effects."
  },
  "privateUrl": {
    "result": "deny",
    "ruleIds": [
      "policy.network.private-address"
    ],
    "reason": "Network destination is private or metadata-like: 127.0.0.1"
  },
  "prWithoutAuth": {
    "result": "deny",
    "ruleIds": [
      "policy.git.pr.release-auth"
    ],
    "reason": "PR creation requires a current ReleaseAuthorization."
  }
}
```

### provider-contracts

Status: PASS

Capability manifests validate; browser/MCP/vision fail closed without backends.

```json
{
  "providerIds": [
    "filesystem",
    "process",
    "web",
    "browser",
    "mcp",
    "vision"
  ],
  "capabilityIds": [
    "browser.interact",
    "filesystem.delete",
    "filesystem.read",
    "filesystem.write",
    "mcp.invoke",
    "process.exec",
    "vision.inspect",
    "web.fetch"
  ],
  "unavailableReasons": [
    "No browser backend configured.",
    "No MCP invoker configured.",
    "No vision backend configured."
  ]
}
```

### stale-phase-write

Status: PASS

Stale phase output is rejected and recorded as ignored.

```json
{
  "text": "STALE OUTPUT REJECTED: phaseAttemptId mismatch: got old-phase-attempt, expected ig-guide-stale/c1/research/a1 for goal_report_phase_result. Active run=ig-guide-stale, activePhase=ig-guide-stale/c1/research/a1. Your message is from a previous turn and has been ignored.",
  "eventKind": "stale_phase_output_ignored"
}
```

### visual-artifacts

Status: PASS

Desktop and mobile screenshots are present.

```json
{
  "desktopExists": true,
  "mobileExists": true
}
```
