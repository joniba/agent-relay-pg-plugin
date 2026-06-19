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
 * connection password). Returns a fresh token each call, so a caller that invokes
 * `get()` per new connection always authenticates with a current token.
 *
 * @param {object} [opts]
 * @param {{ getToken: (scope: string|string[]) => Promise<{ token: string } | null> }} [opts.credential]
 *   The underlying Azure token source. Defaults to `DefaultAzureCredential`
 *   (honors `az login`, env vars, managed identity, …). Inject a fake in tests.
 * @param {string} [opts.scope]  OAuth scope for the token. Defaults to the
 *   Azure Database for PostgreSQL AAD scope.
 * @param {string} [opts.tenantId]  Microsoft Entra tenant to acquire the token
 *   for. Set this when the signed-in account spans multiple tenants (or the DB
 *   tenant enforces MFA), so the token targets the server's tenant explicitly
 *   instead of relying on the `az` default context. Ignored when a `credential`
 *   is injected.
 * @returns {CredentialProvider}
 */
export function createAzureEntraCredentials({ credential, scope = PG_AAD_SCOPE, tenantId } = {}) {
  // Construct the default credential lazily only when none is injected, so the
  // module stays unit-testable with a fake WITHOUT @azure/identity being
  // resolvable, and so the heavy SDK loads only on the real cross-machine path —
  // never on the local default.
  let source = credential ?? null;

  return {
    async get() {
      if (!source) source = await defaultCredential(tenantId);
      const result = await source.getToken(scope);
      const token = result && result.token;
      if (!token) {
        throw new Error("azure-entra credentials: token acquisition returned no token");
      }
      return token;
    },
  };
}

/** The Azure Database for PostgreSQL Microsoft Entra (AAD) OAuth scope. */
export const PG_AAD_SCOPE = "https://ossrdbms-aad.database.windows.net/.default";

async function defaultCredential(tenantId) {
  const { DefaultAzureCredential } = await import("@azure/identity");
  return new DefaultAzureCredential(tenantId ? { tenantId } : undefined);
}
