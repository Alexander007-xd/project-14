// Load .env into process.env before anything else reads configuration.
// Uses Node's built-in parser, so there is still no dependency to install.
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = process.env.STASH_ENV_FILE ?? resolve(root, '.env');

if (existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch (err) {
    console.warn(`[stash] could not read ${envPath}: ${err.message}`);
  }
}
