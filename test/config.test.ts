/**
 * expertise-client — config resolution + env parsing tests (ADR-0103).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseEnvFile, loadEnvLocal } from "../lib/env.ts";
import {
  buildClientConfig,
  isLoopbackHost,
  DEFAULT_BASE_URL,
  ENV_BASE_URL,
  ENV_API_KEY,
  ENV_ALLOW_WRITE,
  ENV_UPSTREAM_BASE_URL,
  ENV_UPSTREAM_TOKEN,
  ENV_UPSTREAM_SECRETS_FILE,
  resolveUpstreamSecretsPath,
  loadUpstreamSecrets,
} from "../shared/expertise-api-config.ts";

test("parseEnvFile parses KEY=VALUE, ignores comments/blank, strips quotes", () => {
  const parsed = parseEnvFile(
    [
      "# a comment",
      "",
      "PI_EXPERTISE_API_KEY = secret-key ",
      'PI_EXPERTISE_API_BASE_URL="http://127.0.0.1:9000"',
      "PI_EXPERTISE_ALLOW_LOCALDEV_WRITE='1'",
      "not a valid line",
    ].join("\n"),
  );
  assert.equal(parsed[ENV_API_KEY], "secret-key");
  assert.equal(parsed[ENV_BASE_URL], "http://127.0.0.1:9000");
  assert.equal(parsed[ENV_ALLOW_WRITE], "1");
  assert.equal(Object.keys(parsed).length, 3);
});

test("loadEnvLocal returns {} for a missing file", () => {
  assert.deepEqual(loadEnvLocal(join(tmpdir(), "definitely-missing-.env.local")), {});
});

test("loadEnvLocal reads and parses an existing file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "exp-env-"));
  try {
    const path = join(dir, ".env.local");
    await fs.writeFile(path, "PI_EXPERTISE_API_KEY=from-file\n");
    assert.equal(loadEnvLocal(path)[ENV_API_KEY], "from-file");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadUpstreamSecrets reads the explicit upstream file override", async () => {
  const dir = await mkdtemp(join(tmpdir(), "exp-upstream-env-"));
  try {
    const path = join(dir, "secrets.env");
    await fs.writeFile(
      path,
      "EXPERTISE_API_BASE_URL=https://expertise.lan.example\n" +
        "EXPERTISE_API_TOKEN=test-token\n",
    );
    const loaded = loadUpstreamSecrets({ [ENV_UPSTREAM_SECRETS_FILE]: path });
    assert.equal(loaded[ENV_UPSTREAM_BASE_URL], "https://expertise.lan.example");
    assert.equal(loaded[ENV_UPSTREAM_TOKEN], "test-token");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("isLoopbackHost accepts loopback forms and rejects others", () => {
  for (const h of ["localhost", "127.0.0.1", "127.0.0.2", "::1", "[::1]"]) {
    assert.equal(isLoopbackHost(h), true, h);
  }
  for (const h of ["example.com", "10.0.0.1", "0.0.0.0", "expertise.internal"]) {
    assert.equal(isLoopbackHost(h), false, h);
  }
});

test("buildClientConfig: process.env overrides .env.local overrides default", () => {
  const fileEnv = {
    [ENV_BASE_URL]: "http://127.0.0.1:9000",
    [ENV_API_KEY]: "file-key",
  };
  const processEnv = {
    [ENV_BASE_URL]: "http://127.0.0.1:7000",
    [ENV_API_KEY]: "proc-key",
  };
  const r = buildClientConfig(processEnv, fileEnv);
  assert.ok(r.ok);
  assert.equal(r.config.baseUrl, "http://127.0.0.1:7000");
  assert.equal(r.config.bearerToken, "proc-key");
  assert.equal(r.config.authMode, "local-api-key");
});

test("buildClientConfig: defaults base URL when neither source sets it", () => {
  const r = buildClientConfig({ [ENV_API_KEY]: "k" }, {});
  assert.ok(r.ok);
  assert.equal(r.config.baseUrl, new URL(DEFAULT_BASE_URL).origin);
});

test("buildClientConfig: .env.local fills in when process.env is unset", () => {
  const r = buildClientConfig({}, { [ENV_API_KEY]: "file-key" });
  assert.ok(r.ok);
  assert.equal(r.config.bearerToken, "file-key");
});

test("buildClientConfig: refuses a non-loopback legacy base URL", () => {
  const r = buildClientConfig(
    { [ENV_BASE_URL]: "http://expertise.example.com", [ENV_API_KEY]: "k" },
    {},
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /loopback/i);
});

test("buildClientConfig: accepts upstream HTTPS bearer config", () => {
  const r = buildClientConfig(
    {
      [ENV_UPSTREAM_BASE_URL]: "https://expertise.lan.example/path",
      [ENV_UPSTREAM_TOKEN]: "header.payload.signature",
    },
    { [ENV_API_KEY]: "legacy-key" },
  );
  assert.ok(r.ok);
  assert.equal(r.config.baseUrl, "https://expertise.lan.example");
  assert.equal(r.config.bearerToken, "header.payload.signature");
  assert.equal(r.config.authMode, "upstream-bearer");
});

test("buildClientConfig: upstream process env overrides upstream secrets file", () => {
  const r = buildClientConfig(
    {
      [ENV_UPSTREAM_BASE_URL]: "https://process.example",
      [ENV_UPSTREAM_TOKEN]: "process-token",
    },
    {},
    {
      [ENV_UPSTREAM_BASE_URL]: "https://file.example",
      [ENV_UPSTREAM_TOKEN]: "file-token",
    },
  );
  assert.ok(r.ok);
  assert.equal(r.config.baseUrl, "https://process.example");
  assert.equal(r.config.bearerToken, "process-token");
});

test("buildClientConfig: upstream secrets file supplies the bearer profile", () => {
  const r = buildClientConfig(
    {},
    {},
    {
      [ENV_UPSTREAM_BASE_URL]: "https://expertise.lan.example",
      [ENV_UPSTREAM_TOKEN]: "file-token",
    },
  );
  assert.ok(r.ok);
  assert.equal(r.config.authMode, "upstream-bearer");
  assert.equal(r.config.bearerToken, "file-token");
});

test("buildClientConfig: partial upstream config fails instead of falling back", () => {
  const r = buildClientConfig(
    { [ENV_UPSTREAM_BASE_URL]: "https://expertise.lan.example" },
    { [ENV_API_KEY]: "legacy-key" },
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /must both be set/i);
});

test("buildClientConfig: upstream remote cleartext and URL credentials are refused", () => {
  const cleartext = buildClientConfig(
    {
      [ENV_UPSTREAM_BASE_URL]: "http://expertise.lan.example",
      [ENV_UPSTREAM_TOKEN]: "token",
    },
    {},
  );
  assert.equal(cleartext.ok, false);
  if (!cleartext.ok) assert.match(cleartext.reason, /https/i);

  const userinfo = buildClientConfig(
    {
      [ENV_UPSTREAM_BASE_URL]: "https://user:pass@expertise.lan.example",
      [ENV_UPSTREAM_TOKEN]: "token",
    },
    {},
  );
  assert.equal(userinfo.ok, false);
  if (!userinfo.ok) assert.match(userinfo.reason, /URL credentials/i);
});

test("buildClientConfig: upstream loopback HTTP remains valid for development", () => {
  const r = buildClientConfig(
    {
      [ENV_UPSTREAM_BASE_URL]: "http://127.0.0.1:8080",
      [ENV_UPSTREAM_TOKEN]: "dev:team:expertise.read",
    },
    {},
  );
  assert.ok(r.ok);
  assert.equal(r.config.authMode, "upstream-bearer");
});

test("resolveUpstreamSecretsPath uses the upstream default or explicit override", () => {
  assert.match(resolveUpstreamSecretsPath({}), /\.config\/expertise-api\/secrets\.env$/);
  assert.equal(
    resolveUpstreamSecretsPath({ [ENV_UPSTREAM_SECRETS_FILE]: "/tmp/custom.env" }),
    "/tmp/custom.env",
  );
});

test("buildClientConfig: refuses a missing API key", () => {
  const r = buildClientConfig({}, {});
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /PI_EXPERTISE_API_KEY/);
});

test("buildClientConfig: write opt-in reflects PI_EXPERTISE_ALLOW_LOCALDEV_WRITE=1", () => {
  const on = buildClientConfig(
    { [ENV_API_KEY]: "k", [ENV_ALLOW_WRITE]: "1" },
    {},
  );
  assert.ok(on.ok);
  assert.equal(on.config.allowWrite, true);

  const off = buildClientConfig({ [ENV_API_KEY]: "k" }, {});
  assert.ok(off.ok);
  assert.equal(off.config.allowWrite, false);
});
