#!/bin/bash
# Post-deploy verification suite
# Run AFTER triggering the Kalshi ingest worker

PROJECT="gen-lang-client-0281999829"
INSTANCE="clearspace"
DB="sports-mlb-db"
SQL="gcloud spanner databases execute-sql $DB --instance=$INSTANCE --project=$PROJECT --sql"

echo "============================================="
echo "Q0: PmQuarantine write semantics (append vs upsert)"
echo "============================================="
$SQL="SELECT COUNT(*) AS total_rows, COUNT(DISTINCT CONCAT(Platform, '|', MarketId)) AS distinct_keys FROM PmQuarantine;"

echo ""
echo "============================================="
echo "Q1: Fresh resolved rows by MarketType"
echo "============================================="
$SQL="SELECT MarketType, COUNT(*) AS legs, COUNT(DISTINCT CanonicalEventId) AS distinct_events FROM PmResolvedMarket WHERE ResolvedAt >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 15 MINUTE) GROUP BY MarketType ORDER BY legs DESC;"

echo ""
echo "============================================="
echo "Q2: Eyeball resolved values"
echo "============================================="
$SQL="SELECT MarketType, Subject, Line, Comparator, CanonicalEventId FROM PmResolvedMarket WHERE ResolvedAt >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 15 MINUTE) ORDER BY MarketType LIMIT 30;"

echo ""
echo "============================================="
echo "Q3: Moneyline subject check"
echo "============================================="
$SQL="SELECT COUNTIF(Subject = 'yes') AS still_broken_yes, COUNTIF(Subject != 'yes' AND Subject != '') AS has_real_subject, COUNT(*) AS total_moneyline FROM PmResolvedMarket WHERE MarketType = 'moneyline' AND ResolvedAt >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 15 MINUTE);"

echo ""
echo "============================================="
echo "Q4: Fresh quarantine reasons"
echo "============================================="
$SQL="SELECT Reason, COUNT(*) AS cnt FROM PmQuarantine WHERE CapturedAt >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 15 MINUTE) GROUP BY Reason ORDER BY cnt DESC;"

echo ""
echo "============================================="
echo "Q5: Games on ticker-derived date"
echo "============================================="
$SQL="SELECT EventId, HomeTeamName, AwayTeamName, GameDate FROM MlbGames WHERE GameDate = CURRENT_DATE() LIMIT 15;"
