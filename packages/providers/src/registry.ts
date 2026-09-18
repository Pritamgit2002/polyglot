import {
  ProviderError,
  getEmbeddingModel,
  getModel,
  getProviderConfig,
  loadConfig,
  type Provider,
  type ProviderContext,
} from '@polyglot/core';

/**
 * Adapter resolution.
 *
 * THE EXTENSIBILITY CLAIM, stated precisely: adding a provider means
 *   (1) one new file at src/adapters/<name>.ts default-exporting a Provider
 *   (2) one entry under `providers` in packages/config/models.json
 *       plus one entry per model under `models`
 * and nothing else. There is no barrel file to edit, no switch statement, no
 * DI container registration — the adapter is resolved by dynamic import from
 * the `adapter` field in config.
 *
 * The name is validated against /^[a-z0-9-]+$/ by the config schema before it
 * reaches here, so config can never be used to import an arbitrary path.
 */

export interface AdapterModule {
  default: Provider;
  /** Optional. When several config providers share one adapter file (OpenAI,
   *  Groq and DeepSeek all use openai-compat), this lets the adapter stamp the
   *  real provider name onto its errors and metrics. */
  create?: (providerName: string) => Provider;
}

const cache = new Map<string, Provider>();

export async function getProvider(providerName: string): Promise<Provider> {
  const cached = cache.get(providerName);
  if (cached) return cached;

  const cfg = getProviderConfig(providerName);
  let mod: AdapterModule;
  try {
    mod = (await import(`./adapters/${cfg.adapter}.js`)) as AdapterModule;
  } catch (e) {
    throw new ProviderError({
      kind: 'bad_request',
      provider: providerName,
      message: `No adapter module "src/adapters/${cfg.adapter}.ts" for provider "${providerName}".`,
      raw: e,
    });
  }

  const provider = mod.create ? mod.create(providerName) : mod.default;
  cache.set(providerName, provider);
  return provider;
}

/** Builds the per-call context: key, base URL, vendor model id, timeout. */
export function buildContext(
  modelId: string,
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): ProviderContext {
  const env = opts.env ?? process.env;
  const model = getModel(modelId);
  const provider = getProviderConfig(model.provider);
  const apiKey = env[provider.apiKeyEnv];

  if (!apiKey) {
    throw new ProviderError({
      kind: 'unconfigured',
      provider: model.provider,
      message: `${provider.apiKeyEnv} is not set.`,
    });
  }

  return {
    apiKey,
    baseUrl: provider.baseUrl,
    providerModelId: model.providerModelId,
    timeoutMs: opts.timeoutMs ?? loadConfig().defaults.timeoutMs,
    extra: provider.extra,
  };
}

export function buildEmbeddingContext(
  modelId: string,
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): ProviderContext {
  const env = opts.env ?? process.env;
  const model = getEmbeddingModel(modelId);
  const provider = getProviderConfig(model.provider);
  const apiKey = env[provider.apiKeyEnv];

  if (!apiKey) {
    throw new ProviderError({
      kind: 'unconfigured',
      provider: model.provider,
      message: `${provider.apiKeyEnv} is not set.`,
    });
  }

  return {
    apiKey,
    baseUrl: provider.baseUrl,
    providerModelId: model.providerModelId,
    timeoutMs: opts.timeoutMs ?? 30_000,
    extra: provider.extra,
  };
}

/** Embeddings go through the same registry, so swapping the embedding provider
 *  is a config change too — the requirement in Module C. */
export async function embed(texts: string[], modelId: string, env?: NodeJS.ProcessEnv): Promise<number[][]> {
  const model = getEmbeddingModel(modelId);
  const provider = await getProvider(model.provider);
  if (!provider.embed) {
    throw new ProviderError({
      kind: 'bad_request',
      provider: model.provider,
      message: `Provider "${model.provider}" does not implement embeddings.`,
    });
  }
  return provider.embed(texts, buildEmbeddingContext(modelId, { env }));
}

/** Test seam: lets adapter tests register a fake without touching config. */
export function __setProviderForTests(name: string, provider: Provider): void {
  cache.set(name, provider);
}

export function __clearProviderCache(): void {
  cache.clear();
}
