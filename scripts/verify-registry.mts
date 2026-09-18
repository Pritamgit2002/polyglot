/**
 * Proves the extensibility claim without touching the network or a database.
 *
 *   npx tsx scripts/verify-registry.mts
 *
 * Every provider in models.json must resolve to an adapter purely by dynamic
 * import from its `adapter` field. If adding a provider ever required editing
 * a barrel, a switch or a registration call, this script would still pass while
 * the claim in the README quietly became false — so it also prints the adapter
 * each provider resolved to, which makes the indirection visible.
 */
import { buildContext, getProvider } from '@polyglot/providers';
import { computeCostUsd, getModel, listModels, loadConfig } from '@polyglot/core';

const cfg = loadConfig();
console.log(`config OK — ${Object.keys(cfg.providers).length} providers, ${Object.keys(cfg.models).length} models\n`);

console.log('provider -> adapter (resolved by dynamic import, no registration code):');
for (const name of Object.keys(cfg.providers)) {
  const p = await getProvider(name);
  const embeds = typeof p.embed === 'function' ? 'yes' : 'no';
  console.log(`  ${name.padEnd(10)} -> ${cfg.providers[name]!.adapter.padEnd(14)} name="${p.name}" embeddings=${embeds}`);
}

console.log('\nmodels (configured = an API key is present in this environment):');
for (const m of listModels()) {
  console.log(`  ${m.id.padEnd(34)} tools=${String(m.capabilities.tools).padEnd(5)} configured=${m.configured}`);
}

const cost = computeCostUsd(
  { inputTokens: 12_000, outputTokens: 800, cachedInputTokens: 10_000 },
  getModel('anthropic:claude-sonnet-4-6').pricing,
);
console.log(`\ncost of 12k input (10k of it cached) + 800 output on Sonnet: $${cost.toFixed(6)}`);

try {
  buildContext('groq:llama-3.3-70b-versatile', { env: {} as NodeJS.ProcessEnv });
  console.log('\n! expected a missing-key error');
} catch (e) {
  const err = e as { kind: string; retryable: boolean };
  console.log(`missing key degrades to kind="${err.kind}" retryable=${err.retryable} (not a crash)`);
}
