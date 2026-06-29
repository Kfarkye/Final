#!/usr/bin/env bash
# scripts/provision-infra.sh
#
# Commercial-Grade Provisioning Script for Truth MLB Pub/Sub v1.2 Pipeline.
# Performs preflight checks, applies Spanner DDL, configures Pub/Sub topics,
# deploys Cloud Run workers, registers push subscriptions with OIDC, and verifies auth.

set -e

PROJECT_ID=$(gcloud config get-value project)
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format="value(projectNumber)")
REGION="us-central1"
IMAGE_URI="us-central1-docker.pkg.dev/${PROJECT_ID}/truth/reverie:latest"
SA_NAME="truth-ingest-invoker"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
PUBSUB_SERVICE_AGENT="service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com"

echo "=== 1. Spanner DDL Preflight ==="
# Check if any of the target tables already exist
EXISTING_TABLES=$(gcloud spanner databases execute-sql sports-mlb-db \
  --instance=clearspace \
  --sql="SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = '' AND TABLE_NAME IN ('MlbPipelineSchemaRegistry', 'MlbOddsBackfillRuns', 'MlbLiveMonitors')" \
  --format="value(table_name)")

if [ -n "$EXISTING_TABLES" ]; then
  echo "WARNING: The following Spanner tables already exist: $EXISTING_TABLES"
  echo "Proceeding with caution. DDL update will only apply missing elements."
else
  echo "Preflight clean. No conflicting v1.2 control-plane tables found."
fi

echo "=== 2. Applying Spanner DDL Migration ==="
gcloud spanner databases ddl update sports-mlb-db \
  --instance=clearspace \
  --ddl-file=src/db/migrations/002_mlb_pubsub_pipeline_v1_2.ddl

echo "=== 3. Verifying Spanner Tables Table-by-Table ==="
VERIFY_TABLES=$(gcloud spanner databases execute-sql sports-mlb-db \
  --instance=clearspace \
  --sql="SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = '' AND TABLE_NAME LIKE 'Mlb%'" \
  --format="value(table_name)")

echo "Currently active tables in sports-mlb-db:"
echo "$VERIFY_TABLES"

echo "=== 4. Creating Pub/Sub Topics ==="
# We create 8 new topics. The 9th topic (live-state-committed) already exists.
NEW_TOPICS=(
  "mlb-odds-backfill-command"
  "mlb-odds-backfill-snapshot-requested"
  "mlb-odds-backfill-snapshot-result"
  "mlb-odds-backfill-run-result"
  "mlb-live-monitor-command"
  "mlb-live-monitor-tick"
  "mlb-live-monitor-alert"
  "mlb-pipeline-dlq"
)
for topic in "${NEW_TOPICS[@]}"; do
  if gcloud pubsub topics describe "$topic" >/dev/null 2>&1; then
    echo "Topic $topic already exists."
  else
    echo "Creating topic $topic..."
    gcloud pubsub topics create "$topic"
  fi
done

echo "=== 5. Granting Pub/Sub Service Agent Publisher Rights on DLQ ==="
gcloud pubsub topics add-iam-policy-binding mlb-pipeline-dlq \
  --member="serviceAccount:${PUBSUB_SERVICE_AGENT}" \
  --role="roles/pubsub.publisher"

echo "=== 6. Deploying Cloud Run Worker Microservices ==="
SERVICES=(
  "mlb-odds-backfill-planner"
  "mlb-odds-backfill-snapshot-worker"
  "mlb-odds-backfill-result-reducer"
  "mlb-live-monitor-planner"
  "mlb-live-monitor-worker"
  "mlb-live-monitor-alert-consumer"
)
for svc in "${SERVICES[@]}"; do
  echo "Deploying Cloud Run service: $svc..."
  gcloud run deploy "$svc" \
    --image="$IMAGE_URI" \
    --region="$REGION" \
    --platform=managed \
    --no-allow-unauthenticated \
    --service-account="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
    --set-env-vars="GOOGLE_CLOUD_PROJECT=${PROJECT_ID},NODE_ENV=production"

  echo "Granting Pub/Sub invoker access to $svc..."
  gcloud run services add-iam-policy-binding "$svc" \
    --region="$REGION" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="roles/run.invoker"
done

echo "=== 7. Creating Pub/Sub Push Subscriptions ==="
# Map each topic to the corresponding service endpoint
# Format: TOPIC_NAME => SERVICE_NAME:ROUTE_PATH
declare -A SVC_MAP
SVC_MAP["mlb-odds-backfill-command"]="mlb-odds-backfill-planner:/internal/pubsub/v1/odds-backfill-command"
SVC_MAP["mlb-odds-backfill-snapshot-requested"]="mlb-odds-backfill-snapshot-worker:/internal/pubsub/v1/odds-backfill-snapshot-requested"
SVC_MAP["mlb-odds-backfill-snapshot-result"]="mlb-odds-backfill-result-reducer:/internal/pubsub/v1/odds-backfill-snapshot-result"
SVC_MAP["mlb-odds-backfill-run-result"]="mlb-odds-backfill-planner:/internal/pubsub/v1/odds-backfill-run-result"
SVC_MAP["mlb-live-monitor-command"]="mlb-live-monitor-planner:/internal/pubsub/v1/live-monitor-command"
SVC_MAP["mlb-live-monitor-tick"]="mlb-live-monitor-worker:/internal/pubsub/v1/live-monitor-tick"
SVC_MAP["live-state-committed"]="mlb-live-monitor-worker:/internal/pubsub/v1/live-state-committed" # Reusing existing topic
SVC_MAP["mlb-live-monitor-alert"]="mlb-live-monitor-alert-consumer:/internal/pubsub/v1/live-monitor-alert"
SVC_MAP["mlb-pipeline-dlq"]="mlb-live-monitor-alert-consumer:/internal/pubsub/v1/pipeline-dlq" # DLQ handler subscription

for topic in "${!SVC_MAP[@]}"; do
  val=${SVC_MAP[$topic]}
  svc=${val%%:*}
  path=${val#*:}
  
  SVC_URL=$(gcloud run services describe "$svc" --region="$REGION" --format='value(status.url)' 2>/dev/null || echo "")
  if [ -z "$SVC_URL" ]; then
    echo "ERROR: Could not find URL for service $svc. Skipping subscription."
    continue
  fi
  
  sub_name="${topic}-sub"
  if gcloud pubsub subscriptions describe "$sub_name" >/dev/null 2>&1; then
    echo "Push subscription $sub_name already exists, updating..."
    gcloud pubsub subscriptions update "$sub_name" \
      --push-endpoint="${SVC_URL}${path}" \
      --push-auth-service-account="${SA_EMAIL}" \
      --push-auth-token-audience="${SVC_URL}" \
      --dead-letter-topic="projects/${PROJECT_ID}/topics/mlb-pipeline-dlq" \
      --max-delivery-attempts=5
  else
    echo "Creating push subscription $sub_name pointing to ${SVC_URL}${path}..."
    gcloud pubsub subscriptions create "$sub_name" \
      --topic="$topic" \
      --push-endpoint="${SVC_URL}${path}" \
      --push-auth-service-account="${SA_EMAIL}" \
      --push-auth-token-audience="${SVC_URL}" \
      --dead-letter-topic="projects/${PROJECT_ID}/topics/mlb-pipeline-dlq" \
      --max-delivery-attempts=5
  fi
done

echo "=== 8. Performing OIDC Auth Negative Verification ==="
PLANNER_URL=$(gcloud run services describe mlb-live-monitor-planner --region="$REGION" --format='value(status.url)')
echo "Sending unauthenticated request to ${PLANNER_URL}/internal/pubsub/v1/live-monitor-command..."

HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${PLANNER_URL}/internal/pubsub/v1/live-monitor-command")

if [ "$HTTP_STATUS" = "401" ] || [ "$HTTP_STATUS" = "403" ]; then
  echo "✅ Auth check passed: Unauthenticated request was blocked with HTTP $HTTP_STATUS."
else
  echo "❌ Auth check FAILED: Unauthenticated request returned HTTP $HTTP_STATUS."
  exit 1
fi

echo "Infrastructure provisioning complete!"
