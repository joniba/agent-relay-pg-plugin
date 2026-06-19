#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Provision an Azure Database for PostgreSQL Flexible Server for agent-relay's
  cross-machine transport. Microsoft Entra-only auth (password auth DISABLED),
  TLS enforced. Idempotent: safe to re-run.

.DESCRIPTION
  Creates (if absent): a resource group, a PostgreSQL Flexible Server with
  Entra auth enabled and password auth disabled, sets the signed-in user as the
  Entra administrator, and opens public network access GATED BY ENTRA AUTH (no
  IP allowlist — egress IPs rotate, so authentication is the security boundary).

  SECURITY: this script never prints tokens, tenant ids, or subscription ids, and
  suppresses verbose `az` JSON. It prints only the NON-SECRET connection settings
  (host / user / database) for you to export as AGENT_RELAY_PG_*. The connection
  password is a short-lived Entra token minted at runtime on each machine via
  `az login` — it is never created, stored, or transferred by this script.

  Run this ONCE per environment (Phase E). The extension only CONSUMES the
  AGENT_RELAY_PG_* settings; it never provisions.

.PARAMETER ResourceGroup
  Resource group name. Default: rg-agent-relay.

.PARAMETER ServerName
  PostgreSQL Flexible Server name (must be GLOBALLY UNIQUE, lowercase). Required.

.PARAMETER Location
  Azure region. Default: eastus. Override with any Azure region near you.

.PARAMETER Database
  Application database name. Default: agentrelay.

.PARAMETER AdminObjectId
  Entra object id of the admin user. Default: the signed-in user's object id.

.PARAMETER AdminUpn
  Entra user principal name of the admin (display name for the AD admin + the
  Postgres `user`). Default: the signed-in user's UPN.

.EXAMPLE
  ./scripts/provision-azure.ps1 -ServerName pg-agent-relay-7f3a
#>
[CmdletBinding()]
param(
    [string]$ResourceGroup = "rg-agent-relay",
    [Parameter(Mandatory = $true)][string]$ServerName,
    [string]$Location = "eastus",
    [string]$Database = "agentrelay",
    [string]$Tier = "Burstable",
    [string]$Sku = "Standard_B1ms",
    [string]$Version = "16",
    [string]$AdminObjectId,
    [string]$AdminUpn
)

$ErrorActionPreference = "Stop"
# Idempotency relies on `az ... show` failing QUIETLY (non-zero exit, no throw)
# when a resource doesn't yet exist, so the create branch runs. A user profile
# that sets $PSNativeCommandUseErrorActionPreference=$true would turn that
# non-zero exit into a terminating error and abort on first run — pin it off.
$PSNativeCommandUseErrorActionPreference = $false

function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

# --- Preconditions ----------------------------------------------------------
if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw "Azure CLI (az) not found on PATH. Install it, then `az login`."
}
# Confirm a login exists WITHOUT printing identity details.
if (-not (az account show --query id -o tsv 2>$null)) {
    throw "Not logged in. Run `az login` first."
}

# Resolve the signed-in admin (object id + UPN) only if not supplied. These are
# used to grant DB access; the object id is not a secret but we do not echo it.
if (-not $AdminObjectId) { $AdminObjectId = az ad signed-in-user show --query id -o tsv 2>$null }
if (-not $AdminUpn) { $AdminUpn = az ad signed-in-user show --query userPrincipalName -o tsv 2>$null }
if (-not $AdminObjectId -or -not $AdminUpn) {
    throw "Could not resolve the signed-in user. Pass -AdminObjectId and -AdminUpn explicitly."
}

# --- Resource group (idempotent) -------------------------------------------
Step "Resource group '$ResourceGroup' in '$Location'"
if ((az group exists --name $ResourceGroup) -ne "true") {
    az group create --name $ResourceGroup --location $Location --output none
}

# --- Flexible Server (idempotent) ------------------------------------------
$serverExists = az postgres flexible-server show -g $ResourceGroup -n $ServerName --query name -o tsv 2>$null
if (-not $serverExists) {
    Step "Creating PostgreSQL Flexible Server '$ServerName' (Entra-only, no password auth)"
    # --public-access All => reachable from any IP; the security boundary is the
    # Entra token + TLS, NOT an IP allowlist (egress rotates). No password exists.
    az postgres flexible-server create `
        --name $ServerName `
        --resource-group $ResourceGroup `
        --location $Location `
        --tier $Tier --sku-name $Sku `
        --version $Version `
        --storage-size 32 `
        --active-directory-auth Enabled `
        --password-auth Disabled `
        --public-access All `
        --yes --output none
} else {
    Step "Server '$ServerName' already exists — skipping create"
}

# --- Enforce TLS explicitly (the "T" in the Entra+TLS security boundary) -----
# Don't rely on the mutable server default; set it so the guarantee is explicit
# and self-healing on re-run. Idempotent.
Step "Enforcing TLS (require_secure_transport=ON, min TLS 1.2)"
az postgres flexible-server parameter set -g $ResourceGroup -s $ServerName `
    --name require_secure_transport --value ON --output none
az postgres flexible-server parameter set -g $ResourceGroup -s $ServerName `
    --name ssl_min_protocol_version --value TLSv1.2 --output none

# --- Entra admin (idempotent) ----------------------------------------------
Step "Setting Entra administrator"
$adminExists = az postgres flexible-server ad-admin list -g $ResourceGroup -s $ServerName `
    --query "[?objectId=='$AdminObjectId'] | [0].objectId" -o tsv 2>$null
if (-not $adminExists) {
    az postgres flexible-server ad-admin create `
        --resource-group $ResourceGroup --server-name $ServerName `
        --display-name $AdminUpn --object-id $AdminObjectId --type User `
        --output none
} else {
    Step "Entra admin already set — skipping"
}

# --- Application database (idempotent) -------------------------------------
Step "Database '$Database'"
$dbExists = az postgres flexible-server db show -g $ResourceGroup -s $ServerName -d $Database --query name -o tsv 2>$null
if (-not $dbExists) {
    az postgres flexible-server db create -g $ResourceGroup -s $ServerName -d $Database --output none
} else {
    Step "Database already exists — skipping"
}

$fqdn = az postgres flexible-server show -g $ResourceGroup -n $ServerName --query fullyQualifiedDomainName -o tsv 2>$null

# --- Output: NON-SECRET connection settings only ---------------------------
Write-Host ""
Write-Host "Provisioning complete. Export these (NON-SECRET) settings on each machine:" -ForegroundColor Green
Write-Host ""
Write-Host "  `$env:AGENT_RELAY_TRANSPORT = 'postgres'"
Write-Host "  `$env:AGENT_RELAY_PG_HOST   = '$fqdn'"
Write-Host "  `$env:AGENT_RELAY_PG_USER   = '$AdminUpn'"
Write-Host "  `$env:AGENT_RELAY_PG_DB     = '$Database'"
Write-Host ""
Write-Host "Auth: each machine mints a short-lived Entra token at runtime via its own `az login`." -ForegroundColor DarkGray
Write-Host "No password is created or transferred. The token + TLS is the security boundary." -ForegroundColor DarkGray
Write-Host ""
Write-Host "Teardown when no longer needed:  az group delete --name $ResourceGroup --yes" -ForegroundColor DarkGray
