import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';

/**
 * Every tenant-owned table carries a NOT NULL `tenant_id` and is covered by a
 * row-level security policy (see sql/0002_policies.sql). The column is not a
 * convention we remember to filter on — it is the thing Postgres itself
 * filters on, for a role that cannot turn RLS off.
 */

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default('New conversation'),
    /** Last model used, so the UI can restore the picker after a reload. */
    lastModelId: text('last_model_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('conversations_tenant_updated_idx').on(t.tenantId, t.updatedAt)],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    /** ContentBlock[] in our provider-agnostic format — never a vendor shape. */
    content: jsonb('content').notNull(),
    /** Internal model id that produced this turn, e.g. "google:gemini-2.5-flash". */
    modelId: text('model_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('messages_conversation_idx').on(t.conversationId, t.createdAt)],
);

export const collections = pgTable(
  'collections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    embeddingModelId: text('embedding_model_id').notNull(),
    /** Runtime-tunable retrieval settings (chunk size, overlap, top-k, ...). */
    settings: jsonb('settings').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('collections_tenant_idx').on(t.tenantId)],
);

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    byteSize: integer('byte_size').notNull(),
    /** pending | processing | ready | failed */
    status: text('status').notNull().default('pending'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('documents_collection_idx').on(t.collectionId)],
);

export const chunks = pgTable(
  'chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    text: text('text').notNull(),
    /** Page number for PDFs, heading path for Markdown — whatever makes a
     *  citation clickable back to the source. */
    locator: text('locator'),
    tokenCount: integer('token_count').notNull().default(0),
    /** Dimension is fixed at 1536 to allow an HNSW index. Swapping to a model
     *  with different dimensions needs a migration — called out in DESIGN.md. */
    embedding: vector('embedding', { dimensions: 1536 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('chunks_document_idx').on(t.documentId, t.ordinal)],
);

export const requestLogs = pgTable(
  'request_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id'),
    modelId: text('model_id').notNull(),
    provider: text('provider').notNull(),
    ttftMs: integer('ttft_ms'),
    totalMs: integer('total_ms').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cachedInputTokens: integer('cached_input_tokens'),
    reasoningTokens: integer('reasoning_tokens'),
    /** numeric, not float: money in a float is how you get $0.30000000000000004.
     *  8dp because a cheap model's per-request cost is ~$0.00008 — at 6dp that
     *  is one significant figure and the truncation biases the aggregate low. */
    costUsd: numeric('cost_usd', { precision: 16, scale: 8 }).notNull().default('0'),
    finishReason: text('finish_reason').notNull(),
    retryCount: integer('retry_count').notNull().default(0),
    fallbackFrom: text('fallback_from'),
    errorKind: text('error_kind'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('request_logs_tenant_created_idx').on(t.tenantId, t.createdAt)],
);

/** Append-only trail of every tenant context the API ever opened. Answers the
 *  Section 4 question "how would you know if it had ever leaked?" */
export const tenantAccessLog = pgTable(
  'tenant_access_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    route: text('route').notNull(),
    method: text('method').notNull(),
    requestId: text('request_id').notNull(),
    rowsTouched: integer('rows_touched'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('tenant_access_log_created_idx').on(t.createdAt)],
);

export const schema = {
  tenants,
  conversations,
  messages,
  collections,
  documents,
  chunks,
  requestLogs,
  tenantAccessLog,
};

export { sql, boolean, real };
