/**
 * expertise-client — configuration-file path anchoring (ADR-0103).
 *
 * The legacy local profile keeps its extension-owned `.env.local`. The upstream
 * bearer profile uses agent-expertise-api's operator-owned
 * `~/.config/expertise-api/secrets.env` contract (or its explicit process-env
 * override). Neither path is discovered from the current repository.
 */

import { fileURLToPath } from "node:url";

export {
  loadEnvLocal,
  loadUpstreamSecrets,
  parseEnvFile,
  resolveUpstreamSecretsPath,
} from "../shared/expertise-api-config.ts";

/** Absolute path of the one env file the client will read. */
export function resolveEnvPath(): string {
  // `.env.local` lives in the extension root, one level above this lib module.
  return fileURLToPath(new URL("../.env.local", import.meta.url));
}
