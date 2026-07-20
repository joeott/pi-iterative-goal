---
name: goal
description: Run the active pi-iterative-goal production-certification contract
argument-hint: "[requested outcome within the active goal]"
---

Read `goal.md` as the living session contract, `northstar.md` as its strategic
authority, `state.md` as the exact current proof boundary and resume point, and
`learnings.md` as the durable record. Read all four before acting.

Use `$ARGUMENTS` as the requested outcome within the active contract. If it is
empty, select the highest-priority unblocked lane in `goal.md`. Do not replace
the session objective, relax an invariant, or expand production/destructive
authority based on an argument.

Work through the repository's durable research → plan → implement → validate
loop. Keep at most one task in progress, use independent reviewers for material
slices, preserve exact evidence and budget accounting, and stop only under the
contract's stop rules. Completion belongs to trusted checks and the independent
evaluator, not the implementation model.

After every milestone, update the lane scoreboard and append an evolution entry
in `goal.md`. Add only durable reproduced truths to `learnings.md`. Replace
`state.md` at pauses, compaction, handoff, before and after long external runs,
and session end. Keep all four tracked on the visible PR head.
