import { createAzureCliTokenSource, AUTHORIZATION_TIMEOUT_MS } from "./cli-token-source.mjs";

/**
 * Azure Entra CredentialProvider — mints a PostgreSQL-scoped Microsoft Entra
 * access token for the Postgres transport to use as its connection password.
 *
 * This is the ONLY module that knows about Azure. It lives in the self-contained
 * `azure/` lib so it can be lifted out into a separate repo / npm package later
 * with no change to the rest of the extension (the transport depends on the
 * Credentials *seam*, never on this module directly).
 *
 * Honors the {@link CredentialProvider} shape:
 * `get()` resolves to the raw token string (the transport passes it as the `pg`
 * connection password). Reuses unexpired tokens and shares concurrent acquisition.
 *
 * @param {object} [opts]
 * @param {{ getToken: (scope: string|string[]) => Promise<{ token: string } | null> }} [opts.credential]
 *   The underlying Azure token source. Defaults to the existing Azure CLI login.
 *   Inject a fake in tests.
 * @param {string} [opts.scope]  OAuth scope for the token. Defaults to the
 *   Azure Database for PostgreSQL AAD scope.
 * @param {string} [opts.tenantId]  Microsoft Entra tenant to acquire the token
 *   for. Set this when the signed-in account spans multiple tenants (or the DB
 *   tenant enforces MFA), so the token targets the server's tenant explicitly
 *   instead of relying on the `az` default context. Ignored when a `credential`
 *   is injected.
 * @returns {CredentialProvider}
 */
export function createAzureEntraCredentials({
  credential, scope = PG_AAD_SCOPE, tenantId, env = process.env,
  log = () => {}, clock = Date.now, timeoutMs = AUTHORIZATION_TIMEOUT_MS,
} = {}) {
  const source = credential ?? createAzureCliTokenSource({ tenantId, env, log, timeoutMs });
  let cached = null;
  let acquiring = null;
  let closed = false;

  return {
    async get() {
      if (closed) throw new Error("Azure authorization provider is closed");
      if (cached && cached.expiresOnTimestamp > clock() + 300_000) {
        log(`authorization cache hit remaining_ms=${cached.expiresOnTimestamp - clock()}`, { level: "debug" });
        return cached.token;
      }
      if (!acquiring) {
        acquiring = Promise.resolve().then(async () => {
          const started = clock();
          log("authorization request started");
          try {
            const result = await source.getToken(scope);
            if (!result?.token) throw new Error("azure-entra credentials: token acquisition returned no token");
            if (closed) throw new Error("Azure authorization provider closed before acquisition finished");
            const remaining = result.expiresOnTimestamp - clock();
            cached = Number.isFinite(remaining) && remaining > 300_000 ? result : null;
            if (Number.isFinite(remaining) && remaining <= 0) {
              throw new Error("Azure authorization returned an expired token");
            }
            log(`authorization acquired elapsed_ms=${clock() - started} cacheable=${!!cached}`);
            return result.token;
          } catch (error) {
            log(`authorization request failed elapsed_ms=${clock() - started} reason=${error.message}`, { level: "warning" });
            throw error;
          }
        });
      } else {
        log("authorization request joined; no additional process started", { level: "debug" });
      }
      const request = acquiring;
      try {
        return await request;
      } finally {
        if (acquiring === request) acquiring = null;
      }
    },
    async close() {
      closed = true;
      cached = null;
      await source.close?.();
    },
  };
}

/** The Azure Database for PostgreSQL Microsoft Entra (AAD) OAuth scope. */
export const PG_AAD_SCOPE = "https://ossrdbms-aad.database.windows.net/.default";
