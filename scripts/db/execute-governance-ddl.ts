import { Spanner } from '@google-cloud/spanner';
import * as dotenv from 'dotenv';
dotenv.config();

const projectId = process.env.SPANNER_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || 'gen-lang-client-0281999829';
const instanceId = process.env.SPANNER_INSTANCE_ID || 'clearspace';
const databaseId = process.env.SPANNER_DATABASE_ID || 'sports-mlb-db';

const spanner = new Spanner({ projectId });

async function createGovernanceTables() {
  const instance = spanner.instance(instanceId);
  const database = instance.database(databaseId);

  const request = `
    CREATE TABLE AuditLogs (
      Id STRING(36) NOT NULL,
      UserId STRING(128) NOT NULL,
      Email STRING(256) NOT NULL,
      Action STRING(256) NOT NULL,
      Details JSON,
      CreatedAt TIMESTAMP OPTIONS (allow_commit_timestamp=true)
    ) PRIMARY KEY (Id);

    CREATE TABLE RateLimits (
      Key STRING(256) NOT NULL,
      Count INT64 NOT NULL,
      ResetTime TIMESTAMP NOT NULL
    ) PRIMARY KEY (Key);
  `;

  console.log(`Executing Governance DDL on ${instanceId}/${databaseId}...`);
  try {
    // Spanner allows passing an array of statements
    const [operation] = await database.updateSchema({
      statements: [
        `CREATE TABLE IF NOT EXISTS AuditLogs (
          Id STRING(36) NOT NULL,
          UserId STRING(128) NOT NULL,
          Email STRING(256) NOT NULL,
          Action STRING(256) NOT NULL,
          Details STRING(MAX),
          CreatedAt TIMESTAMP OPTIONS (allow_commit_timestamp=true)
        ) PRIMARY KEY (Id)`,
        `CREATE TABLE IF NOT EXISTS RateLimits (
          Key STRING(256) NOT NULL,
          Count INT64 NOT NULL,
          ResetTime TIMESTAMP NOT NULL
        ) PRIMARY KEY (Key)`
      ]
    });
    console.log(`Waiting for operation to complete...`);
    await operation.promise();
    console.log(`Tables AuditLogs and RateLimits created successfully.`);
  } catch (err: any) {
    if (err.message && err.message.includes('Duplicate name in schema')) {
      console.log('Tables already exist.');
    } else {
      console.error('Error creating tables:', err);
    }
  } finally {
    await database.close();
  }
}

createGovernanceTables().catch(console.error);
