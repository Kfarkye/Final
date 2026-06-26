#!/bin/bash
# Create Kubernetes secret from current Cloud Run env vars
# Run after: gcloud container clusters get-credentials truth-cluster --region=us-central1

kubectl create secret generic truth-secrets \
  --from-literal=GEMINI_API_KEY="$(gcloud secrets versions access latest --secret=GEMINI_API_KEY 2>/dev/null || echo 'AIzaSyB8jxdazG76gQmAXGuZYX-ix9BGN41eUlk')" \
  --from-literal=OPENAI_API_KEY="$(gcloud secrets versions access latest --secret=tenant_default_OPENAI_API_KEY 2>/dev/null || gcloud run services describe reverie --region=us-central1 --format='value(spec.template.spec.containers[0].env[OPENAI_API_KEY])')" \
  --from-literal=ANTHROPIC_API_KEY="$(gcloud secrets versions access latest --secret=tenant_default_ANTHROPIC_API_KEY 2>/dev/null || echo '')" \
  --from-literal=XAI_API_KEY="$(gcloud secrets versions access latest --secret=tenant_default_XAI_API_KEY 2>/dev/null || echo '')" \
  --from-literal=ODDS_API_KEY="$(gcloud secrets versions access latest --secret=tenant_default_ODDS_API_KEY)" \
  --from-literal=SPANNER_INSTANCE_ID="clearspace" \
  --from-literal=SPANNER_DATABASE_ID="core-db" \
  --from-literal=KALSHI_API_KEY_ID="492827c3-0101-43cc-822b-c54ca41e78a5" \
  --from-literal=YOUTUBE_API_KEY="AIzaSyBiPS9aHp9R0UhBPM-35bvn-xYbMacqsIg" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "✅ truth-secrets created/updated"
