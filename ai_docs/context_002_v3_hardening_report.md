# Stabilization Report: pi-iterative-goal v3 Hardening

**Date**: 2026-05-26
**Author**: Claude (pi harness)
**Branch**: (working tree, post-PR#3 merge)

## Executive Summary

Hardened the pi-iterative-goal harness against all 10 non-negotiable invariants identified from the original transcript failure analysis. All changes preserve the v2 architecture while closing critical safety gaps discovered during audit of the merged PR #3 code.

## Files Changed (6 files, +982/-3,012)

| File | Change | Description |
|------|--------|-------------|
| `src/types.ts` | +5 lines | Added `runId`/`phaseAttemptId` to PhaseResultParams schema; added `stale_phase_output_ignored` event kind |
| `src/state.ts` | +49 lines | v1→v2 migration (`migrateState()`); `clear()` archives `active-run.json` to prevent stale restore |
| `src/index.ts` | rewritten | Stale-write guard on all tool handlers; `completePhaseAttempt()` calls; `startPhaseAttempt` auto-fallback; generalized model health check via `preflightAllModels()`; `/goal-reset` archives lock file; `/goal-finalize` produces PR description; removed duplicate `acquireLock()` call |
| `src/phases.ts` | rewritten | All phase prompts embed `runId` + `phaseAttemptId` identity nonces; tool instructions generated from capability snapshot; compact, clean layout |
| `src/evaluator.ts` | +42/-X lines | `checkAllowlistViolations()` reads from persistent `implementation-verification.json` instead of returning hardcoded `violation:false, actualFiles:[]` |
| `package-lock.json` | regenerated | Clean lockfile with no stale `@mariozechner/*` references |

## Build & Test Results

```
$ npm run build
> tsc
(exits 0, clean)

$ node -e "import('./dist/index.js').then(()=>console.log('smoke: ok'))"
smoke: ok

$ node scripts/smoke-goal-harness.mjs
✓ Test 1: Module imports cleanly, PhaseEventKind includes stale_phase_output_ignored
✓ Test 2: v1 state migrated to v2 without crash
✓ Test 3: Stale-write guard rejects mismatched runId, phaseAttemptId, and non-running states
✓ Test 4: Allowlist correctly detects out-of-plan file
✓ Test 5: Validation script generation produces valid bash
✓ Test 6: Harness meta includes runId + phaseAttemptId nonce
✓ Test 7: /goal-status --json structure includes lock + evaluator state
All tests passed. ✓
```

## Fixes Against Invariants

### Invariant 1: No stale queued phase may mutate a different run
- `checkStaleWriteGuard()` in index.ts: every tool handler rejects writes with mismatched `runId` or `phaseAttemptId`
- `rejectStale()` emits a `stale_phase_output_ignored` event with details
- `PhaseResultParams` now requires `runId` and `phaseAttemptId`

### Invariant 2: No phase result accepted unless runId + phaseAttemptId match
- `goal_report_phase_result` and `goal_record_blocker` both enforce the guard
- `synthesizePhaseResultSafe()` records `_nonceMatched` flag

### Invariant 3: Synthesized artifacts tied to active phase attempt
- `agent_end` checks `state.lock.activePhaseId` before synthesizing
- `completePhaseAttempt()` called after artifact recording

### Invariant 4: Only evaluator may declare goal completion
- No change needed — already correct in v2

### Invariant 5: Phase transitions backed by durable run-scoped artifacts
- `verifyImplementationAgainstPlan()` writes `implementation-verification.json` to run-scoped path
- All artifact writes use `getArtifactPath()` which includes runId + cycle + phase

### Invariant 6: Every file path includes runId + cycle + phase
- `getArtifactPath(runId, cycle, phase, filename)` enforces this
- Validation scripts use `${cycleDir}` = `.pi/iterative-goal/runs/<runId>/cycles/<cycle>/validate`

### Invariant 7: v1 state migrated or rejected safely
- `migrateState()` fills missing v2 fields (lock, phaseAttempts, evaluatorState, finalizationPolicy, modelHealth)
- v1 state.json will not crash v2 restore

### Invariant 8: Git finalization default-deny
- `/goal-finalize` NEVER calls git commands unless policy explicitly allows
- Patch + PR description generated when git is disabled
- `tool_call` handler blocks blocked git commands with suggestion to use patch

### Invariant 9: /goal-status --json authoritative
- Now includes: `evaluator.status`, `evaluator.startedAt`, `evaluator.lastHeartbeatAt`, `evaluator.isStale`, `lock.phaseStatus`, `phaseAttempts`, `artifactPaths`
- Answers "is eval running?" unambiguously

### Invariant 10: Build + smoke pass
- ✅

## Additional Fixes

- **Lock lifecycle**: Removed duplicate `acquireLock(state.runId, "")` in `/goal-start` that erased the real `phaseAttemptId`. `startPhaseAttempt()` is now the sole lock acquirer.
- **Model health**: Changed from hardcoded `openrouter/deepseek/deepseek-v4-pro` to `preflightAllModels()` that checks all configured models (primary + all fallbacks).
- **Auto-fallback**: `startPhaseAttempt()` auto-selects the first healthy fallback if the primary model is in cooldown.
- **Reset**: Archives `active-run.json` to `legacy/` directory instead of leaving it dangling.
- **Dashboard**: Fixed corrupted evaluator state display line.

## Remaining Limitations

- Isolated worktree finalization mode still not implemented
- No continuous evaluator heartbeat during long model calls (wraps call boundaries only)
- No formal CI/CD for the extension itself
- `sendUserMessage` followUp IDs not cancelable at the Pi framework level — canned via logical nonce rejection instead

## Safety Assessment

- ✅ TypeScript: clean
- ✅ Module import: clean
- ✅ 7/7 smoke tests pass
- ✅ All destructive operations default-deny
- ✅ `active-run.json` archived on reset
- ✅ v1 state migrates safely
- ✅ No stale old-scope packages in lockfile

## How to Run Tests

```bash
cd /Users/joe/Projects/pi-iterative-goal
npm run build
node scripts/smoke-goal-harness.mjs
```
