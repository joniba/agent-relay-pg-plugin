import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

export const AUTHORIZATION_TIMEOUT_MS = 180_000;

function authorizationEnvironment(env, log) {
  const childEnv = { ...env };
  const marker = childEnv.COPILOT_AGENT_SESSION_ID;
  if (/^[\da-f]{2}-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/i.test(marker ?? "")) {
    if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(childEnv.SESSION_ID ?? "")) {
      throw new Error("Azure authorization: session attribution cannot be normalized");
    }
    childEnv.COPILOT_AGENT_SESSION_ID = childEnv.SESSION_ID;
    log("authorization: normalized session attribution");
  }
  return childEnv;
}

export function resolveAzureCli(env = process.env, platform = process.platform) {
  const path = env.PATH ?? env.Path ?? "";
  const names = platform === "win32" ? ["az.exe", "az.cmd"] : ["az"];
  for (const directory of path.split(platform === "win32" ? ";" : delimiter).filter(Boolean)) {
    for (const name of names) {
      const command = join(directory.replace(/^"|"$/g, ""), name);
      if (!existsSync(command)) continue;
      if (platform !== "win32" || name.endsWith(".exe")) return { command, prefix: [] };
      const python = resolve(dirname(command), "..", "python.exe");
      const wrapper = readFileSync(command, "utf8");
      if (!existsSync(python) || !wrapper.includes('python.exe" -IBm azure.cli')) {
        throw new Error("Azure authorization: the installed az.cmd wrapper is unsupported");
      }
      return { command: python, prefix: ["-IBm", "azure.cli"], installer: true };
    }
  }
  throw new Error("Azure authorization: Azure CLI was not found in this session's PATH");
}

function commandFailure(stderr, code) {
  const aad = stderr.match(/\bAADSTS\d+\b/)?.[0];
  const login = /\baz login\b|interaction_required|login required/i.test(stderr);
  return new Error(
    `Azure authorization failed (exit ${code ?? "unknown"}${aad ? `, ${aad}` : ""}` +
    `${login ? ", Azure CLI sign-in requires attention" : ""})`,
  );
}

export function createAzureCliTokenSource({
  env = process.env,
  tenantId,
  timeoutMs = AUTHORIZATION_TIMEOUT_MS,
  log = () => {},
  launcher = resolveAzureCli,
  spawnProcess = spawn,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Azure authorization requires a positive timeout");
  }
  let child = null;
  let active = null;
  let closed = false;

  return {
    getToken(scope) {
      if (closed) return Promise.reject(new Error("Azure authorization provider is closed"));
      if (active) return Promise.reject(new Error("Azure authorization request is already running"));
      active = new Promise((resolveRequest, rejectRequest) => {
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let cancelled = false;
        let overflow = false;
        let launchError = null;
        let deadline = null;
        let killDeadline = null;
        const finish = (error, result) => {
          clearTimeout(deadline);
          clearTimeout(killDeadline);
          child = null;
          if (error) rejectRequest(error);
          else resolveRequest(result);
        };
        try {
          const childEnv = authorizationEnvironment(env, log);
          const launch = launcher(childEnv);
          if (launch.installer) childEnv.AZ_INSTALLER = "MSI";
          const args = [
            ...launch.prefix, "account", "get-access-token", "--output", "json",
            "--resource", scope.replace(/\/\.default$/, ""),
            ...(tenantId ? ["--tenant", tenantId] : []),
          ];
          child = spawnProcess(launch.command, args, {
            env: childEnv, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
          });
          const stop = () => {
            child.kill("SIGTERM");
            killDeadline ??= setTimeout(() => {
              log("authorization process: still stopping; terminating the same process", { level: "warning" });
              child?.kill("SIGKILL");
            }, 5000);
          };
          log(`authorization process started pid=${child.pid ?? "pending"} timeout_ms=${timeoutMs}`);
          child.stdout.setEncoding("utf8");
          child.stderr.setEncoding("utf8");
          child.stdout.on("data", chunk => {
            stdout += chunk;
            if (stdout.length > 1_048_576 && !overflow) {
              overflow = true;
              stop();
            }
          });
          child.stderr.on("data", chunk => {
            stderr = (stderr + chunk).slice(-65_536);
          });
          child.on("error", error => { launchError = error; });
          child.once("close", code => {
            log(`authorization process exited pid=${child?.pid ?? "unknown"} code=${code ?? "signal"}`);
            if (timedOut) {
              const error = new Error(`Azure authorization exceeded ${timeoutMs}ms; its process has stopped`);
              error.code = "AGENT_RELAY_AUTH_TIMEOUT";
              finish(error);
            } else if (cancelled || closed) {
              finish(new Error("Azure authorization was cancelled; its process has stopped"));
            } else if (overflow) {
              finish(new Error("Azure authorization returned more output than allowed"));
            } else if (launchError) {
              finish(new Error(`Azure authorization program could not start (${launchError.code ?? launchError.name})`));
            } else if (code !== 0) {
              finish(commandFailure(stderr, code));
            } else {
              try {
                const result = JSON.parse(stdout);
                const expiresOnTimestamp = Number(result.expires_on) * 1000;
                if (typeof result.accessToken !== "string" || !result.accessToken ||
                    !Number.isFinite(expiresOnTimestamp) || expiresOnTimestamp <= Date.now()) {
                  throw new Error("Azure authorization returned no valid token and expiry");
                }
                finish(null, { token: result.accessToken, expiresOnTimestamp });
              } catch {
                finish(new Error("Azure authorization returned invalid token or expiry data"));
              }
            }
          });
          deadline = setTimeout(() => {
            timedOut = true;
            log(`authorization process timed out pid=${child?.pid ?? "unknown"}`, { level: "warning" });
            stop();
          }, timeoutMs);
          child.cancelAuthorization = () => {
            cancelled = true;
            stop();
          };
        } catch (error) {
          finish(error);
        }
      });
      const request = active;
      return request.finally(() => {
        if (active === request) active = null;
      });
    },
    async close() {
      closed = true;
      if (child) child.cancelAuthorization();
      if (active) {
        try {
          await active;
        } catch {
          // The original caller receives the cancellation error.
        }
      }
    },
  };
}
