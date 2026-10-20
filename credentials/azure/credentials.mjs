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
 *   The underlying Azure token source. Defaults to `AzureCliCredential`, using
 *   the existing `az login` context with a 30-second command timeout. There is
 *   no automatic fallback to PowerShell or other credentials. Inject a fake in tests.
 * @param {string} [opts.scope]  OAuth scope for the token. Defaults to the
 *   Azure Database for PostgreSQL AAD scope.
 * @param {string} [opts.tenantId]  Microsoft Entra tenant to acquire the token
 *   for. Set this when the signed-in account spans multiple tenants (or the DB
 *   tenant enforces MFA), so the token targets the server's tenant explicitly
 *   instead of relying on the `az` default context. Ignored when a `credential`
 *   is injected.
 * @param {NodeJS.ProcessEnv} [opts.env] Environment to normalize; defaults to process.env.
 * @param {(message: string) => void} [opts.log] Diagnostic logger; never receives token values.
 * @returns {CredentialProvider}
 */
export function createAzureEntraCredentials({
  credential,
  scope = PG_AAD_SCOPE,
  tenantId,
  env = process.env,
  log = () => {},
} = {}) {
  // Construct the default credential lazily only when none is injected, so the
  // module stays unit-testable with a fake WITHOUT @azure/identity being
  // resolvable, and so the heavy SDK loads only on the real cross-machine path —
  // never on the local default.
  let source = credential ?? null;

  return {
    async get() {
      normalizeAgentSession(env, log);
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

function normalizeAgentSession(env, log) {
  const agentSession = env.COPILOT_AGENT_SESSION_ID;
  const validSession = /^[A-Za-z0-9._~-]{20,50}$/;
  if (!agentSession || validSession.test(agentSession)) return;

  // Some CLI builds inject a W3C traceparent here. Azure CLI forwards this as
  // Entra's client_session, whose 50-character limit rejects the 55-character header.
  const traceparent = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/i;
  if (!traceparent.test(agentSession) || !validSession.test(env.SESSION_ID ?? "")) {
    throw new Error(
      "azure-entra credentials: invalid COPILOT_AGENT_SESSION_ID; " +
        "a traceparent requires a valid canonical SESSION_ID",
    );
  }
  env.COPILOT_AGENT_SESSION_ID = env.SESSION_ID;
  log("azure-entra: corrected traceparent-shaped agent metadata using the canonical session id");
}

async function defaultCredential(tenantId) {
  const { AzureCliCredential } = await import("@azure/identity");
  return new AzureCliCredential({ tenantId, processTimeoutInMs: 30_000 });
}
