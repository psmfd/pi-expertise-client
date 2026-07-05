/**
 * expertise-client — read-side `expertise_search` (ADR-0028).
 *
 * Targets the SEMANTIC search endpoint of agent-expertise-api v1.1.0
 * (`GET /expertise/search/semantic`), verified against the live API and the
 * server source (#489): query param is `q`, `limit` is clamped server-side to
 * [1, 100], and the endpoint is governed by a token-bucket rate limit of
 * 10 requests/min per principal (429 with Retry-After, no queuing). The
 * keyword FTS endpoint (`/expertise/search`) takes only `q` +
 * `includeDeprecated` and is deliberately not exposed in phase 1.
 */

import type { ClientConfig } from "./config.ts";
import { apiGet, errorDetail } from "./http.ts";

export const SEARCH_PATH = "/expertise/search/semantic";

/** Server clamps `limit` to this range; we clamp client-side to match. */
export const LIMIT_MIN = 1;
export const LIMIT_MAX = 100;

export interface SearchParams {
  query: string;
  limit?: number;
}

export type SearchResult =
  | { ok: true; status: number; text: string; truncated: boolean }
  | { ok: false; reason: string };

export interface SearchOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/** Query expertise entries. Read-only; never mutates API state. */
export async function searchExpertise(
  config: ClientConfig,
  params: SearchParams,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const searchParams: Record<string, string> = { q: params.query };
  if (params.limit !== undefined && Number.isFinite(params.limit)) {
    searchParams.limit = String(
      Math.min(LIMIT_MAX, Math.max(LIMIT_MIN, Math.trunc(params.limit))),
    );
  }

  try {
    const res = await apiGet(config, SEARCH_PATH, {
      searchParams,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    if (res.status === 429) {
      const retryNote = res.retryAfter
        ? `Retry after ${res.retryAfter}s.`
        : "Wait before retrying.";
      return {
        ok: false,
        reason:
          `expertise search is rate-limited (HTTP 429): the semantic endpoint ` +
          `allows 10 requests/min and each call runs model inference. ` +
          `${retryNote} Do not retry immediately.`,
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        reason:
          `expertise search returned HTTP ${res.status} ${res.statusText}` +
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
      reason: `expertise search request failed: ${(err as Error).message}`,
    };
  }
}
