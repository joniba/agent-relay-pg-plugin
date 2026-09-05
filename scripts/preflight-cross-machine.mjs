#!/usr/bin/env node
/**
 * Cross-machine preflight — verifies that a cross-machine (Postgres) session will
 * ACTUALLY connect, using the real credential + transport path (not a shortcut).
 *
 * Run after `az login` (e.g. by the installer) against the installed extension
 * dir. Exits 0 on success, or a SPECIFIC non-zero code with a human message
 * classifying the failure so the caller can tell the user exactly what to fix.
 *
 * Usage:  node scripts/preflight-cross-machine.mjs <installed-extension-dir>
 *
 * It loads the installed `.env` (so it tests the same config a real session will,
 * best-effort via the installed env loader), builds THIS plugin's transport +
 * credentials from its own factory (`../index.mjs`), and brings the transport up
 * (init → stop). `init()` connects, mints an Entra token via the Credentials
 * provider, and runs the schema migration — i.e. it exercises auth, TLS,
 * reachability, and schema in one shot, exactly as a real session does.
 */
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

import createPgPlugin from "../index.mjs";

export const EXIT = {
  OK: 0,
  ENV_INCOMPLETE: 10,
  PG_MISSING: 11,
  NO_AUTH: 12,
  AUTH_REJECTED: 13,
  UNREACHABLE: 14,
  SCHEMA_NEWER: 15,
  OTHER: 1,
};

/** Print a message to stderr and exit with the given code. */
function fail(code, msg) {
  process.stderr.write(msg.trimEnd() + "\n");
  process.exit(code);
}

/**
 * Classify a transport/credential failure into an EXIT code + actionable message.
 * Pure (no I/O), so it is unit-tested directly. Order matters: the MOST specific
 * cases come first — notably the wrong-tenant/wrong-account case (which carries an
 * `AADSTS50020` code) is matched BEFORE the generic "not signed in" case, so a
 * guest/cross-tenant token isn't mislabeled as "run az login".
 *
 * @param {unknown} err
 * @param {NodeJS.ProcessEnv} [env]  Source of the PG_USER/PG_HOST shown in messages.
 * @returns {{ code: number, message: string }}
 */
export function classify(err, env = process.env) {
  const msg = String((err && err.message) || err);
  const code = err && err.code;
  const user = env.AGENT_RELAY_PG_USER ?? "?";
  const host = env.AGENT_RELAY_PG_HOST ?? "?";

  if (/requires a host|requires a user|requires a database/i.test(msg)) {
    return {
      code: EXIT.ENV_INCOMPLETE,
      message: `Incomplete config: ${msg}\n→ Set AGENT_RELAY_PG_HOST / _USER / _DB in your .env (or environment).`,
    };
  }
  if (/requires the 'pg' package/i.test(msg)) {
    return {
      code: EXIT.PG_MISSING,
      message: `The 'pg' package isn't installed.\n→ Run 'npm install' in the agent-relay-pg plugin folder, then re-try.`,
    };
  }
  // Wrong tenant / account — checked BEFORE the generic no-auth case below, since
  // these carry an AADSTS50020 code that a bare "AADSTS" match would swallow.
  if (/isn't valid for this server's tenant|Acquire a new token for tenant|AADSTS50020|does not exist in tenant|cross-tenant|wrong tenant/i.test(msg)) {
    return {
      code: EXIT.AUTH_REJECTED,
      message: `Your Azure token is for the WRONG tenant/account.\n→ Sign in as the provisioned DB admin (AGENT_RELAY_PG_USER='${user}') — e.g. 'az login' into the AZURE_CONFIG_DIR profile as that account. A corp/other-tenant token authenticates to Azure but the database rejects it.\n(${msg})`,
    };
  }
  if (/Run 'az login'|az login|AzureCliCredential|CredentialUnavailable|DefaultAzureCredential|no token|InteractiveBrowser/i.test(msg)) {
    return {
      code: EXIT.NO_AUTH,
      message: `Could not mint a Microsoft Entra token (you're not signed in to Azure).\n→ Run 'az login' as the database admin, then re-install.\n(${msg})`,
    };
  }
  if (
    code === "28P01" || code === "28000" || code === "28P02" ||
    /password authentication failed|pg_hba|PAM|no pg_hba\.conf entry|role .* does not exist|not authorized|permission denied/i.test(msg)
  ) {
    return {
      code: EXIT.AUTH_REJECTED,
      message: `The signed-in identity was REJECTED by the database.\n→ Sign in as the provisioned DB admin (AGENT_RELAY_PG_USER='${user}'). A token for any other account authenticates to Azure but fails here.\n(${msg})`,
    };
  }
  if (
    ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EHOSTUNREACH", "EAI_AGAIN"].includes(code) ||
    /ETIMEDOUT|ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|getaddrinfo|connect ETIMEDOUT/i.test(msg)
  ) {
    return {
      code: EXIT.UNREACHABLE,
      message: `Could not reach the database host '${host}'.\n→ Check AGENT_RELAY_PG_HOST, your network, and that the server is running.\n(${msg})`,
    };
  }
  if (/newer than this build/i.test(msg)) {
    return {
      code: EXIT.SCHEMA_NEWER,
      message:
        `The database schema is newer than this build of the Postgres plugin.\n` +
        `→ Upgrade the INSTALLED plugin (a git pull here only updates this clone):\n` +
        `    npx --yes github:joniba/agent-relay --add-plugin github:joniba/agent-relay-pg-plugin\n` +
        `(${msg})`,
    };
  }
  return { code: EXIT.OTHER, message: `Cross-machine preflight failed: ${msg}` };
}

/** Imperative entry: load the installed config, bring the transport up, classify. */
async function main() {
  // Importing `../index.mjs` above already populated process.env from the plugin's
  // own installed `.env` (the plugin owns its config; D7). So we just read it — no
  // import back into core, no separate env loader.
  if (!process.env.AGENT_RELAY_PG_HOST) {
    fail(
      EXIT.OTHER,
      "preflight: AGENT_RELAY_PG_HOST is not set — not a cross-machine (Postgres) config.",
    );
  }

  const self = { id: `preflight-${Date.now()}`, name: "preflight" };
  let transport;
  try {
    // Build the transport + credentials from THIS plugin's own factory — the same
    // path a real session takes through the plugin loader. An incomplete config
    // makes init() throw ("requires a host/user/database"), which classify() maps
    // to ENV_INCOMPLETE rather than letting it escape as a raw stack trace.
    const plugin = createPgPlugin({ env: process.env });
    transport = plugin.transport.create({ log: () => {} });
    const credentials = plugin.credentials();
    await transport.init({ self, credentials });
    await transport.stop();
    process.stdout.write("preflight: OK — connected to the cross-machine database.\n");
    process.exit(EXIT.OK);
  } catch (err) {
    try {
      await transport?.stop?.();
    } catch {
      /* best-effort */
    }
    const { code, message } = classify(err);
    fail(code, message);
  }
}

// Run main() ONLY when invoked directly, so a test can `import { classify }`
// without this connecting to Azure and calling process.exit().
const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) main();
