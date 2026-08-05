# Swarm Monitor Convention

Convention for supervising long-running, multi-campaign agent-swarm executions in this
repository (introduced during the `feat/deployment-plan-c0-c4` campaign run, 2026-07-20).

## Components

1. **Tracer** — `scripts/swarm-monitor-trace.mjs`. A deterministic Node script that
   appends exactly one timestamped journal entry per invocation. It performs no model
   calls and no mutations beyond the journal append: it snapshots git HEAD, worktree
   dirty count (excluding `.pi/`), and per-agent task output-log sizes/mtimes from the
   session's task directory.
2. **Journal** — `.pi/iterative-goal/monitor/swarm-c0-c4.journal.log` (runtime state,
   untracked, alongside the harness's other run state). The file begins with a
   **deterministic header** — fixed content, written once, containing no timestamps or
   run-variable data — followed by one entry per trace tick:
   `iso_ts | head=<sha> | dirty=<n> | tasks(id:out_bytes:out_mtime_iso)`.
3. **ACTIVE marker** — `.pi/iterative-goal/monitor/ACTIVE`. The tracer daemon loops
   while this file exists; deleting it stops the monitor cleanly at the next tick.
4. **Daemon** — a detached shell loop invoking the tracer every 360 s (6 min). Cheap,
   deterministic, and does not wake the supervising model.
5. **Supervisor wake** — a recurring model-level reminder at a coarser cadence
   (every 24 min, i.e. every 4th tick) to read the journal tail, reconcile with the
   live task list, and act on stalled or completed agents. Task-completion
   notifications may wake the supervisor earlier; the 24-minute wake is the floor.

## Cadence rationale

- 6-minute trace ticks give fine-grained progress history without model cost.
- 24-minute supervisor wakes bound worst-case stall detection while keeping the
  pipeline notification-driven in the normal case.

## Lifecycle

- Start: create the ACTIVE marker, launch the daemon loop, create the wake reminder.
- Stop (when the campaign is done): delete the ACTIVE marker, cancel the wake
  reminder. The journal is retained as run evidence.

## Reuse

For future swarm runs, copy this pattern with a run-specific journal name and branch
value in the tracer header. Keep the header deterministic: format version, repo,
branch, cadence, and column schema only — never timestamps or counts.
