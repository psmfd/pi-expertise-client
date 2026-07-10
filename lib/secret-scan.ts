/**
 * expertise-client — lightweight create-body secret guard (ADR-0028, #318).
 *
 * `secrets-guard` (the global pi extension) intercepts only
 * `write`/`edit`/`artifact_review`/`bash` tool calls and is scoped to
 * disk/commit persistence; it never sees `expertise_create`. To keep an
 * accidental credential from being published into an expertise entry, this
 * module scans the create body field-by-field BEFORE any network call.
 *
 * The canonical pattern set (`SECRET_PATTERNS`) and the raw-string scanner
 * (`scanRawString`) live in `../../shared/secret-scan.ts` (ADR-0088, #635) so
 * that both this extension and the config-mirror-shipped expertise-indexer can
 * consume them without a cross-mirror import. This module keeps only the
 * `CreateParams`-shaped create-body gate (`scanForSecrets`). The scan returns
 * CATEGORY NAMES only — never the matched secret text.
 *
 * Pure, no side effects.
 */

import type { CreateParams } from "./create.ts";
import { SECRET_PATTERNS } from "../shared/secret-scan.ts";

/**
 * Collect each string field/element of the create body for scanning.
 *
 * Deliberately generic (every own string property plus string-array elements)
 * rather than a hardcoded field list: #489 showed that a field list drifts
 * when `CreateParams` gains or renames fields, silently exempting the new
 * fields from the scan. Whatever shape `CreateParams` takes, every string it
 * carries is scanned.
 */
function collectStrings(body: CreateParams): string[] {
  const out: string[] = [];
  for (const value of Object.values(body)) {
    if (typeof value === "string") {
      out.push(value);
    } else if (Array.isArray(value)) {
      for (const el of value) {
        if (typeof el === "string") out.push(el);
      }
    }
  }
  return out;
}

/**
 * Scan a create body for credential patterns. Returns the deduplicated
 * category names of any matches (never the matched secret text). An empty
 * array means the body is clean.
 */
export function scanForSecrets(body: CreateParams): string[] {
  const fields = collectStrings(body);
  const matched = new Set<string>();
  for (const value of fields) {
    for (const { name, re } of SECRET_PATTERNS) {
      if (re.test(value)) matched.add(name);
    }
  }
  return [...matched];
}
