import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

import { createPostgresTransport } from "../transport/postgres.mjs";

function fakePools(t, { failFirstConnect = false } = {}) {
  const pools = [];
  class FakePool {
    constructor(options) {
      this.options = options;
      this.passwords = [];
      this.ended = false;
      pools.push(this);
    }
    on() {}
    async connect() {
      this.passwords.push(await this.options.password());
      if (failFirstConnect && pools.length === 1) throw new Error("connect failed");
      return {
        async query() {
          return {
            rows: [
              { key: "schema_version", value: "2" },
              { key: "min_reader_version", value: "1" },
            ],
          };
        },
        release() {},
      };
    }
    async end() { this.ended = true; }
  }
  t.mock.method(pg, "Pool", function (options) { return new FakePool(options); });
  return pools;
}

function transport(t, options = {}) {
  const tx = createPostgresTransport({
    host: "test-host",
    user: "test-user",
    database: "test-db",
    connectMaxAttempts: 1,
    ...options,
  });
  t.after(() => tx.stop());
  return tx;
}

const self = { id: "test-session", name: "test-agent" };

test("startup authenticates before creating the pool and reuses that token only once", async (t) => {
  const pools = fakePools(t);
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  let finish;
  const credential = new Promise((resolve) => { finish = resolve; });
  let calls = 0;
  const tx = transport(t);
  const initializing = tx.init({
    self,
    credentials: {
      async get() {
        calls += 1;
        if (calls === 1) { signalStarted(); return credential; }
        return "fresh-token";
      },
    },
  });
  await started;
  assert.equal(pools.length, 0, "the PostgreSQL deadline must not include initial authentication");
  finish("startup-token");
  await initializing;
  assert.equal(calls, 1);
  assert.deepEqual(pools[0].passwords, ["startup-token"]);
  const client = await pools[0].connect();
  client.release();
  assert.equal(calls, 2);
  assert.deepEqual(pools[0].passwords, ["startup-token", "fresh-token"]);
});

test("startup retries credential failures without constructing a half-initialized pool", async (t) => {
  const pools = fakePools(t);
  const backoffs = [];
  const tx = transport(t, {
    connectMaxAttempts: 2,
    sleep: async (ms) => backoffs.push(ms),
  });
  let calls = 0;
  await tx.init({
    self,
    credentials: {
      async get() {
        if (++calls === 1) throw new Error("credential unavailable");
        return "retry-token";
      },
    },
  });
  assert.equal(calls, 2);
  assert.equal(pools.length, 1);
  assert.deepEqual(pools[0].passwords, ["retry-token"]);
  assert.deepEqual(backoffs, [2000]);
});

test("startup cleans up a failed pool and acquires new credentials before retrying", async (t) => {
  const pools = fakePools(t, { failFirstConnect: true });
  const tx = transport(t, { connectMaxAttempts: 2, sleep: async () => {} });
  let calls = 0;
  await tx.init({ self, credentials: { async get() { return `token-${++calls}`; } } });
  assert.equal(calls, 2);
  assert.equal(pools[0].ended, true);
  assert.deepEqual(pools.map((pool) => pool.passwords), [["token-1"], ["token-2"]]);
});

test("startup bounds credential acquisition and reports its own timeout", async (t) => {
  const pools = fakePools(t);
  const tx = transport(t, { credentialTimeoutMillis: 10 });
  await assert.rejects(
    tx.init({ self, credentials: { get: () => new Promise(() => {}) } }),
    /startup credential acquisition timed out after 10ms/,
  );
  assert.equal(pools.length, 0);
});

test("startup preserves passwordless credentials", async (t) => {
  const pools = fakePools(t);
  const tx = transport(t);
  await tx.init({ self, credentials: { async get() { return null; } } });
  assert.deepEqual(pools[0].passwords, [undefined]);
});
