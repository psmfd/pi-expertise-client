/**
 * expertise-client — expertise_create / runCreate tests (ADR-0028, #318, #489).
 *
 * Covers the create policy ladder (opt-in gate → body-secret scan → readiness
 * → create) at the runCreate dispatch boundary, plus the transport-level
 * createExpertise against the REAL agent-expertise-api v1.1.0 body contract
 * ({domain, title, body, entryType, severity, source, tags?, sourceVersion?}
 * — no tenant), 409 near-duplicate surfacing, Idempotency-Key uniqueness, and
 * fail-closed behavior. Secret-non-disclosure: the API key is sent as a
 * header but must never appear in any tool-visible output or refusal reason.
 *
 * Fixture secret literals are assembled at runtime from fragments so this file
 * contains no committed secret pattern.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { ClientConfig } from "../lib/config.ts";
import type { CreateParams } from "../lib/create.ts";
import { CREATE_PATH, DEFAULT_SOURCE, createExpertise } from "../lib/create.ts";
import { runCreate } from "../lib/run-create.ts";

const SECRET = "super-secret-api-key";
const AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE";

const WRITE_CONFIG: ClientConfig = {
  baseUrl: "http://127.0.0.1:8080",
  apiKey: SECRET,
  allowWrite: true,
};
const NO_WRITE_CONFIG: ClientConfig = { ...WRITE_CONFIG, allowWrite: false };

/** Minimal valid create body per the v1.1.0 contract; override per test. */
function entry(overrides: Partial<CreateParams> = {}): CreateParams {
  return {
    domain: "kafka",
    title: "tune producers",
    body: "use idempotent producers",
    entryType: "Pattern",
    severity: "Info",
    ...overrides,
  };
}

interface Captured {
  url?: URL;
  headers?: Record<string, string>;
  body?: string;
}

function capturingFetch(
  cap: Captured,
  status: number,
  body: string,
): typeof fetch {
  return (async (url: URL, init: RequestInit) => {
    cap.url = url;
    cap.headers = init.headers as Record<string, string>;
    cap.body = init.body as string;
    return new Response(body, { status });
  }) as unknown as typeof fetch;
}

const readyOk = async () => ({ ready: true as const });

// --- runCreate policy ladder ------------------------------------------------

test("runCreate refuses when allowWrite is false (before any network call)", async () => {
  let called = false;
  const r = await runCreate(NO_WRITE_CONFIG, entry(), {
    checkReady: (async () => {
      called = true;
      return { ready: true };
    }) as never,
    createExpertise: (async () => {
      called = true;
      return { ok: true, status: 201, text: "{}", truncated: false };
    }) as never,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /PI_EXPERTISE_ALLOW_LOCALDEV_WRITE/);
  assert.equal(called, false);
});

test("runCreate refuses a body containing a credential, without echoing it", async () => {
  let networkTouched = false;
  const r = await runCreate(
    WRITE_CONFIG,
    entry({ body: `leak ${AWS_KEY}` }),
    {
      checkReady: (async () => {
        networkTouched = true;
        return { ready: true };
      }) as never,
      createExpertise: (async () => {
        networkTouched = true;
        return { ok: true, status: 201, text: "{}", truncated: false };
      }) as never,
    },
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.reason, /aws-access-key/);
    assert.equal(r.reason.includes(AWS_KEY), false);
  }
  assert.equal(networkTouched, false);
});

test("runCreate succeeds through the full ladder", async () => {
  const cap: Captured = {};
  const r = await runCreate(
    WRITE_CONFIG,
    entry({ tags: ["mq"], source: "pi-session" }),
    { checkReady: readyOk as never, fetchImpl: capturingFetch(cap, 201, '{"id":1}') },
  );
  assert.ok(r.ok);
  if (r.ok) assert.match(r.text, /id/);
  assert.equal(cap.url?.pathname, CREATE_PATH);
});

test("runCreate fails closed when readiness fails", async () => {
  const r = await runCreate(WRITE_CONFIG, entry(), {
    checkReady: (async () => ({ ready: false, reason: "down" })) as never,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /not ready/);
});

// --- createExpertise transport ---------------------------------------------

test("createExpertise POSTs the real v1.1.0 body shape with Bearer auth and Idempotency-Key", async () => {
  const cap: Captured = {};
  const r = await createExpertise(
    WRITE_CONFIG,
    entry({
      entryType: "Caveat",
      severity: "Warning",
      tags: ["mq"],
      source: "pi-session",
      sourceVersion: "4.0",
    }),
    { fetchImpl: capturingFetch(cap, 201, "{}") },
  );
  assert.ok(r.ok);
  assert.equal(cap.url?.pathname, CREATE_PATH);
  assert.equal(cap.headers?.["authorization"], `Bearer ${SECRET}`);
  assert.equal(cap.headers?.["content-type"], "application/json");
  assert.ok(cap.headers?.["Idempotency-Key"]);
  const parsed = JSON.parse(cap.body ?? "{}") as Record<string, unknown>;
  assert.equal(parsed.domain, "kafka");
  assert.equal(parsed.title, "tune producers");
  assert.equal(parsed.body, "use idempotent producers");
  assert.equal(parsed.entryType, "Caveat");
  assert.equal(parsed.severity, "Warning");
  assert.equal(parsed.source, "pi-session");
  assert.deepEqual(parsed.tags, ["mq"]);
  assert.equal(parsed.sourceVersion, "4.0");
  // legacy assumed field must be gone
  assert.equal("content" in parsed, false);
});

test("createExpertise defaults source and never sends tenant", async () => {
  const cap: Captured = {};
  await createExpertise(WRITE_CONFIG, entry(), {
    fetchImpl: capturingFetch(cap, 201, "{}"),
  });
  const parsed = JSON.parse(cap.body ?? "{}") as Record<string, unknown>;
  assert.equal(parsed.source, DEFAULT_SOURCE);
  // tenant:"shared" bypasses the draft/review queue — deliberately unexposed.
  assert.equal("tenant" in parsed, false);
  assert.equal("sourceVersion" in parsed, false);
});

test("createExpertise sends a fresh, unique Idempotency-Key per call", async () => {
  const cap1: Captured = {};
  const cap2: Captured = {};
  await createExpertise(WRITE_CONFIG, entry(), {
    fetchImpl: capturingFetch(cap1, 201, "{}"),
  });
  await createExpertise(WRITE_CONFIG, entry(), {
    fetchImpl: capturingFetch(cap2, 201, "{}"),
  });
  const k1 = cap1.headers?.["Idempotency-Key"];
  const k2 = cap2.headers?.["Idempotency-Key"];
  assert.ok(k1);
  assert.ok(k2);
  assert.notEqual(k1, k2);
});

test("createExpertise surfaces a 409 as near-duplicate with the existing entry", async () => {
  const cap: Captured = {};
  const existing = '{"id":"abc","title":{"value":"tune producers"}}';
  const r = await createExpertise(WRITE_CONFIG, entry(), {
    fetchImpl: capturingFetch(cap, 409, existing),
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.reason, /near-duplicate/);
    assert.match(r.reason, /409/);
    assert.match(r.reason, /tune producers/);
    assert.equal(r.reason.includes(SECRET), false);
  }
});

test("createExpertise fails closed on non-2xx, surfacing the bounded error body", async () => {
  const cap: Captured = {};
  const r = await createExpertise(WRITE_CONFIG, entry(), {
    fetchImpl: capturingFetch(
      cap,
      400,
      '{"title":"Domain, Title, Body, and Source are required."}',
    ),
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.reason, /400/);
    assert.match(r.reason, /required/);
    assert.equal(r.reason.includes(SECRET), false);
  }
});

test("createExpertise fails closed on a network error", async () => {
  const throwing = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const r = await createExpertise(WRITE_CONFIG, entry(), {
    fetchImpl: throwing,
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.reason, /failed/i);
    assert.equal(r.reason.includes(SECRET), false);
  }
});
