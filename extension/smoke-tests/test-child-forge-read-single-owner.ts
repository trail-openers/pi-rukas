#!/usr/bin/env bun
/**
 * test-child-forge-read-single-owner.ts — `forge_read` has ONE owner per child
 * process (#2382).
 *
 * The defect: Pi 1.5.2's `detectExtensionConflicts` turns a tool name that two
 * loaded extensions each registered into a load-time ERROR (`Tool "forge_read"
 * conflicts with <repo>/extension`), and main.js exits 1 on any extension-load
 * error. A strict/headless child loads BOTH the full pi-rukas extension and the
 * child-guards companion, and BOTH called `registerChildForgeReadTool`, so every
 * strict/headless child died before its session attached. The comment at both
 * registration sites claimed Pi de-duplicates the name; Pi 1.4.0 tolerated the
 * duplicate, 1.5.2 does not, and nothing tested the claim.
 *
 * The contract this pins, in the order the child actually loads:
 *   1. strict/headless shape — both entry points into ONE fake API under
 *      `PI_ENSEMBLE_SUBAGENT_MODE=1`: exactly one `forge_read`, and it is the
 *      broker-backed child tool (its handler dials `PI_ENSEMBLE_FORGE_READ_SOCKET`
 *      — proved against a real listener, so "one registration" can never be
 *      satisfied by some other tool wearing the name);
 *   2. trust shape — the companion alone (the interactive default, which loads
 *      no full extension): still exactly one `forge_read`;
 *   3. the no-login arms: a child with no broker pair gets no `forge_read` from
 *      either shape, so the registered-but-always-refuses tool stays unreachable.
 *
 * Env is pinned for every case (`withEnv`): registration reads the role and the
 * broker pair out of `process.env`, and the process running this suite may carry
 * all three from the dispatch that spawned it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createServer } from "node:net";
import childGuards from "../src/child-guards.ts";
import { registerSubagentGuard } from "../src/permission-subagent-guard.ts";
import { withEnv } from "./lib/env-scope.ts";
import { assert, exit } from "./lib/assert-rig.ts";

/** A helper child whose parent served a broker: the pair AND a non-ops role. */
const FORGE_CHILD = {
  PI_ENSEMBLE_ROLE: "developer",
  PI_ENSEMBLE_FORGE_READ_SOCKET: "/tmp/pi-rukas-2382-unused.sock",
  PI_ENSEMBLE_FORGE_READ_SECRET: "0123456789abcdef".repeat(4),
  PI_ENSEMBLE_SUBAGENT_MODE: undefined,
  PI_ENSEMBLE_SANDBOX_MODE: undefined,
  PI_ENSEMBLE_TRUST_MODE: undefined,
  PI_ENSEMBLE_CHILD_CODEMODE: undefined,
  PI_ENSEMBLE_WRITE_ROOT: undefined,
  PI_ENSEMBLE_WRITE_REPO: undefined,
  PI_ENSEMBLE_WRITE_SCRATCH: undefined,
  PI_ENSEMBLE_WRITE_FENCE: undefined,
  PI_ENSEMBLE_CHILD_TMP: undefined,
};

/** One fake ExtensionAPI collecting every registration the two entry points make. */
function makeCollector() {
  const handlers: Record<string, Array<(e: unknown, c: unknown) => unknown>> = {};
  const tools: Array<{ name: string; execute: (id: string, raw: unknown) => Promise<unknown> }> =
    [];
  const pi = {
    on: (name: string, fn: (e: unknown, c: unknown) => unknown) => {
      (handlers[name] ??= []).push(fn);
    },
    getActiveTools: () => ["read", "bash"],
    setActiveTools: () => undefined,
    registerTool: (t: { name: string; execute: (id: string, raw: unknown) => Promise<unknown> }) => {
      tools.push({ name: t.name, execute: t.execute });
    },
    registerCommand: () => undefined,
    registerProvider: () => undefined,
    registerFlag: () => undefined,
  };
  return { pi: pi as unknown as ExtensionAPI, tools, handlers };
}

/**
 * A listener on `socketPath` answering like the parent's broker. The child's
 * tool signs its request with the per-child secret and refuses an unsigned
 * reply, so this is a real round trip — a case that only counted registrations
 * could not tell the broker tool from a stub.
 */
async function startBroker(socketPath: string): Promise<{ stop(): void; received: string[] }> {
  const secret = FORGE_CHILD.PI_ENSEMBLE_FORGE_READ_SECRET;
  const received: string[] = [];
  const { forgeReadMac, newForgeReadNonce } = await import("../src/forge-read-auth.ts");
  const server = createServer((conn) => {
    let buf = "";
    conn.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      received.push(buf.slice(0, nl));
      const req = JSON.parse(buf.slice(0, nl)) as { nonce?: string };
      const echo = String(req.nonce ?? "");
      const replyNonce = newForgeReadNonce();
      const body: Record<string, unknown> = {
        type: "forge-read-response",
        ok: true,
        // Plain text, not JSON: `output` crosses the socket as a string, so a
        // needle with quotes in it would be compared against escaped bytes.
        output: "FORGE_READ_OK issue=2382",
        nonce: replyNonce,
        echo,
      };
      const mac = forgeReadMac(secret, replyNonce, JSON.stringify(body));
      conn.write(`${JSON.stringify({ ...body, mac })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  return {
    received,
    stop: () => {
      try {
        server.close();
      } catch {
        /* already closed */
      }
    },
  };
}

/** Call the named tool the way the model would; returns its text, or undefined. */
async function callTool(
  tools: Array<{ name: string; execute: (id: string, raw: unknown) => Promise<unknown> }>,
  args: Record<string, unknown>,
): Promise<string | undefined> {
  const tool = tools.find((t) => t.name === "forge_read");
  if (!tool) return undefined;
  const res = (await tool.execute("call-1", args)) as {
    content?: Array<{ type: string; text?: string }>;
  };
  return (res.content ?? []).map((c) => c.text ?? "").join("");
}

const forgeNames = (tools: Array<{ name: string }>) =>
  tools.filter((t) => t.name === "forge_read").length;

// ── 1. The strict/headless shape: BOTH entry points, ONE forge_read. ────────
// The argv order of `buildChildArgs`: the full extension is forwarded, then the
// companion is appended (the order is irrelevant to the contract — Pi reports a
// conflict whichever way round the two load — but this is the real one).
await withEnv({ ...FORGE_CHILD, PI_ENSEMBLE_SUBAGENT_MODE: "1" }, async () => {
  const { pi, tools } = makeCollector();
  registerSubagentGuard(pi);
  childGuards(pi);
  assert(
    forgeNames(tools) === 1,
    `strict/headless child: the full extension + the companion register forge_read exactly once (got ${forgeNames(tools)}, all tools: ${JSON.stringify(tools.map((t) => t.name))})`,
  );
});

// ── 1b. That one registration IS the broker-backed child tool. ──────────────
// A single registration is not enough: it must be the tool that talks to the
// parent's socket, not an extension-side one that would read with a login the
// child does not have.
{
  const socketPath = `/tmp/pi-rukas-dev-2382/broker-${process.pid}.sock`;
  const broker = await startBroker(socketPath);
  try {
    await withEnv({ ...FORGE_CHILD, PI_ENSEMBLE_SUBAGENT_MODE: "1", PI_ENSEMBLE_FORGE_READ_SOCKET: socketPath }, async () => {
      const { pi, tools } = makeCollector();
      registerSubagentGuard(pi);
      childGuards(pi);
      const text = await callTool(tools, { verb: "issue_view", number: 2382 });
      const brokerSawBytes =
        text !== undefined &&
        broker.received.length === 1 &&
        text.includes("FORGE_READ_OK issue=2382");
      assert(
        brokerSawBytes,
        `strict/headless child: the one forge_read IS the broker tool — its handler put one signed request on the socket and returned the broker's bytes (text ${JSON.stringify(text)}, requests ${broker.received.length})`,
      );
      assert(
        broker.received.length === 1,
        `strict/headless child: exactly one registration means exactly one signed request on the wire (got ${broker.received.length})`,
      );
    });
  } finally {
    broker.stop();
  }
}

// ── 2. The trust shape: the companion ALONE still registers it once. ────────
// The interactive default: no full extension is forwarded, so the companion is
// the child's only entry point — the child `forge_read` exists for.
await withEnv({ ...FORGE_CHILD }, async () => {
  const { pi, tools } = makeCollector();
  childGuards(pi);
  assert(
    forgeNames(tools) === 1,
    `trust child (companion alone): exactly one forge_read (got ${forgeNames(tools)})`,
  );
});

// ── 3. No broker pair → no tool, in either shape. ───────────────────────────
// The registered-but-always-refuses state stays unreachable now that only one
// site owns the registration: the predicate still answers it.
await withEnv({ ...FORGE_CHILD, PI_ENSEMBLE_FORGE_READ_SOCKET: undefined }, async () => {
  const { pi, tools } = makeCollector();
  registerSubagentGuard(pi);
  childGuards(pi);
  assert(
    forgeNames(tools) === 0,
    `strict/headless child with no broker socket registers no forge_read (got ${forgeNames(tools)})`,
  );
});
await withEnv({ ...FORGE_CHILD, PI_ENSEMBLE_ROLE: "ops" }, async () => {
  const { pi, tools } = makeCollector();
  registerSubagentGuard(pi);
  childGuards(pi);
  assert(
    forgeNames(tools) === 0,
    `ops keeps its own login, so neither entry point registers forge_read (got ${forgeNames(tools)})`,
  );
});

if (exit === 0) console.log("✓ all forge_read single-owner assertions passed");
process.exit(exit);
