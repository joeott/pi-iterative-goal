---
description: Draft a goal contract from a source file/direction and launch the iterative goal loop
argument-hint: "<source file or direction> [extra guidance]"
---

The user's direction: `$ARGUMENTS`

Review the referenced file(s) completely before drafting. If the argument names a
file, read it in full; also read `goal.md`, `northstar.md`, and `learnings.md`
when present so the draft follows the established method and respects durable
constraints.

Then write the goal contract for the user, in this shape:

- Goal: one statement of what must become true, grounded in the reviewed file.
- Completion criterion: explicit, verifiable checks the harness can execute and
  sign attestations for — commands with expected exit codes, tests that must
  pass, artifacts that must exist, searches that must return zero. Never prose
  claims; the evaluator only accepts harness-signed evidence and trusted-runner
  receipts.
- Scope: what the work may touch and what is off-limits.
- Stop rule: when to report blocked instead of forcing a pass.

Number the criteria. Keep the loop in mind: it runs fixed
research → plan → implement → validate cycles with an evaluator verdict each
cycle, re-entering at the phase the evaluator directs, until the criterion is
met — so the criterion, not effort, is the whole contract.

Do not ask for confirmation. Launch immediately by calling the `goal_launch`
tool with the drafted goal and criterion. After launch the loop pursues the goal
continuously; do not interfere with its phases.
