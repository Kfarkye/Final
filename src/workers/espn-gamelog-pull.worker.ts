import { PubSub, Message } from '@google-cloud/pubsub';
import { Spanner } from '@google-cloud/spanner';
import * as http from 'http';

// 1. Structured JSON Logging for GCP Cloud Logging
const log = (severity: string, msg: string, data: any = {}) => {
  console.log(JSON.stringify({ severity, message: msg, ...data }));
};

// 2. Initialize Clients with strict connection boundaries
const pubsub = new PubSub();
const spanner = new Spanner();

const db = spanner
  .instance('clearspace')
  .database('sports-mlb-db', {
    min: 5,
    max: 25, // Hard cap to prevent Spanner exhaustion during KEDA spikes
  });

const performancesTable = db.table('MlbPlayerPerformances');

// 3. Flow-Controlled Subscription
const subscription = pubsub.subscription('mlb-fetch-player-gamelog-sub', {
  flowControl: { maxMessages: 20 }, // 1 Pod processes max 20 concurrently
});

// 4. Liveness/Readiness Probe Server for GKE
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('OK');
}).listen(8080, () => log('INFO', 'Health probe listening on :8080'));

// 5. Core Processing Loop
const messageHandler = async (message: Message) => {
  let espnPlayerId = 'UNKNOWN';
  try {
    const payload = JSON.parse(message.data.toString());
    espnPlayerId = payload.espnPlayerId;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const url = `https://sports.core.api.espn.com/v2/sports/baseball/mlb/athletes/${espnPlayerId}/statistics/log?season=${payload.season}`;
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
      if (response.status === 429) log('WARNING', 'ESPN 429 Rate Limit Hit', { espnPlayerId });
      throw new Error(`Upstream API returned ${response.status}`);
    }

    const data = await response.json();
    const labels: string[] = data.labels || [];
    
    // Dynamic schema mapping (Zero hardcoded index breaks)
    const statIndex = labels.reduce((acc, label, idx) => {
      acc[label.toUpperCase()] = idx;
      return acc;
    }, {} as Record<string, number>);

    const mutations = Object.entries(data.events || {}).map(([eventId, eventData]: [string, any]) => {
      const stats = eventData.stats || [];
      const getStat = (label: string): number => {
        const idx = statIndex[label];
        return idx !== undefined ? Number(stats[idx]) || 0 : 0;
      };

      return {
        GamePk: eventId,
        PlayerId: espnPlayerId,
        PlayerName: payload.playerName,
        TeamId: payload.teamId,
        AtBats: getStat('AB'),
        Hits: getStat('H'),
        HomeRuns: getStat('HR'),
        Strikeouts: getStat('K'),
        IngestedAt: Spanner.COMMIT_TIMESTAMP,
      };
    });

    if (mutations.length > 0) {
      // Idempotent UPSERT prevents duplication on at-least-once delivery
      await performancesTable.upsert(mutations);
    }

    message.ack();
    log('INFO', 'ACK: Gamelog processed', { espnPlayerId, count: mutations.length });

  } catch (err: any) {
    log('ERROR', 'NACK: Processing failed', { espnPlayerId, error: err.message });
    message.nack(); // Routes to exponential backoff and eventually DLQ
  }
};

subscription.on('message', messageHandler);

// 6. Graceful Kubernetes Teardown
let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log('INFO', `Received ${signal}, initiating graceful drain...`);

  server.close();
  // Stops pulling new messages and awaits current handlers
  await subscription.close(); 
  // Closes Spanner connection pool cleanly
  await db.close(); 

  log('INFO', 'Drain complete. Container terminating.');
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
