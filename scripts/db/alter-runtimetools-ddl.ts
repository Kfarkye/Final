import { Spanner } from '@google-cloud/spanner';
import * as dotenv from 'dotenv';
dotenv.config();

const projectId = process.env.SPANNER_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || 'gen-lang-client-0281999829';
const instanceId = process.env.SPANNER_INSTANCE_ID || 'clearspace';
const databaseId = process.env.SPANNER_DATABASE_ID || 'sports-mlb-db';

const spanner = new Spanner({ projectId });
const instance = spanner.instance(instanceId);
const database = instance.database(databaseId);

async function alterRuntimeToolsTable() {
  const statements = [
    `ALTER TABLE RuntimeTools ADD COLUMN ApprovalHash STRING(64)`,
    `ALTER TABLE RuntimeTools ADD COLUMN ApprovedBy STRING(MAX)`,
    `ALTER TABLE RuntimeTools ADD COLUMN ApprovedAt TIMESTAMP`
  ];

  console.log(`Executing ALTER TABLE RuntimeTools on Spanner...`);
  try {
    const [operation] = await database.updateSchema({ statements });
    console.log(`Waiting for operation to complete...`);
    await operation.promise();
    console.log(`Columns ApprovalHash, ApprovedBy, ApprovedAt added successfully.`);
  } catch (err: any) {
    if (err.message && err.message.includes('Duplicate column name')) {
      console.log('Columns already exist.');
    } else {
      console.error('Error altering table:', err);
    }
  } finally {
    await database.close();
  }
}

alterRuntimeToolsTable().catch(console.error);
