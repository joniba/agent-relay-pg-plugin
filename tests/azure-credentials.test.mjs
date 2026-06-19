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
