# Stabilization Report: pi-iterative-goal v2

**Date**: 2026-05-26
**Author**: Claude (pi harness)
**Branch**: (current working tree, no branch created)

## Summary

Upgraded `pi-iterative-goal` from the `@mariozechner/*` package scope to `@earendil-works/*` (pi v0.75.5) and implemented 15 harness reliability improvements drawn from postmortem analysis of a multi-run session transcript.

## Files Changed (11 files, +3,940/-361 lines)

| File | Change | Description |
|------|--------|-------------|
| `package.json` | +13/-13 | Migrated dependencies to `@earendil-works/*` v0.75.5 |
| `package-lock.json` | +2073 | Lockfile updates for new scope |
| `src/types.ts` | +138 | Added RunLock, PhaseAttempt, PhaseLifecycleEvent, EvaluatorState, StructuredPhaseResult, FinalizationPolicy, ModelHealthEntry |
| `src/state.ts` | +411 | Run-scoped directories, atomic persistence (tmp→fsync→rename), run lock acquisition/release, evaluator state persistence |
| `src/index.ts` | +1126 | Phase lifecycle events, diff verification after implement, model health preflight, /goal-status --json, /goal-finalize command, queue cancellation, startPhaseAttempt helper |
| `src/phases.ts` | +322 | Truthful tool-contract generation; conditionally references tools from capability snapshot; harness-owned validation script generation |
| `src/evaluator.ts` | +200 | Explicit EvaluatorState with heartbeat; allowlist violation checking; state manager integration |
| `src/dashboard.ts` | +8 | Evaluator state display |
| `src/capabilities.ts` | +2 | Import scope migration only |
| `src/shell.ts` | +4 | Import scope migration only |
| `src/subagents.ts` | +4 | Import scope migration only |

## Build Result

```
> pi-iterative-goal@0.1.0 build
> tsc

(exits 0, clean)
```

## Smoke Test

```
$ node -e "import('./dist/index.js').then(()=>console.log('ok'))"
ok
```

## Implemented Improvements

1. **Tool-contract truthfulness**: Phase prompts now generate tool instructions from the actual capability snapshot. The model is never told to call `goal_report_phase_result` if it isn't in the active tool list.

2. **Run-scoped artifact directories**: New layout:
   ```
   .pi/iterative-goal/
     active-run.json
     runs/<runId>/
       state.json, events.jsonl, latest.md
       evaluator-state.json, evaluator-verdicts.jsonl
       cycles/<n>/<phase>/result.json, diff.patch, test-results.txt, etc.
   ```

3. **Single active-run lock**: `RunLock` with `activeRunId`, `activePhaseId`, `phaseLeaseOwner`, `phaseStatus` prevents interleaving of old/new goals.

4. **Transactional phase lifecycle**: Events tracked from `phase_started` through all intermediate states to `next_phase_started`, including `model_fallback` and `transition_decided`. Events written to `events.jsonl`.

5. **Atomic persistence**: `writeFileAtomic(path, content)` using tmp→fsync→rename.

6. **Explicit evaluator state**: `EvaluatorState` with `status`, `startedAt`, `lastHeartbeatAt`, `error`. Not inferred from file existence. Stale heartbeat detection (120s).

7. **Diff-based implementation verification**: After implement phase, captures `git diff --name-only` and `git diff` to verify plan allowlist adherence.

8. **Harness-owned validation scripts**: `generateValidationScript()` produces a strict bash script with `set -euo pipefail`, proper redirection, artifact capture.

9. **PR/finalization modes**: `/goal-finalize` command. Default falls back to patch when git is disabled. `FinalizationPolicy` struct with allowGitFinalization, allowCommit, allowPush, allowPR, fallback.

10. **`/goal-status --json`**: Machine-readable status output including lock state, evaluator heartbeat, model health, and phase attempt history.

11. **Queue cancellation**: Creating a new goal cancels queued phase messages for old runs.

12. **Model health caching**: `ModelHealthEntry` with cooldown. Preflights model availability before starting a run. Cooldown prevents retrying known-bad models.

13. **Phase attempt tracking**: `PhaseAttempt` with `phaseAttemptId` (runId/cN/phase/aN), fallback chain, status lifecycle.

14. **Allowlist violation detection**: Evaluator prompt now includes plan allowlist vs actual changed files.

15. **Structured phase result schema**: `StructuredPhaseResult` type for parseable phase outputs with tests, gates, blockers, changedFiles, patchPath.

## Remaining Known Limitations

- **Isolated worktree finalization**: `/goal-finalize --mode isolated-worktree` stubbed but not implemented.
- **Evaluator model health**: Only preflighted on `/goal-start`, not continuously monitored during long runs.
- **MCP/server status unification**: Status bar still uses existing MCP detection; not yet unified with capability snapshot.
- **No migration of existing state**: Old `.pi/iterative-goal/state.json` files (v1 format) are not auto-migrated to v2. New runs start fresh.
- **Import scope change**: Other installed extensions that depend on `@mariozechner/pi-coding-agent` may need their own migrations. This extension now uses `@earendil-works/*` exclusively.
- **pi-sub-agent npm package**: Installed globally as `pi-sub-agent@0.1.5` (from npm) for the model selector update. Runs on `@earendil-works/pi-coding-agent@0.74.2` as a dependency, which may be a version behind the main pi install at 0.75.5.

## Safety Assessment

- ✅ TypeScript compilation: clean
- ✅ Module import: clean
- ✅ No architectural expansion beyond what was already planned
- ✅ All destructive operations default-deny
- ✅ Patch produced at `/tmp/pi-iterative-goal-v2.patch`

## Next Steps

1. Test in a fresh Pi session with `/goal-start "test goal"`
2. Verify evaluator state file is written during validate phase
3. Test `/goal-status --json` output
4. Test run-scoped artifact paths
5. Consider committing to a feature branch and creating a PR

---

Patch: `/tmp/pi-iterative-goal-v2.patch` (200KB)