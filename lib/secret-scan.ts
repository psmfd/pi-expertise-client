/**
 * expertise-client — lightweight create-body secret guard (ADR-0028, #318).
 *
 * `secrets-guard` (the global pi extension) intercepts only
 * `write`/`edit`/`artifact_review`/`bash` tool calls and is scoped to
 * disk/commit persistence; it never sees `expertise_create`. To keep an
 * accidental credential from being published into an expertise entry, this
 * module scans the create body field-by-field BEFORE any network call.
 *
 * The pattern set mirrors `secrets-guard`'s shared source of truth exactly
 * (keep in lockstep with agent/extensions/secrets-guard/index.ts and
 * hooks/secrets-guard.sh). The scan returns CATEGORY NAMES only — never the
 * matched secret text — so a refusal message cannot itself leak the value.
 *
 * Pure, no side effects.
 */

import type { CreateParams } from "./create.ts";

// Keep this in lockstep with agent/extensions/secrets-guard/index.ts and
// hooks/secrets-guard.sh (ADR-0071; framework ADR-095 for the JWT/Bearer
// detectors). validate.sh check_secret_pattern_lockstep enforces parity.
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  {
    name: "pem-private-key",
    // Includes the ENCRYPTED (PKCS#8) header form, in lockstep with secrets-guard.
    re: /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED |)PRIVATE KEY/,
  },
  {
    name: "aws-access-key",
    re: /(^|[^A-Z0-9])(AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}([^A-Z0-9]|$)/,
  },
  // All five documented GitHub token prefixes (gho/ghp/ghr/ghs/ghu), open-ended
  // body to match the longer ghs_ format — in lockstep with secrets-guard.
  { name: "github-token", re: /gh[oprsu]_[A-Za-z0-9]{36,}/ },
  { name: "github-pat-fine-grained", re: /github_pat_[A-Za-z0-9_]{82,}/ },
  // Signed JWT — header.payload.signature, each segment length-bounded (`eyJ` is
  // base64url `{"`). Signed tokens only; unsigned/alg:none is out of scope
  // (framework ADR-095 / #64). The pattern text does not match its own regex.
  {
    name: "signed-jwt",
    // Segments upper-bounded ({10,4000}) so the chained `{n,}\.` shape cannot
    // drive O(n²) backtracking on adversarial ~512KB non-dot input in the V8
    // engine; a real JWT segment is far under 4000 chars (ADR-0071).
    re: /eyJ[A-Za-z0-9_-]{10,4000}\.eyJ[A-Za-z0-9_-]{10,4000}\.[A-Za-z0-9_-]{10,4000}/,
  },
  // Authorization: Bearer <20+ token chars>. Case-insensitive on both words; the
  // length bound keeps placeholders (`Bearer %s`, `Bearer <key>`, `Bearer $VAR`)
  // below the threshold (framework ADR-095).
  {
    name: "authorization-bearer",
    re: /[Aa]uthorization: [Bb]earer [A-Za-z0-9._~+/=-]{20,}/,
  },
];

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

/**
 * Sibling entry point for consumers that hold a raw string rather than a
 * `CreateParams`-shaped object (canonicalizer pre-write gate, #598/#608).
 * Runs the same `SECRET_PATTERNS` set against the entire string; returns the
 * deduplicated category names of any matches. Never returns the matched
 * secret text — so a caller's refusal message can safely echo the result.
 *
 * Kept in this file (not extracted to `shared/`) so the pattern set remains
 * single-sourced within a lockstep target that `scripts/validate.sh`
 * §6b-bis already verifies. Extracting to `shared/` would add a fourth
 * lockstep site with no compensating benefit.
 */
export function scanRawString(text: string): string[] {
  const matched = new Set<string>();
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(text)) matched.add(name);
  }
  return [...matched];
}
