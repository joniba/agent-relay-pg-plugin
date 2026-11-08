import { EventEmitter } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAzureCliTokenSource } from "../credentials/azure/cli-token-source.mjs";

function harness(options = {}) {
  const child = new EventEmitter();
  child.pid = 12345;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = child.stderr.setEncoding = () => {};
  const kills = [];
  let announceKill;
  const killed = new Promise(resolve => { announceKill = resolve; });
  child.kill = signal => { kills.push(signal); announceKill(); return true; };
  const launches = [];
  const lines = [];
  const source = createAzureCliTokenSource({
    env: {}, timeoutMs: 5000,
    launcher: () => ({ command: String.raw`C:\Azure\python.exe`, prefix: ["-IBm", "azure.cli"], installer: true }),
    spawnProcess: (...args) => { launches.push(args); return child; },
    log: line => lines.push(line),
    ...options,
  });
  return { source, child, launches, lines, kills, killed };
}

test("runs the authorization program without a shell and parses authoritative expiry", async () => {
  const h = harness({ tenantId: "test-tenant" });
  const result = h.source.getToken("https://example.invalid/.default");
  const [command, args, options] = h.launches[0];
  assert.equal(command, String.raw`C:\Azure\python.exe`);
  assert.equal(options.shell, false);
  assert.equal(options.env.AZ_INSTALLER, "MSI");
  assert.deepEqual(args.slice(-4), ["--resource", "https://example.invalid", "--tenant", "test-tenant"]);
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  h.child.stdout.emit("data", JSON.stringify({ accessToken: "private-test-token", expires_on: expiry }));
  h.child.emit("close", 0);
  assert.deepEqual(await result, { token: "private-test-token", expiresOnTimestamp: expiry * 1000 });
  assert.ok(h.lines.every(line => !line.includes("private-test-token")));
});

test("timeout stops the exact program and prevents another request until it exits", async () => {
  const h = harness({ timeoutMs: 10 });
  const pending = h.source.getToken("https://example.invalid/.default");
  const rejected = assert.rejects(pending, error => error.code === "AGENT_RELAY_AUTH_TIMEOUT");
  await h.killed;
  assert.deepEqual(h.kills, ["SIGTERM"]);
  await assert.rejects(h.source.getToken("https://example.invalid/.default"), /already running/);
  assert.equal(h.launches.length, 1);
  h.child.emit("close", null);
  await rejected;
});

test("closing during acquisition stops the program and reports cancellation", async () => {
  const h = harness();
  const pending = h.source.getToken("https://example.invalid/.default");
  const rejected = assert.rejects(pending, /cancelled/);
  const closing = h.source.close();
  assert.deepEqual(h.kills, ["SIGTERM"]);
  h.child.emit("close", null);
  await closing;
  await rejected;
  await assert.rejects(h.source.getToken("https://example.invalid/.default"), /closed/);
});

test("invalid output and authorization errors never expose returned token or identity data", async () => {
  for (const code of [0, 1]) {
    const h = harness();
    const pending = h.source.getToken("https://example.invalid/.default");
    const rejected = assert.rejects(pending, error =>
      !error.message.includes("private-test-token") && !error.message.includes("private-user"));
    h.child.stdout.emit("data", '{"accessToken":"private-test-token"');
    h.child.stderr.emit("data", "AADSTS70043 private-user must run az login");
    h.child.emit("close", code);
    await rejected;
    assert.ok(h.lines.every(line => !/private-test-token|private-user/.test(line)));
  }
});

test("normalizes only legacy trace attribution in the child environment", async () => {
  const env = {
    COPILOT_AGENT_SESSION_ID: "00-" + "a".repeat(32) + "-" + "b".repeat(16) + "-01",
    SESSION_ID: "12345678-1234-1234-1234-123456789abc",
  };
  const h = harness({ env });
  const pending = h.source.getToken("https://example.invalid/.default");
  const rejected = assert.rejects(pending, /failed/);
  assert.equal(h.launches[0][2].env.COPILOT_AGENT_SESSION_ID, env.SESSION_ID);
  assert.notEqual(env.COPILOT_AGENT_SESSION_ID, env.SESSION_ID);
  h.child.emit("close", 1);
  await rejected;
});
