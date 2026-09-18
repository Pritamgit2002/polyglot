import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Read at runtime rather than `import ... with { type: 'json' }` so that an
 * operator can edit prices or add a model without a rebuild — and so that the
 * "one config entry" claim in the README is literally true.
 */
export function readRawConfig(): unknown {
  const path = fileURLToPath(new URL('../models.json', import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8'));
}

export const MODELS_CONFIG_PATH = fileURLToPath(new URL('../models.json', import.meta.url));
