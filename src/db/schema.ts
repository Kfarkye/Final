import { relations } from 'drizzle-orm';
import { pgTable, serial, text, timestamp, jsonb, integer } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  uid: text('uid').notNull().unique(), // Firebase Auth UID
  email: text('email').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

export const auditLogs = pgTable('audit_logs', {
  id: serial('id').primaryKey(),
  userId: text('user_id').notNull(),
  email: text('email').notNull(),
  action: text('action').notNull(), 
  details: jsonb('details'), 
  createdAt: timestamp('created_at').defaultNow(),
});

export const rateLimits = pgTable('rate_limits', {
  key: text('key').primaryKey(),
  count: integer('count').notNull(),
  resetTime: timestamp('reset_time').notNull(),
});

