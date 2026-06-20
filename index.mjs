import { hostname } from "node:os";

import { createPostgresTransport } from "./transport/postgres.mjs";
import { createEnvPasswordCredentials } from "./credentials/env-password.mjs";
import { createAzureEntraCredentials } from "./credentials/azure/index.mjs";
import { loadEnvFile } from "./env-file.mjs";

// The pg-plugin owns ALL its config (D7): load its OWN gitignored `.env` (the pg
// connection settings) into process.env when this plugin is imported — BEFORE the
// factory reads them. Core no longer loads any `.env`. Search order:
// $AGENT_RELAY_ENV_FILE, then `<this-plugin-dir>/.env`. Shell-exported vars win.
loadEnvFile();

/** Strip control chars from a peer-controlled header field so it can't forge line
 * breaks / framing in the wake prompt. (Self-contained copy — this plugin does not
 * import from core. Mirrors core's `sanitize.mjs`.) */
function stripControl(s) {
  // eslint-disable-next-line no-control-regex
  return String(s ?? "").replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]/g, "");
}

/**
 * agent-relay-pg — the cross-machine Postgres plugin, packaged exactly like an
 * external drop-in plugin (its own package.json + node_modules).
 *
 * Default-exports the plugin factory `(ctx) => Registration`. It reads connection
 * settings from `ctx.env` and returns a Registration declaring three seams:
 *   - `transport`: the vendor-neutral Postgres transport (its `init()` owns the
 *     connect-retry; `create()` just constructs). It is told this session's
 *     `machine` so it can store + surface it (core is machine-agnostic).
 *   - `credentials`: the env-password provider when `AGENT_RELAY_PG_PASSWORD` is
 *     set (local Docker / CI), else the Azure Entra token provider.
 *   - `interceptors`: reintroduces the machine/device concept that core dropped —
 *     stamps the sender's machine outbound (`meta.fromDevice`) and renders a
 *     machine-ful wake header inbound. Present only because this plugin is installed.
 *
 * @param {{ env?: NodeJS.ProcessEnv, dataDir?: string|null, log?: (msg: string, opts?: object) => void }} ctx
 * @returns {object} a Registration { name, transport, credentials, interceptors }
 */
export default function createPgPlugin(ctx) {
  const { env = process.env } = ctx ?? {};
  // This session's machine label — provided by the PLUGIN (core has no machine
  // concept). Used to stamp outbound provenance and to tag this session's roster row.
  const machine = env.AGENT_RELAY_HOST || hostname();
  return {
    name: "agent-relay-pg",
    transport: {
      id: "postgres",
      create: ({ log } = {}) =>
        createPostgresTransport({
          host: env.AGENT_RELAY_PG_HOST,
          user: env.AGENT_RELAY_PG_USER,
          database: env.AGENT_RELAY_PG_DB,
          port: env.AGENT_RELAY_PG_PORT ? Number(env.AGENT_RELAY_PG_PORT) : 5432,
          // TLS on by default (Azure); a local Docker server sets AGENT_RELAY_PG_SSL=false.
          ssl: env.AGENT_RELAY_PG_SSL === "false" ? false : { rejectUnauthorized: true },
          machine,
          log,
        }),
    },
    credentials: () =>
      env.AGENT_RELAY_PG_PASSWORD
        ? createEnvPasswordCredentials({ env })
        : createAzureEntraCredentials({ tenantId: env.AGENT_RELAY_AZURE_TENANT }),
    interceptors: [
      {
        // Stamp the SENDER's machine onto the opaque meta bag (round-tripped by the
        // transport) so the recipient can render where a message came from.
        onSend(message, next) {
          message.meta = { ...message.meta, fromDevice: machine };
          return next(message);
        },
        // Machine-ful wake header: [agent-relay] Message from: <alias> (<machine>) -> <to-alias>.
        // The machine is a PARENTHETICAL annotation, not glued into the alias, so the bare
        // alias stays the clean, addressable reply handle. The sender's session id stays in
        // meta.fromId (provenance) but is NOT rendered. Structured fields are control-char
        // stripped (forgery-safe); the body is left as-is.
        renderPrompt(message, self) {
          const dev = message.meta && message.meta.fromDevice ? ` (${stripControl(message.meta.fromDevice)})` : "";
          const to = stripControl((self && self.name) || message.to || "unknown");
          return `[agent-relay] Message from: ${stripControl(message.from)}${dev} -> ${to}\n\n${message.body}`;
        },
      },
    ],
  };
}
