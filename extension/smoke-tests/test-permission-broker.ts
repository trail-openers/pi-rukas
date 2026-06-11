#!/usr/bin/env bun
/**
 * Pure unit test for the permission-broker — the parent-side socket server
 * that handles `ask` verdicts escalated from subagent pi-ensemble guards.
 *
 * Exercises the broker's full request/response loop over a real Unix socket
 * with a mocked subagent client and mocked BrokerDeps:
 *
 *   - cache hit (cached allow) → respond immediately with allowed=true
 *   - cache hit (cached deny) → respond with allowed=false + reason
 *   - cache miss → call promptUser, persist on "always", respond
 *   - promptUser rejection (headless / cancellation) → respond with deny
 *   - malformed request line → respond with deny + reason
 *
 * Stops the broker, asserts the socket file is unlinked.
 */

import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import type { BrokerDeps, PermissionRequest } from "../src/permission-broker.ts";
import { startBroker } from "../src/permission-broker.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

interface MockState {
  cache: Map<string, boolean>;
  persistCalls: Array<{ key: string; allowed: boolean }>;
  promptCalls: PermissionRequest[];
  promptResponse:
    | { allowed: boolean; scope: "once" | "always" }
    | { reject: Error };
}

function makeDeps(state: MockState): BrokerDeps {
  const keyOf = (req: PermissionRequest) =>
    req.toolName === "bash" ? `bash:${req.bashCommand}` : req.toolName;
  return {
    cachedLookup(req) {
      return state.cache.get(keyOf(req));
    },
    persistDecision(req, allowed) {
      const key = keyOf(req);
      state.cache.set(key, allowed);
      state.persistCalls.push({ key, allowed });
    },
    async promptUser(req) {
      state.promptCalls.push(req);
      if ("reject" in state.promptResponse) {
        throw state.promptResponse.reject;
      }
      return state.promptResponse;
    },
  };
}

function sendAndReceive(
  socketPath: string,
  req: PermissionRequest,
): Promise<{ allowed: boolean; reason?: string; scope?: string }> {
  return new Promise((resolve, reject) => {
    const conn = createConnection(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error("broker did not respond within 2s"));
    }, 2000);
    conn.setEncoding("utf8");
    conn.on("data", (chunk: string | Buffer) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const nl = buffer.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(timer);
        const line = buffer.slice(0, nl);
        try {
          const parsed = JSON.parse(line);
          resolve(parsed);
        } catch (err) {
          reject(err);
        } finally {
          conn.end();
        }
      }
    });
    conn.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    conn.write(`${JSON.stringify(req)}\n`);
  });
}

function sendRaw(socketPath: string, raw: string): Promise<{ allowed: boolean; reason?: string }> {
  return new Promise((resolve, reject) => {
    const conn = createConnection(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error("broker did not respond within 2s"));
    }, 2000);
    conn.setEncoding("utf8");
    conn.on("data", (chunk: string | Buffer) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const nl = buffer.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(buffer.slice(0, nl)));
        } catch (err) {
          reject(err);
        } finally {
          conn.end();
        }
      }
    });
    conn.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    conn.write(raw);
  });
}

// 1. Cache hit — allow.
{
  const sockPath = path.join(os.tmpdir(), `pi-ensemble-test-broker-${process.pid}-1.sock`);
  const state: MockState = {
    cache: new Map([["bash:ls", true]]),
    persistCalls: [],
    promptCalls: [],
    promptResponse: { allowed: false, scope: "once" }, // unused
  };
  const broker = startBroker(sockPath, makeDeps(state));
  try {
    const resp = await sendAndReceive(sockPath, {
      type: "permission-request",
      role: "ops",
      toolName: "bash",
      bashCommand: "ls",
    });
    assert(resp.allowed === true, "cached allow → allowed=true");
    assert(state.promptCalls.length === 0, "cached allow → promptUser not called");
    assert(resp.scope === "always", "cached verdicts come back as always-scope");
  } finally {
    broker.stop();
  }
  assert(!existsSync(sockPath), "broker.stop() unlinks the socket file");
}

// 2. Cache hit — deny with reason.
{
  const sockPath = path.join(os.tmpdir(), `pi-ensemble-test-broker-${process.pid}-2.sock`);
  const state: MockState = {
    cache: new Map([["bash:rm -rf /", false]]),
    persistCalls: [],
    promptCalls: [],
    promptResponse: { allowed: false, scope: "once" },
  };
  const broker = startBroker(sockPath, makeDeps(state));
  try {
    const resp = await sendAndReceive(sockPath, {
      type: "permission-request",
      role: "ops",
      toolName: "bash",
      bashCommand: "rm -rf /",
    });
    assert(resp.allowed === false, "cached deny → allowed=false");
    assert(typeof resp.reason === "string" && resp.reason.length > 0, "cached deny carries a reason");
    assert(state.promptCalls.length === 0, "cached deny → promptUser not called");
  } finally {
    broker.stop();
  }
}

// 3. Cache miss — prompt allow always, persist.
{
  const sockPath = path.join(os.tmpdir(), `pi-ensemble-test-broker-${process.pid}-3.sock`);
  const state: MockState = {
    cache: new Map(),
    persistCalls: [],
    promptCalls: [],
    promptResponse: { allowed: true, scope: "always" },
  };
  const broker = startBroker(sockPath, makeDeps(state));
  try {
    const resp = await sendAndReceive(sockPath, {
      type: "permission-request",
      role: "developer",
      toolName: "bash",
      bashCommand: "npm install left-pad",
    });
    assert(resp.allowed === true, "user allow always → allowed=true");
    assert(resp.scope === "always", "verdict scope reflects user choice");
    assert(state.promptCalls.length === 1, "promptUser called once");
    assert(state.persistCalls.length === 1, "persistDecision called once (always-scope)");
    assert(state.persistCalls[0]?.allowed === true, "persisted allow=true");
  } finally {
    broker.stop();
  }
}

// 4. Cache miss — prompt allow once, do NOT persist.
{
  const sockPath = path.join(os.tmpdir(), `pi-ensemble-test-broker-${process.pid}-4.sock`);
  const state: MockState = {
    cache: new Map(),
    persistCalls: [],
    promptCalls: [],
    promptResponse: { allowed: true, scope: "once" },
  };
  const broker = startBroker(sockPath, makeDeps(state));
  try {
    const resp = await sendAndReceive(sockPath, {
      type: "permission-request",
      role: "explore",
      toolName: "bash",
      bashCommand: "curl https://example.com",
    });
    assert(resp.allowed === true, "user allow once → allowed=true");
    assert(resp.scope === "once", "scope=once preserved");
    assert(state.persistCalls.length === 0, "no persist when scope=once");
  } finally {
    broker.stop();
  }
}

// 5. Prompt rejection (headless / cancellation) → deny.
{
  const sockPath = path.join(os.tmpdir(), `pi-ensemble-test-broker-${process.pid}-5.sock`);
  const state: MockState = {
    cache: new Map(),
    persistCalls: [],
    promptCalls: [],
    promptResponse: { reject: new Error("headless: no parent UI") },
  };
  const broker = startBroker(sockPath, makeDeps(state));
  try {
    const resp = await sendAndReceive(sockPath, {
      type: "permission-request",
      role: "ops",
      toolName: "bash",
      bashCommand: "docker run something",
    });
    assert(resp.allowed === false, "promptUser rejection → allowed=false");
    assert(
      typeof resp.reason === "string" && resp.reason.includes("headless"),
      "deny reason surfaces the prompt-failure message",
    );
    assert(state.persistCalls.length === 0, "no persist on prompt failure");
  } finally {
    broker.stop();
  }
}

// 6. Malformed request line → deny with reason.
{
  const sockPath = path.join(os.tmpdir(), `pi-ensemble-test-broker-${process.pid}-6.sock`);
  const state: MockState = {
    cache: new Map(),
    persistCalls: [],
    promptCalls: [],
    promptResponse: { allowed: true, scope: "always" },
  };
  const broker = startBroker(sockPath, makeDeps(state));
  try {
    const resp = await sendRaw(sockPath, "not valid json\n");
    assert(resp.allowed === false, "malformed JSON → deny");
    assert(
      typeof resp.reason === "string" && resp.reason.toLowerCase().includes("malformed"),
      "deny reason mentions malformed",
    );
    assert(state.promptCalls.length === 0, "malformed → promptUser not called");
  } finally {
    broker.stop();
  }
}

// 7. Wrong request type → deny with reason.
{
  const sockPath = path.join(os.tmpdir(), `pi-ensemble-test-broker-${process.pid}-7.sock`);
  const state: MockState = {
    cache: new Map(),
    persistCalls: [],
    promptCalls: [],
    promptResponse: { allowed: true, scope: "always" },
  };
  const broker = startBroker(sockPath, makeDeps(state));
  try {
    const resp = await sendRaw(
      sockPath,
      `${JSON.stringify({ type: "not-a-permission-request", role: "ops", toolName: "bash" })}\n`,
    );
    assert(resp.allowed === false, "wrong type → deny");
    assert(
      typeof resp.reason === "string" && resp.reason.includes("invalid request shape"),
      "deny reason flags invalid shape",
    );
  } finally {
    broker.stop();
  }
}

// 8. stop() is idempotent.
{
  const sockPath = path.join(os.tmpdir(), `pi-ensemble-test-broker-${process.pid}-8.sock`);
  const broker = startBroker(sockPath, makeDeps({
    cache: new Map(),
    persistCalls: [],
    promptCalls: [],
    promptResponse: { allowed: false, scope: "once" },
  }));
  broker.stop();
  let threw = false;
  try {
    broker.stop();
  } catch {
    threw = true;
  }
  assert(!threw, "broker.stop() called twice — second call is a safe no-op");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
