import { relations } from 'drizzle-orm';
import { pgTable, serial, text, timestamp, jsonb, integer, index, vector } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  uid: text('uid').notNull().unique(), // Firebase Auth UID
  email: text('email').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

export const codeChunks = pgTable('code_chunks', {
  id: serial('id').primaryKey(),
  snapshotId: text('snapshot_id').notNull(),
  path: text('path').notNull(),
  chunkIndex: integer('chunk_index').notNull(),
  content: text('content').notNull(),
  language: text('language').notNull(),
  embedding: vector('embedding', { dimensions: 768 }),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => ({
  embeddingIndex: index('embeddingIndex').using('hnsw', table.embedding.op('vector_cosine_ops')),
}));
