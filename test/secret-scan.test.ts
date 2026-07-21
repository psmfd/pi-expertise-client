/**
 * expertise-client — secret-scan tests (ADR-0103, #318, #489).
 *
 * Asserts the body guard matches each credential category and returns category
 * NAMES only — never the matched secret text. #489 regression coverage: every
 * string field of the create body (v1.1.0, unchanged through v1.4.1; including
 * domain and sourceVersion)
 * is scanned — a hardcoded field list previously let renamed/new fields bypass
 * the guard silently.
 *
 * Fixture literals are assembled at runtime from fragments so this test file
 * itself contains no committed secret pattern (keeps secrets-guard happy).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { CreateParams } from "../lib/create.ts";
import { scanForSecrets } from "../lib/secret-scan.ts";

const AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE";
const GH_CLASSIC = "ghp_" + "A".repeat(36);
const GH_SERVER = "ghs_" + "C".repeat(40); // server-to-server / GITHUB_TOKEN
const GH_FINE = "github_pat_" + "B".repeat(82);
const PEM = "-----BEGIN RSA " + "PRIVATE KEY-----";
const PEM_ENC = "-----BEGIN ENCRYPTED " + "PRIVATE KEY-----";
// Assembled by concatenation so this source file carries no literal JWT/bearer
// token (keeps the pre-commit secrets-guard + gitleaks from self-tripping).
const JWT = "eyJ" + "a".repeat(12) + "." + "eyJ" + "b".repeat(12) + "." + "c".repeat(20);
const BEARER = "Authorization: " + "Bearer " + "x".repeat(24);

/** Minimal valid create body per the v1.1.0 contract; override per test. */
function entry(overrides: Partial<CreateParams> = {}): CreateParams {
  return {
    domain: "kafka",
    title: "kafka tuning",
    body: "use idempotent producers",
    entryType: "Pattern",
    severity: "Info",
    ...overrides,
  };
}

test("clean body returns []", () => {
  assert.deepEqual(scanForSecrets(entry()), []);
});

test("detects AWS access key in body", () => {
  const cats = scanForSecrets(entry({ body: `key ${AWS_KEY}` }));
  assert.deepEqual(cats, ["aws-access-key"]);
});

test("detects GitHub classic PAT in title", () => {
  const cats = scanForSecrets(entry({ title: GH_CLASSIC }));
  assert.deepEqual(cats, ["github-token"]);
});

test("detects a signed JWT in body", () => {
  const cats = scanForSecrets(entry({ body: `token ${JWT}` }));
  assert.deepEqual(cats, ["signed-jwt"]);
});

test("detects an Authorization: Bearer literal in body", () => {
  const cats = scanForSecrets(entry({ body: `curl -H '${BEARER}'` }));
  assert.deepEqual(cats, ["authorization-bearer"]);
});

test("does not flag a Bearer placeholder below the length bound", () => {
  assert.deepEqual(scanForSecrets(entry({ body: "Authorization: Bearer <key>" })), []);
  assert.deepEqual(scanForSecrets(entry({ body: "Authorization: Bearer %s" })), []);
});

test("detects GitHub server-to-server token (ghs_) in body", () => {
  const cats = scanForSecrets(entry({ body: `token ${GH_SERVER}` }));
  assert.deepEqual(cats, ["github-token"]);
});

test("detects ENCRYPTED PEM private-key block in source", () => {
  const cats = scanForSecrets(entry({ source: PEM_ENC }));
  assert.deepEqual(cats, ["pem-private-key"]);
});

test("detects GitHub fine-grained PAT in a tag", () => {
  const cats = scanForSecrets(entry({ tags: ["ok", GH_FINE] }));
  assert.deepEqual(cats, ["github-pat-fine-grained"]);
});

test("detects PEM private-key block in source", () => {
  const cats = scanForSecrets(entry({ source: PEM }));
  assert.deepEqual(cats, ["pem-private-key"]);
});

// --- #489 regression: new/renamed v1.1.0 fields are scanned ------------------

test("detects a credential in domain", () => {
  const cats = scanForSecrets(entry({ domain: GH_CLASSIC }));
  assert.deepEqual(cats, ["github-token"]);
});

test("detects a credential in sourceVersion", () => {
  const cats = scanForSecrets(entry({ sourceVersion: `v ${AWS_KEY}` }));
  assert.deepEqual(cats, ["aws-access-key"]);
});

test("scans every string field generically (no hardcoded field list)", () => {
  // A field unknown to the current shape must still be scanned — this is the
  // exact drift class #489 closed (renamed fields silently bypassing the scan).
  const withExtra = {
    ...entry(),
    futureField: PEM,
  } as unknown as CreateParams;
  assert.deepEqual(scanForSecrets(withExtra), ["pem-private-key"]);
});

test("returned values are category names, never the secret text", () => {
  const cats = scanForSecrets(
    entry({ title: GH_CLASSIC, body: AWS_KEY, source: PEM }),
  );
  const joined = cats.join("|");
  assert.equal(joined.includes(GH_CLASSIC), false);
  assert.equal(joined.includes(AWS_KEY), false);
  assert.equal(joined.includes(PEM), false);
});
