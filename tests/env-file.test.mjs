import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";

import { loadEnvFile } from "../env-file.mjs";

function tmp() {
  return mkdtempSync(join(tmpdir(), "agent-relay-env-"));
}

test("returns null when no .env exists in any candidate", () => {
  const dir = tmp();
  try {
    const env = {}; // no AGENT_RELAY_ENV_FILE
    assert.equal(loadEnvFile({ env, baseDir: join(dir, "extension") }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loads <baseDir>/.env and fills process.env gaps", () => {
  const dir = tmp();
  try {
    const base = join(dir, "extension");
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, ".env"), "AGENT_RELAY_TRANSPORT=postgres\nAGENT_RELAY_PG_DB=agentrelay\n");
    const env = {};
    const res = loadEnvFile({ env, baseDir: base });
    assert.equal(res.path, join(base, ".env"));
    assert.equal(env.AGENT_RELAY_TRANSPORT, "postgres");
    assert.equal(env.AGENT_RELAY_PG_DB, "agentrelay");
    assert.deepEqual(res.applied.sort(), ["AGENT_RELAY_PG_DB", "AGENT_RELAY_TRANSPORT"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("does NOT override a variable already set in the environment (shell wins)", () => {
  const dir = tmp();
  try {
    const base = join(dir, "extension");
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, ".env"), "AGENT_RELAY_PG_HOST=from-file\nAGENT_RELAY_PG_DB=agentrelay\n");
    const env = { AGENT_RELAY_PG_HOST: "from-shell" };
    const res = loadEnvFile({ env, baseDir: base });
    assert.equal(env.AGENT_RELAY_PG_HOST, "from-shell", "pre-set value must win");
    assert.equal(env.AGENT_RELAY_PG_DB, "agentrelay", "unset gap is filled");
    assert.deepEqual(res.applied, ["AGENT_RELAY_PG_DB"], "only the gap is reported applied");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("$AGENT_RELAY_ENV_FILE takes precedence over <baseDir>/.env", () => {
  const dir = tmp();
  try {
    const base = join(dir, "extension");
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, ".env"), "WHO=basedir\n");
    const explicit = join(dir, "custom.env");
    writeFileSync(explicit, "WHO=explicit\n");
    const env = { AGENT_RELAY_ENV_FILE: explicit };
    const res = loadEnvFile({ env, baseDir: base });
    assert.equal(res.path, explicit);
    assert.equal(env.WHO, "explicit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("falls back to <baseDir>/../.env (repo root) when <baseDir>/.env is absent", () => {
  const dir = tmp();
  try {
    const base = join(dir, "extension");
    mkdirSync(base, { recursive: true });
    writeFileSync(join(dir, ".env"), "WHO=parent\n"); // repo-root sibling of extension/
    const env = {};
    const res = loadEnvFile({ env, baseDir: base });
    assert.equal(res.path, join(dir, ".env"));
    assert.equal(env.WHO, "parent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a double-quoted value containing '#' is preserved (Entra guest UPN)", () => {
  const dir = tmp();
  try {
    const base = join(dir, "extension");
    mkdirSync(base, { recursive: true });
    writeFileSync(
      join(base, ".env"),
      'AGENT_RELAY_PG_USER="user_gmail.com#EXT#@tenant.onmicrosoft.com"\n',
    );
    const env = {};
    loadEnvFile({ env, baseDir: base });
    assert.equal(env.AGENT_RELAY_PG_USER, "user_gmail.com#EXT#@tenant.onmicrosoft.com");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
