import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;
const pool = new Pool({
  host: process.env.SQL_HOST || 'localhost',
  user: process.env.SQL_USER || 'postgres',
  password: process.env.SQL_PASSWORD || 'password',
  database: process.env.SQL_DB_NAME || 'reverie',
});

async function checkPg() {
  console.log("Checking Postgres DB 'reverie' for data gaps...");
  try {
    const resUsers = await pool.query('SELECT COUNT(*) as c FROM users');
    console.log(`Total users: ${resUsers.rows[0].c}`);

    const resUsersNull = await pool.query('SELECT COUNT(*) as c FROM users WHERE uid IS NULL OR email IS NULL');
    console.log(`Users with NULL uid or email: ${resUsersNull.rows[0].c}`);

    const resAudit = await pool.query('SELECT COUNT(*) as c FROM audit_logs');
    console.log(`Total audit logs: ${resAudit.rows[0].c}`);

    const resAuditNull = await pool.query('SELECT COUNT(*) as c FROM audit_logs WHERE user_id IS NULL OR action IS NULL');
    console.log(`Audit logs with NULL user_id or action: ${resAuditNull.rows[0].c}`);
  } catch (e) {
    console.log("Error querying Postgres:", e.message);
  } finally {
    pool.end();
  }
}
checkPg();