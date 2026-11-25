import { test } from "node:test";
import assert from "node:assert/strict";

import { createPostgresTransport } from "../transport/postgres.mjs";

function harness(t, onRegistered) {
  const state = { taken: [], committed: null, failCommit: false, stale: false };
  let pending;
  const query = async (sql, params) => {
    if (sql.includes("SELECT key, value")) {
      return { rows: [{ key: "schema_version", value: "2" }] };
    }
    if (sql.includes("SELECT name FROM agents")) {
      return { rows: state.taken.map((name) => ({ name })) };
    }
    if (sql.includes("INSERT INTO agents")) pending = params[1];
    if (sql === "COMMIT" && pending !== undefined) {
      if (state.failCommit) throw new Error("commit failed");
      state.committed = pending;
      pending = undefined;
    }
    if (sql === "ROLLBACK") pending = undefined;
    if (sql.includes("UPDATE agents SET last_heartbeat")) {
      const rowCount = state.stale ? 0 : 1;
      state.stale = false;
      return { rows: [], rowCount };
    }
    return { rows: [], rowCount: 0 };
  };
  class Pool {
    on() {}
    async connect() { return { query, release() {} }; }
    query = query;
    async end() {}
  }
  const transport = createPostgresTransport({
    host: "test.invalid", user: "test", database: "test",
    loadPg: async () => ({ default: { Pool } }),
    pollIntervalMs: 10, heartbeatIntervalMs: 0,
  });
  t.after(() => transport.stop());
  const self = { id: "session-1", name: "rick", candidates: ["rick", "liam"] };
  const init = () => transport.init({
    self, credentials: { get: async () => null },
    onRegistered: (identity) => onRegistered(identity, state),
  });
  return { transport, self, state, init };
}

test("registration notifies with the committed alias, including heartbeat re-registration", {
  timeout: 2000,
}, async (t) => {
  const seen = [];
  const resumed = Promise.withResolvers();
  const h = harness(t, (identity, state) => {
    seen.push({ name: identity.name, committed: state.committed });
    if (seen.length === 2) resumed.resolve();
  });
  await h.init();
  await h.transport.register(h.self);
  h.state.taken = ["rick"];
  h.state.stale = true;
  h.transport.startReceiving(async () => {});
  await resumed.promise;
  assert.deepEqual(seen, [
    { name: "rick", committed: "rick" },
    { name: "liam", committed: "liam" },
  ]);
});

test("a failed re-registration neither changes nor announces the last committed alias", async (t) => {
  const seen = [];
  const h = harness(t, (identity) => seen.push(identity.name));
  await h.init();
  await h.transport.register(h.self);
  h.state.taken = ["rick"];
  h.state.failCommit = true;
  await assert.rejects(h.transport.register(h.self), /commit failed/);
  assert.equal(h.self.name, "rick");
  assert.deepEqual(seen, ["rick"]);
});
