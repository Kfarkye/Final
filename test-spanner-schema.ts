import { edgeDb } from './src/db/spanner';
async function run() {
  try {
    const [metadata] = await edgeDb.table('RuntimeTools').getMetadata();
    console.log(metadata);
  } finally {
    edgeDb.close();
  }
}
run();
