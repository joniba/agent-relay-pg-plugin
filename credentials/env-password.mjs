/**
 * Vendor-neutral CredentialProvider that returns a static password from an
 * environment variable. Used to pair the Postgres transport with a plain
 * password-auth server (e.g. local Docker Postgres in tests/dev) WITHOUT pulling
 * any cloud SDK into the path.
 *
 * For the Azure cross-machine deployment, the Postgres transport is instead
 * paired with the Entra-token credential from the `azure/` lib — same seam, no
 * transport change.
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]   Defaults to `process.env`.
 * @param {string} [opts.varName]          Env var holding the password.
 *   Default `AGENT_RELAY_PG_PASSWORD`.
 * @returns {CredentialProvider}
 */
export function createEnvPasswordCredentials({ env = process.env, varName = "AGENT_RELAY_PG_PASSWORD" } = {}) {
  return {
    async get() {
      return env[varName] ?? null;
    },
  };
}
