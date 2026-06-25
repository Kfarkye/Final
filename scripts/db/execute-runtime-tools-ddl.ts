import { Spanner } from '@google-cloud/spanner';
import * as dotenv from 'dotenv';

dotenv.config();

const projectId = process.env.GOOGLE_CLOUD_PROJECT || 'bet-turing';
const instanceId = process.env.SPANNER_INSTANCE || 'reverie-instance';
const databaseId = process.env.SPANNER_DATABASE || 'reverie-db';

const spanner = new Spanner({ projectId });

async function createRuntimeToolsTable() {
  const instance = spanner.instance(instanceId);
  const database = instance.database(databaseId);

  const request = `
    CREATE TABLE RuntimeTools (
      Name STRING(64) NOT NULL,
      Description STRING(MAX),
      Parameters JSON,
      HandlerCode STRING(MAX),
      CreatedAt TIMESTAMP OPTIONS (allow_commit_timestamp=true)
    ) PRIMARY KEY (Name)
  `;

  console.log(`Executing DDL on ${instanceId}/${databaseId}...`);
  try {
    const [operation] = await database.updateSchema(request);
    console.log(`Waiting for operation to complete...`);
    await operation.promise();
    console.log(`Table RuntimeTools created successfully.`);
  } catch (err: any) {
    if (err.message && err.message.includes('Duplicate name in schema')) {
      console.log('Table RuntimeTools already exists.');
    } else {
      console.error('Error creating table:', err);
    }
  } finally {
    await database.close();
  }
}

createRuntimeToolsTable().catch(console.error);
