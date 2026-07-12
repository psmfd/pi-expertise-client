/**
 * expertise-client — create-only write path `expertise_create` (ADR-0028, #318).
 *
 * Transport-only: POSTs a single expertise entry to the local API. The body
 * schema matches agent-expertise-api's `CreateExpertiseRequest`, verified
 * against the server source at v1.1.0 (#489) and re-verified unchanged at
 * v1.4.1 (2026-07-10): required `domain`, `title`, `body`, `entryType`,
 * `severity`, `source`; optional `tags`, `sourceVersion`. v1.3.0 added
 * optional `tenant` (see below) and `originAuthorPrincipal` (aggregator
 * up-sync attribution) — both deliberately not exposed here.
 * Field names are sent camelCase (server binding is case-insensitive, Web
 * defaults); enum values are the server's literal member names.
 *
 * `entryType`/`severity` are REQUIRED here even though the server would accept
 * their omission — the server silently defaults omitted values to
 * `IssueFix`/`Info`, which mis-tags entries rather than erroring (#489).
 *
 * The server's `tenant` field is DELIBERATELY not exposed: `tenant: "shared"`
 * bypasses the draft/review queue (created directly as Approved), which is
 * outside ADR-0028's phase-1 create-only localdev scope. Mutating semantics
 * are strictly create-only — no update, delete, archive, or approve.
 *
 * Idempotency: the server requires an `Idempotency-Key` header; a fresh key is
 * generated per create request via `crypto.randomUUID()`. This matches
 * ADR-0028 ("generated per create request"). It does NOT provide cross-call
 * retry de-duplication — two identical create bodies sent as two calls produce
 * two distinct keys, though the server's near-duplicate detection (409) is a
 * separate content-level backstop.
 */

import { randomUUID } from "node:crypto";

import type { ClientConfig } from "../shared/expertise-api-config.ts";
import { apiPost, errorDetail } from "../shared/expertise-api-http.ts";

export const CREATE_PATH = "/expertise";

/** Server enum literal member names (JsonStringEnumConverter, no naming policy). */
export const ENTRY_TYPES = ["IssueFix", "Caveat", "Requirement", "Pattern"] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

export const SEVERITIES = ["Info", "Warning", "Critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Fallback provenance when the caller does not name one (server requires non-blank). */
export const DEFAULT_SOURCE = "pi-session";

/** Create-entry shape, matching `CreateExpertiseRequest` (v1.1.0, unchanged through v1.4.1). */
export interface CreateParams {
  /** Required. Domain/topic area of the entry (e.g. "kafka"). */
  domain: string;
  /** Required. Short title of the expertise entry. */
  title: string;
  /** Required. Body content of the entry. */
  body: string;
  /** Required. Entry classification. */
  entryType: EntryType;
  /** Required. Severity of the captured knowledge. */
  severity: Severity;
  /** Optional. Provenance; defaults to "pi-session". */
  source?: string;
  /** Optional. Free-form tags. */
  tags?: string[];
  /** Optional. Version of the source the entry derives from. */
  sourceVersion?: string;
}

export type CreateResult =
  | { ok: true; status: number; text: string; truncated: boolean }
  | { ok: false; reason: string };

export interface CreateOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/** Create a single expertise entry. Create-only; never updates or deletes. */
export async function createExpertise(
  config: ClientConfig,
  params: CreateParams,
  options: CreateOptions = {},
): Promise<CreateResult> {
  const body = {
    domain: params.domain,
    title: params.title,
    body: params.body,
    entryType: params.entryType,
    severity: params.severity,
    source: params.source ?? DEFAULT_SOURCE,
    ...(params.tags !== undefined ? { tags: params.tags } : {}),
    ...(params.sourceVersion !== undefined
      ? { sourceVersion: params.sourceVersion }
      : {}),
    // no `tenant`: deliberately unexposed (see module header).
  };

  try {
    const res = await apiPost(config, CREATE_PATH, {
      body,
      extraHeaders: { "Idempotency-Key": randomUUID() },
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    if (res.status === 409) {
      // The 409 body is the EXISTING near-duplicate entry (not ProblemDetails);
      // surface it so the caller can reuse it instead of retrying the create.
      return {
        ok: false,
        reason:
          `expertise create rejected as a near-duplicate (HTTP 409). ` +
          `An equivalent entry already exists — do not retry; reuse it` +
          errorDetail(res.text, 2000),
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        reason:
          `expertise create returned HTTP ${res.status} ${res.statusText}` +
          errorDetail(res.text),
      };
    }
    return {
      ok: true,
      status: res.status,
      text: res.text,
      truncated: res.truncated,
    };
  } catch (err) {
    return {
      ok: false,
      reason: `expertise create request failed: ${(err as Error).message}`,
    };
  }
}
