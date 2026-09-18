import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asc, desc, eq } from 'drizzle-orm';
import { conversations, messages, withTenant } from '@polyglot/db';

const createBody = z.object({ title: z.string().min(1).max(200).optional() });
const idParam = z.object({ id: z.string().uuid() });

export function registerConversationRoutes(app: FastifyInstance): void {
  app.get('/api/conversations', async (req) =>
    withTenant(req.tenantId, (tx) =>
      tx
        .select({
          id: conversations.id,
          title: conversations.title,
          lastModelId: conversations.lastModelId,
          updatedAt: conversations.updatedAt,
        })
        .from(conversations)
        .orderBy(desc(conversations.updatedAt))
        .limit(50),
    ),
  );

  app.post('/api/conversations', async (req, reply) => {
    const body = createBody.parse(req.body ?? {});
    const [row] = await withTenant(req.tenantId, (tx) =>
      tx
        .insert(conversations)
        .values({ tenantId: req.tenantId, title: body.title ?? 'New conversation' })
        .returning(),
    );
    return reply.code(201).send(row);
  });

  app.get('/api/conversations/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);

    const result = await withTenant(req.tenantId, async (tx) => {
      // No `and(eq(tenantId, ...))` here on purpose: RLS already applied it.
      // A row belonging to another tenant is not filtered out, it is invisible.
      const [conversation] = await tx.select().from(conversations).where(eq(conversations.id, id)).limit(1);
      if (!conversation) return null;

      const rows = await tx
        .select()
        .from(messages)
        .where(eq(messages.conversationId, id))
        .orderBy(asc(messages.createdAt));

      return { conversation, messages: rows };
    });

    if (!result) return reply.code(404).send({ error: { kind: 'not_found', message: 'Conversation not found.' } });
    return result;
  });

  app.delete('/api/conversations/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    await withTenant(req.tenantId, (tx) => tx.delete(conversations).where(eq(conversations.id, id)));
    return reply.code(204).send();
  });
}
