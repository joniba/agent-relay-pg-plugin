import { test } from "node:test";
import assert from "node:assert/strict";

import createPgPlugin from "../index.mjs";

test("createPgPlugin returns a Registration: transport + credentials + one machine interceptor", () => {
  const reg = createPgPlugin({
    env: { AGENT_RELAY_PG_HOST: "h", AGENT_RELAY_PG_USER: "u", AGENT_RELAY_PG_DB: "d", AGENT_RELAY_HOST: "box-1" },
  });
  assert.equal(reg.name, "agent-relay-pg");
  assert.equal(reg.transport.id, "postgres");
  assert.equal(typeof reg.transport.create, "function");
  assert.equal(typeof reg.credentials, "function");
  assert.ok(Array.isArray(reg.interceptors) && reg.interceptors.length === 1);
  assert.equal(typeof reg.interceptors[0].onSend, "function");
  assert.equal(typeof reg.interceptors[0].renderPrompt, "function");
});

test("the machine interceptor stamps meta.fromDevice (the sender's machine) on send, preserving fromId", async () => {
  const i = createPgPlugin({ env: { AGENT_RELAY_HOST: "box-A" } }).interceptors[0];
  const msg = { from: "alice", to: "bob", body: "hi", meta: { fromId: "s-alice" } };
  let passed;
  await i.onSend(msg, (m) => { passed = m; });
  assert.equal(passed.meta.fromDevice, "box-A");
  assert.equal(passed.meta.fromId, "s-alice");
});

test("the machine interceptor renders the machine-ful header: <from> (<machine>) -> <to-alias> (id stays in meta, not rendered)", () => {
  const i = createPgPlugin({ env: { AGENT_RELAY_HOST: "box-A" } }).interceptors[0];
  const msg = { from: "alice", to: "bob", body: "hi", meta: { fromId: "s-alice", fromDevice: "box-A" } };
  const prompt = i.renderPrompt(msg, { id: "s-bob", name: "bob" });
  assert.equal(prompt, "[agent-relay] Message from: alice (box-A) -> bob\n\nhi");
});

test("the machine interceptor strips control chars from header fields (forgery-safe)", () => {
  const i = createPgPlugin({ env: { AGENT_RELAY_HOST: "box\nA" } }).interceptors[0];
  const msg = { from: "alice\nX", to: "bob", body: "hi", meta: { fromId: "s\nalice", fromDevice: "box\nA" } };
  const prompt = i.renderPrompt(msg, { id: "s-bob", name: "bob" });
  assert.equal(prompt, "[agent-relay] Message from: aliceX (boxA) -> bob\n\nhi");
});

test("credentials() returns the env-password provider when AGENT_RELAY_PG_PASSWORD is set", async () => {
  const provider = createPgPlugin({ env: { AGENT_RELAY_PG_PASSWORD: "secret" } }).credentials();
  assert.equal(typeof provider.get, "function");
  assert.equal(await provider.get(), "secret");
});
