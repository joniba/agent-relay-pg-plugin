# agent-relay — Azure lib

The **only** Azure-aware code in agent-relay. Everything that depends on Azure — the Azure CLI credential adapter and
the Microsoft Entra token scope — lives in **this folder**. Its **companion
provisioning script** is `scripts/provision-azure.ps1` (a sibling, kept as a
shell script because it runs `az`); it is part of the Azure surface and is taken
along on extraction (see *How to extract later*). Everything is deliberately
isolated so it can be **lifted out into a separate repo or npm package** later
(e.g. `@agent-relay/azure`) with no change to the rest of the extension.

## What's here

| File | Role |
|---|---|
| `credentials.mjs` | `createAzureEntraCredentials()` → a `CredentialProvider` whose `get()` mints a PostgreSQL-scoped Microsoft Entra access token. |
| `cli-token-source.mjs` | Runs existing Azure CLI authorization with a separate deadline and stops its own program on cancellation. |
| `index.mjs` | The stable public surface (re-exports). Import the lib only through this. |

The companion provisioning script lives at `scripts/provision-azure.ps1` (it runs
`az`, so it stays a shell script rather than JS).

## How it plugs in (no lock-in)

agent-relay's core never knows Azure exists. The cross-machine **Postgres
transport is vendor-neutral** (`pg` only) and obtains its connection password
through the **Credentials seam** (a duck-typed `{ async get() }` provider). The
pg-plugin's `index.mjs` factory is the single place that picks this Azure
credential (or the env-password provider) for the Postgres transport:

```js
import { createAzureEntraCredentials } from "./azure/index.mjs";
// …in the plugin factory's `credentials`:
credentials: () => createAzureEntraCredentials({ tenantId: env.AGENT_RELAY_AZURE_TENANT }),
```

The transport obtains initial authorization before constructing its connection pool.
Later connections call `credentials.get()`, which shares an active request or reuses
an unexpired token until five minutes before expiry. Tokens without a reliable expiry
are not cached. The provider's optional `close()` cancels its active program.
Password auth on the server is disabled; the token + TLS is the security boundary.

## How to extract later

1. Move this `azure/` folder to its own package; keep `index.mjs` as the entry.
2. Move `scripts/provision-azure.ps1` alongside it.
3. In agent-relay, replace `import … from "./azure/index.mjs"` with the package
   name. Nothing else references Azure — the transport and core are untouched.

Because every Azure authorization operation is confined to this folder and the rest of the
code depends only on the Credentials seam, extraction is a folder move plus one
import swap.

## Auth model

- **Microsoft Entra token, password auth disabled, TLS required.** No password
  exists to leak; only a valid Entra token for a server admin can connect.
- **No IP allowlist is relied upon** — the security boundary is authentication,
  not network location (egress IPs can rotate). Public network access stays on,
  gated by Entra.
- The token is minted **locally on each machine** through the existing Azure CLI
  login. Automatic fallback to other credential providers is not used. Tokens
  are cached only in memory and never stored or transferred between machines.
- The authorization program has a 180-second deadline. On Windows, the standard
  MSI launcher's Python program is executed directly rather than through a shell.
  A timed-out request is not considered finished until that program has exited.
- Diagnostic logs contain elapsed times, process IDs, and classified failures,
  not tokens, command output, or account identifiers.

## Provisioning & lifecycle

Run `scripts/provision-azure.ps1 -ServerName pg-agent-relay-<unique>` **once** per
environment (it's idempotent). It creates the resource group, the Flexible Server
(Entra-only auth, password auth disabled, TLS enforced), sets the signed-in user as
the Entra admin, and the application database — printing only the **non-secret**
`AGENT_RELAY_PG_*` settings to export. See the repo README's *Cross-machine
messaging* section for the per-machine setup.

- **Cost:** a rough compute estimate for the default Burstable **B1ms** SKU is ~$12–15/month
  (excludes storage/backup; varies by region/currency — check Azure pricing for exact figures).
  The server is meant to stay running as the shared substrate.
- **Region:** defaults to `eastus` (`-Location` to change).
- **Teardown** when no longer needed (replace `rg-agent-relay` if you used `-ResourceGroup`):

  ```powershell
  az group delete --name rg-agent-relay --yes
  ```
