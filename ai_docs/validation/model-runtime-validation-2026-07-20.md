# Exact model runtime validation — 2026-07-20

This receipt records live provider evidence for the only nine model routes
permitted by `config/model-roster.json`. It contains no credential values.
Catalog presence, authenticated inference, and behavior/tool conformance are
separate proof states.

## Result

| Profile | Exact provider/model | Catalog | Live completion / structured / tools | Boundary |
| --- | --- | --- | --- | --- |
| `zai_glm_5_2` | `zai/glm-5.2` | listed | PASS / PASS / PASS (HTTP 200) | response model `glm-5.2` |
| `fireworks_glm_5_2_max` | `fireworks/accounts/fireworks/models/glm-5p2` | listed | PASS / PASS / PASS (HTTP 200) | response model matched exactly |
| `fireworks_glm_5_2_fast` | `fireworks/accounts/fireworks/routers/glm-5p2-fast` | router is not catalog-enumerated | PASS / PASS / PASS (HTTP 200) | exact router accepted; provider reports its fixed backing model `accounts/fireworks/models/glm-5p2` |
| `openrouter_kimi_k3` | `openrouter/moonshotai/kimi-k3` | listed | BLOCKED / BLOCKED / BLOCKED (HTTP 401) | model name validated; configured authentication did not authorize inference |
| `cerebras_gpt_oss_120b` | `cerebras/gpt-oss-120b` | listed | PASS / PASS / PASS (HTTP 200) | response model matched exactly |
| `cerebras_glm_4_7` | `cerebras/zai-glm-4.7` | listed | PASS / PASS / PASS (HTTP 200) | response model matched exactly |
| `cerebras_gemma_4_31b` | `cerebras/gemma-4-31b` | listed | PASS / PASS / PASS (HTTP 200) | response model matched exactly |
| `openrouter_claude_sonnet_5` | `openrouter/anthropic/claude-sonnet-5` | listed | BLOCKED / BLOCKED / BLOCKED (HTTP 401) | model name validated; configured authentication did not authorize inference |
| `openrouter_claude_fable_5` | `openrouter/anthropic/claude-fable-5` | listed | BLOCKED / BLOCKED / BLOCKED (HTTP 401) | model name validated; configured authentication did not authorize inference |

Six routes therefore have current authenticated behavioral proof. The three
OpenRouter routes have current catalog-name proof but not authenticated
inference proof. They remain exact roster entries and fail closed; no substitute
model or provider fallback was used.

## Evidence binding

- Catalog probe:
  `.pi/iterative-goal/managed/evidence/model-probes/2026-07-20T18-42-23-794Z.json`
  — SHA-256 `60d1f486ad51a05247ca5d5bdbabdbca8224d984c1259a0f00531f601f110795`.
- Final behavior probe:
  `.pi/iterative-goal/managed/evidence/model-probes/2026-07-20T18-43-03-071Z.json`
  — SHA-256 `79d73357e29496a60a7e05be9ebae9c5391360812695b42bc932b59793d46058`.
- Roster catalog hash recorded by both probes:
  `683bac3a4b8df5127c9c77a228288b8c87564e4a90089f8d70dd5181f76b9601`.

Raw probe JSON remains ignored, bounded local evidence. This compact receipt is
the tracked handoff. A future OpenRouter credential repair must rerun all three
behavior probes and append a new receipt; catalog success alone must never be
promoted to live-inference PASS.
