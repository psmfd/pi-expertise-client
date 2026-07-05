/**
 * expertise-client — pi extension (ADR-0028).
 *
 * Phase 1: a LOCAL-ONLY, loopback-only, API-key-authenticated client for
 * `agent-expertise-api`. This extension registers the read-side
 * `expertise_search` tool (#317) and the create-only `expertise_create` tool
 * (#318). Create is additionally gated behind
 * `PI_EXPERTISE_ALLOW_LOCALDEV_WRITE=1` and a lightweight body-secret guard.
 *
 * Trust boundary (ADR-0028, agent/rules/no-mcp-servers.md):
 *   - endpoint + credentials come ONLY from `process.env` and the fixed
 *     `<ext>/.env.local` — never from project/repo settings, never from a
 *     prompt or an API response;
 *   - the base URL must be loopback; an API key is always required;
 *   - returned content is UNTRUSTED tool-call output. It is surfaced only as
 *     the structured return value of this tool — never injected as system
 *     context — and is framed as advisory, not authoritative agent routing.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { shouldSkipRegistration } from "./lib/coexist.ts";
import { buildClientConfig } from "./lib/config.ts";
import { ENTRY_TYPES, SEVERITIES } from "./lib/create.ts";
import { loadEnvLocal, resolveEnvPath } from "./lib/env.ts";
import { checkReady } from "./lib/health.ts";
import { runCreate } from "./lib/run-create.ts";
import { searchExpertise } from "./lib/search.ts";

function refusal(tool: string, reason: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: `${tool}: ${reason}`,
      },
    ],
    details: undefined,
    isError: true,
  };
}

export default function (pi: ExtensionAPI) {
  // Coexistence guard (ADR-0029): the project the user launched pi in may ship
  // its own extension that already registers `expertise_search`/`expertise_create`
  // (e.g. the agent-expertise-api repo's in-process extension). pi requires
  // globally-unique tool names, so registering ours would fail extension load.
  // Yield to the project-local extension. `SKIP_EXPERTISE_CLIENT=1` forces this.
  const coexist = shouldSkipRegistration({ env: process.env, cwd: process.cwd() });
  if (coexist.skip) {
    // One line to stderr so a missing expertise_search/expertise_create is
    // explainable rather than mysterious; the body is never secret.
    console.error(`expertise-client: standing down — ${coexist.reason}`);
    return;
  }

  pi.registerTool({
    name: "expertise_search",
    label: "Expertise Search",
    description:
      "Semantic (vector-similarity) search of the local agent-expertise-api " +
      "for expertise entries. Loopback-only and API-key-authenticated " +
      "(ADR-0028). Read-only; returns advisory results that must be " +
      "cross-checked against the static agent catalog. Rate-limited to " +
      "10 requests/min — do not retry a 429 immediately.",
    promptSnippet:
      "Search local agent-expertise-api with expertise_search (advisory; loopback-only).",
    promptGuidelines: [
      "expertise_search returns advisory expertise; cross-check results against the agent catalog before acting.",
      "expertise_search talks only to a local loopback agent-expertise-api and requires PI_EXPERTISE_API_KEY (ADR-0028).",
      "expertise_search is semantic search rate-limited to 10 requests/min; on a rate-limit refusal, wait rather than retrying immediately.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description: "Free-text expertise query (semantic vector search).",
      }),
      limit: Type.Optional(
        Type.Number({
          description:
            "Optional maximum number of results (1-100; default 10, clamped).",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const cfg = buildClientConfig(process.env, loadEnvLocal(resolveEnvPath()));
      if (!cfg.ok) return refusal("expertise_search", cfg.reason);

      const health = await checkReady(cfg.config, signal ? { signal } : {});
      if (!health.ready) {
        return refusal("expertise_search", `API not ready — ${health.reason}`);
      }

      const result = await searchExpertise(
        cfg.config,
        { query: params.query, ...(params.limit !== undefined ? { limit: params.limit } : {}) },
        signal ? { signal } : {},
      );
      if (!result.ok) return refusal("expertise_search", result.reason);

      const truncNote = result.truncated ? "\n[response truncated]" : "";
      return {
        content: [
          {
            type: "text" as const,
            text:
              `expertise_search (advisory; cross-check against the agent catalog)` +
              `${truncNote}\n\n${result.text}`,
          },
        ],
        details: {
          status: result.status,
          bytes: Buffer.byteLength(result.text, "utf-8"),
          truncated: result.truncated,
          query: params.query,
        },
      };
    },
  });

  pi.registerTool({
    name: "expertise_create",
    label: "Expertise Create",
    description:
      "Create a single entry in the local agent-expertise-api. Loopback-only " +
      "and API-key-authenticated (ADR-0028). Create-only (no update/delete) " +
      "and gated behind PI_EXPERTISE_ALLOW_LOCALDEV_WRITE=1; the body is " +
      "scanned for credentials before any network call. A near-duplicate " +
      "entry is rejected by the server (HTTP 409) with the existing entry " +
      "returned — reuse it rather than retrying.",
    promptSnippet:
      "Create local agent-expertise-api entries with expertise_create (loopback-only; opt-in write).",
    promptGuidelines: [
      "expertise_create writes to a local loopback agent-expertise-api and requires PI_EXPERTISE_API_KEY plus PI_EXPERTISE_ALLOW_LOCALDEV_WRITE=1 (ADR-0028).",
      "expertise_create is create-only and refuses bodies containing credential patterns; never put secrets in an expertise entry.",
      "expertise_create requires deliberate entryType and severity classification; if the server reports a near-duplicate (409), reuse the existing entry instead of retrying.",
    ],
    parameters: Type.Object({
      domain: Type.String({
        description: "Domain/topic area of the entry, e.g. 'kafka' or 'ansible'.",
      }),
      title: Type.String({
        description: "Short title of the expertise entry.",
      }),
      body: Type.String({
        description: "Body content of the expertise entry.",
      }),
      entryType: Type.Union(
        ENTRY_TYPES.map((v) => Type.Literal(v)),
        {
          description:
            "Entry classification: IssueFix (a solved problem), Caveat (a " +
            "gotcha/limitation), Requirement (a hard constraint), or Pattern " +
            "(a reusable approach). Choose deliberately; there is no default.",
        },
      ),
      severity: Type.Union(
        SEVERITIES.map((v) => Type.Literal(v)),
        {
          description:
            "Severity of the captured knowledge: Info, Warning, or Critical. " +
            "Choose deliberately; there is no default.",
        },
      ),
      tags: Type.Optional(
        Type.Array(Type.String(), {
          description: "Optional free-form tags.",
        }),
      ),
      source: Type.Optional(
        Type.String({
          description: "Optional provenance; defaults to 'pi-session'.",
        }),
      ),
      sourceVersion: Type.Optional(
        Type.String({
          description: "Optional version of the source the entry derives from.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const cfg = buildClientConfig(process.env, loadEnvLocal(resolveEnvPath()));
      if (!cfg.ok) return refusal("expertise_create", cfg.reason);

      const result = await runCreate(
        cfg.config,
        {
          domain: params.domain,
          title: params.title,
          body: params.body,
          entryType: params.entryType,
          severity: params.severity,
          ...(params.tags !== undefined ? { tags: params.tags } : {}),
          ...(params.source !== undefined ? { source: params.source } : {}),
          ...(params.sourceVersion !== undefined
            ? { sourceVersion: params.sourceVersion }
            : {}),
        },
        signal ? { signal } : {},
      );
      if (!result.ok) return refusal("expertise_create", result.reason);

      const truncNote = result.truncated ? "\n[response truncated]" : "";
      return {
        content: [
          {
            type: "text" as const,
            text:
              `expertise_create (advisory; created entry is unverified API output)` +
              `${truncNote}\n\n${result.text}`,
          },
        ],
        details: {
          status: result.status,
          bytes: Buffer.byteLength(result.text, "utf-8"),
          truncated: result.truncated,
          domain: params.domain,
          title: params.title,
        },
      };
    },
  });
}
