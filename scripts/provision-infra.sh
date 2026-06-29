#!/usr/bin/env bash
# scripts/provision-infra.sh
set -e

PROJECT_ID=$(gcloud config get-value project)
REGION="us-central1"
IMAGE_URI="us-central1-docker.pkg.dev/${PROJECT_ID}/truth/reverie:latest"
SA_NAME="truth-ingest-invoker"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

echo "1. Applying Spanner DDL to clearspace/sports-mlb-db..."
gcloud spanner databases ddl update sports-mlb-db \
  --instance=clearspace \
  --ddl-file=src/db/migrations/002_mlb_pubsub_pipeline_v1_2.ddl

echo "2. Creating Pub/Sub topics..."
TOPICS=(
  "mlb-odds-backfill-command"
  "mlb-odds-backfill-snapshot-requested"
  "mlb-odds-backfill-snapshot-result"
  "mlb-odds-backfill-run-result"
  "mlb-live-monitor-command"
  "mlb-live-monitor-tick"
  "mlb-live-monitor-alert"
  "mlb-pipeline-dlq"
)
for topic in "${TOPICS[@]}"; do
  gcloud pubsub topics create "$topic" || true
done

echo "3. Deploying Cloud Run services..."
SERVICES=(
  "mlb-odds-backfill-planner"
  "mlb-odds-backfill-snapshot-worker"
  "mlb-odds-backfill-result-reducer"
  "mlb-live-monitor-planner"
  "mlb-live-monitor-worker"
  "mlb-live-monitor-alert-consumer"
)
for svc in "${SERVICES[@]}"; do
  echo "Deploying $svc..."
  gcloud run deploy "$svc" \
    --image="$IMAGE_URI" \
    --region="$REGION" \
    --platform=managed \
    --no-allow-unauthenticated \
    --service-account="${PROJECT_ID}-compute@developer.gserviceaccount.com" \
    --set-env-vars="GOOGLE_CLOUD_PROJECT=${PROJECT_ID}" || true

  echo "Granting invoker access to $svc..."
  gcloud run services add-iam-policy-binding "$svc" \
    --region="$REGION" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="roles/run.invoker" || true
done

echo "4. Creating Pub/Sub push subscriptions..."
# Map each topic to the corresponding service endpoint
declare -A SVC_MAP
SVC_MAP["mlb-odds-backfill-command"]="mlb-odds-backfill-planner:/internal/pubsub/odds-backfill-command"
SVC_MAP["mlb-odds-backfill-snapshot-requested"]="mlb-odds-backfill-snapshot-worker:/internal/pubsub/odds-backfill-snapshot-requested"
SVC_MAP["mlb-odds-backfill-snapshot-result"]="mlb-odds-backfill-result-reducer:/internal/pubsub/odds-backfill-snapshot-completed"
SVC_MAP["mlb-odds-backfill-run-result"]="mlb-odds-backfill-planner:/internal/pubsub/odds-backfill-run-completed"
SVC_MAP["mlb-live-monitor-command"]="mlb-live-monitor-planner:/internal/pubsub/live-monitor-command"
SVC_MAP["mlb-live-monitor-tick"]="mlb-live-monitor-worker:/internal/pubsub/live-monitor-tick"
SVC_MAP["mlb-live-monitor-alert"]="mlb-live-monitor-alert-consumer:/internal/pubsub/live-monitor-alert"

for topic in "${!SVC_MAP[@]}"; do
  val=${SVC_MAP[$topic]}
  svc=${val%%:*}
  path=${val#*:}
  
  echo "Getting URL for $svc..."
  SVC_URL=$(gcloud run services describe "$svc" --region="$REGION" --format='value(status.url)' 2>/dev/null || echo "")
  if [ -z "$SVC_URL" ]; then
    echo "Could not find URL for service $svc. Skipping subscription creation."
    continue
  fi
  
  sub_name="${topic}-sub"
  echo "Creating push subscription $sub_name pointing to ${SVC_URL}${path}..."
  gcloud pubsub subscriptions create "$sub_name" \
    --topic="$topic" \
    --push-endpoint="${SVC_URL}${path}" \
    --push-auth-service-account="${SA_EMAIL}" \
    --push-auth-token-audience="${SVC_URL}" \
    --dead-letter-topic="projects/${PROJECT_ID}/topics/mlb-pipeline-dlq" \
    --max-delivery-attempts=5 || true
done

echo "Infrastructure provisioning complete!"
