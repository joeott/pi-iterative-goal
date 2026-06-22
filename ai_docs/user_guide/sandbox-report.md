# pi-iterative-goal User Guide Sandbox Report

Generated: 2026-06-22T17:36:59.409Z

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
  "stdoutTail": "✓ Test 4: Typed path scopes reject fuzzy allowlist matches\n✓ Test 5: Validation script executes argv checks, records exit codes, and fails closed\n✓ Test 6: Harness meta includes runId + phaseAttemptId nonce\n✓ Test 7: /goal-status --json structure includes lock + evaluator state\n✓ Test 8: Resume prompt carries nonce + tool contract\n✓ Test 9: agent_end synthesis handles plain-string and structured assistant output\n✓ Test 10: goal-status latestArtifact shape is parseable\n✓ Test 11: AWS CLI config, safety classification, and broker policy evidence behave as expected\n✓ Test 12: Resume prompt exposes AWS tool guidance when enabled\n✓ Test 13: Git finalization config and prompt guidance behave as expected\n✓ Test 14: Model allowlist restricts stale/unapproved models\n✓ Test 15: Central policy, broker, and provider manifest contracts validate effects\n✓ Test 16: Isolated writer worktree captures patch without touching main worktree\n✓ Test 17: Event replay reconstructs new run state and rejects hash-chain tampering\n✓ Test 18: New-run replay corruption does not silently reconstruct from stale cache\n✓ Test 19: ReleaseAuthorization is invalidated by a new HEAD\n✓ Test 20: Structured PR body generation includes evidence matrix and authorization\n\nAll tests passed. ✓\n"
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
    "goal_checkpoint"
  ]
}
```

### extension-load-goal-shell

Status: PASS

Loaded dist extension and ran goal_shell in a disposable git repo.

```json
{
  "registeredTools": [
    "goal_aws_cli",
    "goal_checkpoint",
    "goal_git",
    "goal_record_blocker",
    "goal_report_phase_result",
    "goal_request_capability_repair",
    "goal_shell",
    "goal_subagent"
  ],
  "registeredCommands": [
    "goal-audit",
    "goal-authorize-release",
    "goal-dashboard",
    "goal-finalize",
    "goal-pause",
    "goal-repair-capabilities",
    "goal-replay",
    "goal-reset",
    "goal-resume",
    "goal-start",
    "goal-status",
    "goal-trace"
  ],
  "tempRepo": "/var/folders/7w/4nb4hqg947b4lgfjp19mm2ww0000gn/T/pi-ig-guide-shell-EOHFn6",
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
