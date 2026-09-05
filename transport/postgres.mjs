// `pg` is loaded LAZILY inside init() (see below), NOT at module top — so this
// plugin's `node_modules` is touched only when a session actually opts into the
// cross-machine Postgres transport. Mirrors how the Azure credential lazily
// imports @azure/identity.
//
// This module is SELF-CONTAINED: it depends only on `pg` and the (duck-typed)
// Credentials seam passed via ctx.credentials. It imports NOTHING from agent-relay
// core — the seam contracts referenced in JSDoc below are documentation only.

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Cross-machine Transport: a shared PostgreSQL store + interval poll. The
 * cross-machine analogue of `sqlite-poll.mjs` — same two-table model (an `agents`
 * registry + a `messages` inbox), same contract, so the core is unchanged. Only
 * the substrate moved across the machine boundary; the wake stays in-process.
 *
 * VENDOR-NEUTRAL: this module depends only on `pg` and the Credentials seam. It
 * works against ANY PostgreSQL (local Docker, Azure, RDS, self-hosted). The
 * Azure-specific credential is supplied via `ctx.credentials` (see the `azure/`
 * lib); nothing Azure appears here.
 *
 * Honors {@link Transport}:
 *   - `register` resolves alias collisions **atomically across machines** under a
 *     Postgres advisory lock (the cross-machine analogue of SQLite's
 *     `BEGIN IMMEDIATE`), and marks the row `online`.
 *   - `deregister` marks the row offline (does NOT delete) so an exact-id send to
 *     a momentarily-away session is still durable.
 *   - `startReceiving` claims pending rows with `FOR UPDATE SKIP LOCKED` + a
 *     short lease (no overlapping/duplicate wake), wakes via `onMessage`, and
 *     DELETEs on success / dead-letters after `maxAttempts`. The heartbeat is
 *     non-resurrecting: a session that went stale re-registers before going live.
 *   - `meta` is round-tripped as `jsonb` (opaque).
 *
 * @param {object} opts
 * @param {string} opts.host
 * @param {string} opts.user
 * @param {string} opts.database
 * @param {number} [opts.port]                 Default 5432.
 * @param {number} [opts.connectionTimeoutMillis] Per-connection acquire timeout so a
 *   blocked/slow connect fails fast instead of hanging boot (default 30000).
 * @param {number} [opts.connectMaxAttempts]    How many times init() retries the
 *   initial connect before giving up (default 3). A deterministic schema-version
 *   error is never retried.
 * @param {number[]} [opts.connectBackoffsMs]   Backoff before each retry (default
 *   [2000, 4000]); index i is the wait after attempt i+1.
 * @param {(ms: number) => Promise<void>} [opts.sleep]   Backoff sleep (injectable for tests).
 * @param {boolean|object} [opts.ssl]          `pg` ssl option. Default
 *   `{ rejectUnauthorized: true }`; pass `false` for a local Docker server.
 * @param {number} [opts.pollIntervalMs]       Poll cadence (default 3000).
 * @param {number} [opts.heartbeatIntervalMs]  Heartbeat cadence (default 9000;
 *   decoupled from poll to cut write amplification).
 * @param {number} [opts.staleMs]              Liveness window (default 45000).
 * @param {number} [opts.leaseMs]              In-flight claim lease (default 30000).
 * @param {number} [opts.maxAttempts]          Redelivery cap before dead-letter (default 5).
 * @param {number} [opts.maxPerPoll]           Messages handled per cycle (default 10).
 * @param {number} [opts.sweepIntervalMs]      Base cleanup cadence (default 1_200_000 =
 *   20 min; each run is jittered to ~15–30 min so concurrent sessions rarely contend).
 * @param {number} [opts.messageTtlMs]         Delete messages older than this, any status
 *   (default 86_400_000 = 24 h).
 * @param {number} [opts.agentRetentionMs]     Drop agent rows not heartbeating within this
 *   window (default 604_800_000 = 7 d; LONGER than the message TTL so durable exact-id
 *   delivery to an away machine isn't cut short).
 * @param {string} [opts.machine]   This session's machine/host label. The PLUGIN
 *   provides it (core is machine-agnostic); it is stored as the agent's
 *   `device_name` and surfaced on `listAgents` entries as `attributes.machine`.
 * @param {Logger} [opts.log]   Optional diagnostic logger.
 * @returns {Transport}
 */
export function createPostgresTransport({
  host,
  user,
  database,
  machine,
  port = 5432,
  connectionTimeoutMillis = 30000,
  connectMaxAttempts = 3,
  connectBackoffsMs = [2000, 4000],
  sleep = defaultSleep,
  ssl = { rejectUnauthorized: true },
  pollIntervalMs = 3000,
  heartbeatIntervalMs = 9000,
  staleMs = 45000,
  leaseMs = 30000,
  maxAttempts = 5,
  maxPerPoll = 10,
  sweepIntervalMs = 1_200_000,
  messageTtlMs = 86_400_000,
  agentRetentionMs = 604_800_000,
  log = () => {},
  debug = false,
} = {}) {
  if (!host) throw new Error("postgres transport requires a host");
  if (!user) throw new Error("postgres transport requires a user");
  if (!database) throw new Error("postgres transport requires a database");

  const staleSecs = staleMs / 1000;
  const leaseSecs = leaseMs / 1000;
  const messageTtlSecs = messageTtlMs / 1000;
  const agentRetentionSecs = agentRetentionMs / 1000;

  /** @type {import('pg').Pool} */
  let pool;
  /** Lazily-imported `pg` module namespace (loaded once in init). */
  let pg;
  /** @type {AgentIdentity} */
  let self;
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let sweepTimer = null;
  let draining = false;
  let stopped = false;
  let deregistered = false;
  let lastHeartbeat = 0;

  // ── alias collision resolution (advisory-locked, cross-machine atomic) ──────
  async function register(identity) {
    self = identity;
    deregistered = false; // coming online (clears a prior intentional offline)
    const candidates =
      Array.isArray(identity.candidates) && identity.candidates.length ? identity.candidates : null;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Serialize alias acquisition across ALL machines (released at COMMIT).
      await client.query("SELECT pg_advisory_xact_lock($1)", [ALIAS_LOCK_KEY]);
      let name = identity.name;
      if (candidates) {
        const taken = new Set(
          (
            await client.query(
              `SELECT name FROM agents
               WHERE id <> $1 AND online AND last_heartbeat >= now() - make_interval(secs => $2)`,
              [identity.id, staleSecs],
            )
          ).rows.map((r) => r.name),
        );
        name = candidates.find((c) => !taken.has(c)) ?? candidates[0];
        identity.name = name; // core reads the chosen name live
      }
      await client.query(
        `INSERT INTO agents (id, name, device_name, online, registered_at, last_heartbeat, attributes)
         VALUES ($1, $2, $3, true, now(), now(), $4::jsonb)
         ON CONFLICT (id) DO UPDATE
           SET name = excluded.name, device_name = excluded.device_name,
               online = true, last_heartbeat = now(),
               -- MERGE, never replace. A resuming session supplies no attributes —
               -- they live here, not in its configuration — so replacing would erase
               -- everything it had published before anything could notice.
               attributes = agents.attributes || excluded.attributes`,
        [identity.id, name, machine ?? null, JSON.stringify(identity.attributes ?? {})],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  function toMessage(row) {
    /** @type {Message} */
    const message = {
      id: row.id,
      from: row.from_name,
      to: row.to_target,
      body: row.body,
      ts: row.ts instanceof Date ? row.ts.toISOString() : String(row.ts),
      meta: row.meta ?? {},
    };
    if (row.in_reply_to) message.inReplyTo = row.in_reply_to;
    return message;
  }

  // ── session-owned cleanup (jittered; only ONE session sweeps per window) ─────
  // Every live session schedules a sweep, but `pg_try_advisory_xact_lock` makes
  // all-but-one a cheap no-op per window. No always-on infra (RD-CM: cleanup
  // waits for the next live session if none is up — acceptable at single-user
  // scale). Exposed on the transport so the integration suite can drive it.
  async function sweep() {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Try-lock (non-blocking): if another session already holds it this window,
      // we no-op. Released automatically at COMMIT/ROLLBACK (xact-scoped).
      const got = (
        await client.query("SELECT pg_try_advisory_xact_lock($1) AS ok", [SWEEP_LOCK_KEY])
      ).rows[0].ok;
      if (!got) {
        await client.query("ROLLBACK");
        return { swept: false, skipped: true };
      }
      // Messages older than the TTL go (any status — pending/dead alike). `ts` is
      // the sender's timestamp; at a 24 h window cross-machine skew is immaterial.
      const msgs = await client.query(
        "DELETE FROM messages WHERE ts < now() - make_interval(secs => $1)",
        [messageTtlSecs],
      );
      // Known recipients are retained LONGER than messages so durable exact-id
      // delivery to an away machine isn't cut short; drop only long-stale rows.
      const agents = await client.query(
        "DELETE FROM agents WHERE last_heartbeat < now() - make_interval(secs => $1)",
        [agentRetentionSecs],
      );
      await client.query("COMMIT");
      // Routine cleanup is background noise in the session timeline, so it's
      // silent by default. Enable `debug` (AGENT_RELAY_DEBUG) to trace EVERY
      // sweep — including no-ops — when diagnosing whether cleanup is running.
      // Sweep ERRORS (below) are NOT gated: a failing sweep is a real fault.
      if (debug) {
        log(`postgres sweep: removed ${msgs.rowCount} message(s), ${agents.rowCount} stale agent(s)`);
      }
      return { swept: true, messages: msgs.rowCount, agents: agents.rowCount };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      log(`postgres sweep error: ${err.message}`);
      return { swept: false, error: err.message };
    } finally {
      client.release();
    }
  }

  function scheduleSweep() {
    if (stopped) return;
    // Long, randomized interval (~15–30 min for the 20 min base) so concurrent
    // sessions rarely contend; the try-lock makes the loser a cheap no-op.
    const delay = sweepIntervalMs * (0.75 + Math.random() * 0.75);
    sweepTimer = setTimeout(async () => {
      if (stopped) return;
      try {
        await sweep();
      } catch {
        // sweep() logs its own errors; cleanup must never crash the loop.
      }
      scheduleSweep();
    }, delay);
    if (typeof sweepTimer.unref === "function") sweepTimer.unref();
  }

  return {
    async init(ctx) {
      self = ctx.self;
      // Load `pg` on demand. If it isn't installed, this is the cross-machine
      // opt-in path without its dependency — surface a clear, actionable error
      // (the entry then surfaces the failure and the relay goes inactive).
      if (!pg) {
        try {
          pg = (await import("pg")).default;
        } catch (err) {
          throw new Error(
            "the 'postgres' transport requires the 'pg' package — run `npm install` " +
              `in the agent-relay-pg plugin folder (original: ${err.message})`,
          );
        }
      }

      // Connect-retry lives HERE: the transport owns its own connect resilience
      // (the entry no longer retries). A transient/slow initial connect is retried
      // a few times — each attempt bounded by the pool's connectionTimeoutMillis
      // fast-fail — with a bounded backoff. A DETERMINISTIC schema-version error
      // ("newer than this build") can't heal, so it is NOT retried. On terminal
      // failure the error propagates so the entry marks the relay inactive.
      const attempts = Math.max(1, connectMaxAttempts);
      for (let attempt = 1; attempt <= attempts; attempt++) {
        pool = new pg.Pool({
          host,
          user,
          database,
          port,
          ssl,
          // Async password from the Credentials seam → minted per NEW connection.
          // For Azure this is a fresh Entra token; for local/dev a static env value.
          password: async () => (await ctx.credentials.get()) ?? undefined,
          max: 4,
          maxLifetimeSeconds: 2700, // recycle connections before a token would expire
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis,
        });
        // An idle-client error must never crash the host process.
        pool.on("error", (err) => log(`pg pool error: ${err.message}`));
        try {
          await migrate(pool, log);
          return; // connected + schema ready
        } catch (err) {
          // This attempt failed (unreachable host, bad creds, refuse-newer schema,
          // …) — release the pool so a leaked idle client can't keep the process
          // alive, then decide whether to retry.
          try {
            await pool.end();
          } catch {
            /* already ended */
          }
          pool = null;
          const deterministic = /newer than this build/i.test(err.message || "");
          const isFinal = attempt === attempts;
          if (deterministic || isFinal) {
            if (isFinal && !deterministic && attempts > 1) {
              log(
                `postgres: connect failed after ${attempts} attempts — giving up (${err.message})`,
                { level: "error" },
              );
            }
            throw err;
          }
          log(
            `postgres: connect failed (attempt ${attempt}/${attempts}) — retrying (${err.message})`,
            { level: "warning" },
          );
          const backoff = connectBackoffsMs[attempt - 1] ?? 0;
          if (backoff > 0) await sleep(backoff);
        }
      }
    },

    register,

    async deregister(identity) {
      // Mark offline, do NOT delete: the row stays a known recipient so an
      // exact-id send to an away session is still durable. `deregistered` stops
      // the heartbeat from re-registering (resurrecting) the ended session.
      deregistered = true;
      await pool.query("UPDATE agents SET online = false WHERE id = $1", [identity.id]);
    },

    async listAgents() {
      const rows = (
        await pool.query(
          `SELECT id, name, device_name, attributes FROM agents
           WHERE online AND last_heartbeat >= now() - make_interval(secs => $1)
           ORDER BY name`,
          [staleSecs],
        )
      ).rows;
      return rows.map((r) => {
        // Session-published facts first, then the transport-derived ones — so a
        // session cannot displace `machine`, which this transport asserts from its
        // own column rather than taking anyone's word for.
        const attributes = {
          ...(r.attributes ?? {}),
          ...(r.device_name ? { machine: r.device_name } : {}),
        };
        return {
          id: r.id,
          name: r.name,
          ...(Object.keys(attributes).length ? { attributes } : {}),
        };
      });
    },

    /**
     * PATCH one agent's attributes. Keys present are set, keys ABSENT are left alone,
     * and a key whose value is NULL is removed.
     *
     * The merge is done **in Postgres** (`||` for the set, `- key` for the removals)
     * rather than as a read-modify-write here, so two sessions patching different keys
     * of the same row concurrently cannot clobber one another.
     */
    async setAttributes({ id, attributes, force = false } = {}) {
      const target = id ?? self.id;
      if (attributes == null || typeof attributes !== "object" || Array.isArray(attributes)) {
        return { ok: false, error: "'attributes' must be an object" };
      }
      // Writing another session's row changes the state of something running that
      // will not be told. Possible — this is a trusted mesh — but asked for, not default.
      if (target !== self.id && !force) {
        return {
          ok: false,
          error: `refusing to write attributes on another session (${target}) without force`,
        };
      }
      const removals = Object.keys(attributes).filter((k) => attributes[k] === null);
      const sets = Object.fromEntries(Object.entries(attributes).filter(([, v]) => v !== null));
      const res = await pool.query(
        `UPDATE agents
            SET attributes = (COALESCE(attributes, '{}'::jsonb) || $2::jsonb) - $3::text[]
          WHERE id = $1
        RETURNING attributes`,
        [target, JSON.stringify(sets), removals],
      );
      if (res.rowCount === 0) return { ok: false, error: `no such agent: ${target}` };
      return { ok: true, attributes: res.rows[0].attributes ?? {} };
    },

    async send(message) {
      // Exact id resolves a KNOWN agent even if offline/stale (durable delivery
      // to an away machine); a NAME resolves only a LIVE agent (never a freed
      // alias), most-recently-heartbeating wins. `device_name` is carried for
      // diagnostics (logging the target machine of a cross-machine send).
      let recipient = (
        await pool.query("SELECT id, device_name FROM agents WHERE id = $1", [message.to])
      ).rows[0];
      if (!recipient) {
        recipient = (
          await pool.query(
            `SELECT id, device_name FROM agents
             WHERE name = $1 AND online AND last_heartbeat >= now() - make_interval(secs => $2)
             ORDER BY last_heartbeat DESC LIMIT 1`,
            [message.to, staleSecs],
          )
        ).rows[0];
      }
      if (!recipient) {
        log(`postgres: send rejected — no live recipient for "${message.to}"`);
        return { accepted: false, error: `no such agent: ${message.to}` };
      }

      await pool.query(
        `INSERT INTO messages (id, from_name, to_target, recipient_id, body, ts, in_reply_to, meta, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')`,
        [
          message.id,
          message.from,
          message.to,
          recipient.id,
          message.body,
          message.ts, // preserve the sender's creation timestamp (parity with SQLite)
          message.inReplyTo ?? null,
          JSON.stringify(message.meta ?? {}),
        ],
      );
      return { accepted: true, id: message.id };
    },

    startReceiving(onMessage) {
      const drain = async () => {
        if (draining || stopped) return;
        draining = true;
        try {
          if (stopped) return;

          // Heartbeat on its own (slower) cadence, WITHOUT resurrecting a stale
          // row: if we already aged out (e.g. the machine slept and our alias may
          // have been reassigned), re-register to re-acquire an alias.
          const now = Date.now();
          if (now - lastHeartbeat >= heartbeatIntervalMs) {
            lastHeartbeat = now;
            const hb = await pool.query(
              `UPDATE agents SET last_heartbeat = now()
               WHERE id = $1 AND online AND last_heartbeat >= now() - make_interval(secs => $2)`,
              [self.id, staleSecs],
            );
            if (hb.rowCount === 0 && !stopped && !deregistered) await register(self);
          }
          if (stopped) return;

          // Claim pending rows atomically (no overlapping/cross-machine double
          // wake) with a short lease, then wake outside the claiming statement.
          const claimed = (
            await pool.query(
              `UPDATE messages SET lease_until = now() + make_interval(secs => $3)
               WHERE id IN (
                 SELECT id FROM messages
                 WHERE recipient_id = $1 AND status = 'pending'
                   AND (lease_until IS NULL OR lease_until < now())
                 ORDER BY seq LIMIT $2
                 FOR UPDATE SKIP LOCKED
               )
               RETURNING *`,
              [self.id, maxPerPoll, leaseSecs],
            )
          ).rows;

          for (const row of claimed) {
            if (stopped) break;
            let handled = false;
            try {
              await onMessage(toMessage(row));
              handled = true;
            } catch {
              handled = false; // wake failed → bounded retry below
            }
            if (stopped) break;
            try {
              if (handled) {
                await pool.query("DELETE FROM messages WHERE id = $1", [row.id]);
              } else {
                const attempts = row.attempts + 1;
                if (attempts >= maxAttempts) {
                  await pool.query(
                    "UPDATE messages SET status = 'dead', attempts = $1, lease_until = NULL WHERE id = $2",
                    [attempts, row.id],
                  );
                  log(`postgres: message ${row.id} dead-lettered after ${attempts} attempt(s)`);
                } else {
                  await pool.query(
                    "UPDATE messages SET attempts = $1, lease_until = NULL WHERE id = $2",
                    [attempts, row.id],
                  );
                }
              }
            } catch {
              // DB hiccup — leave the row (lease expires → retried). At-least-once.
            }
          }
        } catch {
          // A cycle hit a transient error — swallow; the transport must survive a
          // cycle (the poll naturally retries).
        } finally {
          draining = false;
        }
      };

      timer = setInterval(() => void drain(), pollIntervalMs);
      if (typeof timer.unref === "function") timer.unref();
      scheduleSweep();
    },

    sweep,

    async stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (sweepTimer) {
        clearTimeout(sweepTimer);
        sweepTimer = null;
      }
      while (draining) await new Promise((r) => setTimeout(r, 5));
      if (pool) {
        try {
          await pool.end();
        } catch {
          /* already ended */
        }
        pool = null;
      }
    },
  };
}

// Advisory-lock keys (arbitrary, stable constants; distinct per concern).
const MIGRATE_LOCK_KEY = 498061001;
const ALIAS_LOCK_KEY = 498061002;
const SWEEP_LOCK_KEY = 498061003;

/** The schema version this transport build expects. */
export const TARGET_SCHEMA = 2;

/**
 * Idempotent schema migration, serialized across machines with an advisory lock.
 * Creates the schema on a fresh DB, upgrades an older one, and REFUSES to operate
 * on a newer schema than this build supports (the entry then falls back).
 *
 * @param {import('pg').Pool} pool
 * @param {Logger} log
 */
export async function migrate(pool, log = () => {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATE_LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS agent_relay_meta (key text PRIMARY KEY, value text NOT NULL)`,
    );
    const res = await client.query(
      "SELECT value FROM agent_relay_meta WHERE key = 'schema_version'",
    );
    const current = res.rows.length ? parseInt(res.rows[0].value, 10) : 0;

    if (current > TARGET_SCHEMA) {
      throw new Error(
        `agent-relay: database schema_version ${current} is newer than this build supports ` +
          `(${TARGET_SCHEMA}). Upgrade the extension; refusing to run on an unknown schema.`,
      );
    }

    if (current < 1) {
      log("postgres: applying schema migration 1 (initial)");
      await client.query(`
        CREATE TABLE IF NOT EXISTS agents (
          id             text PRIMARY KEY,
          name           text NOT NULL,
          device_name    text,
          online         boolean NOT NULL DEFAULT true,
          registered_at  timestamptz NOT NULL DEFAULT now(),
          last_heartbeat timestamptz NOT NULL DEFAULT now()
        )`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_agents_live ON agents (last_heartbeat)`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS messages (
          id            text PRIMARY KEY,
          from_name     text NOT NULL,
          to_target     text NOT NULL,
          recipient_id  text NOT NULL,
          body          text NOT NULL,
          ts            timestamptz NOT NULL DEFAULT now(),
          seq           bigserial,
          in_reply_to   text,
          meta          jsonb NOT NULL DEFAULT '{}',
          status        text NOT NULL DEFAULT 'pending',
          attempts      int  NOT NULL DEFAULT 0,
          lease_until   timestamptz
        )`);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_inbox ON messages (recipient_id, status, seq)`,
      );
    }

    if (current < 2) {
      log("postgres: applying schema migration 2 (session attributes)");
      // Deliberately ADDITIVE: a nullable column with a default. An older build
      // selects explicit columns and never mentions this one, so it keeps working
      // against an upgraded database — only a FRESH older start refuses, via the
      // schema_version guard above. That is what makes a staggered upgrade across
      // machines safe rather than a flag day.
      await client.query(
        `ALTER TABLE agents ADD COLUMN IF NOT EXISTS attributes jsonb NOT NULL DEFAULT '{}'`,
      );
    }

    await client.query(
      `INSERT INTO agent_relay_meta (key, value) VALUES ('schema_version', $1)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      [String(TARGET_SCHEMA)],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
