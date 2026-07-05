> **First-party** pi extension. Local client for `agent-expertise-api`. See [ADR-0028](https://github.com/psmfd/pi-config/blob/main/adrs/0028-agent-expertise-api-client.md) and tracking issue #149.

# expertise-client

A local-only pi extension that talks to a developer's locally-running
[`agent-expertise-api`](https://github.com/psmfd/agent-expertise-api). Phase 1
(per ADR-0028) is **Linux/macOS only, loopback only, API-key authenticated**.

This extension registers the read-side tool `expertise_search` (#317) and the
create-only `expertise_create` tool (#318).

## Install

```sh
pi install git:github.com/psmfd/pi-expertise-client
```

Try it first without installing: `pi -e git:github.com/psmfd/pi-expertise-client`.

## Prerequisite — a running `agent-expertise-api`

This extension is a **client**. It does nothing on its own: it requires a
separately-obtained [`agent-expertise-api`](https://github.com/psmfd/agent-expertise-api)
service **running locally on loopback** before either tool works. You must:

1. Obtain and run `agent-expertise-api` (a separate repository) on a loopback
   origin (e.g. `http://127.0.0.1:8080`).
2. Copy `.env.example` to `.env.local` (gitignored) and set `PI_EXPERTISE_API_BASE_URL`
   (loopback only) and `PI_EXPERTISE_API_KEY`. Writes additionally require
   `PI_EXPERTISE_ALLOW_LOCALDEV_WRITE=1`.

Without that service reachable, the tools return a health/connection error.

## Coexistence (ADR-0029)

This client is installed globally (`~/.pi/agent/extensions/`), so it loads for
**every** pi session. The
[`agent-expertise-api`](https://github.com/psmfd/agent-expertise-api) repository
ships its **own** project-local extension (`.pi/extensions/expertise-api/`) that
registers `expertise_search`/`expertise_create` directly. Because pi requires
globally-unique tool names, launching pi inside that repo with both active fails
extension load with a tool-name conflict.

To avoid the collision, the client **stands down** (registers nothing) when the
current project already defines a conflicting expertise tool — the project-local
extension wins. Detection scans the project-local extension discovery paths
(`<cwd>/.pi/extensions/<dir>/index.ts` and the single-file form
`<cwd>/.pi/extensions/<name>.ts`) for a conflicting tool-name registration and
fails open (registers normally) on any read error. Set
`SKIP_EXPERTISE_CLIENT=1` to force stand-down unconditionally.

## Tools

| Tool | Kind | Notes |
|---|---|---|
| `expertise_search` | read-only | Semantic (vector-similarity) query of the local API. Output is **advisory** and must be cross-checked against the static agent catalog. Rate-limited to 10 requests/min server-side. |
| `expertise_create` | create-only write | Creates a single entry. Double-gated: requires `PI_EXPERTISE_ALLOW_LOCALDEV_WRITE=1` **and** a clean body-secret scan. No update/delete/archive/approve. |

## Configuration

Configuration comes from `process.env` and a single FIXED file —
`agent/extensions/expertise-client/.env.local` — and nothing else. The
extension never walks parent directories and never reads a repository's own
`.env`, so a checked-out project cannot redirect the endpoint or supply
credentials.

Precedence: `process.env` > `.env.local` > built-in defaults.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PI_EXPERTISE_API_BASE_URL` | no | `http://127.0.0.1:8080` | Loopback origin of the local API. Non-loopback hosts are refused. |
| `PI_EXPERTISE_API_KEY` | **yes** | — | Sent as `Authorization: Bearer` on every call. Never logged or surfaced. |
| `PI_EXPERTISE_ALLOW_LOCALDEV_WRITE` | only for writes | `0` | Opt-in for `expertise_create`. Must be `1` to enable create. Ignored by search. |
| `SKIP_EXPERTISE_CLIENT` | no | `0` | Override: when truthy, the client registers no tools (see [Coexistence](#coexistence-adr-0029)). |

Copy `.env.example` to `.env.local` and fill in your key:

```bash
cp agent/extensions/expertise-client/.env.example agent/extensions/expertise-client/.env.local
# then edit .env.local and set PI_EXPERTISE_API_KEY
```

`.env.local` is gitignored. Only `.env.example` is tracked.

## Refusal policy (per-rule)

All of the following are **hard refusals** (fail closed, no override in phase 1):

| Condition | Result |
|---|---|
| `PI_EXPERTISE_API_BASE_URL` is not a valid URL | refuse |
| base URL host is not loopback (`localhost` / `127.0.0.0/8` / `::1`) | refuse |
| `PI_EXPERTISE_API_KEY` missing/empty | refuse |
| `/health/ready` returns non-200 or is unreachable | refuse |
| search request errors or returns non-2xx | refuse |
| `expertise_create` called with `PI_EXPERTISE_ALLOW_LOCALDEV_WRITE` != `1` | refuse (before any network call) |
| any string field of the `expertise_create` body matches a credential pattern | refuse (category named, secret never echoed) |
| create request errors or returns non-2xx | refuse (409 near-duplicate and 400/other bodies are surfaced) |
| search returns HTTP 429 (rate limit) | refuse with a wait-before-retry message (surfaces `Retry-After` when present) |

## Trust boundary

- Loopback is a network locality boundary, **not** an authentication boundary —
  hence the mandatory API key even for local calls.
- Returned content is **untrusted tool-call output**. It is surfaced only as the
  structured return value of `expertise_search`, framed as advisory, and is
  **never** injected as system context (see
  [`agent/rules/no-mcp-servers.md`](https://github.com/psmfd/pi-config/blob/main/agent/rules/no-mcp-servers.md)).
- Response bodies are bounded to 256 KB.
- The API key is never written to tool `content`, `details`, logs, errors, or
  refusal messages.
- **Create body-secret guard.** `secrets-guard` (the global extension) only sees
  `write`/`edit`/`artifact_review`/`bash` and is scoped to disk/commit
  persistence, so it never inspects `expertise_create`. Instead an
  extension-local lightweight guard (`lib/secret-scan.ts`) scans **every string
  field** of the create body before any network call and refuses if any carries
  a credential pattern (PEM private-key block / AWS access key ID / GitHub token /
  signed JWT / `Authorization: Bearer` literal — the exact `secrets-guard` pattern
  set, framework ADR-095). The scan is field-shape-agnostic
  (every string property and string-array element), so a future contract field
  cannot silently bypass it (#489). It returns **category names only**, never
  the matched secret, so the refusal message cannot leak the value.

## API contract

Verified against `agent-expertise-api` v1.1.0 (live end-to-end, #489). These
are single-edit constants centralized in `lib/search.ts` / `lib/create.ts`.

- **Search route:** `GET /expertise/search/semantic?q=...&limit=...` — semantic
  vector search. `q` is required; `limit` is clamped to `[1, 100]` (client- and
  server-side, default 10). Governed by a token-bucket rate limit of 10
  requests/min per principal; a `429` is surfaced as a wait-before-retry
  refusal. The keyword FTS endpoint (`/expertise/search`, `q` +
  `includeDeprecated` only, no `limit`) is not exposed in phase 1.
- **Create route:** `POST /expertise` with a JSON body — required `domain`,
  `title`, `body`, `entryType` (`IssueFix` | `Caveat` | `Requirement` |
  `Pattern`), `severity` (`Info` | `Warning` | `Critical`), `source` (defaults
  to `pi-session`); optional `tags[]`, `sourceVersion`. Sent with a fresh
  `Idempotency-Key` header per request (the server requires it) and
  `content-type: application/json`. `entryType`/`severity` are **required tool
  parameters** even though the server would default an omitted value — the
  server silently defaults to `IssueFix`/`Info`, which mis-tags entries rather
  than erroring. The server's `tenant` field is **deliberately not exposed**:
  `tenant: "shared"` bypasses the draft/review queue (created directly as
  Approved), outside ADR-0028's phase-1 create-only localdev scope. The
  per-call `Idempotency-Key` satisfies ADR-0028's "generated per create
  request"; it does **not** de-duplicate retries across calls, though the
  server's near-duplicate detection returns `409` with the existing entry, which
  the tool surfaces so the caller can reuse it.
- **Readiness route:** `GET /health/ready` (200 ⇒ ready).
- **Credential header:** `Authorization: Bearer <key>` (the only scheme
  agent-expertise-api's ApiKey mode accepts — #486).

## Tests

```bash
./scripts/test-expertise-client.sh
```

Tests are hermetic — they stub `fetch` and never touch the network.
