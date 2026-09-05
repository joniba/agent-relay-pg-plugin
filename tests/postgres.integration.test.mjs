// Integration tests for the Postgres transport — require a REAL PostgreSQL.
//
// These prove the behaviors that CANNOT be faked: advisory-lock alias-race
// correctness, FOR UPDATE SKIP LOCKED no-double-wake, the non-resurrecting
// heartbeat, schema migration, and durable exact-id delivery.
//
// They are GATED on AGENT_RELAY_TEST_PG and never connect at import time, so the
// default `node --test` (no env) stays green with no Docker. To run them:
//   docker compose -f docker-compose.test.yml up -d
//   AGENT_RELAY_TEST_PG=1 AGENT_RELAY_TEST_PG_HOST=localhost \
//   AGENT_RELAY_TEST_PG_PORT=5433 AGENT_RELAY_TEST_PG_USER=postgres \
//   AGENT_RELAY_TEST_PG_PASSWORD=relaytest AGENT_RELAY_TEST_PG_DB=postgres \
//     node --test tests/postgres.integration.test.mjs
//
// Any real Postgres works — point the vars at one. If Docker is unavailable, the
// `embedded-postgres` package starts a genuine server from a downloaded binary with
// no daemon and no container. Note that an in-process engine such as PGlite is NOT
// sufficient: it accepts a single connection, and these tests deliberately open
// several to exercise advisory locks, alias races and SKIP LOCKED.

import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createPostgresTransport } from "../transport/postgres.mjs";

// Self-contained message builder (mirrors agent-relay core's createMessage) so
// this plugin package has no back-import into core. Builds a Message with a
// fresh id + timestamp and an opaque, transport-preserved `meta` bag.
function createMessage({ from, to, body, inReplyTo, meta }) {
  const message = {
    id: randomUUID(),
    from,
    to,
    body,
    ts: new Date().toISOString(),
    meta: meta ? { ...meta } : {},
  };
  if (inReplyTo) message.inReplyTo = inReplyTo;
  return message;
}

const ENABLED = !!process.env.AGENT_RELAY_TEST_PG;
const skip = ENABLED ? false : "set AGENT_RELAY_TEST_PG (+ a Docker Postgres) to run";

const PG = {
  host: process.env.AGENT_RELAY_TEST_PG_HOST || "localhost",
  port: process.env.AGENT_RELAY_TEST_PG_PORT ? Number(process.env.AGENT_RELAY_TEST_PG_PORT) : 5433,
  user: process.env.AGENT_RELAY_TEST_PG_USER || "postgres",
  database: process.env.AGENT_RELAY_TEST_PG_DB || "postgres",
  password: process.env.AGENT_RELAY_TEST_PG_PASSWORD || "relaytest",
};

const staticCreds = () => ({ get: async () => PG.password });

// Track every transport created so afterEach stops them — even when a test
// throws before its own stop() (a leaked pg.Pool would keep the process alive).
const created = [];

// A transport wired for the test DB. Fast intervals; ssl off (local Docker).
function makeTransport(overrides = {}) {
  const tx = createPostgresTransport({
    host: PG.host,
    port: PG.port,
    user: PG.user,
    database: PG.database,
    ssl: false,
    pollIntervalMs: 150,
    heartbeatIntervalMs: 150,
    staleMs: 1500,
    leaseMs: 2000,
    ...overrides,
  });
  created.push(tx);
  return tx;
}

const ctx = (id, name, candidates, deviceName) => ({
  self: { id, name, ...(candidates ? { candidates } : {}), ...(deviceName ? { deviceName } : {}) },
  credentials: staticCreds(),
});

const ident = (id, name, candidates, deviceName) => ({
  id,
  name,
  ...(candidates ? { candidates } : {}),
  ...(deviceName ? { deviceName } : {}),
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Clean slate before each test using a throwaway admin transport's pool.
let pg;
before(async (t) => {
  if (!ENABLED) return;
  pg = (await import("pg")).default;
});
beforeEach(async (t) => {
  if (!ENABLED) return;
  const pool = new pg.Pool({ ...PG, ssl: false, max: 1 });
  await pool
    .query("DROP TABLE IF EXISTS messages, agents, agent_relay_meta CASCADE")
    .catch(() => {});
  await pool.end();
});

// Stop every transport a test created, even if it threw before its own stop().
afterEach(async () => {
  if (!ENABLED) return;
  const txs = created.splice(0);
  await Promise.all(txs.map((tx) => tx.stop().catch(() => {})));
});

// ── schema migration ─────────────────────────────────────────────────────────

test("migrate creates schema on a fresh DB and is idempotent", { skip }, async () => {
  const tx = makeTransport();
  await tx.init(ctx("m1", "alpha"));
  // second init on the same DB must not error (idempotent)
  const tx2 = makeTransport();
  await tx2.init(ctx("m2", "beta"));
  await tx.stop();
  await tx2.stop();
});

test("migrate refuses a NEWER schema than supported", { skip }, async () => {
  const tx = makeTransport();
  await tx.init(ctx("mv", "alpha"));
  await tx.stop();
  // bump the stored version beyond TARGET, then a fresh init must throw
  const pool = new pg.Pool({ ...PG, ssl: false, max: 1 });
  await pool.query(
    "UPDATE agent_relay_meta SET value = '999' WHERE key = 'schema_version'",
  );
  await pool.end();
  const tx2 = makeTransport();
  await assert.rejects(() => tx2.init(ctx("mv2", "beta")), /newer than this build/i);
  await tx2.stop();
});

// ── register / collision / presence ──────────────────────────────────────────

test("two registrants racing the SAME alias get DISTINCT names", { skip }, async () => {
  const a = makeTransport();
  const b = makeTransport();
  await a.init(ctx("ra", "x"));
  await b.init(ctx("rb", "x"));
  // identical candidate order; concurrent register under the advisory lock
  const idA = ident("ra", "gull", ["gull", "pebble", "clove"]);
  const idB = ident("rb", "gull", ["gull", "pebble", "clove"]);
  await Promise.all([a.register(idA), b.register(idB)]);
  assert.notEqual(idA.name, idB.name, "two sessions must not share an alias");
  assert.ok(["gull", "pebble", "clove"].includes(idA.name));
  assert.ok(["gull", "pebble", "clove"].includes(idB.name));
  await a.stop();
  await b.stop();
});

test("listAgents returns live peers with machine attributes; hides stale", { skip }, async () => {
  // Two separate transports = two sessions (each owns its `self`/heartbeat). The
  // machine label is a TRANSPORT option (the plugin provides it; core is agnostic).
  const a = makeTransport({ staleMs: 800, machine: "my-laptop" });
  const b = makeTransport({ staleMs: 800, machine: "my-desktop" });
  await a.init(ctx("la", "alpha"));
  await b.init(ctx("lb", "beta"));
  await a.register(ident("la", "alpha"));
  await b.register(ident("lb", "beta"));
  let roster = await a.listAgents();
  const names = roster.map((r) => r.name).sort();
  assert.deepEqual(names, ["alpha", "beta"]);
  assert.equal(roster.find((r) => r.name === "alpha").attributes.machine, "my-laptop");
  // a keeps heartbeating; b does NOT → b goes stale.
  a.startReceiving(async () => {});
  await wait(1200);
  roster = await a.listAgents();
  assert.deepEqual(roster.map((r) => r.name), ["alpha"], "stale peer hidden");
  await a.stop();
  await b.stop();
});

test("deregister marks offline but keeps the row (durable exact-id send)", { skip }, async () => {
  const a = makeTransport();
  await a.init(ctx("da", "alpha"));
  await a.register(ident("da", "alpha"));
  await a.deregister(ident("da", "alpha"));
  // not in the live roster
  assert.equal((await a.listAgents()).length, 0);
  // but an EXACT-ID send still resolves it (durable)
  const res = await a.send(createMessage({ from: "x", to: "da", body: "hi" }));
  assert.equal(res.accepted, true, "exact-id send to an offline known agent is durable");
  // a NAME send to the (now non-live) alias is rejected
  const res2 = await a.send(createMessage({ from: "x", to: "alpha", body: "hi" }));
  assert.equal(res2.accepted, false);
  await a.stop();
});

// ── send / deliver / ack ─────────────────────────────────────────────────────

test("round-trip: send → poll → wake → delete (at-least-once)", { skip }, async () => {
  const sender = makeTransport();
  const receiver = makeTransport();
  await sender.init(ctx("sx", "sender"));
  await receiver.init(ctx("rx", "receiver"));
  await sender.register(ident("sx", "sender"));
  await receiver.register(ident("rx", "receiver"));

  const woke = [];
  receiver.startReceiving(async (m) => {
    woke.push(m);
  });

  const res = await sender.send(
    createMessage({ from: "sender", to: "receiver", body: "hello cross-machine", meta: { k: 1 } }),
  );
  assert.equal(res.accepted, true);

  await wait(600);
  assert.equal(woke.length, 1, "receiver woke exactly once");
  assert.equal(woke[0].body, "hello cross-machine");
  assert.deepEqual(woke[0].meta, { k: 1 }, "jsonb meta round-trips");
  await sender.stop();
  await receiver.stop();
});

test("send preserves the sender's message.ts (parity with SQLite)", { skip }, async () => {
  const sender = makeTransport();
  const receiver = makeTransport();
  await sender.init(ctx("ts-s", "sender"));
  await receiver.init(ctx("ts-r", "receiver"));
  await sender.register(ident("ts-s", "sender"));
  await receiver.register(ident("ts-r", "receiver"));

  const woke = [];
  receiver.startReceiving(async (m) => woke.push(m));
  const msg = createMessage({ from: "sender", to: "receiver", body: "ts-check" });
  await sender.send(msg);
  await wait(600);
  assert.equal(woke.length, 1);
  assert.equal(woke[0].ts, msg.ts, "creation timestamp is preserved end-to-end, not replaced by server now()");
  await sender.stop();
  await receiver.stop();
});

test("deregister is NOT undone by the running heartbeat (no resurrection)", { skip }, async () => {
  // Regression guard: deregister sets online=false; the heartbeat must not
  // re-register (resurrect) the intentionally-offline session.
  const a = makeTransport({ heartbeatIntervalMs: 100, pollIntervalMs: 100, staleMs: 5000 });
  await a.init(ctx("dr", "alpha"));
  await a.register(ident("dr", "alpha"));
  a.startReceiving(async () => {}); // heartbeats run while we deregister
  await wait(250); // let a heartbeat happen (a is live)
  assert.equal((await a.listAgents()).length, 1, "live before deregister");
  await a.deregister(ident("dr", "alpha"));
  await wait(500); // several heartbeat cycles
  assert.equal((await a.listAgents()).length, 0, "stays offline — heartbeat did not resurrect it");
  const res = await a.send(createMessage({ from: "x", to: "alpha", body: "x" }));
  assert.equal(res.accepted, false, "name-send to the deregistered alias is rejected");
  await a.stop();
});

test("unknown recipient is rejected and stores nothing", { skip }, async () => {
  const a = makeTransport();
  await a.init(ctx("ua", "alpha"));
  await a.register(ident("ua", "alpha"));
  const res = await a.send(createMessage({ from: "alpha", to: "nobody", body: "x" }));
  assert.equal(res.accepted, false);
  assert.match(res.error, /no such agent/i);
  await a.stop();
});

test("a failing wake is retried then dead-lettered (no infinite loop)", { skip }, async () => {
  const sender = makeTransport();
  const receiver = makeTransport({ maxAttempts: 3, leaseMs: 200 });
  await sender.init(ctx("fs", "sender"));
  await receiver.init(ctx("fr", "receiver"));
  await sender.register(ident("fs", "sender"));
  await receiver.register(ident("fr", "receiver"));

  let attempts = 0;
  receiver.startReceiving(async () => {
    attempts += 1;
    throw new Error("wake fails");
  });
  await sender.send(createMessage({ from: "sender", to: "receiver", body: "poison" }));
  await wait(1500);
  assert.ok(attempts >= 3, `expected >=3 attempts, got ${attempts}`);

  // the row is dead-lettered (status='dead'), not endlessly retried
  const pool = new pg.Pool({ ...PG, ssl: false, max: 1 });
  const dead = await pool.query("SELECT status FROM messages WHERE recipient_id = 'fr'");
  await pool.end();
  assert.ok(dead.rows.length === 1 && dead.rows[0].status === "dead", "poison message dead-lettered");
  const before = attempts;
  await wait(500);
  assert.equal(attempts, before, "dead-lettered message is no longer retried");
  await sender.stop();
  await receiver.stop();
});

test("overlapping consumers do NOT double-wake a message (lease + SKIP LOCKED)", { skip }, async () => {
  // Two receivers polling the SAME recipient id concurrently. Exactly one wakes.
  const sender = makeTransport();
  const r1 = makeTransport({ pollIntervalMs: 60 });
  const r2 = makeTransport({ pollIntervalMs: 60 });
  await sender.init(ctx("os", "sender"));
  await r1.init(ctx("shared", "dup1"));
  await r2.init(ctx("shared", "dup2"));
  await sender.register(ident("os", "sender"));
  await r1.register(ident("shared", "dup")); // same id on purpose

  let total = 0;
  const slowWake = async () => {
    total += 1;
    await wait(120); // hold the lease window
  };
  r1.startReceiving(slowWake);
  r2.startReceiving(slowWake);

  await sender.send(createMessage({ from: "sender", to: "shared", body: "once" }));
  await wait(700);
  assert.equal(total, 1, "message delivered exactly once across overlapping consumers");
  await sender.stop();
  await r1.stop();
  await r2.stop();
});

test("a stale session that resumes re-registers (no resurrected duplicate alias)", { skip }, async () => {
  // a registers "gull", then goes stale. b takes "gull" and stays live. a
  // resumes (heartbeat) and must NOT keep "gull" — it re-registers to the next
  // candidate, so there's exactly one live "gull" (b's).
  const a = makeTransport({ staleMs: 500, heartbeatIntervalMs: 120, pollIntervalMs: 120 });
  const b = makeTransport({ staleMs: 500, heartbeatIntervalMs: 120, pollIntervalMs: 120 });
  await a.init(ctx("rs-a", "x"));
  await b.init(ctx("rs-b", "x"));
  const idA = ident("rs-a", "gull", ["gull", "pebble", "clove"]);
  await a.register(idA);
  assert.equal(idA.name, "gull");

  // a goes stale (no heartbeat) — wait past staleMs.
  await wait(800);
  // b claims "gull" (a is stale → its name is free) and STAYS live (heartbeats).
  const idB = ident("rs-b", "gull", ["gull", "pebble", "clove"]);
  await b.register(idB);
  assert.equal(idB.name, "gull", "b takes the freed alias");
  b.startReceiving(async () => {});

  // a resumes polling → heartbeat finds it's stale (rowCount 0) → re-registers
  // away from the now-taken "gull".
  a.startReceiving(async () => {});
  await wait(500);
  const roster = await b.listAgents();
  const gulls = roster.filter((r) => r.name === "gull");
  assert.equal(gulls.length, 1, "exactly one live 'gull' (no resurrected duplicate)");
  assert.equal(gulls[0].id, "rs-b", "the alias belongs to b, not the resurrected a");
  assert.ok(
    roster.some((r) => r.id === "rs-a" && r.name !== "gull"),
    "a is live again under a DIFFERENT alias",
  );
  await a.stop();
  await b.stop();
});

// ── sweep / retention ────────────────────────────────────────────────────────

test("sweep deletes old messages + long-stale agents, keeps fresh ones", { skip }, async () => {
  // messageTtl 24h, agentRetention 7d (the defaults). We forge old timestamps
  // directly so the test doesn't have to wait.
  const a = makeTransport();
  await a.init(ctx("sw-a", "alpha"));
  await a.register(ident("sw-a", "alpha"));

  const pool = new pg.Pool({ ...PG, ssl: false, max: 1 });
  try {
    // A fresh + an old agent (old one hasn't heartbeat in 8 days → past 7d window).
    await pool.query(
      `INSERT INTO agents (id, name, online, registered_at, last_heartbeat)
       VALUES ('sw-old', 'ancient', false, now() - interval '8 days', now() - interval '8 days')`,
    );
    // A fresh + an old message (old one is 25h past → beyond the 24h TTL).
    await pool.query(
      `INSERT INTO messages (id, from_name, to_target, recipient_id, body, ts, status)
       VALUES ('msg-old', 'x', 'alpha', 'sw-a', 'stale', now() - interval '25 hours', 'pending'),
              ('msg-new', 'x', 'alpha', 'sw-a', 'fresh', now(), 'pending')`,
    );

    const result = await a.sweep();
    assert.equal(result.swept, true, "the only live session wins the sweep lock");
    assert.equal(result.messages, 1, "exactly the >24h message is removed");
    assert.equal(result.agents, 1, "exactly the >7d agent is removed");

    const msgs = (await pool.query("SELECT id FROM messages ORDER BY id")).rows.map((r) => r.id);
    assert.deepEqual(msgs, ["msg-new"], "fresh message survives, stale one swept");
    const agents = (await pool.query("SELECT id FROM agents ORDER BY id")).rows.map((r) => r.id);
    assert.ok(agents.includes("sw-a"), "the live session's own row survives");
    assert.ok(!agents.includes("sw-old"), "the long-stale agent is swept");

    // Idempotent: a second sweep with nothing old removes nothing.
    const again = await a.sweep();
    assert.equal(again.swept, true);
    assert.equal(again.messages, 0);
    assert.equal(again.agents, 0);
  } finally {
    await pool.end();
    await a.stop();
  }
});

test("sweep logging is silent by default and verbose under debug", { skip }, async () => {
  // debug off (default): a sweep — even one that wins the lock — logs nothing.
  const quietLogs = [];
  const quiet = makeTransport({ log: (m) => quietLogs.push(m) });
  // debug on: the same no-op sweep logs its result line.
  const loudLogs = [];
  const loud = makeTransport({ debug: true, log: (m) => loudLogs.push(m) });
  try {
    await quiet.init(ctx("sw-quiet", "q"));
    await quiet.register(ident("sw-quiet", "q"));
    const q = await quiet.sweep();
    assert.equal(q.swept, true, "the quiet session wins the sweep lock");
    assert.ok(
      !quietLogs.some((m) => m.includes("postgres sweep:")),
      "no sweep line is logged when debug is off",
    );

    await loud.init(ctx("sw-loud", "l"));
    await loud.register(ident("sw-loud", "l"));
    const l = await loud.sweep();
    assert.equal(l.swept, true, "the loud session wins the sweep lock");
    assert.ok(
      loudLogs.some((m) => m.includes("postgres sweep:")),
      "the sweep result is logged when debug is on (even on a no-op)",
    );
  } finally {
    await quiet.stop();
    await loud.stop();
  }
});

test("sweep no-ops (does not delete) when another session holds the sweep lock", { skip }, async () => {
  const a = makeTransport();
  await a.init(ctx("swl-a", "alpha"));
  await a.register(ident("swl-a", "alpha"));

  // Two SEPARATE single-conn pools: one holds the lock, one runs verification —
  // so the verification query never waits on the holder's checked-out connection.
  const verifyPool = new pg.Pool({ ...PG, ssl: false, max: 1 });
  const holderPool = new pg.Pool({ ...PG, ssl: false, max: 1 });
  let holder;
  try {
    await verifyPool.query(
      `INSERT INTO messages (id, from_name, to_target, recipient_id, body, ts, status)
       VALUES ('msg-stale', 'x', 'alpha', 'swl-a', 'old', now() - interval '25 hours', 'pending')`,
    );
    // Hold the sweep advisory lock from a separate session so a.sweep() can't get it.
    holder = await holderPool.connect();
    await holder.query("BEGIN");
    const got = (await holder.query("SELECT pg_try_advisory_xact_lock(498061003) AS ok")).rows[0].ok;
    assert.equal(got, true, "the holder grabs the sweep lock first");

    const result = await a.sweep();
    assert.equal(result.swept, false, "the contending sweep no-ops");
    assert.equal(result.skipped, true);
    const remaining = (await verifyPool.query("SELECT count(*)::int AS n FROM messages")).rows[0].n;
    assert.equal(remaining, 1, "no rows deleted while another session sweeps");
  } finally {
    if (holder) {
      await holder.query("ROLLBACK").catch(() => {}); // release the xact-scoped lock
      holder.release();
    }
    await holderPool.end();
    await verifyPool.end();
    await a.stop();
  }
});

after(async () => {
  // nothing global to tear down; each transport stops itself.
});

// ─── session attributes (migration 2) ────────────────────────────

test("migration 2 adds the attributes column and is idempotent across concurrent migrators", { skip }, async () => {
  // Two transports coming up at once is the normal case on a two-machine mesh, and
  // the advisory lock is what keeps that from racing.
  const [a, b] = [makeTransport(), makeTransport()];
  await Promise.all([
    a.init({ self: { id: "s-a", name: "a" }, credentials: staticCreds() }),
    b.init({ self: { id: "s-b", name: "b" }, credentials: staticCreds() }),
  ]);

  const pool = new pg.Pool({ ...PG, ssl: false, max: 1 });
  try {
    const col = await pool.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_name = 'agents' AND column_name = 'attributes'`,
    );
    assert.equal(col.rows[0]?.data_type, "jsonb");
    const version = await pool.query("SELECT value FROM agent_relay_meta WHERE key = 'schema_version'");
    assert.equal(version.rows[0].value, "2");
  } finally {
    await pool.end();
  }
});

test("attributes round-trip through register and listAgents", { skip }, async () => {
  const t = makeTransport();
  const self = { id: `s-${randomUUID()}`, name: "loon", attributes: { "role.owner": "2026-01-01" } };
  await t.init({ self, credentials: staticCreds() });
  await t.register(self);

  const [agent] = (await t.listAgents()).filter((x) => x.id === self.id);
  assert.equal(agent.attributes["role.owner"], "2026-01-01");
});

test("the transport-derived machine wins over a session-published one", { skip }, async () => {
  // `machine` comes from this transport's own column. A session claiming it should
  // not be able to displace the infrastructure's own answer.
  const t = makeTransport({ machine: "real-box" });
  const self = { id: `s-${randomUUID()}`, name: "loon", attributes: { machine: "spoofed" } };
  await t.init({ self, credentials: staticCreds() });
  await t.register(self);

  const [agent] = (await t.listAgents()).filter((x) => x.id === self.id);
  assert.equal(agent.attributes.machine, "real-box");
});

test("setAttributes PATCHes, and null removes a key", { skip }, async () => {
  const t = makeTransport();
  const self = { id: `s-${randomUUID()}`, name: "loon", attributes: { a: "1", b: "2" } };
  await t.init({ self, credentials: staticCreds() });
  await t.register(self);

  const patched = await t.setAttributes({ attributes: { b: "changed", c: "3" } });
  assert.deepEqual(patched.attributes, { a: "1", b: "changed", c: "3" });

  const removed = await t.setAttributes({ attributes: { a: null } });
  assert.deepEqual(removed.attributes, { b: "changed", c: "3" });
  assert.ok(!("a" in removed.attributes), "the key must be gone, not set to null");
});

test("writing another session's attributes needs force", { skip }, async () => {
  const t = makeTransport();
  const self = { id: `s-${randomUUID()}`, name: "loon" };
  const victim = { id: `s-${randomUUID()}`, name: "gull" };
  await t.init({ self, credentials: staticCreds() });
  await t.register(self);
  await t.register(victim);
  await t.register(self); // re-assert who `self` is after registering the other id

  const refused = await t.setAttributes({ id: victim.id, attributes: { x: "1" } });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /without force/);

  const forced = await t.setAttributes({ id: victim.id, attributes: { x: "1" }, force: true });
  assert.equal(forced.ok, true);
});

test("re-registering without attributes does NOT erase the stored ones", { skip }, async () => {
  // The resume path: a returning session supplies none, because they live here.
  const t = makeTransport();
  const self = { id: `s-${randomUUID()}`, name: "loon", attributes: { "role.owner": "2026-01-01" } };
  await t.init({ self, credentials: staticCreds() });
  await t.register(self);
  await t.register({ id: self.id, name: "loon" });

  const [agent] = (await t.listAgents()).filter((x) => x.id === self.id);
  assert.equal(agent.attributes["role.owner"], "2026-01-01");
});

test("concurrent writers patching DIFFERENT keys do not clobber each other", { skip }, async () => {
  const t = makeTransport();
  const self = { id: `s-${randomUUID()}`, name: "loon" };
  await t.init({ self, credentials: staticCreds() });
  await t.register(self);

  await Promise.all([
    t.setAttributes({ attributes: { "role.first": "1" } }),
    t.setAttributes({ attributes: { "role.second": "2" } }),
  ]);

  const [agent] = (await t.listAgents()).filter((x) => x.id === self.id);
  assert.equal(agent.attributes["role.first"], "1");
  assert.equal(agent.attributes["role.second"], "2");
});

test("a re-register after a removal must NOT resurrect the removed key", { skip }, async () => {
  // The heartbeat re-registers whenever its UPDATE matches no row — a laptop waking,
  // or a stall past staleMs — passing the SAME identity object it started with. If
  // setAttributes only wrote the database, that object still held keys it had just
  // deleted, and the additive merge put them back unannounced. Note the asymmetry
  // that hides this: additions survive either way, so only removals are undone.
  const t = makeTransport();
  const self = { id: `s-${randomUUID()}`, name: "loon", attributes: { "role.owner": "2026-01-01" } };
  await t.init({ self, credentials: staticCreds() });
  await t.register(self);

  await t.setAttributes({ attributes: { "role.owner": null } });
  await t.register(self); // exactly what the heartbeat's non-resurrecting path does

  const [agent] = (await t.listAgents()).filter((x) => x.id === self.id);
  assert.ok(!("role.owner" in (agent.attributes ?? {})), "a released role must stay released");
});

test("an undefined value REMOVES the key rather than reporting a false success", { skip }, async () => {
  // undefined is not a value jsonb can hold and JSON.stringify drops it, so treating
  // it as a set produced an empty patch that still reported ok — telling the caller a
  // key was cleared when it was not. A patch built from a lookup that missed lands here.
  const t = makeTransport();
  const self = { id: `s-${randomUUID()}`, name: "loon", attributes: { "role.owner": "2026-01-01" } };
  await t.init({ self, credentials: staticCreds() });
  await t.register(self);

  const res = await t.setAttributes({ attributes: { "role.owner": undefined } });
  assert.equal(res.ok, true);
  assert.ok(!("role.owner" in res.attributes), "undefined must clear the key");
});

test("a non-object attributes bag cannot corrupt the column into a jsonb array", { skip }, async () => {
  // Postgres `||` treats a non-object operand as a single-element ARRAY, and there is
  // no way back through any exposed operation: later merges append instead of merging
  // and key removal silently no-ops. setAttributes validated its input; register did not.
  const t = makeTransport();
  const self = { id: `s-${randomUUID()}`, name: "loon" };
  await t.init({ self, credentials: staticCreds() });
  await t.register({ ...self, attributes: ["hostile"] });

  const res = await t.setAttributes({ attributes: { "role.owner": "2026-01-01" } });
  assert.equal(res.ok, true);
  assert.deepEqual(res.attributes, { "role.owner": "2026-01-01" });

  const removed = await t.setAttributes({ attributes: { "role.owner": null } });
  assert.deepEqual(removed.attributes, {}, "removal must still work, i.e. it is an object");
});
