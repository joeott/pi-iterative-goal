# Plan: Deployment Strategy for pi-iterative-goal Harness Efficacy

## Objective
Produce a deployment plan for `joeott/pi-iterative-goal` (Pi Coding Agent extension, four-phase
supervisor loop: research → plan → implement → validate → external evaluator) that maximizes
harness efficacy across four axes:
1. **Smooth UI visibility** — clean, live rendering of current phase/cycle state in the Pi TUI
2. **Swarming capabilities** — supervisor → specialist fan-out inside/around the loop
3. **Effective sharding** — work decomposition applied AFTER research+plan phases complete
   (dependency-graph sharding, DAG scheduling, contract-net style assignment)
4. **Diagrams + pattern proof + external validation** — architecture diagrams, mapping of the
   12 swarm patterns to this codebase, and web-validated efficacy evidence (HEFT, spectral
   bisection, contract net, blackboard, etc.)

## Stage 0 — Repo Recon (DONE by orchestrator)
- Scanned repo tree, SPEC.md, package.json. Confirmed: Pi extension, TS, TUI dashboard
  (`src/dashboard.ts`, `src/harness-ui.ts`, `src/ui/`), subagent adapter (`src/subagents.ts`,
  `src/agents/`), kernel/workspace/policy/domain subsystems, state machine in `src/state.ts`.

## Stage 1 — Parallel Research (two independent sub-agents, run concurrently)
- **R1: repo-anatomist (explore)** — Deep-read key files via GitHub MCP:
  `src/index.ts`, `src/phases.ts`, `src/dashboard.ts`, `src/harness-ui.ts`, `src/ui/`,
  `src/subagents.ts`, `src/agents/`, `src/state.ts` (public surface), `src/kernel/`,
  `src/workspace/`, `src/types.ts`, plus branches `fix/factory-state-manager` and
  `fix/harness-v2-optimizations` for in-flight work. Output: (a) current UI rendering
  pipeline for phase visibility and its gaps; (b) current subagent/swarm substrate and its
  gaps; (c) where sharding hooks could attach post-plan phase; (d) file-level change map.
- **R2: pattern-validator (explore)** — External web validation of the efficacy of:
  HEFT DAG scheduling, spectral bisection / Fiedler-vector graph partitioning, contract-net
  protocol, blackboard architectures, supervisor-worker LLM swarms, map-reduce research
  swarms, evaluator-gated loops. Output: claim → evidence table with verifiable citations
  (papers, production systems), including counter-evidence/limitations.

## Stage 2 — Validation Gate (orchestrator)
- Cross-check R1 findings against repo facts; cross-check R2 citations for verifiability.
  Fail → redelegate with refined brief.

## Stage 3 — Writing (report-writing skill)
- Load `report-writing`. Produce the deployment plan document:
  - Current-state assessment (UI, swarm substrate, loop motor)
  - Target architecture with mermaid diagrams (deployment topology, phase-state UI model,
    sharding pipeline: research/plan → shard → schedule → execute → verify)
  - Pattern-proof section: each of the 12 patterns mapped to concrete repo files + validated
    external efficacy evidence from R2
  - Sharding design: dependency-graph build, spectral bisection, HEFT-ordered task DAG,
    contract-net assignment, worktree isolation, blackboard/event ledger on `.pi/iterative-goal/`
  - Phased rollout campaign with acceptance gates
- Output: `/mnt/agents/output/pi-iterative-goal-deployment-plan.md`

## Stage 4 — Artifact (docx skill)
- Load `docx`. Convert final markdown → `/mnt/agents/output/pi-iterative-goal-deployment-plan.docx`
  (mermaid diagrams rendered as images). Deliver both .md and .docx.

## Constraints
- No writes to the GitHub repo (read-only planning engagement).
- Citations must be real and verifiable; no fabricated sources.
- Diagrams: mermaid source in the .md; rendered images in the .docx.
