/**
 * expertise-client — expertise_search tests (ADR-0103, #489).
 *
 * Pins the REAL agent-expertise-api semantic-search contract (v1.1.0, re-verified
 * unchanged at v1.4.1)
 * (`GET /expertise/search/semantic?q=...&limit=...`), verified against the
 * server source — not an assumed shape. Includes a secret-non-disclosure
 * assertion: the API key is sent as a header but must never appear in
 * tool-visible output.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { ClientConfig } from "../shared/expertise-api-config.ts";
import { SEARCH_PATH, searchExpertise } from "../shared/expertise-api-search.ts";

const SECRET = "super-secret-api-key";
const CONFIG: ClientConfig = {
  baseUrl: "http://127.0.0.1:8080",
  bearerToken: SECRET,
  authMode: "local-api-key",
  allowWrite: false,
};

const OIDC_CONFIG: ClientConfig = {
  baseUrl: "https://expertise.lan.example",
  bearerToken: SECRET,
  authMode: "upstream-bearer",
  allowWrite: false,
};

interface Captured {
  url?: URL;
  headers?: Record<string, string>;
}

function capturingFetch(
  cap: Captured,
  status: number,
  body: string,
  responseHeaders?: Record<string, string>,
): typeof fetch {
  return (async (url: URL, init: RequestInit) => {
    cap.url = url;
    cap.headers = init.headers as Record<string, string>;
    return new Response(body, { status, headers: responseHeaders });
  }) as unknown as typeof fetch;
}

test("searchExpertise targets the semantic endpoint with q= and limit=", async () => {
  const cap: Captured = {};
  const r = await searchExpertise(
    CONFIG,
    { query: "kafka", limit: 5 },
    { fetchImpl: capturingFetch(cap, 200, '{"results":[]}') },
  );
  assert.ok(r.ok);
  if (r.ok) assert.match(r.text, /results/);
  assert.equal(cap.url?.pathname, "/expertise/search/semantic");
  assert.equal(cap.url?.pathname, SEARCH_PATH);
  assert.equal(cap.url?.searchParams.get("q"), "kafka");
  assert.equal(cap.url?.searchParams.has("query"), false);
  assert.equal(cap.url?.searchParams.get("limit"), "5");
});

test("searchExpertise omits limit when not provided", async () => {
  const cap: Captured = {};
  await searchExpertise(
    CONFIG,
    { query: "kafka" },
    { fetchImpl: capturingFetch(cap, 200, "[]") },
  );
  assert.equal(cap.url?.searchParams.has("limit"), false);
});

test("searchExpertise clamps limit to the server's [1,100] range", async () => {
  const high: Captured = {};
  await searchExpertise(
    CONFIG,
    { query: "x", limit: 1000 },
    { fetchImpl: capturingFetch(high, 200, "[]") },
  );
  assert.equal(high.url?.searchParams.get("limit"), "100");

  const low: Captured = {};
  await searchExpertise(
    CONFIG,
    { query: "x", limit: 0 },
    { fetchImpl: capturingFetch(low, 200, "[]") },
  );
  assert.equal(low.url?.searchParams.get("limit"), "1");
});

test("searchExpertise sends bearer and agent-audit headers", async () => {
  const cap: Captured = {};
  await searchExpertise(
    CONFIG,
    { query: "x" },
    { fetchImpl: capturingFetch(cap, 200, "{}") },
  );
  assert.equal(cap.headers?.["authorization"], `Bearer ${SECRET}`);
  assert.equal(cap.headers?.["x-actor-class"], "agent");
  assert.match(cap.headers?.["user-agent"] ?? "", /pi-coding-agent/);
});

test("searchExpertise never leaks the API key into output", async () => {
  const cap: Captured = {};
  const r = await searchExpertise(
    CONFIG,
    { query: "x" },
    { fetchImpl: capturingFetch(cap, 200, "ok") },
  );
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.text.includes(SECRET), false);
});

test("searchExpertise surfaces a 429 as a rate-limit refusal with Retry-After", async () => {
  const cap: Captured = {};
  const r = await searchExpertise(
    CONFIG,
    { query: "x" },
    {
      fetchImpl: capturingFetch(cap, 429, "too many", { "retry-after": "42" }),
    },
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.reason, /rate-limited/i);
    assert.match(r.reason, /429/);
    assert.match(r.reason, /42s/);
    assert.equal(r.reason.includes(SECRET), false);
  }
});

test("searchExpertise gives static-OIDC replacement guidance on HTTP 401", async () => {
  const cap: Captured = {};
  const r = await searchExpertise(
    OIDC_CONFIG,
    { query: "x" },
    {
      fetchImpl: capturingFetch(
        cap,
        401,
        JSON.stringify({ title: `invalid token ${SECRET}` }),
      ),
    },
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.reason, /may be expired or invalid/i);
    assert.match(r.reason, /mint_token\.py/);
    assert.equal(r.reason.includes(SECRET), false);
    assert.match(r.reason, /REDACTED:credential/);
  }
});

test("searchExpertise fails closed on non-2xx, surfacing the bounded error body", async () => {
  const cap: Captured = {};
  const r = await searchExpertise(
    CONFIG,
    { query: "x" },
    { fetchImpl: capturingFetch(cap, 400, '{"title":"Query parameter \'q\' is required."}') },
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.reason, /400/);
    assert.match(r.reason, /required/);
    assert.equal(r.reason.includes(SECRET), false);
  }
});

test("searchExpertise fails closed on a network error", async () => {
  const throwing = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const r = await searchExpertise(CONFIG, { query: "x" }, { fetchImpl: throwing });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /failed/i);
});
