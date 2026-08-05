# External Validation of Multi-Agent Orchestration Patterns

**Purpose:** Independent evidence check on 7 orchestration patterns a proposed LLM-agent harness deployment plan intends to rely on. Every URL below was opened and confirmed during this review; anything that could not be verified is marked **UNVERIFIED** and excluded (none remain in the final tables — all listed sources resolved and matched the claims attributed to them).

---

## 1. HEFT (Heterogeneous Earliest Finish Time) DAG scheduling

**Efficacy summary.** HEFT (Topcuoglu, Hariri, Wu, 2002) is a list-scheduling heuristic that ranks DAG tasks by upward rank (mean computation + communication cost) and assigns each task to the processor giving the earliest finish time, using insertion-based scheduling. It consistently produced near-optimal makespans at low complexity across random and application DAGs, which is why it became the de facto reference baseline: two decades later, workflow-scheduling studies still describe HEFT as "one of the most popular scheduling algorithms" and use it as the primary comparator (arXiv:2403.07120). Its core weakness is structural: it is a *static* heuristic whose decisions are only as good as the a priori per-task/per-machine computation and communication cost estimates it is fed. Robustness studies of static DAG heuristics (Canon et al., 2008) show schedule quality degrades under uncertain estimates, and adversarial instance generation (PISA, 2024) finds instances where HEFT is up to ~4.3x worse than trivial baselines — it has no dominance guarantee.

| Claim | Source title | Venue/Author | Year | URL | Supports/Limits |
|---|---|---|---|---|---|
| HEFT achieves near-optimal makespan at low complexity; model assumes given static computation/communication cost matrices | Performance-Effective and Low-Complexity Task Scheduling for Heterogeneous Computing | IEEE Trans. Parallel & Distributed Systems 13(3):260–274 — Topcuoglu, Hariri, Wu | 2002 | https://ieeexplore.ieee.org/document/993206/ | Supports (origin; also defines the static-cost-model assumption) |
| Static DAG heuristics (HEFT among the 20 analyzed) trade robustness against makespan when runtime estimates are uncertain | Comparative Evaluation of the Robustness of DAG Scheduling Heuristics | Grid Computing (CoreGRID), Springer — Canon, Jeannot, Sakellariou, Zheng | 2008 | https://link.springer.com/chapter/10.1007/978-0-387-09457-1_7 | Limits (estimate sensitivity) |
| HEFT remains "one of the most popular scheduling algorithms" and the standard comparator; adversarial instances exist where it is ~4.3x worse than a simple baseline | An Adversarial Approach to Comparing Task Graph Scheduling Algorithms (SAGA/PISA) | arXiv:2403.07120 | 2024 | https://arxiv.org/abs/2403.07120 | Supports (baseline status) + Limits (no dominance guarantee) |

**Deployment implication:** HEFT is a defensible default for scheduling agent subtasks across a heterogeneous worker pool, but its cost model must be calibrated from live telemetry (measured model latency/token costs/tool runtimes) and refreshed, not hard-coded static estimates; add schedule-robustness checks or re-ranking when estimates drift, and never assume HEFT is optimal on any given instance.

---

## 2. Spectral bisection / Fiedler-vector graph partitioning

**Efficacy summary.** Spectral bisection partitions a graph by the sign/median split of the Fiedler vector (second-smallest Laplacian eigenvector), originating with Fiedler (1973) and operationalized for sparse-matrix/circuit workloads by Pothen, Simon & Liou (1990). It is a principled, globally-informed relaxation of cut minimization and is "still in use today" (Buluç et al., 2016). However, the evidence is unambiguous about its modern role: exact balanced cut minimization is NP-complete, minimum bisection with a perfect balance constraint is NP-hard with no constant-factor approximation in general, and spectral bisection itself is "expensive in terms of running time." The practically dominant approach is multilevel (hMETIS for VLSI hypergraphs, KaHIP for graphs), which uses cheap heuristics (sometimes spectral at coarse levels) plus local refinement; KaHIP's lineage holds the majority of Walshaw benchmark records.

| Claim | Source title | Venue/Author | Year | URL | Supports/Limits |
|---|---|---|---|---|---|
| Second Laplacian eigenvector ("algebraic connectivity") underpins spectral graph partitioning | Algebraic connectivity of graphs | Czechoslovak Mathematical Journal 23(2):298–305 — Fiedler | 1973 | https://dml.cz/handle/10338.dmlcz/101168 | Supports (origin) |
| Laplacian eigenvectors yield good edge/vertex separators for parallel sparse factorization (spectral bisection method) | Partitioning Sparse Matrices with Eigenvectors of Graphs | SIAM J. Matrix Anal. Appl. 11(3):430–452 — Pothen, Simon, Liou | 1990 | https://epubs.siam.org/doi/10.1137/0611030 | Supports (method) |
| Spectral bisection "still in use today" but "expensive in running time"; balanced-cut partitioning is NP-complete; min bisection NP-hard at perfect balance; no constant-factor approx for ε=0; multilevel is "the most successful approach" for large graphs | Recent Advances in Graph Partitioning | Algorithm Engineering, Springer LNCS 9220; arXiv:1311.3144 — Buluç, Meyerhenke, Safro, Sanders, Schulz | 2016 | https://arxiv.org/abs/1311.3144 | Supports (viability) + Limits (cost, NP-hardness, dominated by multilevel) |
| Multilevel hypergraph partitioning is the standard practical method in VLSI/circuit partitioning (hMETIS) | Multilevel Hypergraph Partitioning: Applications in VLSI Domain | IEEE Trans. VLSI Systems 7(1):69–79 — Karypis, Aggarwal, Kumar, Shekhar | 1999 | https://ieeexplore.ieee.org/document/748202 | Supports (circuit-domain practice; implies spectral-only is not SOTA) |
| Modern multilevel graph partitioner (KaHIP) achieves/​improves most Walshaw benchmark records | Engineering Multilevel Graph Partitioning Algorithms | ESA 2011; arXiv:1012.0006 — Sanders, Schulz | 2011 | https://arxiv.org/abs/1012.0006 | Supports (practical SOTA = multilevel, not spectral-alone) |

**Deployment implication:** Use the Fiedler vector as a cheap global *prior* (e.g., seeding an initial split of the task/agent dependency graph), but hand final partitioning to a multilevel tool (KaHIP/METIS-family) with local refinement; do not expect exact minimum bisection (NP-hard under the balance constraint) — relax to bicriteria/imbalance-tolerant objectives, which is also the only regime with useful approximation guarantees.

---

## 3. Contract Net Protocol (CNP) for task allocation

**Efficacy summary.** Smith's Contract Net Protocol (1980) — a manager broadcasts task announcements, nodes bid, the manager awards to the best bidder — is the canonical market-style task-allocation mechanism in multi-agent systems and was durable enough to be standardized by FIPA as an agent interaction protocol (SC00029H, 2002). Decades of multirobot work confirm its strengths (fast, flexible, robust to failures, decentralized) and its two structural weaknesses: (i) no global-optimality guarantee — "good local solutions may not sum to a good global solution," and decompose-then-allocate pipelines "may find highly suboptimal solutions"; (ii) coordination costs — broadcast/bid messaging and information gathering impose heavy communication demands as teams scale (Dias et al., Proc. IEEE 2006).

| Claim | Source title | Venue/Author | Year | URL | Supports/Limits |
|---|---|---|---|---|---|
| Original CNP: high-level communication/control protocol for distributed problem solvers via task announcement, bidding, awarding | The Contract Net Protocol: High-Level Communication and Control in a Distributed Problem Solver | IEEE Trans. Computers C-29(12):1104–1113 — Smith | 1980 | https://ieeexplore.ieee.org/document/1675516 | Supports (origin; evidence of foundational use) |
| CNP adopted as an official FIPA standard interaction protocol for agent systems | FIPA Contract Net Interaction Protocol Specification (SC00029H) | FIPA TC C, status: Standard | 2002 | http://www.fipa.org/specs/fipa00029/ | Supports (durable real-world adoption) |
| Market-based/distributed allocation is fast and robust "but can produce highly suboptimal solutions since good local solutions may not sum to a good global solution"; centralized coordination has "high communication demands"; two-stage decompose-then-allocate "may find highly suboptimal solutions" | Market-Based Multirobot Coordination: A Survey and Analysis | Proceedings of the IEEE 94(7):1257–1270 — Dias, Zlot, Kalra, Stentz (DOI 10.1109/JPROC.2006.876939; verified full-text PDF) | 2006 | https://cse-robotics.engr.tamu.edu/dshell/cs689/papers/dias06market.pdf | Limits (no global optimum; communication overhead) |

**Deployment implication:** CNP-style bidding is a reasonable decentralized allocation layer among peer agents, but treat its output as a *satisficing* allocation, not an optimal one: bound message fan-out (targeted announcements to capable workers instead of broadcast), and pair it with a periodic global critic/re-planner (or the HEFT scheduler above) that can reassign work when local bids drift from global efficiency.

---

## 4. Blackboard architecture for multi-agent coordination

**Efficacy summary.** The blackboard model — independent knowledge sources opportunistically reading/writing a shared, structured workspace under a control component — was established by HEARSAY-II (Erman, Hayes-Roth, Lesser, Reddy, 1980) and formalized by Nii (1986), who also documented that the hard part is the *control/scheduling* of knowledge sources. The pattern is experiencing a genuine LLM-era revival: a 2025 study reports a blackboard-architecture LLM multi-agent system matching state-of-the-art multi-agent systems while consuming fewer tokens than message-passing-style designs (arXiv:2507.01701), and another 2025 paper explicitly re-adopts the blackboard as the minimal shared substrate for studying multi-agent safety/collusion (arXiv:2510.14312) — which also flags the risk side: a shared writable channel enables error propagation and collusion if unmonitored.

| Claim | Source title | Venue/Author | Year | URL | Supports/Limits |
|---|---|---|---|---|---|
| Origin: HEARSAY-II coordinates diverse cooperating knowledge sources via a shared blackboard to resolve uncertainty | The Hearsay-II Speech-Understanding System: Integrating Knowledge to Resolve Uncertainty | ACM Computing Surveys 12(2):213–253 — Erman, Hayes-Roth, Lesser, Reddy | 1980 | https://dl.acm.org/doi/10.1145/356810.356816 | Supports (origin) |
| Canonical formalization of the blackboard model/framework; control of knowledge-source scheduling is the central design problem | The Blackboard Model of Problem Solving and the Evolution of Blackboard Architectures | AI Magazine 7(2):38–53 — Nii (DOI 10.1609/aimag.v7i2.537) | 1986 | https://ojs.aaai.org/aimagazine/index.php/aimagazine/article/view/537 | Supports (model) + Limits (control complexity) |
| Blackboard-based LLM multi-agent system is competitive with SOTA MASs while using fewer tokens | Exploring Advanced LLM Multi-Agent Systems Based on Blackboard Architecture | arXiv:2507.01701 — Li et al. | 2025 | https://arxiv.org/abs/2507.01701 | Supports (modern relevance, token efficiency) |
| Blackboard repurposed as minimal substrate for LLM multi-agent safety/privacy/security studies (enables studying collusion and failure modes on a shared channel) | Revisiting the Blackboard for Multi-Agent Safety, Privacy, and Security Studies (Terrarium) | arXiv:2510.14312 | 2025 | https://arxiv.org/abs/2510.14312 | Supports (modern relevance) + Limits (shared-channel risks) |

**Deployment implication:** A shared append-only blackboard (artifacts + status entries) is an evidence-backed, token-efficient coordination substrate — but budget for the classic control problem (an attention/scheduling policy for which agent reads/writes when), enforce message schemas and provenance, and monitor the channel for error cascades/collusion since the shared medium is also the main failure surface.

---

## 5. LLM multi-agent orchestration efficacy (2023–2026)

**Efficacy summary.** Evidence is genuinely mixed and task-dependent. On the supporting side: Anthropic reports its orchestrator-worker research system (one lead agent + parallel subagents) beat a single-agent configuration by 90.2% on its internal research evaluation, and parallel subagents cut research time by up to 90%; AutoCodeRover's two-agent structure-search pipeline reached 19% on SWE-bench Lite at ~$0.43/issue, improving on prior autonomous agents. On the counter side: Agentless showed a deliberately simple three-phase *non-agent* pipeline reaching 32% on SWE-bench Lite at ~$0.70 — outperforming most complex agent designs of its time; the MAST taxonomy (Cemri et al., 2025) catalogs 14 failure modes across 7 popular frameworks and finds gains over single-agent/best-of-N baselines are often minimal; Cognition's engineering team argues multi-agent architectures are fragile because subagents make implicit, conflicting decisions that cannot be reconciled. Anthropic itself states the caveat: agents burn ~4x (single) to ~15x (multi-agent) the tokens of chat, and multi-agent is "not a good fit" for tasks (like most coding work) where subtasks share context and are not truly parallelizable. A 2025 hybrid-systems paper (arXiv:2505.18286) finds MAS benefits over single agents diminish as base models improve, favoring cascade/hybrid designs.

| Claim | Source title | Venue/Author | Year | URL | Supports/Limits |
|---|---|---|---|---|---|
| Lead-agent + parallel subagents outperformed single agent by 90.2% on internal research eval; but agents use ~4x/15x chat tokens; "not a good fit" when subtasks must share context (most coding tasks) | How we built our multi-agent research system | Anthropic Engineering (vendor blog) | 2025 | https://www.anthropic.com/engineering/built-multi-agent-research-system | Supports (breadth-first research) + Limits (cost multiplier, coding-task caveat) |
| Orchestrator-workers and parallelization (MapReduce-style sectioning/voting) are first-class workflow patterns; but "start with the simplest solution possible" — agents trade cost/latency for performance | Building effective agents | Anthropic Engineering (vendor blog) | 2024 | https://www.anthropic.com/engineering/building-effective-agents | Supports (pattern taxonomy) + Limits (simplicity-first guidance) |
| Two-agent (context + patch) system with spectrum-based fault localization solved 19% of SWE-bench Lite at $0.43 avg cost, beating prior autonomous agents | AutoCodeRover: Autonomous Program Improvement | ISSTA 2024; arXiv:2404.05427 — Zhang et al. | 2024 | https://arxiv.org/abs/2404.05427 | Supports (multi-agent coding efficacy at low cost) |
| Simple three-phase localize→repair→validate pipeline reached 32% on SWE-bench Lite at $0.70, questioning the need for complex autonomous agents | Agentless: Demystifying LLM-based Software Engineering Agents | arXiv:2407.01489 — Xia et al. | 2024 | https://arxiv.org/abs/2407.01489 | Limits (simplicity can beat multi-agent complexity) |
| 14 failure modes (specification, inter-agent misalignment, verification failures) identified across 7 frameworks; MAS gains over single-agent/best-of-N often minimal | Why Do Multi-Agent LLM Systems Fail? (MAST) | arXiv:2503.13657 — Cemri et al. (UC Berkeley) | 2025 | https://arxiv.org/abs/2503.13657 | Limits (failure taxonomy, error propagation) |
| Multi-agent systems are fragile: subagents make implicit, conflicting decisions; parallelizing work does not parallelize understanding; "read context" beats spawning agents | Don't Build Multi-Agents | Cognition (Walden Yan), vendor engineering blog | 2025 | https://cognition.ai/blog/dont-build-multi-agents | Limits (context-engineering counter-evidence) |

*(Additional verified corroboration: OpenHands platform paper, arXiv:2407.16741; "AI Agents That Matter," Kapoor et al., arXiv:2407.01502 — simple baselines, cost-accuracy trade-offs; "Single-agent or Multi-agent Systems? Why Not Both?", arXiv:2505.18286 — hybrid cascade; diminishing MAS advantage as models improve.)*

**Deployment implication:** Adopt supervisor-worker orchestration selectively: it is evidence-backed for *breadth-first, decomposable* workloads (parallel research, independent searches, independent file edits), and explicitly counter-indicated — including by its strongest proponent — for tightly-coupled sequential tasks. Gate the pattern behind a decomposition check, instrument cost (expect ~an order-of-magnitude token multiplier), and always benchmark against the single-agent/best-of-N baseline before shipping the multi-agent path.

---

## 6. Evaluator-gated completion (LLM-as-judge deciding `goal_met`)

**Efficacy summary.** Using a separate LLM judge to gate completion is workable and is used in production: Zheng et al. (NeurIPS 2023) showed GPT-4-as-judge reaches over 80% agreement with human preferences — the same agreement level humans reach with each other — and Anthropic's multi-agent research system relies on an LLM judge with an explicit rubric to grade results at scale. The bias literature is equally well established and directly enumerates the failure modes a gate must defend against: position bias (favoring the first/second answer shown), verbosity bias (favoring longer answers regardless of quality), self-enhancement/self-preference bias (models favoring their own outputs — later work shows evaluators recognize and favor their own generations), and weak grading of math/reasoning chains.

| Claim | Source title | Venue/Author | Year | URL | Supports/Limits |
|---|---|---|---|---|---|
| GPT-4 judge matches human-preference agreement (>80%); but judges exhibit position bias, verbosity bias, self-enhancement bias, and limited math/reasoning grading | Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena | NeurIPS 2023 Datasets & Benchmarks; arXiv:2306.05685 — Zheng et al. | 2023 | https://arxiv.org/abs/2306.05685 | Supports (reliability) + Limits (named biases) |
| LLM evaluators recognize and systematically favor their own generations; self-recognition inflates scores and biases are hard to fully mitigate | LLM Evaluators Recognize and Favor Their Own Generations | NeurIPS 2024; arXiv:2404.13076 — Liusie, Manakul, Gales | 2024 | https://arxiv.org/abs/2404.13076 | Limits (self-preference bias) |
| LLM-as-judge with an explicit rubric used as the scalable evaluation mechanism inside a production multi-agent system | How we built our multi-agent research system | Anthropic Engineering (vendor blog) | 2025 | https://www.anthropic.com/engineering/built-multi-agent-research-system | Supports (production practice) |

**Deployment implication:** A judge-gated `goal_met` is defensible *if* bias countermeasures are designed in: use a judge model different from (and at least as capable as) the actor model, randomize/blind candidate order, grade against an explicit rubric rather than free-form "did it succeed," never let an agent certify its own output, and fall back to deterministic checks (tests, linters, schemas) wherever a programmatic verifier exists — LLM judging is the fallback for unverifiable-by-code criteria, not the first choice.

---

## 7. Git worktree / workspace isolation for concurrent agent edits

**Efficacy summary.** Direct peer-reviewed evidence is absent, but vendor practice is consistent and explicit. Anthropic's Claude Code documentation recommends running parallel agent sessions in git worktrees precisely so that "edits don't collide" — each worktree is a separate checkout on its own branch, giving agents isolated environments — and exposes this as a first-class CLI feature (`claude --worktree`). Conductor, a dedicated multi-agent orchestration product, builds its entire model on the same primitive: "each Conductor workspace is a new git worktree," with per-agent isolated workspaces feeding a review-and-merge flow. The underlying mechanism is canonical, documented git functionality. The acknowledged limit, visible in these same products, is that isolation moves the conflict from write-time to merge-time: merge conflicts and code review become the bottleneck, and isolation does nothing to reconcile semantically contradictory changes.

| Claim | Source title | Venue/Author | Year | URL | Supports/Limits |
|---|---|---|---|---|---|
| Recommended practice: run parallel Claude Code sessions in git worktrees — separate checkouts on separate branches so concurrent agent edits don't collide; first-class `--worktree` flag | Claude Code Docs — Common workflows ("Run parallel sessions with worktrees") | Anthropic (vendor documentation) | 2025 | https://code.claude.com/docs/en/common-workflows | Supports (vendor-validated practice) |
| Multi-agent orchestration product runs parallel Claude Code/Codex/Cursor agents, each in an isolated workspace that is a git worktree, with review/merge flow (and visible merge-conflict states) | Conductor — Run parallel coding agents | Melty Labs (vendor product site) | 2025 | https://www.conductor.build/ | Supports (practice) + Limits (conflicts surface at merge time) |
| Mechanism documentation: `git worktree` manages multiple working trees attached to one repository, each with its own checked-out branch | git-worktree(1) manual page | Official git documentation | — | https://git-scm.com/docs/git-worktree | Supports (mechanism) |

**Deployment implication:** Give every concurrent coding agent its own worktree + dedicated branch (cheap, vendor-validated, prevents write conflicts), and invest the saved complexity in the merge layer: a deterministic merge/CI gate plus judge-gated review (pattern 6), since the evidence shows conflicts are deferred to integration, not eliminated; do not rely on worktrees to reconcile contradictory edits across agents.

---

## Overall confidence

| # | Pattern | Confidence | Rationale |
|---|---|---|---|
| 1 | HEFT DAG scheduling | **STRONG** | Foundational peer-reviewed algorithm, still the standard baseline 20+ years on; limitations (static estimates, no dominance) precisely characterized in the literature |
| 2 | Spectral bisection / Fiedler partitioning | **STRONG** (as a component; **WEAK** as sole partitioner) | Origins, NP-hardness of balanced bisection, and multilevel dominance are all textbook/survey-level facts; safe if used as a prior feeding multilevel refinement |
| 3 | Contract Net task allocation | **MODERATE** | Canonical, standardized, heavily used in classic MAS/robotics with well-documented suboptimality and communication costs — but the evidence base is pre-LLM; transfer to LLM agents is plausible, not measured |
| 4 | Blackboard coordination | **MODERATE** | Classic lineage is rock-solid; LLM-era evidence (2025 preprints) is promising for token efficiency but recent and not yet independently replicated |
| 5 | LLM multi-agent orchestration | **MODERATE** (task-dependent) | Strong efficacy evidence for breadth-first research decomposition (incl. vendor-quantified gains); credible peer-reviewed and vendor counter-evidence for tightly-coupled coding tasks; ~4–15x token cost multiplier is undisputed |
| 6 | LLM-as-judge gating | **STRONG** (with mandated bias controls) | Peer-reviewed reliability (~human-level pairwise agreement) plus a mature, specific bias literature (position/verbosity/self-preference) with known mitigations; production use by Anthropic |
| 7 | Git worktree isolation | **MODERATE** | Consistent, explicit vendor practice (Anthropic docs, dedicated orchestration product) and canonical git mechanics, but no controlled/peer-reviewed evaluation; evidence is practice-based |

**UNVERIFIED/excluded sources:** none in the final tables. (One planned citation — the IEEE Xplore landing page for Dias et al. 2006, DOI 10.1109/JPROC.2006.876939 — could not be opened directly due to IEEE access restrictions; it was replaced with the verified full-text author-hosted PDF of the identical paper.)
