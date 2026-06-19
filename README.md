# agent-relay-pg-plugin

> Cross-machine messaging for [agent-relay](https://github.com/joniba/agent-relay) — a drop-in
> plugin that swaps the local SQLite transport for a shared **Postgres** mesh, so Copilot CLI
> sessions on **different machines** can wake each other.

agent-relay core is **local-only** by default (sessions on one machine). Installing this plugin adds:

- a **Postgres transport** (shared DB; each machine mints its own short-lived **Microsoft Entra**
  token locally — tokens are never copied between machines),
- the **machine** concept core drops — the wake header and roster show which machine a peer is on.

## Install

**One command — installs core *and* this plugin:**

```bash
npx --yes github:joniba/agent-relay-pg-plugin
```

It git-clones agent-relay core, runs core's own installer (into `<COPILOT_HOME>/extensions/agent-relay/`),
then drops this plugin into that extension's own `plugins/agent-relay-pg/` folder. **If** you've set the
Postgres connection vars (below), it also writes the plugin's `.env` and verifies a real connection;
otherwise it installs everything and tells you exactly what to set. It does **not** launch Copilot.

> **Requirements:** Node 22.5+, **Git** on PATH (the installer clones core), and a reachable Postgres
> (Azure Database for PostgreSQL for the Entra path). For the Entra path you `az login` as the database
> admin — the installer signs you in if needed; **provisioning** (below) requires `az login` first.

### Quickstart (Azure / Entra)

**1. Provision the database (one-time).** Provisioning runs **from a clone** — the script isn't part of
the `npx` install:

```bash
git clone https://github.com/joniba/agent-relay-pg-plugin
cd agent-relay-pg-plugin
az login                                      # the signed-in identity becomes the DB admin
pwsh ./scripts/provision-azure.ps1 -ServerName pg-agent-relay-<unique>
```

It prints the `AGENT_RELAY_PG_HOST` / `_USER` / `_DB` values to use next. (Already have a Postgres? Skip this.)

**2. Point the installer at the database** — export the vars (for the `npx` path), or set
`AGENT_RELAY_ENV_FILE=/path/to/your.env`, or (from a clone) put them in a `.env` next to this README:

```bash
export AGENT_RELAY_PG_HOST=pg-agent-relay-<unique>.postgres.database.azure.com
export AGENT_RELAY_PG_USER='<your-entra-admin-upn>'
export AGENT_RELAY_PG_DB=agentrelay
# export AGENT_RELAY_AZURE_TENANT=<tenant-id>   # if your account spans tenants / the DB tenant needs MFA
```

**3. Install** (signs you in to Azure if needed, then verifies the connection):

```bash
npx --yes github:joniba/agent-relay-pg-plugin
```

**4. Start Copilot** with extensions enabled:

```bash
copilot --experimental
```

On load you'll see `🌐 agent-relay: connected to remote transport as [<alias>]`, and peers on other
machines (also running this plugin against the same DB) become reachable via `send_message` /
`list_relay_agents`.

### Local / CI (password auth, no Azure)

For a local Docker Postgres or CI, use password auth instead of Entra. Make sure the target database
exists first — a stock `postgres` container only has the default `postgres` DB unless you set `POSTGRES_DB`:

```bash
export AGENT_RELAY_PG_HOST=localhost
export AGENT_RELAY_PG_USER=postgres
export AGENT_RELAY_PG_DB=postgres         # the default DB in a stock postgres container
export AGENT_RELAY_PG_PASSWORD=postgres
export AGENT_RELAY_PG_SSL=false           # local server has no TLS
npx --yes github:joniba/agent-relay-pg-plugin
```

## How it works

This package is a normal agent-relay **plugin**: a default-export factory (`index.mjs`) returning a
Registration that declares a `transport` (Postgres; its `init()` owns the connect-retry), `credentials`
(Entra token provider, or env-password for local/CI), and an `interceptor` (re-adds the machine label to
the wake header + roster). It depends only on what it imports (`pg`, `@azure/identity`) — **core is not a
dependency**; the installer git-clones it.

The installer copies a strict **runtime allowlist** into the plugin folder — `package.json`, `index.mjs`,
`env-file.mjs`, `transport/`, `credentials/`, `node_modules/` — and nothing else (no `tests/`, `scripts/`,
or the cloned-core `bin/`).

## Upgrade / uninstall

- **Upgrade:** re-run the install command.
- **Opt out of cross-machine:** delete `<COPILOT_HOME>/extensions/agent-relay/plugins/agent-relay-pg/` —
  core reverts to the local SQLite default. (Reinstalling core never deletes that folder.)

## Configuration

| Var | Meaning |
|---|---|
| `AGENT_RELAY_PG_HOST` / `_USER` / `_DB` | Postgres host, login user, database name (required). For the Azure path `_USER` is the Entra admin UPN the provision script prints; for password auth it's the Postgres role. |
| `AGENT_RELAY_PG_PORT` | Port (default `5432`). |
| `AGENT_RELAY_PG_SSL` | `false` to disable TLS (local Docker); TLS on by default (Azure). |
| `AGENT_RELAY_PG_PASSWORD` | Use password auth instead of Entra (local / CI). |
| `AGENT_RELAY_AZURE_TENANT` | Target tenant id for `az login` / token (multi-tenant or MFA). |
| `AZURE_CONFIG_DIR` | Isolate the `az` profile used for the token. |
| `AGENT_RELAY_HOST` | Override this session's machine label (default: hostname). |
| `AGENT_RELAY_ENV_FILE` | Path to a `.env` the installer reads the above from (alternative to exporting them). |
| `AGENT_RELAY_CORE_REF` | Core git ref/commit the installer clones (advanced; default: a pinned tested commit — Phase-4 release retargets it to `main`). |
| `AGENT_RELAY_CORE_REPO` | Core repo URL the installer clones (advanced/dev; default the public repo — point at a local path for offline/dev installs). |
