/**
 * Public surface of the agent-relay Azure lib.
 *
 * This folder is the ONLY Azure-aware code in agent-relay. It is intentionally
 * self-contained so it can later be extracted into a separate repository or npm
 * package (e.g. `@agent-relay/azure`) with no change to the rest of the extension.
 * The rest of the codebase consumes it only through the Credentials *seam* — the
 * Postgres transport never imports anything from here directly.
 *
 * Extraction contract: this `index.mjs` is the stable entry point. Keep all
 * `@azure/*` imports inside this folder; never let an Azure type or import leak
 * outward. See ./README.md.
 */
export { createAzureEntraCredentials } from "./credentials.mjs";
