# agent-relay-pg-plugin

> Cross-machine messaging for [agent-relay](https://github.com/joniba/agent-relay) — a drop-in
> plugin that swaps the local SQLite transport for a shared **Postgres** mesh, so Copilot CLI
> sessions on **different machines** can wake each other.

agent-relay core is **local-only** by default (sessions on one machine). Installing this plugin adds:

- a **Postgres transport** (shared DB; each machine mints its own short-lived **Microsoft Entra**
  token locally — tokens are never copied between machines),
- the **machine** concept core drops — the wake header and roster show which machine a peer is on.

## Install

This plugin has **no installer of its own** — [agent-relay core](https://github.com/joniba/agent-relay)
installs any plugin from its GitHub repo. Two steps:

```bash
# 1. install agent-relay core (local-only; skip if you already have it)
npx --yes github:joniba/agent-relay

# 2. add THIS plugin (clones it, installs its deps, drops it into the extension's plugins/ folder)
npx --yes github:joniba/agent-relay --add-plugin github:joniba/agent-relay-pg-plugin
```

`--add-plugin` git-clones this repo, runs `npm install --omit=dev` for its deps (`pg`,
`@azure/identity`), and copies the runtime files into
`<COPILOT_HOME>/extensions/agent-relay/plugins/agent-relay-pg/`. It does **not** launch Copilot, and
it does **not** configure the connection — you do that once (below).

> **Requirements:** Node 22.5+, **Git** on PATH (core clones this repo), and a reachable Postgres
> (Azure Database for PostgreSQL for the Entra path).

### Configure the connection (one-time)

The plugin reads its **own** gitignored `.env` at startup, from the installed plugin folder:

```
<COPILOT_HOME>/extensions/agent-relay/plugins/agent-relay-pg/.env
```

Create that file. **Azure / Entra:**

```ini
AGENT_RELAY_PG_HOST="pg-agent-relay-<unique>.postgres.database.azure.com"
AGENT_RELAY_PG_USER="<your-entra-admin-upn>"
AGENT_RELAY_PG_DB="agentrelay"
# AGENT_RELAY_AZURE_TENANT="<tenant-id>"   # if your account spans tenants / the DB tenant needs MFA
```

Then `az login` as that database admin — the plugin mints a short-lived **Microsoft Entra** token
locally at runtime (tokens are never written to config/logs or copied between machines):

```bash
az login        # sign in as AGENT_RELAY_PG_USER
```

**Local / CI (password auth, no Azure)** — TLS off, password instead of Entra (throwaway DBs only):

```ini
AGENT_RELAY_PG_HOST="localhost"
AGENT_RELAY_PG_USER="postgres"
AGENT_RELAY_PG_DB="postgres"
AGENT_RELAY_PG_PASSWORD="postgres"
AGENT_RELAY_PG_SSL="false"
```

> **Gotcha:** double-quote any value containing `#` (e.g. an Entra guest UPN `user#EXT#@tenant`) —
> the `.env` parser treats an unquoted `#` as a comment.

### Provision a database (one-time, optional)

If you don't already have a Postgres, provision an Azure one **from a clone** (not part of the install):

```bash
git clone https://github.com/joniba/agent-relay-pg-plugin
cd agent-relay-pg-plugin
az login                                      # the signed-in identity becomes the DB admin
pwsh ./scripts/provision-azure.ps1 -ServerName pg-agent-relay-<unique>
```

It prints the `AGENT_RELAY_PG_HOST` / `_USER` / `_DB` values to put in the `.env` above.

### Verify + start

Optionally verify the connection **from a clone** (after creating a `.env` there and running
`npm install` for the `pg` / `@azure/identity` deps):

```bash
node scripts/preflight-cross-machine.mjs        # exits 0 on a real connect, else a classified error
```

Then start Copilot with extensions enabled:

```bash
copilot --experimental
```

On load you'll see `🌐 agent-relay: connected to remote transport as [<alias>]`, and peers on other
machines (also running this plugin against the same DB) become reachable via `send_message` /
`list_relay_agents`.

## How it works

This package is a normal agent-relay **plugin**: a default-export factory (`index.mjs`) returning a
Registration that declares a `transport` (Postgres; its `init()` owns the connect-retry), `credentials`
(Entra token provider, or env-password for local/CI), and an `interceptor` (re-adds the machine label to
the wake header + roster). It depends only on what it imports (`pg`, `@azure/identity`) — **core is not a
dependency**; the installer git-clones it.

The installer copies a strict **runtime allowlist** into the plugin folder — `package.json`, `index.mjs`,
`env-file.mjs`, `transport/`, `credentials/`, and the installed `node_modules/` — and nothing else (no
`tests/` or `scripts/`). The set comes from this package's `files` list, which core reads when you run
`agent-relay --add-plugin`.

## Security model

For the **Azure / Entra** path:

- **Microsoft Entra token + TLS is the entire boundary.** Password auth is disabled on the provisioned
  server; only a valid token for a server admin can connect.
- **No IP allowlist** — home/office egress IPs rotate, so network location isn't a control. Public
  network access stays on, gated by authentication.
- Tokens are acquired **locally per machine**, are not written to the plugin's config or logs, and are
  never transferred between machines.
- The four connection values (host, admin user, database name, tenant id) are **not secrets**.

(The local / CI **password** path — `AGENT_RELAY_PG_PASSWORD`, TLS off — is for a throwaway local Docker
or CI database only, not a shared production mesh.)

## Resilience

If the database can't be reached **at startup**, the transport handles it without a silent fallback to
the local mesh (that would split your machines onto separate stores without telling you):

- **Transient** failures (offline, not yet `az login`'d) are **retried a few times**; **deterministic**
  ones (wrong tenant/account, an unsupported newer schema) **fail fast**. Either way, if startup can't
  complete, the session runs **inactive**.
- Fix the cause — network, Azure login/tenant, or schema compatibility — and **restart**. Or remove the
  plugin folder and restart to return to the local SQLite default.
- A transient **mid-session** blip is ridden out by the receive poll loop (it resumes on the next poll,
  no fallback); a `send_message` / `list_relay_agents` issued during the blip may just need retrying.

A session-owned, advisory-lock-guarded sweep prunes old messages (> 24 h) and long-gone peers (> 7 d), so
no always-on cleanup job is needed.

## Upgrade / uninstall

These use **agent-relay core**'s plugin commands (this plugin has no scripts of its own):

- **Upgrade:** re-run the add command — it re-clones and reinstalls the plugin (your `.env` in the
  plugin folder is preserved across the upgrade):

  ```bash
  npx --yes github:joniba/agent-relay --add-plugin github:joniba/agent-relay-pg-plugin
  ```

- **Remove just this plugin** (core stays, reverts to the local SQLite default):

  ```bash
  npx --yes github:joniba/agent-relay --remove-plugin agent-relay-pg
  ```

- **Remove the whole extension** (core + every plugin):

  ```bash
  npx --yes github:joniba/agent-relay --uninstall            # add --purge to also delete the local runtime DB + logs (never Azure)
  ```

(None of these touch your Azure database — see *Teardown* below for that. Your plugin `.env` lives in the
plugin folder, so removing the plugin removes it too.)

## Teardown (remove the Azure resources)

To remove just the database server this plugin provisioned (safe even if the resource group holds other
resources):

```bash
az postgres flexible-server delete --resource-group rg-agent-relay --name pg-agent-relay-<unique> --yes
```

Only if `rg-agent-relay` is **dedicated** to this plugin, you can delete the whole group:

```bash
az group delete --name rg-agent-relay --yes        # deletes EVERYTHING in the group
```

(Use your actual `-ResourceGroup` / `-ServerName` if you customized them. To stop using cross-machine
messaging *without* deleting the database, just uninstall the plugin — see above.)

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
| `AGENT_RELAY_ENV_FILE` | Path to a `.env` the plugin reads its settings from at runtime (overrides the default `<plugin-dir>/.env`). |
