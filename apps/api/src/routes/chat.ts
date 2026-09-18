import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getModel } from '@polyglot/core';
import { runChatTurn } from '../services/chat.js';

const contentBlock = z.object({
  type: z.enum(['text', 'image']),
  text: z.string().max(100_000).optional(),
  mimeType: z.string().max(100).optional(),
  data: z.string().max(8_000_000).optional(),
});

const chatBody = z.object({
  conversationId: z.string().uuid(),
  modelId: z.string().min(1).max(120),
  content: z.array(contentBlock).min(1).max(20),
  system: z.string().max(20_000).optional(),
  collectionId: z.string().uuid().optional(),
  enabledTools: z.array(z.string().max(60)).max(10).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(200_000).optional(),
  fallbackChain: z.array(z.string().max(120)).max(5).optional(),
});

export function registerChatRoutes(app: FastifyInstance): void {
  app.post('/api/chat', async (req, reply) => {
    const body = chatBody.parse(req.body);

    // Fail before opening the stream: a 400 inside an SSE body is invisible to
    // most clients and shows up as "the model said nothing".
    try {
      getModel(body.modelId);
    } catch {
      return reply.code(400).send({ error: { kind: 'bad_request', message: 'Unknown model id.' } });
    }

    const controller = new AbortController();
    // A closed socket must abort the UPSTREAM call, not merely stop writing.
    // Otherwise the user hits Stop, the tab goes quiet, and we keep paying for
    // tokens nobody will ever read.
    req.raw.on('close', () => controller.abort());

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const write = (event: unknown) => {
      if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      for await (const event of runChatTurn({
        tenantId: req.tenantId,
        conversationId: body.conversationId,
        modelId: body.modelId,
        userContent: body.content,
        system: body.system,
        collectionId: body.collectionId,
        enabledTools: body.enabledTools,
        temperature: body.temperature,
        maxTokens: body.maxTokens,
        fallbackChain: body.fallbackChain,
        signal: controller.signal,
      })) {
        write(event);
      }
    } catch (e) {
      req.log.error({ err: e }, 'chat turn failed');
      // Generic text only: the upstream message can echo the prompt back.
      write({ type: 'error', kind: 'server_error', message: 'The request failed. See server logs.' });
    } finally {
      if (!reply.raw.writableEnded) reply.raw.end();
    }
  });
}
