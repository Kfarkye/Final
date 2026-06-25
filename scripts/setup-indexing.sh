#!/usr/bin/env bash
# Deliverable 5: One-time setup — all programmatic on the existing GSA
# Run once after deploying. All calls use the truth-runtime GSA via Workload Identity.
set -euo pipefail

PROJECT="gen-lang-client-0281999829"
GSA="truth-runtime@${PROJECT}.iam.gserviceaccount.com"
DOMAIN="https://mcptruth.com"
SITE_URL="https://mcptruth.com/"

echo "═══ Step 1: Enable APIs ═══"
gcloud services enable \
  indexing.googleapis.com \
  searchconsole.googleapis.com \
  siteverification.googleapis.com \
  --project="$PROJECT"

echo "═══ Step 2: Grant GSA scopes ═══"
# Indexing API scope
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$GSA" \
  --role="roles/indexing.publisher" \
  --condition=None --quiet 2>/dev/null || true

# Search Console / Webmasters scope
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$GSA" \
  --role="roles/webmasters.admin" \
  --condition=None --quiet 2>/dev/null || true

# Site Verification scope
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$GSA" \
  --role="roles/siteverification.viewer" \
  --condition=None --quiet 2>/dev/null || true

# Storage (for artifact reads/writes)
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$GSA" \
  --role="roles/storage.objectAdmin" \
  --condition=None --quiet 2>/dev/null || true

echo "═══ Step 3: Site Verification — get token ═══"
echo "Get verification token via API:"
echo "  POST https://www.googleapis.com/siteVerification/v1/token"
echo '  { "site": { "type": "SITE", "identifier": "'"$DOMAIN"'" }, "verificationMethod": "FILE" }'
echo ""
echo "Deploy the token file to your server, then verify:"
echo "  POST https://www.googleapis.com/siteVerification/v1/webResource?verificationMethod=FILE"
echo '  { "site": { "type": "SITE", "identifier": "'"$DOMAIN"'" } }'
echo ""
echo "NOTE: Since the GSA controls the domain via GKE, you can also verify by:"
echo "  1. Adding a DNS TXT record (google-site-verification=...)"
echo "  2. Or adding the GSA email as an owner in Google Search Console"

echo "═══ Step 4: Add GSC property ═══"
echo "Add property via API:"
echo "  PUT https://www.googleapis.com/webmasters/v3/sites/${SITE_URL}"
echo "  (Requires the GSA to be verified owner of the domain)"

echo "═══ Step 5: Submit sitemap ═══"
echo "Submit sitemap via API:"
ENCODED_SITEMAP=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${DOMAIN}/sitemap.xml', safe=''))")
echo "  PUT https://www.googleapis.com/webmasters/v3/sites/${SITE_URL}/sitemaps/${ENCODED_SITEMAP}"

echo "═══ Step 6: Verify GSA is owner ═══"
echo "The GSA email to add as owner in Search Console:"
echo "  $GSA"
echo ""
echo "To add programmatically via Site Verification API:"
echo "  The GSA must first be verified (Step 3), then it automatically has owner access."

echo ""
echo "════════════════════════════════════════"
echo "API enabling and IAM grants are done."
echo "Steps 3-6 require domain verification."
echo "Run this after DNS propagation confirms"
echo "mcptruth.com → 136.68.40.233."
echo "════════════════════════════════════════"
