# Production Security Review Read-Only Run

- Run ID: `prod-security-review-2026-06-29T12-23-33-568Z`
- Handoff: `/Users/joe/Downloads/third-party-prod-security-review-handoff-2026-06-29.md`
- Handoff SHA-256: `bd1131336a5fd4b794a757d40db83f2073c23aeb88c27f0efcb1674b042601fc`
- Mode: `read-only`
- Read-only enforced: `true`
- Secret values read: `false`
- Production mutations attempted: `false`
- Model-visible handoff context: `/Users/joe/Projects/pi-iterative-goal/ai_docs/prod_security_review/runs/prod-security-review-2026-06-29T12-23-33-568Z/handoff-model-context.md`
- Findings: `6` open, `6` new, `0` repeated
- Drift detected: `false`
- Iterations: `1`

| Iteration | PASS | FAIL | BLOCKED |
|---:|---:|---:|---:|
| 1 | 26 | 0 | 0 |

## Findings

- `SEC-001` critical new: Aurora production cluster lacks encryption or deletion protection
- `SEC-002` high new: Aurora automated snapshots are unencrypted
- `SEC-003` critical new: Pipeline Controller role can delete evidence or launch broad compute
- `SEC-004` high new: OCR adapter security group allows broad invocation or egress
- `SEC-005` medium new: Evidence bucket noncurrent version retention is too short for tamper recovery
- `SEC-006` high new: Cross-account Final Fact secrets role has broad secret discovery/read blast radius

## Commands

### Iteration 1

- `PASS` sts get-caller-identity: `aws sts get-caller-identity --profile unify-old --query '{Account:Account,Arn:Arn}' --output json`
- `PASS` sts get-caller-identity: `aws sts get-caller-identity --profile api-admin --query '{Account:Account,Arn:Arn}' --output json`
- `PASS` cloudformation describe-stacks: `aws cloudformation describe-stacks --stack-name UnifyOcrCpuStack --profile unify-old --region us-east-1`
- `PASS` cloudformation list-stack-resources: `aws cloudformation list-stack-resources --stack-name UnifyOcrCpuStack --profile unify-old --region us-east-1`
- `PASS` cloudformation describe-stacks: `aws cloudformation describe-stacks --stack-name UnifyOcrAdapterStack --profile unify-old --region us-east-1`
- `PASS` cloudformation describe-stacks: `aws cloudformation describe-stacks --stack-name UnifyOcrNemotronStack --profile unify-old --region us-east-1`
- `PASS` ec2 describe-instances: `aws ec2 describe-instances --profile unify-old --region us-east-1    --filters 'Name=tag:Component,Values=PipelineController' 'Name=instance-state-name,Values=running,stopped'`
- `PASS` iam get-role-policy: `aws iam get-role-policy    --role-name UnifyOcrCpuStack-PipelineControllerPipelineControll-eTBCkPXF2Rhe    --policy-name PipelineControllerPipelineControllerRoleDefaultPolicyA0058FF1    --profile unify-old`
- `PASS` ec2 describe-security-groups: `aws ec2 describe-security-groups --group-ids sg-0481376bdc6ec6803 sg-02f7afa7fefba100f sg-0ee7ab7b3fb81dfa9    --profile unify-old --region us-east-1`
- `PASS` s3api get-public-access-block: `aws s3api get-public-access-block --bucket ott-legal-evidence-documents --profile unify-old --region us-east-1`
- `PASS` s3api get-bucket-versioning: `aws s3api get-bucket-versioning --bucket ott-legal-evidence-documents --profile unify-old --region us-east-1`
- `PASS` s3api get-bucket-encryption: `aws s3api get-bucket-encryption --bucket ott-legal-evidence-documents --profile unify-old --region us-east-1`
- `PASS` s3api get-bucket-policy-status: `aws s3api get-bucket-policy-status --bucket ott-legal-evidence-documents --profile unify-old --region us-east-1`
- `PASS` s3api get-bucket-lifecycle-configuration: `aws s3api get-bucket-lifecycle-configuration --bucket ott-legal-evidence-documents --profile unify-old --region us-east-1`
- `PASS` s3api head-object: `aws s3api head-object --bucket ott-legal-evidence-documents    --key pipeline-controller/src/pipeline_controller/daemon.py    --profile unify-old --region us-east-1`
- `PASS` rds describe-db-clusters: `aws rds describe-db-clusters --db-cluster-identifier ott-conformance-aurora --profile unify-old --region us-east-1`
- `PASS` rds describe-db-instances: `aws rds describe-db-instances --profile unify-old --region us-east-1    --filters Name=db-cluster-id,Values=ott-conformance-aurora`
- `PASS` rds describe-db-cluster-snapshots: `aws rds describe-db-cluster-snapshots --db-cluster-identifier ott-conformance-aurora    --profile unify-old --region us-east-1`
- `PASS` ecs describe-services: `aws ecs describe-services --cluster unify-ocr-adapter-production    --services nemotron-ocr-adapter-production --profile unify-old --region us-east-1`
- `PASS` ecs describe-services: `aws ecs describe-services --cluster unify-ocr-nemotron-production    --services nemotron-ocr-production --profile unify-old --region us-east-1`
- `PASS` ecs list-tasks: `aws ecs list-tasks --cluster graph-projection-production --desired-status RUNNING    --profile unify-old --region us-east-1`
- `PASS` events describe-rule: `aws events describe-rule --name UnifyOcrCpuStack-S3ObjectCreatedRule81363060-g1xdUfu728iT    --profile unify-old --region us-east-1`
- `PASS` events describe-rule: `aws events describe-rule --name UnifyOcrCpuStack-PipelineControllerSfnCompletionRul-JocNEyYNqftn    --profile unify-old --region us-east-1`
- `PASS` secretsmanager list-secrets: `aws secretsmanager list-secrets --profile api-admin --region us-east-1    --filters Key=name,Values=final-fact    --query 'SecretList[].{Name:Name,Arn:ARN,LastChanged:LastChangedDate,KmsKeyId:KmsKeyId}'`
- `PASS` iam get-role: `aws iam get-role --role-name final-fact-secrets-reader --profile api-admin`
- `PASS` iam get-role-policy: `aws iam get-role-policy --role-name final-fact-secrets-reader    --policy-name final-fact-secrets-read --profile api-admin`
