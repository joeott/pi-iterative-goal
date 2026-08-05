<UNTRUSTED_DATA source="/Users/joe/Downloads/third-party-prod-security-review-handoff-2026-06-29.md" sha256="bd1131336a5fd4b794a757d40db83f2073c23aeb88c27f0efcb1674b042601fc" classification="operator_handoff">
# Third-Party Production Security Review Handoff

> **Last Changed:** 2026-06-29
> **Doc Type:** prompt
> **Authority:** operational
> **Audience:** operators, review agents
> **Change Summary:** Updated third-party security review prompt to target live production attack lanes validated with read-only AWS CLI.

> Date: 2026-06-29
> Scope: actual production paths only
> Accounts validated with read-only AWS CLI: `371292405073` via profile `unify-old`; `138881449763` via profile `api-admin`
> Primary repos introspected: `unify`, `cas_migration`

Use this as prompt/context for a third-party adversarial security reviewer. This replaces older
handoffs that named retired OCR queues, retired Step Functions names, or repo manifests that drifted
from production. Treat repo docs as context, but prioritize the live AWS evidence and recent merged
PRs below.

## Review Objective

Produce a production hardening plan for the real CAS/OCR paths that are currently merged and, where
AWS confirms it, live. Do not spend review time on retired resources except where stale IAM,
EventBridge, S3 payloads, or source references can resurrect them.

The review should answer:

1. Which principals can mutate production evidence, projection state, OCR routing, graph state, or
   model/runtime secrets?
2. Which network paths can invoke OCR, projection, or S3/RDS writes?
3. Which merged controls are actually live, which are only source-merged, and which require a deploy
   or instance replacement?
4. Which attack lanes can cause cross-tenant access, evidence tampering, graph poisoning, secret
   exposure, or production write/delete impact?

## Recent PR Context To Inspect First

### `unify` production-path PRs

These PRs are the current production hardening lane. Inspect the patches and compare to live AWS:

| PR | Merge commit | Production relevance |
|---|---|---|
| `unify#5520` | `a9217084515d08ee5a9bb9c736032bfd036172f0` | Bakes Pipeline Controller `MemoryMax=1300M`, CAS-only graph projection source gate, and graph projection disable flag into CDK. Source-merged, but AWS `UnifyOcrCpuStack` last update predates this merge, so treat as not stack-proven until redeploy or instance replacement is confirmed. |
| `unify#5519` | `5c401ecfd9c08c4299d40d6c8da9fb915dbb7d68` | Culls Dropbox `rclone` sync loop from Pipeline Controller daemon. S3 controller payload was updated at `2026-06-29T10:09:54Z` and key file MD5s match `origin/main`, so this code payload is live for the daemon source tree. |
| `unify#5516` | `9b0d2c2940178dfa464495a14711a64d3e6dd7fb` | Adds `PC_GRAPH_PROJECTION_CAS_ONLY` source gate. S3 controller payload MD5s match `origin/main`, but verify the running daemon environment before assuming the flag is enabled. |
| `unify#5515` | `e10f8d864be2c509fb51f27de3dcc2a09c8b2b97` | Graph projection prune/reconcile hardening. Lambda updated `2026-06-28T22:19:34Z`; validate runtime flags and dry-run posture. |
| `unify#5514` | `91c73a39cf7c8f1288e204bb0e21efa0ba485510` | Graph projection ECS/RDS accounting reconciliation and orphan reaper, dry-run default. |
| `unify#5513` | `8cbca9e625dff333a69556fae6867bdd8d2d2c8d` | Removes legacy `UnifyOcrStack` and `UnifyOcrGpuStack` source to prevent resurrection. |
| `unify#5512` | `d2c593f121c2c21eb7e90d1668351cabfec8c20a` | Removes dead OCR-worker queue refs and imported exports after queue deletion. |
| `unify#5511` | `2445e6d498c60b5a29e48d150bda59c9a0bb96ec` | Retires SQS break-glass commands from `unify-cli`. |
| `unify#5507` | `583d8b3c81efa58e938570af84b7b6c55284a8da` | Fixes synth credential scanner regression around `LEAD_INTAKE_SECRET`. Review as CI/deploy guardrail, not runtime control. |
| `unify#5497` | `bce70b6eea5b0b64368d3d9b6ed796f505a939c3` | NIM lifecycle resilience for concurrent update errors. |
| `unify#5496` | `d04b4c22261bc9069ebe68fb0550b4fb67055caa` | Modglin image/oversize admission through CpuStack deploy. |
| `unify#5495` | `dfcd347087ff90a5bd80bbf8973bf810e68b2a8e` | Durable Pipeline Controller to OCR adapter egress. AWS SG confirms egress to adapter SG is present. |

### `cas_migration` control PRs

Inspect current `origin/main`, not only the older PR list. GitHub PR list shows control PRs through
`#256`, while `origin/main` also contains later direct commits on 2026-06-28 and 2026-06-29 that
advance repo locks and current state.

Important PRs:

| PR | Merge commit | Production relevance |
|---|---|---|
| `cas_migration#256` | `3c03381302c439c8bee445dd8eabcec9fc801bdd` | Lock #1 SDK gate extension and canonical image-first geometry doctrine. |
| `cas_migration#253` | `ac6d72920270cc2d947b21e041b4cf3e372fe704` | Strict flip for consumer OCR inference gate. |
| `cas_migration#250` | `62016b4b088681015bbc4c23b4ff6208b81c8d2f` | Single locked system foundation, repo-lock auto-advance, disk hygiene, AWS conformance. |

Important later `cas_migration` commits observed on `origin/main`:

| Commit | Relevance |
|---|---|
| `8e788b4` | Records WS-1 sync-cull deployed/live-proven and WS-3 dual-writer design. |
| `2e8ec1b` | Emits standing goal and S38 canonical loop target. |
| `88a42d3` | Advances repo-lock to `unify` `5c401ecfd9`, post-`#5519` sync-cull. |
| `ea3843c` and `2a176c5` | Session 36/37 state consolidation around graph projection and canonical-CAS proof target. |

## Live Production AWS State

Validated with read-only AWS CLI on 2026-06-29.

### Account identities

| Profile | Account | Principal |
|---|---:|---|
| `unify-old` | `371292405073` | `arn:aws:iam::371292405073:user/admin` |
| `api-admin` | `138881449763` | `arn:aws:iam::138881449763:user/api_admin` |
| `default` | `138881449763` | `arn:aws:iam::138881449763:user/api_admin` |
| `cost-audit-bot` | `138881449763` | `arn:aws:iam::138881449763:user/cost-audit-bot` |

### Confirmed live resources

| Resource | Live state |
|---|---|
| Evidence bucket `ott-legal-evidence-documents` | Exists in `us-east-1`; public access blocked; policy status not public; versioning enabled; SSE-S3 encryption enabled; server access logging enabled to `ott-legal-evidence-documents-access-logs-371292405073`; noncurrent versions expire after 7 days. |
| Aurora cluster `ott-conformance-aurora` | Exists and available; engine `aurora-postgresql` `16.11`; `DeletionProtection=false`; `StorageEncrypted=false`; `MultiAZ=false`; instance is not public but also unencrypted and not deletion-protected; latest automated snapshots are unencrypted. |
| `UnifyOcrCpuStack` | `UPDATE_COMPLETE`; last updated `2026-06-28T22:19:25Z`; termination protection enabled. This predates `unify#5520`, so `#5520` CDK/user-data settings are not stack-proven. |
| Pipeline Controller EC2 | Instance `i-08607cbba0428d73c`; running; `t4g.small`; launched `2026-06-26T00:40:06Z`; private IP `172.31.43.119`; role `UnifyOcrCpuStack-PipelineControllerPipelineControll-eTBCkPXF2Rhe`; SG `sg-0481376bdc6ec6803`. |
| Pipeline Controller code payload | S3 prefix `s3://ott-legal-evidence-documents/pipeline-controller/`; relevant files updated `2026-06-29T10:09:54Z`; MD5s for `daemon.py`, `config.py`, `graph_projection.py`, and `db.py` match `unify origin/main`. |
| Pipeline Controller heartbeat alarms | `DaemonHeartbeat` and `RedisReachable` alarms are `OK` with actions enabled. |
| OCR adapter stack | `UnifyOcrAdapterStack` `UPDATE_COMPLETE`, last updated `2026-06-26T01:46:19Z`; service `nemotron-ocr-adapter-production` has desired/running `1/1`, no public IP, SG `sg-02f7afa7fefba100f`. |
| Nemotron stack | `UnifyOcrNemotronStack` `UPDATE_COMPLETE`, last updated `2026-06-19T22:41:17Z`; ECS service `nemotron-ocr-production` desired/running `0/0`, no public IP when tasks run, SG `sg-0ee7ab7b3fb81dfa9`; task image is digest-pinned from `unify/nemotron-parse`. |
| Graph projection | ECS cluster `graph-projection-production`; task definition `graph-projection-production:135`; no running tasks at validation time; Lambda `UnifyOcrCpuStack-GraphProjectionFunction087CA7C7-asYT9z6Dslot` last modified `2026-06-28T22:19:34Z`. |
| Final Fact secrets account | Secrets `final-fact/*` exist in account `138881449763`; role `final-fact-secrets-reader` exists and trusts `arn:aws:iam::371292405073:role/unify-vpc-workbench-role`. |

### Retired or stale identifiers

Do not base findings on these as active paths unless a reviewer discovers a resurrection route:

| Old identifier | Live result |
|---|---|
| SQS queue `ocr-xlarge-production` | `GetQueueUrl` returned `NonExistentQueue`. |
| Step Functions state machine `OCRProcessing` | `DescribeStateMachine` returned `StateMachineDoesNotExist`. |
| ECR repo `nemotron-parse-mirror` | `DescribeRepositories` returned `RepositoryNotFoundException`. Actual Nemotron repo is `unify/nemotron-parse`. |

## Production Trust Boundaries

1. Local Mac and GitHub Actions to AWS deploy paths.
2. `cas_migration` control repo to `unify` source, repo-locks, gates, and operational docs.
3. Pipeline Controller EC2 to S3, RDS, ECS, Lambda, Step Functions, SQS, DynamoDB, CloudWatch,
   SSM, Auto Scaling, Redis, Neo4j, and OCR adapter.
4. OCR adapter ECS to S3 document reads and Nemotron lifecycle controls.
5. Nemotron ECS service to validation SQS, S3, DynamoDB, and Step Functions task callbacks.
6. Graph projection Lambda/ECS to Aurora, Neo4j secrets, and graph writes.
7. S3 object-created events to Dropbox sync queue and downstream intake.
8. Cross-account `final-fact-secrets-reader` trust from `unify-vpc-workbench-role` to
   `final-fact/*` secrets in account `138881449763`.

## Attack Lane Matrix

Prioritize concrete production lanes below.

| Lane | Attacker position | Attack path | Current evidence | Impact | Primary hardening ask |
|---|---|---|---|---|---|
| PC-1 Pipeline Controller role takeover | Compromised PC instance, SSM path, S3 code payload, or any principal that can replace PC code | Use PC role to `s3:PutObject/DeleteObject` in evidence bucket, start arbitrary account Step Functions, invoke `UnifyOcrCpuStack-*` and `UnifyCoreStack-*` Lambdas, `ecs:RunTask/UpdateService` on `*`, and `iam:PassRole` to any role in account to ECS tasks | IAM role has these permissions live; PC instance is running | Evidence tampering, graph poisoning, unauthorized compute, lateral movement through task roles | Scope PC IAM by exact task definitions, cluster ARNs, Lambda ARNs, pass-role ARNs, S3 prefixes, and deny deletes on CAS prefixes. Add permission boundaries or SCP-style explicit denies where possible. |
| PC-2 Controller code supply chain through S3 prefix | Principal with write to `s3://ott-legal-evidence-documents/pipeline-controller/` | Replace daemon source; next sync/restart/instance replacement runs malicious code under PC role | S3 payload is the deployed source of truth and matches `origin/main`; bucket versioning enabled but noncurrent expires after 7 days | Full PC-1 capability under production role | Move controller artifacts to a dedicated deployment bucket/prefix with CI-only write, signed manifest/checksum pin, object lock or long retention, and startup checksum validation. |
| PC-3 Source-merged but not stack-proven hardening | Operator assumes `unify#5520` is live | Instance replacement or redeploy may still not have `MemoryMax=1300M`, durable `PC_GRAPH_PROJECTION_ENABLED=false`, and baked CAS-only tenant allowlist unless stack update/replacement is proven | `UnifyOcrCpuStack` last update `2026-06-28T22:19Z`; `#5520` merged `2026-06-29T10:55Z` | Re-enable graph projection defaults, lose memory cap on replacement, return to unsafe source-gate posture | Require a deploy evidence gate: stack update timestamp after `#5520`, new PC instance launch time after stack update, and read-only verification of emitted user data or `.env` without printing secrets. |
| OCR-1 Adapter invocation from broad VPC | Any compromised workload in `172.31.0.0/16` | Send requests to adapter port 8080 and attempt `/ocr/s3` against permitted S3 keys | Adapter SG allows ingress 8080 from `172.31.0.0/16`; service desired/running `1/1`; no public IP | Unauthorized OCR of legal evidence, cost abuse, document disclosure via OCR response path | Restrict ingress to PC SG and intended ALB/SG only. Add request authentication/signing and allowlisted S3 prefixes/project IDs at the adapter. |
| OCR-2 Adapter outbound egress | Compromised adapter container or exploited OCR input | Exfiltrate through `0.0.0.0/0` egress or reach unexpected services | Adapter SG allows all outbound traffic | Legal evidence exfiltration and command/control | Replace all-egress with VPC endpoints and exact upstreams. Add egress deny/default and CloudWatch/VPC flow detection. |
| OCR-3 Nemotron task callback scope | Compromised Nemotron worker task | Use `states:SendTaskSuccess/Failure/Heartbeat` on `*`; write/read S3; mutate DDB checkpoint tables | Nemotron task role has `states:SendTask*` on `*`, S3 read/write to evidence bucket, DDB access; no public IP and egress constrained to RDS/AWS endpoints | Poison OCR completion state or artifact metadata | Scope Step Functions callbacks to actual state machine ARNs still in use, or remove if validation queue is the only live route. Prove task-token contract cannot be replayed or cross-run confused. |
| GRAPH-1 Projection graph poisoning | Compromised PC, graph task, Lambda role, or project eligibility bug | Launch graph-projection task or invoke Lambda to write Neo4j projection from non-CAS or wrong-tenant data | Graph task exists; Lambda exists; no running task at validation time; source-gate code is in S3 payload but running flag state not verified | Legal work product retrieval/citation pollution | Verify `PC_GRAPH_PROJECTION_ENABLED` and `PC_GRAPH_PROJECTION_CAS_ONLY` on the running daemon. Require projection inputs to carry CAS provenance and tenant/project allowlist at task runtime, not only scheduler runtime. |
| GRAPH-2 Graph Lambda master credential blast radius | Compromised graph Lambda role | Read RDS master/app secrets, execute RDS Data API, read Neo4j secret, read evidence bucket | Lambda role policy allows RDS Data API and Secrets Manager for app/master/Neo4j secrets | DB/graph compromise, tenant isolation bypass | Remove master password from graph projection role; use a minimal DB role with forced RLS and stored procedures or restricted SQL; scope S3 reads to graph input prefixes. |
| RDS-1 Aurora unencrypted and no deletion protection | AWS principal with RDS or snapshot access, or operational accident | Snapshot copy/share/read unencrypted data, delete/replace cluster, or lose cluster | Cluster and latest automated snapshots report `StorageEncrypted=false`; `DeletionProtection=false`; instance not public | High-severity confidentiality and availability risk for multi-tenant legal DB | Plan encrypted-cluster migration via snapshot restore/cutover, enable deletion protection, define backup/restore evidence gate. |
| S3-1 CAS/evidence overwrite or delete | Any principal with object write/delete, including PC role | Overwrite/delete evidence or CAS keys; rollback window limited by lifecycle | Bucket public blocked, versioning enabled, logging enabled; lifecycle expires noncurrent versions after 7 days; PC role has `s3:DeleteObject`, `PutObject`, `GetObject` on bucket | Evidence tampering, data loss, silent replacement | Deny deletes and overwrites on `cas/blake3/*`; use object lock/governance retention for CAS prefixes; extend noncurrent retention for evidence; add CloudTrail data events and alerting. |
| S3-2 EventBridge object-injection into intake | Principal can put matching S3 keys | Create object under `input/dropbox-sync/`, `0060fe67-.../`, or `7bc302c6-.../`; EventBridge sends to Dropbox sync queue | S3 object-created rule is enabled and targets `UnifyOcrCpuStack-DropboxSyncEventQueue...` | Unauthorized intake, tenant/project pollution, queue abuse | Validate producer identity, object key schema, tenant/project allowlist, and manifest CAS before queue processing. |
| SFN-1 Broad completion callback rule | Any Step Functions execution in account | Trigger `PipelineControllerSfnCompletionCallback` on any state machine status event matching broad prefix | EventBridge rule is enabled with three duplicate broad `arn:aws:states:...:stateMachine:` prefixes | Callback noise, state confusion, possible completion poisoning if handler lacks strict correlation | Narrow to exact live state machines or remove if retired. Handler must require run correlation and reject unknown executions. |
| XACCT-1 Cross-account Final Fact secrets | Compromised `unify-vpc-workbench-role` in prod account | Assume `final-fact-secrets-reader` and read provider/Neo4j/Pinecone/etc. secrets in account `138881449763` | Role exists; trust is prod workbench role; policy grants `GetSecretValue/DescribeSecret` on `final-fact/*` and `ListSecrets` on `*` | Exfiltration of model/runtime tokens and graph credentials | Add external ID or session tag condition, narrow `ListSecrets`, split secrets by purpose, alert on AssumeRole and GetSecretValue. |
| CI-1 Deploy credential leakage | GitHub Actions or CDK synth exposes secret values | Secrets appear in synth templates, logs, traces, or artifacts | `unify#5507` fixed a scanner regression; `cas_migration#253/#256` harden gates | Secret exposure leading to direct runtime compromise | Re-run synth credential scanner on current `origin/main`; require scanner output in deploy evidence package. |
| AGENT-1 Agent or shell bypass | Compromised model context, repo instruction injection, or unsafe tool runner | Bypass `goal_shell`/guardrails, print secrets, run production mutation, or emit sensitive traces | `pi-iterative-goal` has safe shell/DLP/tracing controls, but it handles `.env`, AWS secrets persistence, model tokens, and headless traces | Secret leakage and unauthorized AWS writes | Review agent tools against production denylist. Validate traces redact secrets and cannot carry evidence text/model tokens. |

## Non-Targets Unless Resurrection Is Found

The following should be noted only as cleanup/resurrection risks:

- `ocr-xlarge-production`, `ocr-small-production`, `ocr-medium-production`, `ocr-large-production`,
  and old OCR worker DLQs.
- `OCRProcessing` as the old OCR Step Functions state machine.
- ECR `nemotron-parse-mirror`.
- Legacy `UnifyOcrStack` and `UnifyOcrGpuStack` source after `unify#5513`.
- `unify-cli` `classified-retry` and `drain-dlq` after `unify#5511`.

## Required Reviewer Output

Return findings in this schema:

```json
{
  "id": "SEC-###",
  "title": "",
  "severity": "critical|high|medium|low",
  "affected_repo": "unify|cas_migration|pi-iterative-goal|final_fact|spax",
  "affected_resource": "",
  "production_status": "live|source_merged_not_deployed|retired|unknown",
  "attack_lane": "",
  "attack_path": "",
  "evidence": "",
  "impact": "",
  "reproduction_steps_read_only": [],
  "fix": "",
  "regression_gate": "",
  "owner": "",
  "requires_production_access": false,
  "requires_operator_approval": false
}
```

For every confirmed vulnerability, provide:

1. Code/config/IAM fix.
2. Regression gate or read-only validation command.
3. Evidence artifact proving the fix.
4. Rollback or containment plan.

Prioritize:

1. Aurora encryption/deletion protection and DB credential blast radius.
2. Pipeline Controller IAM and S3 code-supply chain.
3. Adapter ingress/egress and OCR invocation authorization.
4. Evidence bucket CAS delete/overwrite hardening.
5. Graph projection source-gate/runtime-flag proof and graph poisoning controls.
6. Cross-account secrets trust.
7. CI/deploy scanner and agent trace redaction.

## Safe Read-Only Validation Commands

Do not print secret values. Do not run production mutations. These commands are safe discovery:

```bash
aws sts get-caller-identity --profile unify-old --query '{Account:Account,Arn:Arn}' --output json
aws sts get-caller-identity --profile api-admin --query '{Account:Account,Arn:Arn}' --output json

aws cloudformation describe-stacks --stack-name UnifyOcrCpuStack --profile unify-old --region us-east-1
aws cloudformation list-stack-resources --stack-name UnifyOcrCpuStack --profile unify-old --region us-east-1
aws cloudformation describe-stacks --stack-name UnifyOcrAdapterStack --profile unify-old --region us-east-1
aws cloudformation describe-stacks --stack-name UnifyOcrNemotronStack --profile unify-old --region us-east-1

aws ec2 describe-instances --profile unify-old --region us-east-1 \
  --filters 'Name=tag:Component,Values=PipelineController' 'Name=instance-state-name,Values=running,stopped'

aws iam get-role-policy \
  --role-name UnifyOcrCpuStack-PipelineControllerPipelineControll-eTBCkPXF2Rhe \
  --policy-name PipelineControllerPipelineControllerRoleDefaultPolicyA0058FF1 \
  --profile unify-old

aws ec2 describe-security-groups --group-ids sg-0481376bdc6ec6803 sg-02f7afa7fefba100f sg-0ee7ab7b3fb81dfa9 \
  --profile unify-old --region us-east-1

aws s3api get-public-access-block --bucket ott-legal-evidence-documents --profile unify-old --region us-east-1
aws s3api get-bucket-versioning --bucket ott-legal-evidence-documents --profile unify-old --region us-east-1
aws s3api get-bucket-encryption --bucket ott-legal-evidence-documents --profile unify-old --region us-east-1
aws s3api get-bucket-policy-status --bucket ott-legal-evidence-documents --profile unify-old --region us-east-1
aws s3api get-bucket-lifecycle-configuration --bucket ott-legal-evidence-documents --profile unify-old --region us-east-1

aws s3api head-object --bucket ott-legal-evidence-documents \
  --key pipeline-controller/src/pipeline_controller/daemon.py \
  --profile unify-old --region us-east-1

aws rds describe-db-clusters --db-cluster-identifier ott-conformance-aurora --profile unify-old --region us-east-1
aws rds describe-db-instances --profile unify-old --region us-east-1 \
  --filters Name=db-cluster-id,Values=ott-conformance-aurora
aws rds describe-db-cluster-snapshots --db-cluster-identifier ott-conformance-aurora \
  --profile unify-old --region us-east-1

aws ecs describe-services --cluster unify-ocr-adapter-production \
  --services nemotron-ocr-adapter-production --profile unify-old --region us-east-1
aws ecs describe-services --cluster unify-ocr-nemotron-production \
  --services nemotron-ocr-production --profile unify-old --region us-east-1
aws ecs list-tasks --cluster graph-projection-production --desired-status RUNNING \
  --profile unify-old --region us-east-1

aws events describe-rule --name UnifyOcrCpuStack-S3ObjectCreatedRule81363060-g1xdUfu728iT \
  --profile unify-old --region us-east-1
aws events describe-rule --name UnifyOcrCpuStack-PipelineControllerSfnCompletionRul-JocNEyYNqftn \
  --profile unify-old --region us-east-1

aws secretsmanager list-secrets --profile api-admin --region us-east-1 \
  --filters Key=name,Values=final-fact \
  --query 'SecretList[].{Name:Name,Arn:ARN,LastChanged:LastChangedDate,KmsKeyId:KmsKeyId}'
aws iam get-role --role-name final-fact-secrets-reader --profile api-admin
aws iam get-role-policy --role-name final-fact-secrets-reader \
  --policy-name final-fact-secrets-read --profile api-admin
```

## Evidence Package Template

Each remediation should produce an evidence bundle:

```markdown
# Production Security Evidence
## Finding IDs
## Repos and commits
## AWS account and region
## Resources changed
## Pre-change read-only evidence
## Approved change command or PR
## Post-change read-only evidence
## Regression gates
## Rollback plan
## Residual risk
```

## Hard Rules For The Reviewer

- Do not ask for or print secrets.
- Do not recommend production mutation as a discovery step.
- Do not treat a merged PR as deployed without AWS evidence.
- Do not treat legacy paths as active without live resource evidence.
- Do not collapse accounts `371292405073` and `138881449763`.
- Do not treat S3 keys, RDS row IDs, Neo4j IDs, vector IDs, or UUIDs as canonical evidence identity.
- CAS byte identity remains `cas:blake3:<64-hex>` and evidence S3 keys under `cas/blake3/<2>/<62>` require stricter immutability than compatibility/source prefixes.

</UNTRUSTED_DATA>

<REVIEW_CONSTRAINTS>
- Use only the extracted safe read-only AWS/repo inspection commands.
- Do not perform production mutations.
- Do not read secret values.
- Treat retired OCR/SQS/Step Functions identifiers only as resurrection risks unless live read-only evidence contradicts retirement.
</REVIEW_CONSTRAINTS>