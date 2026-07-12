/**
 * expertise-client — `.env.local` path anchoring (ADR-0028).
 *
 * Phase 1 reads configuration from two sources only:
 *   1. `process.env` (highest precedence)
 *   2. a single FIXED extension-local file: `<ext>/.env.local`
 *
 * There is intentionally NO arbitrary `.env` discovery: the loader never walks
 * parent directories and never reads a repository's own `.env`. This prevents a
 * checked-out project from silently redirecting the client's endpoint or
 * supplying credentials (ADR-0028 § Trust and Security Controls).
 *
 * The pure parse/load helpers moved to `shared/expertise-api-config.ts`
 * (ADR-0095) so the fanout gate shares one parser; only the path RESOLUTION —
 * which is anchored to THIS extension's directory — stays here. They are
 * re-exported for compatibility with existing imports.
 */

import { fileURLToPath } from "node:url";

export { loadEnvLocal, parseEnvFile } from "../shared/expertise-api-config.ts";

/** Absolute path of the one env file the client will read. */
export function resolveEnvPath(): string {
  // `.env.local` lives in the extension root, one level above this lib module.
  return fileURLToPath(new URL("../.env.local", import.meta.url));
}
