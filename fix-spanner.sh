set -euo pipefail
PROJECT="gen-lang-client-0281999829"
INSTANCE="clearspace"
DB="knowledge-db"

echo "==> Resolving runtime service account..."
SA=$(gcloud run services list --project="$PROJECT" --format="value(spec.template.spec.serviceAccountName)" 2>/dev/null | grep -v '^$' | head -n1 || true)

if [ -z "${SA:-}" ]; then
  SA=$(kubectl get deploy -A -o jsonpath='{range .items[*]}{.spec.template.spec.serviceAccountName}{"\n"}{end}' 2>/dev/null | grep -v '^$' | head -n1 || true)
  if [ -n "${SA:-}" ] && [[ "$SA" != *"@"* ]]; then
    NS=$(kubectl get deploy -A -o jsonpath='{.items[0].metadata.namespace}' 2>/dev/null || echo default)
    GSA=$(kubectl get sa "$SA" -n "$NS" -o jsonpath='{.metadata.annotations.iam\.gke\.io/gcp-service-account}' 2>/dev/null || true)
    SA="${GSA:-}"
  fi
fi

if [ -z "${SA:-}" ]; then
  PROJNUM=$(gcloud projects describe "$PROJECT" --format="value(projectNumber)")
  SA="${PROJNUM}-compute@developer.gserviceaccount.com"
  echo "WARNING: Could not auto-detect workload SA. Falling back to default compute SA: $SA"
fi
echo "==> Runtime service account: $SA"

echo "==> Granting roles/spanner.databaseAdmin on instance $INSTANCE..."
gcloud spanner instances add-iam-policy-binding "$INSTANCE" \
  --project="$PROJECT" \
  --member="serviceAccount:${SA}" \
  --role="roles/spanner.databaseAdmin"

echo "==> Ensuring database $DB exists..."
if gcloud spanner databases describe "$DB" --instance="$INSTANCE" --project="$PROJECT" >/dev/null 2>&1; then
  echo "Database $DB already exists — skipping create."
else
  gcloud spanner databases create "$DB" --instance="$INSTANCE" --project="$PROJECT"
fi

echo "==> VERIFICATION"
echo "-- IAM binding present?"
gcloud spanner instances get-iam-policy "$INSTANCE" --project="$PROJECT" \
  --flatten="bindings[].members" \
  --filter="bindings.role:roles/spanner.databaseAdmin AND bindings.members:${SA}" \
  --format="value(bindings.role)"
echo "-- Database exists?"
gcloud spanner databases describe "$DB" --instance="$INSTANCE" --project="$PROJECT" --format="value(name,state)"
echo "==> DONE."
