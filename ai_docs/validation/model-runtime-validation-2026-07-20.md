# Exact model runtime validation — 2026-07-20

This receipt records earlier July 20 live provider evidence for the only nine model routes
permitted by `config/model-roster.json`. It contains no credential values.
Catalog presence, authenticated inference, and behavior/tool conformance are
separate proof states.

## Result

| Profile | Exact provider/model | Catalog | Live completion / structured / tools | Boundary |
| --- | --- | --- | --- | --- |
| `zai_glm_5_2` | `zai/glm-5.2` | listed | PASS / PASS / PASS (HTTP 200) | response model `glm-5.2` |
| `fireworks_glm_5_2_max` | `fireworks/accounts/fireworks/models/glm-5p2` | listed | PASS / PASS / PASS (HTTP 200) | response model matched exactly |
| `fireworks_glm_5_2_fast` | `fireworks/accounts/fireworks/routers/glm-5p2-fast` | router is not catalog-enumerated | PASS / PASS / PASS (HTTP 200) | exact router accepted; provider reports its fixed backing model `accounts/fireworks/models/glm-5p2` |
| `openrouter_kimi_k3` | `openrouter/moonshotai/kimi-k3` | listed | PASS / PASS / PASS (HTTP 200) | exact response model matched after credential repair |
| `cerebras_gpt_oss_120b` | `cerebras/gpt-oss-120b` | listed | PASS / PASS / PASS (HTTP 200) | response model matched exactly |
| `cerebras_glm_4_7` | `cerebras/zai-glm-4.7` | listed | PASS / PASS / PASS (HTTP 200) | response model matched exactly |
| `cerebras_gemma_4_31b` | `cerebras/gemma-4-31b` | listed | PASS / PASS / PASS (HTTP 200) | response model matched exactly |
| `openrouter_claude_sonnet_5` | `openrouter/anthropic/claude-sonnet-5` | listed | PASS / PASS / PASS (HTTP 200) | exact response model matched after credential repair |
| `openrouter_claude_fable_5` | `openrouter/anthropic/claude-fable-5` | listed | PASS / PASS / PASS (HTTP 200) | exact response model matched after credential repair |

All nine routes therefore had authenticated completion, structured-output, and
tool-call proof in the recorded runs. No substitute model or provider fallback
was used. These receipts predate the final implementation and must be repeated
on the clean candidate before they can be called current.
The initial OpenRouter attempt returned HTTP 401 because first-wins local
materialization selected a stale project credential and did not inspect the
machine-wide OpenCode `openrouter-kimi` auth store. The repair selects that
secure `0600` store before stale fallbacks and writes only to the ignored local
`.env`; no credential value is present in this receipt.

This table validates the raw provider-probe path. The first bounded production
worker comparison separately failed Cerebras GPT-OSS closed with
`response_model_identity_missing`. After the adapter required positive response
identity, the 1-by-2 and sufficient 5-by-2 worker comparisons passed Cerebras
GPT-OSS and the permitted Fireworks-fast backing identity. Those worker receipts
also predate the final candidate and remain a separate proof boundary.

## Evidence binding

- Catalog probe:
  `.pi/iterative-goal/managed/evidence/model-probes/2026-07-20T18-42-23-794Z.json`
  — SHA-256 `60d1f486ad51a05247ca5d5bdbabdbca8224d984c1259a0f00531f601f110795`.
- Final behavior probe:
  `.pi/iterative-goal/managed/evidence/model-probes/2026-07-20T18-43-03-071Z.json`
  — SHA-256 `79d73357e29496a60a7e05be9ebae9c5391360812695b42bc932b59793d46058`.
- OpenRouter candidate validation:
  `.pi/iterative-goal/managed/evidence/model-probes/2026-07-20T19-59-08-431Z.json`
  — 15 PASS / 0 WARN / 0 FAIL, SHA-256
  `2bd757024df0f4cd7d31c48afbab08e87b16bd32fb1f231941939eec9ff0c3cb`.
- Post-materialization OpenRouter validation:
  `.pi/iterative-goal/managed/evidence/model-probes/2026-07-20T20-00-46-491Z.json`
  — 15 PASS / 0 WARN / 0 FAIL, SHA-256
  `b7c5465476c934a031aeb50fc6b1a5a7d37c93ddbfc393a2cab910085bb56672`.
- Roster catalog hash recorded by both probes:
  `683bac3a4b8df5127c9c77a228288b8c87564e4a90089f8d70dd5181f76b9601`.
- Sufficient production-worker comparison:
  `.pi/iterative-goal/managed/evidence/live-worker-matrix/worker-matrix-20260720202120269-94b6c1.json`
  — 10 PASS / 0 FAIL with `sufficientData:true`, SHA-256
  `ed90179e10665b418e89dd491434256516b583dc8193183e9250f28a37281dc8`.

Raw probe JSON remains ignored, bounded local evidence. This compact receipt is
the tracked handoff. Future credential rotation must rerun all three behavior
probes; catalog success alone must never be promoted to live-inference PASS.
