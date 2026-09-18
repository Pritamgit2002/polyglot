import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { ZodError } from 'zod';
import { isProviderError, loadConfig } from '@polyglot/core';
import { registerTenantGuard } from './middleware/tenant.js';
import { registerModelRoutes } from './routes/models.js';
import { registerConversationRoutes } from './routes/conversations.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerDocumentRoutes } from './routes/documents.js';
import { registerMetricsRoutes } from './routes/metrics.js';

const PORT = Number(process.env.API_PORT ?? 3001);
const MAX_REQUEST_BYTES = Number(process.env.MAX_REQUEST_BYTES ?? 1_048_576);
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 10_485_760);

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    // Never let a key reach the log file, even via an error object we forgot
    // to sanitize somewhere upstream.
    redact: ['req.headers.authorization', 'req.headers["x-api-key"]', 'req.headers["x-goog-api-key"]', '*.apiKey'],
  },
  bodyLimit: MAX_REQUEST_BYTES,
  // Fastify generates one per request; we echo it so a user can quote it in a
  // bug report and we can find the exact log line.
  genReqId: () => crypto.randomUUID(),
});

// Fail fast on a broken models.json rather than on the first chat request.
loadConfig();

await app.register(cors, {
  origin: process.env.CORS_ORIGIN?.split(',') ?? ['http://localhost:3000'],
  credentials: true,
  allowedHeaders: ['content-type', 'x-tenant-id'],
});

await app.register(multipart, {
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10 },
});

registerTenantGuard(app);
registerModelRoutes(app);
registerConversationRoutes(app);
registerChatRoutes(app);
registerDocumentRoutes(app);
registerMetricsRoutes(app);

app.get('/health', async () => ({ ok: true }));

/**
 * One error handler, one rule: the client gets a kind and a generic message,
 * the log gets everything. Provider error bodies routinely contain the request
 * that produced them — which for us means the system prompt and retrieved
 * document text.
 */
app.setErrorHandler((error, req, reply) => {
  // Read these up front: the type guards below narrow `error` away, and the
  // fallback branch still needs the plain Error/Fastify fields.
  const statusCode = (error as { statusCode?: number }).statusCode;
  const message = error instanceof Error ? error.message : 'Unknown error';

  if (error instanceof ZodError) {
    return reply.code(400).send({
      error: { kind: 'bad_request', message: 'Invalid request.', issues: error.issues.map((i) => ({ path: i.path, message: i.message })) },
    });
  }

  if (isProviderError(error)) {
    req.log.error({ err: error, raw: error.raw }, 'provider error');
    const status = error.kind === 'auth' ? 502 : error.kind === 'rate_limit' ? 429 : 500;
    return reply.code(status).send({ error: error.toClient() });
  }

  req.log.error({ err: error }, 'unhandled error');
  const status = statusCode && statusCode < 500 ? statusCode : 500;
  return reply.code(status).send({
    // 5xx messages are ALWAYS generic: an unhandled error can carry anything,
    // including a connection string or an upstream response body.
    error: {
      kind: status < 500 ? 'bad_request' : 'server_error',
      message: status < 500 ? message : 'Internal server error.',
      requestId: req.id,
    },
  });
});

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`polyglot api on :${PORT}`);
} catch (e) {
  app.log.error(e);
  process.exit(1);
}
