import { test } from "node:test";
import assert from "node:assert/strict";

import { classify, EXIT } from "../scripts/preflight-cross-machine.mjs";

const env = { AGENT_RELAY_PG_USER: "admin@example.com", AGENT_RELAY_PG_HOST: "db.example" };

test("wrong-tenant AADSTS50020 → AUTH_REJECTED (not NO_AUTH) — the regression", () => {
  const err = new Error(
    "AADSTS50020: User account 'guest_user#EXT#@tenant.onmicrosoft.com' from identity provider " +
      "does not exist in tenant ... Acquire a new token for tenant 'xxxx'.",
  );
  const { code, message } = classify(err, env);
  assert.equal(code, EXIT.AUTH_REJECTED, "AADSTS50020 must classify as wrong tenant/account, not 'not signed in'");
  assert.match(message, /WRONG tenant\/account/i);
  assert.match(message, /admin@example\.com/, "names the expected DB admin");
});

test("not signed in → NO_AUTH", () => {
  const err = new Error("DefaultAzureCredential failed to retrieve a token. AzureCliCredential: Please run 'az login'.");
  assert.equal(classify(err, env).code, EXIT.NO_AUTH);
});

test("incomplete config (missing host) → ENV_INCOMPLETE", () => {
  assert.equal(classify(new Error("postgres transport requires a host"), env).code, EXIT.ENV_INCOMPLETE);
});

test("pg not installed → PG_MISSING", () => {
  const err = new Error("the 'postgres' transport requires the 'pg' package — run npm install");
  assert.equal(classify(err, env).code, EXIT.PG_MISSING);
});

test("DB rejects the token (SQLSTATE 28000) → AUTH_REJECTED", () => {
  const err = Object.assign(new Error("password authentication failed for user"), { code: "28000" });
  const { code, message } = classify(err, env);
  assert.equal(code, EXIT.AUTH_REJECTED);
  assert.match(message, /REJECTED by the database/i);
});

test("host unreachable (ENOTFOUND) → UNREACHABLE", () => {
  const err = Object.assign(new Error("getaddrinfo ENOTFOUND db.example"), { code: "ENOTFOUND" });
  const { code, message } = classify(err, env);
  assert.equal(code, EXIT.UNREACHABLE);
  assert.match(message, /db\.example/);
});

test("schema too new → SCHEMA_NEWER", () => {
  const err = new Error("agent-relay: database schema_version 999 is newer than this build supports (1).");
  assert.equal(classify(err, env).code, EXIT.SCHEMA_NEWER);
});

test("unrecognized error → OTHER", () => {
  assert.equal(classify(new Error("something unexpected"), env).code, EXIT.OTHER);
});

test("never throws on odd inputs; missing env shows '?' placeholders", () => {
  assert.equal(classify(null).code, EXIT.OTHER);
  const { message } = classify(Object.assign(new Error("x"), { code: "ECONNREFUSED" }), {});
  assert.match(message, /host '\?'/);
});
