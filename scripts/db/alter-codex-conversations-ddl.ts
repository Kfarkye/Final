import { Spanner } from '@google-cloud/spanner';
import * as dotenv from 'dotenv';
dotenv.config();

const projectId = process.env.SPANNER_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || 'gen-lang-client-0281999829';
const instanceId = process.env.SPANNER_INSTANCE_ID || 'clearspace';
const databaseId = process.env.SPANNER_DATABASE_ID || 'sports-mlb-db';

const spanner = new Spanner({ projectId });
const instance = spanner.instance(instanceId);
const database = instance.database(databaseId);

async function alterCodexConversationsTable() {
  const statements = [
    `ALTER TABLE codex_conversations ADD COLUMN prompt_tokens INT64`,
    `ALTER TABLE codex_conversations ADD COLUMN completion_tokens INT64`,
    `ALTER TABLE codex_conversations ADD COLUMN reasoning_tokens INT64`
  ];

  console.log(`Executing ALTER TABLE codex_conversations on Spanner...`);
  try {
    const [operation] = await database.updateSchema({ statements });
    console.log(`Waiting for operation to complete...`);
    await operation.promise();
    console.log(`Columns added successfully.`);
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

alterCodexConversationsTable().catch(console.error);
