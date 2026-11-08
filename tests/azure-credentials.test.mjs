import { test } from "node:test";
import assert from "node:assert/strict";

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

test("concurrent requests share one acquisition and immediate reuse uses the cache", async () => {
  let calls = 0;
  let release;
  const result = new Promise(resolve => { release = resolve; });
  const lines = [];
  const creds = createAzureEntraCredentials({
    credential: { getToken: async () => { calls++; return result; } },
    log: message => lines.push(message),
  });
  const requests = [creds.get(), creds.get(), creds.get(), creds.get()];
  await Promise.resolve();
  assert.equal(calls, 1);
  release({ token: "test-token", expiresOnTimestamp: Date.now() + 3_600_000 });
  assert.deepEqual(await Promise.all(requests), Array(4).fill("test-token"));
  assert.equal(await creds.get(), "test-token");
  assert.equal(calls, 1);
  assert.ok(lines.some(line => line.includes("request joined")));
  assert.ok(lines.some(line => line.includes("cache hit")));
  assert.ok(lines.every(line => !line.includes("test-token")));
});

test("refreshes before expiry and never returns an expired replacement", async () => {
  let now = Date.now();
  let calls = 0;
  const creds = createAzureEntraCredentials({
    clock: () => now,
    credential: {
      async getToken() {
        calls++;
        return { token: `token-${calls}`, expiresOnTimestamp: calls === 1 ? now + 600_000 : now - 1 };
      },
    },
  });
  assert.equal(await creds.get(), "token-1");
  now += 300_001;
  await assert.rejects(creds.get(), /expired token/);
  assert.equal(calls, 2);
});

test("a failed acquisition is shared, then a completed failure can be retried", async () => {
  let calls = 0;
  const creds = createAzureEntraCredentials({
    credential: {
      async getToken() {
        if (++calls === 1) throw new Error("test authorization failure");
        return { token: "replacement", expiresOnTimestamp: Date.now() + 600_000 };
      },
    },
  });

  const results = await Promise.allSettled([creds.get(), creds.get()]);
  assert.ok(results.every(result => result.status === "rejected"));
  assert.equal(calls, 1);
  assert.equal(await creds.get(), "replacement");
  assert.equal(calls, 2);
});

test("authorization failure diagnostics do not contain private exception text", async () => {
  const lines = [];
  const creds = createAzureEntraCredentials({
    credential: { getToken: async () => { throw new Error("private-user private-token"); } },
    log: line => lines.push(line),
  });
  await assert.rejects(creds.get(), /private-user/);
  assert.ok(lines.some(line => line.includes("reason=authorization failed")));
  assert.ok(lines.every(line => !/private-user|private-token/.test(line)));
});
