#!/usr/bin/env node
// Install agent-relay-pg — the cross-machine Postgres plugin — AND agent-relay core.
//
// PRIMARY:        npx --yes github:joniba/agent-relay-pg-plugin
// From a clone:   node scripts/install.mjs
//
// Flow (Option B — core is git-CLONED, never an npm dependency, so this package only
// depends on what its own code imports: pg + @azure/identity):
//   1. git-clone agent-relay core (pinned ref) into a gitignored bin/
//   2. run core's OWN installer  -> copies core into <COPILOT_HOME>/extensions/agent-relay/
//   3. copy THIS plugin's RUNTIME ALLOWLIST into <core-install>/plugins/agent-relay-pg/
//        package.json, index.mjs, env-file.mjs, transport/, credentials/, node_modules/
//      and NOTHING else — never tests/, scripts/, docker-compose.test.yml, the cloned-core
//      bin/, lockfiles, .git, or README.
//   4. write the Postgres connection .env into that plugin dir (the runtime loads it)
//   5. preflight — a real connect through the plugin's own transport (az sign-in if needed)
//   6. print next steps (this script does NOT launch Copilot)

import {
  existsSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const NO_PREFLIGHT = argv.includes("--no-preflight");

const GREEN = "\x1b[32m", YELLOW = "\x1b[33m", CYAN = "\x1b[36m", RESET = "\x1b[0m";
const ok = (m) => console.log(`${GREEN}${m}${RESET}`);
const warn = (m) => console.warn(`${YELLOW}${m}${RESET}`);
const info = (m) => console.log(`${CYAN}${m}${RESET}`);
const die = (m) => { console.error(`\n${m}`); process.exit(1); };

// Pinned core ref. Until core's plugin-split branch lands on `main` (Phase 4) this
// tracks the integration branch; override either with an env var.
const CORE_REPO = process.env.AGENT_RELAY_CORE_REPO || "https://github.com/joniba/agent-relay.git";
// Pinned to a TESTED core commit (not a moving branch) for reproducible installs. Phase 4
// retargets this to the release ref on `main`. Override with AGENT_RELAY_CORE_REF.
const CORE_REF = process.env.AGENT_RELAY_CORE_REF || "e124909778477d82fac5cd4f9853372ac1a94043";
const PG_SCOPE = "https://ossrdbms-aad.database.windows.net/.default";

// scripts/<this> -> package root is one dir up.
const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const copilotHome = process.env.COPILOT_HOME || join(homedir(), ".copilot");
const coreInstall = join(copilotHome, "extensions", "agent-relay");
const pluginDest = join(coreInstall, "plugins", "agent-relay-pg");
const binDir = join(pkgRoot, "bin");
const coreClone = join(binDir, "agent-relay");

/** On Windows, npm/az are `.cmd` shims: they can't be spawned directly (Node refuses to
 *  run a `.cmd` without a shell) and `shell:true` + an args array is deprecated AND leaves
 *  the args unescaped (DEP0190). Invoke them through cmd.exe (a real `.exe`) with NO shell
 *  option, so Node still escapes each arg. node/git run directly — no shell, no shim. */
function winShim(cmd, args) {
  return process.platform === "win32" && (cmd === "npm" || cmd === "az")
    ? ["cmd.exe", ["/d", "/s", "/c", cmd, ...args]]
    : [cmd, args];
}
function run(cmd, args, opts = {}) {
  const [c, a] = winShim(cmd, args);
  execFileSync(c, a, { stdio: "inherit", ...opts });
}
/** Like run() but returns false instead of throwing (for optional probes). */
function tryRun(cmd, args, opts = {}) {
  const [c, a] = winShim(cmd, args);
  try { execFileSync(c, a, { stdio: "ignore", ...opts }); return true; }
  catch { return false; }
}

// ── 1. Clone (or refresh) core into bin/ ─────────────────────────────────────
function obtainCore() {
  mkdirSync(binDir, { recursive: true });
  if (existsSync(join(coreClone, ".git"))) {
    info(`Refreshing core clone @ ${CORE_REF}...`);
    try {
      run("git", ["-C", coreClone, "fetch", "--quiet", "--tags", "--force", "origin"]);
      run("git", ["-C", coreClone, "checkout", "--quiet", "--force", CORE_REF]);
      // Fast-forward when CORE_REF is a BRANCH; a no-op (origin/<ref> absent) for a tag/SHA.
      tryRun("git", ["-C", coreClone, "reset", "--hard", "--quiet", `origin/${CORE_REF}`]);
      return;
    } catch {
      warn("Refresh failed — re-cloning core.");
      rmSync(coreClone, { recursive: true, force: true });
    }
  }
  info(`Cloning agent-relay core @ ${CORE_REF}...`);
  // Clone then checkout — works for a branch, tag, OR commit SHA (a pinned SHA can't be
  // passed to `git clone --branch`). A full clone keeps this ref-type-agnostic.
  run("git", ["clone", "--quiet", CORE_REPO, coreClone]);
  run("git", ["-C", coreClone, "checkout", "--quiet", CORE_REF]);
}

// ── 2. Run core's own installer ──────────────────────────────────────────────
function installCore() {
  const coreInstaller = join(coreClone, "scripts", "install.mjs");
  if (!existsSync(coreInstaller)) {
    die(`Core clone is missing scripts/install.mjs at ${coreInstaller}. Is AGENT_RELAY_CORE_REF=${CORE_REF} correct?`);
  }
  info("Installing agent-relay core...");
  // --quiet suppresses core's own "next steps" so the user sees ONE coherent set from us.
  run(process.execPath, [coreInstaller, "--quiet"]); // inherits COPILOT_HOME via env
}

// ── 3. Ensure deps, then copy the runtime allowlist ──────────────────────────
const RUNTIME_ALLOWLIST = ["package.json", "index.mjs", "env-file.mjs", "transport", "credentials", "node_modules"];

function ensureDeps() {
  if (existsSync(join(pkgRoot, "node_modules", "pg"))) return;
  info("Installing plugin dependencies (pg, @azure/identity)...");
  run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], { cwd: pkgRoot });
}

function copyRuntime() {
  ensureDeps();
  mkdirSync(pluginDest, { recursive: true });
  for (const name of RUNTIME_ALLOWLIST) {
    const src = join(pkgRoot, name);
    if (!existsSync(src)) {
      if (name === "node_modules") die(`Plugin dependencies are missing at ${src} — 'npm install' did not produce node_modules.`);
      die(`Plugin runtime file '${name}' is missing at ${src}.`);
    }
    cpSync(src, join(pluginDest, name), { recursive: true, force: true });
  }
  ok(`\u2713 Plugin runtime -> ${pluginDest}`);
}

// ── 4. Collect + write the Postgres .env ─────────────────────────────────────
const ENV_KEYS = [
  "AGENT_RELAY_PG_HOST", "AGENT_RELAY_PG_USER", "AGENT_RELAY_PG_DB", "AGENT_RELAY_PG_PORT",
  "AGENT_RELAY_PG_SSL", "AGENT_RELAY_PG_PASSWORD", "AGENT_RELAY_AZURE_TENANT",
  "AGENT_RELAY_HOST", "AZURE_CONFIG_DIR",
];

function parseEnvFile(path) {
  const map = {};
  if (!existsSync(path)) return map;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 1) continue;
    let v = line.slice(i + 1).trim();
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    map[line.slice(0, i).trim()] = v;
  }
  return map;
}

/** Source config: a `.env` (AGENT_RELAY_ENV_FILE, else <pkgRoot>/.env), overlaid by the
 *  process env (an exported value WINS — matching the runtime's env-file precedence). */
function collectConfig() {
  const fileMap = parseEnvFile(process.env.AGENT_RELAY_ENV_FILE || join(pkgRoot, ".env"));
  const cfg = {};
  for (const k of ENV_KEYS) {
    const v = process.env[k] ?? fileMap[k];
    if (v !== undefined && v !== "") cfg[k] = v;
  }
  return cfg;
}

function writeEnv(cfg) {
  // Wrap every value in double quotes: node:util.parseEnv (the runtime loader) keeps
  // double-quoted content VERBATIM, so values with `#` (Entra guest UPNs like
  // user_x#EXT#@y), spaces, or Windows backslash paths round-trip intact. Unquoted, a
  // `#` would be read as a comment and TRUNCATE the value.
  const lines = [];
  for (const k of ENV_KEYS) {
    if (cfg[k] === undefined) continue;
    const v = String(cfg[k]);
    // A literal " is the one char the .env double-quote form can't represent (parseEnv
    // ends the value at the first "), and backslash-escaping doesn't help (parseEnv keeps
    // backslashes literal). Warn instead of writing a value that would silently truncate.
    if (v.includes('"')) {
      warn(`${k} contains a double-quote (") which the .env format can't round-trip — it may truncate at load. Remove the quote, or set ${k} in the environment at runtime.`);
    }
    lines.push(`${k}="${v}"`);
  }
  writeFileSync(join(pluginDest, ".env"), lines.join("\n") + "\n", "utf8");
  ok(`\u2713 Wrote Postgres .env -> ${join(pluginDest, ".env")}`);
}

// ── 5. Azure sign-in (best-effort) + preflight ───────────────────────────────
function azureSignIn(cfg) {
  // Only the Entra path needs `az`; the password path (local Docker / CI) does not.
  if (cfg.AGENT_RELAY_PG_PASSWORD) return;
  if (cfg.AZURE_CONFIG_DIR) process.env.AZURE_CONFIG_DIR = cfg.AZURE_CONFIG_DIR;
  const tenant = cfg.AGENT_RELAY_AZURE_TENANT;
  const tenantArgs = tenant && /^[0-9a-fA-F-]{8,}$/.test(tenant) ? ["--tenant", tenant] : [];
  if (!tryRun("az", ["version"])) {
    warn("Azure CLI not found on PATH — skipping sign-in. If preflight reports 'not signed in', install the Azure CLI and run 'az login' as the DB admin, then re-run.");
    return;
  }
  if (tryRun("az", ["account", "get-access-token", ...tenantArgs, "--scope", PG_SCOPE, "--output", "none"])) return;
  info(`Not signed in to Azure — launching 'az login' (sign in as the DB admin${cfg.AGENT_RELAY_PG_USER ? `: ${cfg.AGENT_RELAY_PG_USER}` : ""})...`);
  try {
    run("az", ["login", ...tenantArgs, "--output", "none"]);
  } catch {
    warn("'az login' did not complete — preflight will report if a token is still missing.");
  }
}

function preflight() {
  const script = join(pkgRoot, "scripts", "preflight-cross-machine.mjs");
  info("Verifying the cross-machine connection (preflight)...");
  try {
    // Point the plugin's env loader at the EXACT .env the runtime will use.
    run(process.execPath, [script], { env: { ...process.env, AGENT_RELAY_ENV_FILE: join(pluginDest, ".env") } });
    ok("\u2713 Cross-machine verified — this machine can reach the shared mesh.");
  } catch {
    die("Cross-machine verification FAILED (reason above). The plugin is installed; sign in (az login as the DB admin) and re-run, or the extension stays INACTIVE until it can connect.");
  }
}

// ── Orchestrate ──────────────────────────────────────────────────────────────
obtainCore();
installCore();
copyRuntime();

const cfg = collectConfig();
const haveConn = cfg.AGENT_RELAY_PG_HOST && cfg.AGENT_RELAY_PG_USER && cfg.AGENT_RELAY_PG_DB;
if (haveConn) {
  writeEnv(cfg);
  if (!NO_PREFLIGHT) {
    azureSignIn(cfg);
    preflight();
  }
} else {
  warn(
    "\nNo Postgres connection settings found, so no .env was written and preflight was skipped.\n" +
    "The plugin is installed but needs AGENT_RELAY_PG_HOST / _USER / _DB. First-time setup:\n" +
    "  1. provision the database (see scripts/provision-azure.ps1 / the README),\n" +
    "  2. set AGENT_RELAY_PG_HOST / _USER / _DB (export them or put them in a .env),\n" +
    "  3. re-run this installer.",
  );
}

info(`
Next steps (this script does NOT launch Copilot):
  start with extensions enabled:  copilot --experimental

On load you'll see: \ud83c\udf10 agent-relay: connected to remote transport as [<alias>]`);
