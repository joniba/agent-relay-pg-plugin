import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";

import {
  createAzureEntraCredentials,
  PG_AAD_SCOPE,
} from "../credentials/azure/credentials.mjs";

// A fake Azure TokenCredential — records the scope it was asked for and returns
// a canned token. No network, no @azure/identity needed (we inject this).
function fakeCredential(token, { record } = {}) {
  return {
    async getToken(scope) {
      if (record) record.scope = scope;
      return token === null ? null : { token, expiresOnTimestamp: Date.now() + 3_600_000 };
    },
  };
}

test("get() returns the raw token string from the injected credential", async () => {
  const creds = createAzureEntraCredentials({ credential: fakeCredential("tok-abc") });
  assert.equal(await creds.get(), "tok-abc");
});

test("get() requests the PostgreSQL AAD scope by default", async () => {
  const record = {};
  const creds = createAzureEntraCredentials({ credential: fakeCredential("t", { record }) });
  await creds.get();
  assert.equal(record.scope, PG_AAD_SCOPE);
  assert.match(PG_AAD_SCOPE, /ossrdbms-aad\.database\.windows\.net/);
});

test("get() honors a custom scope override", async () => {
  const record = {};
  const creds = createAzureEntraCredentials({
    credential: fakeCredential("t", { record }),
    scope: "https://example/.default",
  });
  await creds.get();
  assert.equal(record.scope, "https://example/.default");
});

test("get() throws a clear error when no token is returned", async () => {
  const creds = createAzureEntraCredentials({ credential: fakeCredential(null) });
  await assert.rejects(() => creds.get(), /no token/i);
});

test("get() mints a fresh token on each call (per-connection refresh)", async () => {
  let n = 0;
  const creds = createAzureEntraCredentials({
    credential: {
      async getToken() {
        n += 1;
        return { token: `tok-${n}` };
      },
    },
  });
  assert.equal(await creds.get(), "tok-1");
  assert.equal(await creds.get(), "tok-2");
});

test("returns a CredentialProvider-shaped object (has async get)", () => {
  const creds = createAzureEntraCredentials({ credential: fakeCredential("t") });
  assert.equal(typeof creds.get, "function");
});

test("get() replaces a traceparent with the canonical session id before acquiring a token", async () => {
  const env = {
    COPILOT_AGENT_SESSION_ID: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
    SESSION_ID: "12345678-1234-1234-1234-123456789abc",
  };
  const logs = [];
  const creds = createAzureEntraCredentials({
    env,
    log: (message) => logs.push(message),
    credential: {
      async getToken() {
        assert.equal(env.COPILOT_AGENT_SESSION_ID, env.SESSION_ID);
        return { token: "token" };
      },
    },
  });
  await creds.get();
  await creds.get();
  assert.equal(logs.length, 1);
  assert.ok(logs.every((message) => !message.includes(env.SESSION_ID)));
});

test("get() preserves valid agent-session metadata and an absent marker", async () => {
  for (const env of [
    {},
    { COPILOT_AGENT_SESSION_ID: "existing-agent-session-id", SESSION_ID: "different-session-id-1234" },
  ]) {
    const before = { ...env };
    const creds = createAzureEntraCredentials({ env, credential: fakeCredential("token") });
    await creds.get();
    assert.deepEqual(env, before);
  }
});

test("get() refuses invalid agent metadata without dropping provenance or acquiring a token", async () => {
  for (const env of [
    { COPILOT_AGENT_SESSION_ID: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01" },
    { COPILOT_AGENT_SESSION_ID: "invalid", SESSION_ID: "12345678-1234-1234-1234-123456789abc" },
  ]) {
    const before = { ...env };
    let called = false;
    const creds = createAzureEntraCredentials({
      env,
      credential: { async getToken() { called = true; return { token: "token" }; } },
    });
    await assert.rejects(() => creds.get(), /invalid COPILOT_AGENT_SESSION_ID/);
    assert.equal(called, false);
    assert.deepEqual(env, before);
  }
});

async function blockCredentialFallbacks(t) {
  const { DefaultAzureCredential, AzurePowerShellCredential } = await import("@azure/identity");
  return [DefaultAzureCredential, AzurePowerShellCredential].map((Credential) =>
    t.mock.method(Credential.prototype, "getToken", async () => {
      assert.fail(`Unexpected ${Credential.name} authentication`);
    }),
  );
}

test("default credentials use only Azure CLI with the requested tenant and a bounded process", async (t) => {
  const fallbacks = await blockCredentialFallbacks(t);
  const tenantId = "12345678-1234-1234-1234-123456789abc";
  const commands = [];
  t.mock.method(childProcess, "exec", (command, options, callback) => {
    commands.push(command);
    assert.equal(options.timeout, 30_000);
    callback(null, JSON.stringify({ accessToken: "cli-token", expires_on: 4_070_908_800 }), "");
  });
  const creds = createAzureEntraCredentials({ tenantId, env: {} });

  assert.equal(await creds.get(), "cli-token");
  assert.equal(commands.length, 1);
  assert.match(commands[0], /^az account get-access-token /);
  assert.ok(commands[0].includes(`--tenant ${tenantId}`));
  assert.ok(commands[0].includes("--resource https://ossrdbms-aad.database.windows.net"));
  for (const fallback of fallbacks) assert.equal(fallback.mock.callCount(), 0);
});

test("missing CLI or expired login fails without falling back to other Azure credentials", async (t) => {
  const fallbacks = await blockCredentialFallbacks(t);
  let stderr;
  const exec = t.mock.method(childProcess, "exec", (_command, _options, callback) => {
    callback(new Error("CLI command failed"), "", stderr);
  });
  const creds = createAzureEntraCredentials({ env: {} });

  for (const failure of [
    { stderr: "'az' is not recognized as an internal or external command.", expected: /Azure CLI could not be found/ },
    { stderr: "Please run 'az login' to set up an account.", expected: /az login/ },
  ]) {
    stderr = failure.stderr;
    await assert.rejects(() => creds.get(), failure.expected);
  }
  assert.equal(exec.mock.callCount(), 2);
  for (const fallback of fallbacks) assert.equal(fallback.mock.callCount(), 0);
});
