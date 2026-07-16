/**
 * expertise-client — pi extension (ADR-0103, superseding ADR-0028).
 *
 * Registers semantic `expertise_search` and guarded create-only
 * `expertise_create`. The local profile remains loopback/API-key only; the
 * upstream profile consumes agent-expertise-api's pre-provisioned bearer-token
 * contract, including static-OIDC JWTs minted by `scripts/mint_token.py`.
 * Create remains gated behind `PI_EXPERTISE_ALLOW_LOCALDEV_WRITE=1` and the
 * body-secret guard in either profile.
 *
 * Endpoint and credentials come only from process env plus fixed operator-owned
 * files, never project settings or API responses. Returned content is untrusted
 * tool output, never hidden/system context.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { shouldSkipRegistration } from "./lib/coexist.ts";
import { buildClientConfig } from "./shared/expertise-api-config.ts";
import { ENTRY_TYPES, SEVERITIES } from "./lib/create.ts";
import {
  loadEnvLocal,
  loadUpstreamSecrets,
  resolveEnvPath,
} from "./lib/env.ts";
import { checkReady } from "./shared/expertise-api-health.ts";
import { runCreate } from "./lib/run-create.ts";
import { searchExpertise } from "./shared/expertise-api-search.ts";

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
      "Semantic (vector-similarity) search of agent-expertise-api for " +
      "expertise entries. Supports the local API-key profile and the upstream " +
      "pre-provisioned bearer/static-OIDC profile (ADR-0103). Read-only; " +
      "returns advisory results that must be cross-checked against source. " +
      "Rate-limited to 10 requests/min — do not retry a 429 immediately.",
    promptSnippet:
      "Search agent-expertise-api with expertise_search before non-trivial coding work (advisory).",
    promptGuidelines: [
      "Use expertise_search before solving a non-trivial coding problem to check for prior knowledge and avoid rediscovery.",
      "expertise_search returns advisory expertise; cross-check results against repository code, first-party documentation, and the agent catalog before acting.",
      "expertise_search supports either local PI_EXPERTISE_* API-key config or agent-expertise-api's EXPERTISE_API_* bearer-token contract; never request or echo the credential.",
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
      const cfg = buildClientConfig(
        process.env,
        loadEnvLocal(resolveEnvPath()),
        loadUpstreamSecrets(process.env),
      );
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
      "Create a single entry in agent-expertise-api through the configured " +
      "local or upstream bearer profile (ADR-0103). Create-only (no " +
      "update/delete) and gated behind PI_EXPERTISE_ALLOW_LOCALDEV_WRITE=1; the body is " +
      "scanned for credentials before any network call. A near-duplicate " +
      "entry is rejected by the server (HTTP 409) with the existing entry " +
      "returned — reuse it rather than retrying.",
    promptSnippet:
      "Create agent-expertise-api entries with expertise_create (human-approved, opt-in write).",
    promptGuidelines: [
      "expertise_create requires PI_EXPERTISE_ALLOW_LOCALDEV_WRITE=1 in either auth profile and remains subject to the expertise-fanout-gate human-approval ledger when that gate is loaded.",
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
      const cfg = buildClientConfig(
        process.env,
        loadEnvLocal(resolveEnvPath()),
        loadUpstreamSecrets(process.env),
      );
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
