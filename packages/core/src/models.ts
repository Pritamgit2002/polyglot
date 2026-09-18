import { z } from 'zod';
import { readRawConfig } from '@polyglot/config';
import type { Usage } from './types.js';

/**
 * Config is validated once at boot with zod. A typo in models.json should fail
 * loudly on startup, not silently produce a $0.00 cost line six hours later.
 */

/**
 * Long-context surcharge.
 *
 * Every major provider now charges more once a prompt crosses a threshold, and
 * they express it differently — OpenAI as a multiplier on the WHOLE request
 * past 272K input tokens, Gemini and Anthropic as a separate rate table past
 * their own thresholds. A single flat rate per model silently under-reports the
 * cost of exactly the requests that cost the most, which is a bad place to be
 * wrong when the point of the module is cost tracking.
 */
const LongContextSchema = z.object({
  /** Applies when inputTokens EXCEEDS this value. */
  thresholdInputTokens: z.number().int().positive(),
  inputMultiplier: z.number().positive().default(1),
  outputMultiplier: z.number().positive().default(1),
});

const PricingSchema = z.object({
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
  cachedInputPerMTok: z.number().nonnegative().optional(),
  cacheWritePerMTok: z.number().nonnegative().optional(),
  reasoningPerMTok: z.number().nonnegative().optional(),
  longContext: LongContextSchema.optional(),
});

const CapabilitiesSchema = z.object({
  tools: z.boolean(),
  vision: z.boolean(),
  jsonSchema: z.boolean(),
  streaming: z.boolean(),
});

/** `adapter` is a bare filename under providers/src/adapters. Constrained to
 *  [a-z0-9-] so config can never be used to import an arbitrary path. */
const ProviderConfigSchema = z.object({
  adapter: z.string().regex(/^[a-z0-9-]+$/, 'adapter must be a bare kebab-case module name'),
  apiKeyEnv: z.string().min(1),
  baseUrl: z.string().url(),
  extra: z.record(z.unknown()).optional(),
});

const ModelConfigSchema = z.object({
  provider: z.string().min(1),
  providerModelId: z.string().min(1),
  displayName: z.string().min(1),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  capabilities: CapabilitiesSchema,
  pricing: PricingSchema,
  /**
   * Per-model quirks, merged OVER the provider's `extra`.
   *
   * Quirks are not always provider-wide. OpenAI's newer models reject
   * `max_tokens` and require `max_completion_tokens`, while older ones accept
   * either — so the knob has to live on the model, not the vendor, or one
   * fleet breaks whichever way you set it.
   */
  extra: z.record(z.unknown()).optional(),
});

const EmbeddingModelConfigSchema = z.object({
  provider: z.string().min(1),
  providerModelId: z.string().min(1),
  displayName: z.string().min(1),
  dimensions: z.number().int().positive(),
  pricing: PricingSchema,
});

const RetrievalDefaultsSchema = z.object({
  chunkSize: z.number().int().min(100).max(8000),
  chunkOverlap: z.number().int().min(0).max(2000),
  topK: z.number().int().min(1).max(50),
  similarityThreshold: z.number().min(0).max(1),
});

const ConfigSchema = z
  .object({
    $comment: z.unknown().optional(),
    providers: z.record(ProviderConfigSchema),
    models: z.record(ModelConfigSchema),
    embeddingModels: z.record(EmbeddingModelConfigSchema),
    defaults: z.object({
      chatModel: z.string(),
      embeddingModel: z.string(),
      fallbackChain: z.array(z.string()).min(1),
      retry: z.object({
        maxAttempts: z.number().int().min(1).max(10),
        baseDelayMs: z.number().int().positive(),
        maxDelayMs: z.number().int().positive(),
        jitter: z.enum(['none', 'full', 'equal']),
      }),
      timeoutMs: z.number().int().positive(),
      retrieval: RetrievalDefaultsSchema,
    }),
  })
  .superRefine((cfg, ctx) => {
    // Referential integrity: every model must point at a declared provider.
    for (const [id, m] of Object.entries(cfg.models)) {
      if (!cfg.providers[m.provider]) {
        ctx.addIssue({ code: 'custom', message: `model "${id}" references unknown provider "${m.provider}"` });
      }
    }
    for (const [id, m] of Object.entries(cfg.embeddingModels)) {
      if (!cfg.providers[m.provider]) {
        ctx.addIssue({ code: 'custom', message: `embedding model "${id}" references unknown provider "${m.provider}"` });
      }
    }
    for (const id of [cfg.defaults.chatModel, ...cfg.defaults.fallbackChain]) {
      if (!cfg.models[id]) ctx.addIssue({ code: 'custom', message: `defaults reference unknown model "${id}"` });
    }
    if (!cfg.embeddingModels[cfg.defaults.embeddingModel]) {
      ctx.addIssue({ code: 'custom', message: `defaults reference unknown embedding model` });
    }
    if (cfg.defaults.retrieval.chunkOverlap >= cfg.defaults.retrieval.chunkSize) {
      ctx.addIssue({ code: 'custom', message: 'chunkOverlap must be smaller than chunkSize' });
    }
  });

export type PolyglotConfig = z.infer<typeof ConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type EmbeddingModelConfig = z.infer<typeof EmbeddingModelConfigSchema>;
export type Pricing = z.infer<typeof PricingSchema>;
export type RetrievalDefaults = z.infer<typeof RetrievalDefaultsSchema>;

let cached: PolyglotConfig | null = null;

export function loadConfig(force = false): PolyglotConfig {
  if (cached && !force) return cached;
  const parsed = ConfigSchema.safeParse(readRawConfig());
  if (!parsed.success) {
    throw new Error(`Invalid models.json:\n${parsed.error.issues.map((i) => `  - ${i.message}`).join('\n')}`);
  }
  cached = parsed.data;
  return cached;
}

export function getModel(id: string): ModelConfig {
  const m = loadConfig().models[id];
  if (!m) throw new Error(`Unknown model id "${id}". Add it to packages/config/models.json.`);
  return m;
}

export function getEmbeddingModel(id: string): EmbeddingModelConfig {
  const m = loadConfig().embeddingModels[id];
  if (!m) throw new Error(`Unknown embedding model id "${id}".`);
  return m;
}

export function getProviderConfig(name: string): ProviderConfig {
  const p = loadConfig().providers[name];
  if (!p) throw new Error(`Unknown provider "${name}".`);
  return p;
}

export interface ModelSummary extends ModelConfig {
  id: string;
  /** False when the server has no API key for this provider. The UI greys the
   *  model out instead of letting the user fire a request that must fail. */
  configured: boolean;
}

export function listModels(env: NodeJS.ProcessEnv = process.env): ModelSummary[] {
  const cfg = loadConfig();
  return Object.entries(cfg.models).map(([id, m]) => ({
    ...m,
    id,
    configured: Boolean(env[cfg.providers[m.provider]!.apiKeyEnv]),
  }));
}

/**
 * Cost in USD. Cached and reasoning tokens are handled explicitly because every
 * vendor counts them differently:
 *  - Anthropic reports cache reads SEPARATELY from input tokens.
 *  - OpenAI reports cached tokens as a SUBSET of prompt tokens.
 *  - Gemini reports cachedContentTokenCount as a subset too.
 * Adapters normalize to "cachedInputTokens is a subset of inputTokens" so this
 * function has exactly one rule to follow.
 */
export function computeCostUsd(usage: Usage, pricing: Pricing): number {
  const cached = usage.cachedInputTokens ?? 0;
  const written = usage.cacheWriteTokens ?? 0;
  const uncachedInput = Math.max(0, usage.inputTokens - cached - written);

  // The surcharge applies to the FULL request once the threshold is crossed,
  // not just to the tokens above it — that is how OpenAI words it, and pricing
  // the excess only would under-report a 300K-token prompt substantially.
  const long = pricing.longContext;
  const overThreshold = long !== undefined && usage.inputTokens > long.thresholdInputTokens;
  const inMult = overThreshold ? long!.inputMultiplier : 1;
  const outMult = overThreshold ? long!.outputMultiplier : 1;

  const inputCost = (uncachedInput / 1_000_000) * pricing.inputPerMTok * inMult;
  const cachedCost = (cached / 1_000_000) * (pricing.cachedInputPerMTok ?? pricing.inputPerMTok) * inMult;
  const writeCost = (written / 1_000_000) * (pricing.cacheWritePerMTok ?? pricing.inputPerMTok) * inMult;
  // Reasoning tokens are billed at the output rate unless the vendor prices
  // them separately; they are already included in outputTokens for every
  // provider we implement, so we do NOT add them again.
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputPerMTok * outMult;

  return round8(inputCost + cachedCost + writeCost + outputCost);
}

/**
 * 8 decimal places, not 6.
 *
 * A short request to a cheap model costs ~$0.00008. At 6dp that is one
 * significant figure, and because rounding a positive number to a coarse grid
 * truncates as often as it rounds up, the error does not cancel across a
 * ledger — it shows up as a systematically wrong total in the aggregate view,
 * which is the number Module E exists to report. The request_logs column is
 * numeric(16,8) to match; storing at lower precision than we compute would
 * put the rounding back.
 */
function round8(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}
