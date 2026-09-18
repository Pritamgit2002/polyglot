import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { chunks, collections, documents, withTenant } from '@polyglot/db';
import { loadConfig } from '@polyglot/core';
import { defaultRetrievalSettings, extractText, ingestDocument, retrieve } from '../services/rag.js';

const ALLOWED_MIME = new Set([
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'application/octet-stream', // browsers send this for .md surprisingly often
]);

const ALLOWED_EXT = /\.(pdf|txt|md|markdown)$/i;

const createCollection = z.object({
  name: z.string().min(1).max(120),
  embeddingModelId: z.string().max(120).optional(),
  settings: z
    .object({
      chunkSize: z.number().int().min(100).max(8000),
      chunkOverlap: z.number().int().min(0).max(2000),
      topK: z.number().int().min(1).max(50),
      similarityThreshold: z.number().min(0).max(1),
    })
    .partial()
    .optional(),
});

const idParam = z.object({ id: z.string().uuid() });
const searchQuery = z.object({ q: z.string().min(1).max(500), topK: z.coerce.number().int().min(1).max(20).optional() });

export function registerDocumentRoutes(app: FastifyInstance): void {
  app.get('/api/collections', async (req) =>
    withTenant(req.tenantId, (tx) => tx.select().from(collections).orderBy(desc(collections.createdAt))),
  );

  app.post('/api/collections', async (req, reply) => {
    const body = createCollection.parse(req.body ?? {});
    const cfg = loadConfig();
    const [row] = await withTenant(req.tenantId, (tx) =>
      tx
        .insert(collections)
        .values({
          tenantId: req.tenantId,
          name: body.name,
          embeddingModelId: body.embeddingModelId ?? cfg.defaults.embeddingModel,
          settings: { ...defaultRetrievalSettings(), ...(body.settings ?? {}) },
        })
        .returning(),
    );
    return reply.code(201).send(row);
  });

  app.get('/api/collections/:id/documents', async (req) => {
    const { id } = idParam.parse(req.params);
    return withTenant(req.tenantId, (tx) => tx.select().from(documents).where(eq(documents.collectionId, id)));
  });

  /** Upload + ingest. Synchronous on purpose for a take-home; a real system
   *  would enqueue this and poll `status`, which is why the column exists. */
  app.post('/api/collections/:id/documents', async (req, reply) => {
    const { id: collectionId } = idParam.parse(req.params);

    const file = await req.file();
    if (!file) return reply.code(400).send({ error: { kind: 'bad_request', message: 'No file uploaded.' } });

    // Validate BOTH the declared type and the extension. The declared type is
    // client-controlled and the extension is user-controlled, so neither alone
    // is trustworthy — and `filename` is never used to build a path.
    if (!ALLOWED_MIME.has(file.mimetype) || !ALLOWED_EXT.test(file.filename)) {
      return reply.code(415).send({ error: { kind: 'bad_request', message: 'Only PDF, TXT and Markdown are accepted.' } });
    }

    const buffer = await file.toBuffer(); // @fastify/multipart enforces the size cap
    const collection = (
      await withTenant(req.tenantId, (tx) => tx.select().from(collections).where(eq(collections.id, collectionId)).limit(1))
    )[0];
    if (!collection) return reply.code(404).send({ error: { kind: 'not_found', message: 'Collection not found.' } });

    const [doc] = await withTenant(req.tenantId, (tx) =>
      tx
        .insert(documents)
        .values({
          tenantId: req.tenantId,
          collectionId,
          filename: file.filename.slice(0, 250),
          mimeType: file.mimetype,
          byteSize: buffer.byteLength,
          status: 'processing',
        })
        .returning(),
    );

    try {
      const text = await extractText(buffer, file.mimetype, file.filename);
      const { chunkCount } = await ingestDocument({
        tenantId: req.tenantId,
        collectionId,
        documentId: doc!.id,
        text,
        embeddingModelId: collection.embeddingModelId,
        settings: { ...defaultRetrievalSettings(), ...(collection.settings as object) },
      });
      return reply.code(201).send({ ...doc, status: 'ready', chunkCount });
    } catch (e) {
      req.log.error({ err: e }, 'ingestion failed');
      await withTenant(req.tenantId, (tx) =>
        tx.update(documents).set({ status: 'failed', error: 'Ingestion failed.' }).where(eq(documents.id, doc!.id)),
      );
      return reply.code(422).send({ error: { kind: 'bad_request', message: 'Could not extract text from that file.' } });
    }
  });

  /** Lets the UI show the retrieved chunk text — Module C requires the user to
   *  be able to inspect what a citation actually points at. */
  app.get('/api/collections/:id/search', async (req) => {
    const { id } = idParam.parse(req.params);
    const { q, topK } = searchQuery.parse(req.query);

    const collection = (
      await withTenant(req.tenantId, (tx) => tx.select().from(collections).where(eq(collections.id, id)).limit(1))
    )[0];
    if (!collection) return { results: [] };

    const settings = { ...defaultRetrievalSettings(), ...(collection.settings as object), ...(topK ? { topK } : {}) };
    return {
      results: await retrieve({
        tenantId: req.tenantId,
        collectionId: id,
        query: q,
        settings,
        embeddingModelId: collection.embeddingModelId,
      }),
    };
  });

  app.get('/api/chunks/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [row] = await withTenant(req.tenantId, (tx) =>
      tx.select({ id: chunks.id, text: chunks.text, locator: chunks.locator, ordinal: chunks.ordinal }).from(chunks).where(eq(chunks.id, id)).limit(1),
    );
    if (!row) return reply.code(404).send({ error: { kind: 'not_found', message: 'Chunk not found.' } });
    return row;
  });
}
