# agent-relay-pg-plugin — repository instructions

This repo is the **cross-machine Postgres transport plugin** for
[agent-relay](https://github.com/joniba/agent-relay). agent-relay **core** is local-only and
dependency-free (built-in `node:sqlite`); installing this drop-in plugin swaps in a shared
**Postgres** mesh so Copilot CLI sessions on **different machines** can wake each other. All the
`pg` / `@azure` code, Entra credentials, provisioning, and cross-machine `.env` handling live
**here** — never in core.

ESM only (`"type": "module"`, `.mjs`), Node **>= 22.5.0**.

## This is a plugin, not core — keep it self-contained

- **Never import from agent-relay core.** This package has no dependency on core; the installer
  git-clones it separately. The seam contracts referenced in JSDoc (`Transport`,
  `CredentialProvider`, `Interceptor`) are **duck-typed documentation only**. Where core has a
  helper we need (e.g. `sanitize`/`stripControl`, the test `createMessage`), it is **deliberately
  re-implemented here** to avoid a back-import — keep those copies, don't "DRY" them into core.
- **Dependencies are exactly `pg` and `@azure/identity`** — nothing else. Don't add runtime deps.
- **Both heavy deps are imported LAZILY**, so a session that stays on the local default never
  touches them: `pg` is `import()`-ed inside the transport's `init()` (not at module top), and
  `@azure/identity` inside the Azure credential's `defaultCredential()`. Preserve this — no
  top-level `import "pg"` / `import "@azure/..."`.

## Layout — a plugin factory returning three seams

`index.mjs` default-exports `createPgPlugin(ctx) => Registration`, which reads `AGENT_RELAY_PG_*`
from `ctx.env` and declares:

| Seam | Module | Notes |
|---|---|---|
| `transport` (`id: "postgres"`) | `transport/postgres.mjs` | Vendor-neutral (`pg` only). `init()` owns connect-retry + schema migration; `create()` just constructs. Tables `agents` + `messages` + an `agent_relay_meta` schema-version row; advisory-lock alias races, `FOR UPDATE SKIP LOCKED` + lease claim (**at-least-once** delivery — a crash between wake and delete may redeliver; failed wakes dead-letter after `maxAttempts`), non-resurrecting heartbeat, `jsonb` opaque `meta`. |
| `credentials` | `credentials/env-password.mjs` **or** `credentials/azure/` | Picks env-password when `AGENT_RELAY_PG_PASSWORD` is set (local/CI), else the Azure Entra token provider. |
| `interceptors` (exactly one) | `index.mjs` | Reintroduces the **machine** concept core dropped: stamps `meta.fromDevice` on send and renders the machine-ful wake header `[agent-relay] Message from: <from> (<machine>) -> <to>`. |

The machine label is `AGENT_RELAY_HOST || hostname()` (core is machine-agnostic; the plugin
supplies it). It also appears in the `list_relay_agents` roster as `attributes.machine` (carried by
the transport's `device_name` column). The interceptor's **wake-header renderer** control-char-strips
its rendered fields (sender / machine / recipient) so a hostile value can't forge a line — the
message **body is left as-is**, and the stored `device_name` / `meta.fromDevice` are kept **raw**
(core sanitizes the roster on its own render). The bare alias stays the addressable reply handle —
the machine is only a parenthetical annotation.

## Azure stays isolated (extractable)

All `@azure/*` imports and the Entra scope live **only** in `credentials/azure/` (companion:
`scripts/provision-azure.ps1`). The rest of the code consumes it solely through the Credentials
seam — the transport never imports it directly. `credentials/azure/index.mjs` is the **stable
entry point**; never let an Azure type or import leak outward. The folder is designed to be lifted
into a separate package (e.g. `@agent-relay/azure`) as a folder-move + one import swap — don't add
coupling that breaks that.

The Azure credential returns a **fresh token on every `get()`**; `pg` invokes it per new connection
and recycles connections every ~2700s (before a token would expire) — **don't cache the token**, or
long-running sessions break when it lapses.

## Config — the plugin owns its `.env`

`env-file.mjs` (`loadEnvFile()`, called at the top of `index.mjs` **before** the factory reads
env) loads the plugin's **own gitignored `.env`** into `process.env`. Core loads no `.env`.

- Uses Node's built-in `util.parseEnv` (**dependency-free**).
- Search order (first existing **and parseable** wins): `$AGENT_RELAY_ENV_FILE` →
  `<plugin-dir>/.env` → `<plugin-dir>/../.env`. An existing-but-unparseable candidate is **silently
  skipped** (loading continues to the next), not fatal — so a malformed explicit file can fall
  through to a different config.
- **A value already set in the real environment WINS** — the file only fills gaps.
- **Gotcha:** double-quote any value containing `#` (e.g. an Entra guest UPN `user#EXT#@tenant`),
  or `parseEnv` treats `#` as a comment.

**Connection settings** (read from `ctx.env` in `index.mjs`; README has the full list):

| Var | Meaning | Default |
|---|---|---|
| `AGENT_RELAY_PG_HOST` / `_USER` / `_DB` | Postgres host / login / database (all required) | — |
| `AGENT_RELAY_PG_PORT` | Port | `5432` |
| `AGENT_RELAY_PG_SSL` | `false` disables TLS (local Docker); TLS on otherwise (Azure) | on |
| `AGENT_RELAY_PG_PASSWORD` | Password auth instead of Entra (local/CI) | — |
| `AGENT_RELAY_AZURE_TENANT` | Target tenant for the Entra token (multi-tenant / MFA) | — |
| `AGENT_RELAY_HOST` | This session's machine label | hostname |

## Security & resilience (don't regress these)

- **Azure path:** Entra token + TLS is the *entire* boundary — password auth is disabled and
  public-access-All is set **at provisioning (create) time** (`scripts/provision-azure.ps1`); a
  rerun only re-enforces TLS, so it won't re-harden a drifted existing server. There is no IP
  allowlist (egress rotates); tokens are minted **locally per machine**, never written to config/logs
  or transferred. The four connection values (host, user, db, tenant) are **not secrets**. The
  password path (`AGENT_RELAY_PG_PASSWORD`, `AGENT_RELAY_PG_SSL=false`) is for **throwaway local/CI**
  DBs only.
- **No silent fallback to the local SQLite mesh.** If startup can't connect, core marks the relay
  **inactive** for the session — it never falls back to a different store. In `transport.init()`
  connect-retry, only a **deterministic schema-newer** error (message matches `"newer than this
  build"`) is failed fast (never retried); everything else (auth, unreachable) is retried
  `connectMaxAttempts` times (default `3`, backoffs `[2000, 4000]ms`) before throwing.
- **Preflight classifier.** `scripts/preflight-cross-machine.mjs` brings the real transport up and
  maps the *final* failure to a specific `EXIT` code + actionable message: `10` env-incomplete
  (missing user/db) · `11` pg-missing · `12` no-auth (not `az login`'d) · `13` auth-rejected (incl.
  wrong-tenant `AADSTS50020`, matched **before** the generic no-auth case) · `14` unreachable · `15`
  schema-newer · `1` other/uncategorized. Note: a **missing `AGENT_RELAY_PG_HOST` short-circuits to
  exit `1`** ("not a cross-machine config") *before* `classify()` runs — it is not reported as `10`.
  `classify()` is **pure and unit-tested** (`tests/preflight-classify.test.mjs`) — keep it pure (no
  I/O) so those tests stay fast and offline.

## Tests

`npm test` (`node --test`) is the default and **must stay green with no Docker and no Azure** —
integration tests are **gated** on `AGENT_RELAY_TEST_PG` and never connect at import time. Keep any
new integration test gated the same way.

To run the Postgres integration tests against a real DB:

```bash
docker compose -f docker-compose.test.yml up -d          # postgres:16 on localhost:5433
AGENT_RELAY_TEST_PG=1 AGENT_RELAY_TEST_PG_HOST=localhost AGENT_RELAY_TEST_PG_PORT=5433 \
AGENT_RELAY_TEST_PG_USER=postgres AGENT_RELAY_TEST_PG_PASSWORD=relaytest AGENT_RELAY_TEST_PG_DB=postgres \
  node --test tests/postgres.integration.test.mjs
docker compose -f docker-compose.test.yml down
```

## Packaging

- The **`files` allowlist** in `package.json` is exactly `index.mjs`, `env-file.mjs`, `transport/`,
  `credentials/` (npm always also ships `package.json`). It does **not** list `node_modules/` — the
  core installer copies that separately after running `npm install --omit=dev`. `tests/` and
  `scripts/` are **not shipped**. **If you add a runtime module, add it to `files`** or it won't be
  installed.
- `bin/` is **gitignored** — a local vendored copy of core used only for local wiring/testing.
  It is not part of this package; ignore it when reasoning about what ships.
- This plugin has **no installer of its own** — install/upgrade/uninstall go through agent-relay
  core's plugin commands (`--add-plugin` / `--remove-plugin`). Don't add one here.
