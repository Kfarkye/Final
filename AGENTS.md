# Project Database Instructions

## Environment

Default GCP project:
- dev: gen-lang-client-0281999829
- staging: gen-lang-client-0281999829
- prod: gen-lang-client-0281999829

Never operate against prod unless the prompt explicitly says prod and the user approves the exact command.

## Required Discovery Commands

Before database work, run read-only discovery:

```bash
gcloud config list
gcloud auth list
```

For Spanner:

```bash
gcloud spanner instances list
gcloud spanner databases list --instance=INSTANCE_ID
gcloud spanner databases ddl describe DATABASE_ID --instance=INSTANCE_ID
```

For AlloyDB:

```bash
gcloud alloydb clusters list --region=REGION
gcloud alloydb instances list --cluster=CLUSTER_ID --region=REGION
```

For BigQuery:

```bash
bq ls --project_id PROJECT_ID
bq ls PROJECT_ID:DATASET
bq show --format=prettyjson PROJECT_ID:DATASET.TABLE
```

## Safety

- All DML / DDL requires explicit user approval.
- Production changes require rollback plan.
- BigQuery queries over 10 GB estimated bytes require explicit approval.
- Do not create indexes without proving workload benefit.
- Do not change IAM without explicit approval.

## Deliverable Standard

Every answer must include:
- what was inspected
- what was found
- exact evidence
- recommended next action
- risk
- validation
- rollback
