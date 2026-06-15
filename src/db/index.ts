import { drizzle } from 'drizzle-orm/node-postgres';
import pkg from 'pg';
const { Pool } = pkg;
import * as schema from './schema.ts';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export const createPool = () => {
  if (env.DATABASE_URL) {
    return new Pool({
      connectionString: env.DATABASE_URL,
      connectionTimeoutMillis: 15000,
    });
  }

  return new Pool({
    host: env.SQL_HOST,
    user: env.SQL_USER,
    password: env.SQL_PASSWORD,
    database: env.SQL_DB_NAME,
    connectionTimeoutMillis: 15000,
  });
};

// 🛡️ Export the connection pool instance
export const pool = createPool();

pool.on('error', (err) => {
  console.error('Unexpected error on idle SQL pool client:', err);
});

export const db = drizzle(pool, { schema });

// 🛡️ Export a safe shutdown function
export const closeDatabase = async () => {
  logger.info({ msg: "Closing database connection pool..." });
  await pool.end();
};
