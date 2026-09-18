import type { FastifyInstance } from 'fastify';
import { listModels, loadConfig } from '@polyglot/core';

export function registerModelRoutes(app: FastifyInstance): void {
  /** The UI uses `configured` to grey out models whose key is missing, rather
   *  than letting the user fire a request that is guaranteed to 401. Note that
   *  we expose only the boolean — never the key or the env var's value. */
  app.get('/api/models', async () => {
    const cfg = loadConfig();
    return {
      models: listModels().map((m) => ({
        id: m.id,
        provider: m.provider,
        displayName: m.displayName,
        contextWindow: m.contextWindow,
        maxOutputTokens: m.maxOutputTokens,
        capabilities: m.capabilities,
        pricing: m.pricing,
        configured: m.configured,
      })),
      defaults: {
        chatModel: cfg.defaults.chatModel,
        fallbackChain: cfg.defaults.fallbackChain,
        retrieval: cfg.defaults.retrieval,
      },
    };
  });
}
