import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresTransport } from "../transport/postgres.mjs";

test("authorization finishes before a pool is created and the initial password is consumed once", async () => {
  let announce;
  let release;
  const pending = new Promise(resolve => { announce = resolve; });
  const authorized = new Promise(resolve => { release = resolve; });
  const options = [];
  const replacement = mock.module("pg", {
    defaultExport: {
      Pool: class {
        constructor(config) { options.push(config); }
        on() {}
        async connect() {
          await options[0].password();
          return {
            query: async () => ({ rows: [{ key: "schema_version", value: "999" }, { key: "min_reader_version", value: "1" }] }),
            release() {},
          };
        }
        async end() {}
      },
    },
  });
  try {
    let calls = 0;
    const transport = createPostgresTransport({ host: "test.invalid", user: "test", database: "test" });
    const boot = transport.init({
      self: { id: "test", name: "test" },
      credentials: { get: async () => { calls++; announce(); await authorized; return "test-token"; } },
    });
    await pending;
    assert.equal(options.length, 0);
    release();
    await boot;
    assert.equal(calls, 1);
    assert.equal(await options[0].password(), "test-token");
    assert.equal(calls, 2);
    await transport.stop();
  } finally {
    replacement.restore();
  }
});

test("authorization timeout is terminal rather than starting another acquisition", async () => {
  let calls = 0;
  let sleeps = 0;
  const replacement = mock.module("pg", { defaultExport: { Pool: class {
    constructor() { throw new Error("must not construct a pool"); }
  } } });
  try {
    const transport = createPostgresTransport({
      host: "test.invalid", user: "test", database: "test", sleep: async () => { sleeps++; },
    });

    await assert.rejects(transport.init({
      self: { id: "test", name: "test" },
      credentials: {
        get: async () => {
          calls++;
          const error = new Error("authorization timed out");
          error.code = "AGENT_RELAY_AUTH_TIMEOUT";
          throw error;
        },
      },
    }), /authorization timed out/);
    assert.equal(calls, 1);
    assert.equal(sleeps, 0);
    await transport.stop();
  } finally {
    replacement.restore();
  }
});

test("poll failures are logged, delay later attempts, recover, and stop cleanly", async (t) => {
  let failing = true;
  let polls = 0;
  const lines = [];
  const replacement = mock.module("pg", {
    defaultExport: {
      Pool: class {
        on() {}
        async connect() {
          return {
            query: async () => ({ rows: [{ key: "schema_version", value: "999" }, { key: "min_reader_version", value: "1" }] }),
            release() {},
          };
        }
        async query() {
          polls++;
          if (failing) throw new Error("private-user private-database");
          return { rowCount: 1, rows: [] };
        }
        async end() {}
      },
    },
  });
  const transport = createPostgresTransport({
    host: "test.invalid", user: "test", database: "test", pollIntervalMs: 10,
    log: line => lines.push(line),
  });
  try {
    await transport.init({ self: { id: "test", name: "test" }, credentials: { get: async () => "test-token" } });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    transport.startReceiving(async () => {});
    t.mock.timers.tick(10);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(polls, 1);
    assert.ok(lines.some(line => /poll failed.*next_retry_ms=20.*database operation failed/.test(line)));
    assert.ok(lines.every(line => !/private-user|private-database/.test(line)));
    t.mock.timers.tick(19);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(polls, 1);
    t.mock.timers.tick(1);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(lines.some(line => /poll failed.*next_retry_ms=40/.test(line)));
    failing = false;
    t.mock.timers.tick(40);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(lines.some(line => /poll recovered after 2/.test(line)));
    await transport.stop();
    const before = polls;
    t.mock.timers.tick(100);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(polls, before);
  } finally {
    await transport.stop();
    replacement.restore();
  }
});
