#!/usr/bin/env bash
set -e

PROJECT_ID=$(gcloud config get-value project)
REGION="us-central1"
SERVICE_NAME="truth-mlb-stats-ingest"
SA_NAME="truth-ingest-invoker"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

echo "1. Creating Service Account for Pub/Sub push identity..."
gcloud iam service-accounts create $SA_NAME \
  --display-name="Pub/Sub Ingestion Invoker" || true

echo "2. Granting Cloud Run Invoker role..."
gcloud run services add-iam-policy-binding $SERVICE_NAME \
  --region=$REGION \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/run.invoker"

echo "3. Creating Pub/Sub topics..."
gcloud pubsub topics create mlb.stats.ingest || true
gcloud pubsub topics create mlb.stats.deadletter || true

echo "4. Getting Cloud Run Service URL..."
SERVICE_URL=$(gcloud run services describe $SERVICE_NAME --region=$REGION --format='value(status.url)')

echo "5. Creating/Updating Push Subscription with OIDC..."
# Try to create, if exists update
if gcloud pubsub subscriptions describe mlb-stats-ingest-sub >/dev/null 2>&1; then
  gcloud pubsub subscriptions update mlb-stats-ingest-sub \
    --push-endpoint="${SERVICE_URL}/internal/ingest/mlb-stats" \
    --push-auth-service-account="${SA_EMAIL}" \
    --push-auth-token-audience="${SERVICE_URL}" \
    --dead-letter-topic="projects/${PROJECT_ID}/topics/mlb.stats.deadletter" \
    --max-delivery-attempts=5
else
  gcloud pubsub subscriptions create mlb-stats-ingest-sub \
    --topic=mlb.stats.ingest \
    --push-endpoint="${SERVICE_URL}/internal/ingest/mlb-stats" \
    --push-auth-service-account="${SA_EMAIL}" \
    --push-auth-token-audience="${SERVICE_URL}" \
    --dead-letter-topic="projects/${PROJECT_ID}/topics/mlb.stats.deadletter" \
    --max-delivery-attempts=5
fi

echo "Done! Ingestion plane is now wired up with OIDC auth."
