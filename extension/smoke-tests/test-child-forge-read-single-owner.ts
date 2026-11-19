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
 * The fix is structural, not a runtime stand-down: the companion registers the
 * tool and the forwarded extension registers NOTHING — `registerSubagentGuard`
 * does not call the registration, and `registerSubagentGuard` itself is reachable
 * only under `PI_ENSEMBLE_SUBAGENT_MODE=1` (index.ts and permission-guard.ts both
 * gate it on that variable). The rows here, in the order the child loads:
 *   1. strict/headless shape — both entry points into ONE fake API under
 *      `PI_ENSEMBLE_SUBAGENT_MODE=1`: exactly one `forge_read`;
 *   2. trust shape — the companion alone (the interactive default, which loads no
 *      full extension): still exactly one `forge_read`;
 *   3. that one registration IS the broker-backed child tool — proved against a
 *      real listener, so "one registration" cannot be satisfied by some other
 *      tool wearing the name (this is the ONLY row that counts the fixture's
 *      received requests — the other rows count what the collector recorded, and
 *      a fixture receiving two signed requests would mean two registrations
 *      reached the wire);
 *   4. the no-login arms: no broker pair, or the role that keeps its login, and
 *      neither entry point registers the tool.
 *
 * The gate is observed RED as well as green (§5): `lib/forge-read-duplicate-
 * mutant.ts` restores the pre-#2382 owner argument and the same counting rule must
 * then land on 2 in the strict arm while the trust arm stays at 1. A gate that has
 * never been run in a failing state is bloat, so that pair is the exit criterion.
 *
 * Env is pinned for every case (`withEnv`): registration reads the role and the
 * broker pair out of `process.env`, and the process running this suite may carry
 * all three from the dispatch that spawned it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import childGuards from "../src/child-guards.ts";
import { registerSubagentGuard } from "../src/permission-subagent-guard.ts";
import { assert, exit } from "./lib/assert-rig.ts";
import { withEnv } from "./lib/env-scope.ts";
import { forgeNames, makeForgeCollector } from "./lib/forge-read-collector.ts";
import {
  assertMutantIsPreFixShape,
  duplicateCompanionEntry,
  duplicateSubagentGuardEntry,
} from "./lib/forge-read-duplicate-mutant.ts";

/**
 * The broker pair this run binds, fixed BEFORE any socket is created.
 *
 * Every case below pins both variables — to this fixture pair, or to `undefined`
 * for the arms that must get no tool — so a `PI_ENSEMBLE_FORGE_READ_SOCKET` /
 * `_SECRET` inherited from whatever dispatched this test can never name the
 * socket a case dials: the pair is pinned before `startBroker` binds, and only a
 * listener holding this run's fixture secret can produce a reply the child
 * believes.
 */
const FIXTURE_DIR = mkdtempSync(join(tmpdir(), "pi-rukas-forge-read-"));
const FIXTURE_SOCKET = join(FIXTURE_DIR, `broker-${process.pid}.sock`);
const FIXTURE_SECRET = "0123456789abcdef".repeat(4);

/** A helper child whose parent served a broker: the fixture pair AND a non-ops role. */
const FORGE_CHILD = {
  PI_ENSEMBLE_ROLE: "developer",
  PI_ENSEMBLE_FORGE_READ_SOCKET: FIXTURE_SOCKET,
  PI_ENSEMBLE_FORGE_READ_SECRET: FIXTURE_SECRET,
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

/**
 * A listener on `socketPath` answering like the parent's broker. The child's
 * tool signs its request with the per-child secret and refuses an unsigned
 * reply, so this is a real round trip — a case that only counted registrations
 * could not tell the broker tool from a stub.
 */
async function startBroker(socketPath: string): Promise<{ stop(): void; received: string[] }> {
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
      const mac = forgeReadMac(FIXTURE_SECRET, replyNonce, JSON.stringify(body));
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

/**
 * Load `entries` into one fresh fake API and return the tools they registered.
 * The shipped run and the mutant both go through here, so neither can be judged
 * by a collector the other does not use. `withEnv` returns no value, so the tools
 * are collected by the body rather than returned through it.
 */
async function loadEntries(
  entries: Array<(pi: ExtensionAPI) => void>,
  env: Record<string, string | undefined>,
): Promise<Array<{ name: string; execute: (id: string, raw: unknown) => Promise<unknown> }>> {
  const registered: Array<{
    name: string;
    execute: (id: string, raw: unknown) => Promise<unknown>;
  }> = [];
  await withEnv({ ...FORGE_CHILD, ...env }, async () => {
    const { pi, tools } = makeForgeCollector();
    for (const entry of entries) entry(pi);
    registered.push(...tools);
  });
  return registered;
}

const STRICT = { ...FORGE_CHILD, PI_ENSEMBLE_SUBAGENT_MODE: "1" };

// ── 1. The strict/headless shape: BOTH entry points, ONE forge_read. ────────
// The argv order of `buildChildArgs`: the full extension is forwarded, then the
// companion is appended (the order is irrelevant to the contract — Pi reports a
// conflict whichever way round the two load — but this is the real one).
{
  const tools = await loadEntries([registerSubagentGuard, childGuards], STRICT);
  assert(
    forgeNames(tools) === 1,
    `strict/headless child: the full extension + the companion register forge_read exactly once (got ${forgeNames(tools)}, all tools: ${JSON.stringify(tools.map((t) => t.name))})`,
  );
}

// ── 2. The trust shape: the companion ALONE still registers it once. ────────
// The interactive default: no full extension is forwarded, so the companion is
// the child's only entry point — the child `forge_read` exists for.
{
  const tools = await loadEntries([childGuards], FORGE_CHILD);
  assert(
    forgeNames(tools) === 1,
    `trust child (companion alone): exactly one forge_read (got ${forgeNames(tools)})`,
  );
}

// ── 3. That one registration IS the broker-backed child tool. ───────────────
// A single registration is not enough: it must be the tool that talks to the
// parent's socket, not an extension-side one that would read with a login the
// child does not have. Both halves of the pair are pinned before the bind, so an
// inherited pair cannot name the socket the child dials, and a reply the child
// believes can only have come from the listener holding this run's fixture secret.
{
  const broker = await startBroker(FIXTURE_SOCKET);
  try {
    // Registered and called inside ONE `withEnv`, so the env that decided the
    // registration is the env the tool dials from — a count taken in one env and
    // a call made in another would let the call fall through to whatever pair the
    // process happened to inherit.
    let dialled: string | undefined;
    let dialledCount = -1;
    await withEnv(STRICT, async () => {
      const { pi, tools } = makeForgeCollector();
      registerSubagentGuard(pi);
      childGuards(pi);
      dialledCount = forgeNames(tools);
      dialled = await callTool(tools, { verb: "issue_view", number: 2382 });
    });
    assert(
      dialledCount === 1,
      `strict/headless child: exactly one registration inside the case that dials the fixture (got ${dialledCount})`,
    );
    assert(
      broker.received.length === 1,
      `strict/headless child: the one registration put one signed request on the fixture socket (got ${broker.received.length})`,
    );
    assert(
      dialled?.includes("FORGE_READ_OK issue=2382") && broker.received.length === 1,
      `strict/headless child: the one forge_read IS the broker tool — its handler put one signed request on the fixture socket and returned the broker's bytes (text ${JSON.stringify(dialled?.slice(0, 60))}, requests ${broker.received.length})`,
    );
  } finally {
    broker.stop();
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
  }
}

// ── 4. The no-login arms: the registered-but-always-refuses tool stays unreachable. ──
{
  const tools = await loadEntries([registerSubagentGuard, childGuards], {
    ...STRICT,
    PI_ENSEMBLE_FORGE_READ_SOCKET: undefined,
    PI_ENSEMBLE_FORGE_READ_SECRET: undefined,
  });
  assert(
    forgeNames(tools) === 0,
    `strict/headless child with no broker pair registers no forge_read (got ${forgeNames(tools)})`,
  );
}
{
  const tools = await loadEntries([registerSubagentGuard, childGuards], {
    ...STRICT,
    PI_ENSEMBLE_ROLE: "ops",
  });
  assert(
    forgeNames(tools) === 0,
    `ops keeps its own login, so neither entry point registers forge_read (got ${forgeNames(tools)})`,
  );
}

// ── 5. The gate observed RED: the duplicate-tool mutant. ────────────────────
// A gate never run in a failing state proves nothing, so the same counting rule
// judges the pre-#2382 shape: the strict arm MUST land on 2 (that red row is what
// shows the count bites) and the trust arm MUST stay at 1, because the companion
// alone is unaffected by what the forwarded extension does.
{
  const drift = await assertMutantIsPreFixShape();
  assert(drift.ok, `mutant still reproduces the pre-#2382 shape (drift: ${drift.missing})`);

  const mutantStrict = await loadEntries(
    [duplicateSubagentGuardEntry, duplicateCompanionEntry],
    STRICT,
  );
  const strictCount = forgeNames(mutantStrict);
  assert(
    strictCount === 2,
    `MUTANT (expected red): the duplicate-tool mutant registers forge_read twice in the strict shape (got ${strictCount})`,
  );
  const mutantTrust = await loadEntries([duplicateCompanionEntry], FORGE_CHILD);
  assert(
    forgeNames(mutantTrust) === 1,
    `MUTANT trust shape: the companion alone still registers once (got ${forgeNames(mutantTrust)})`,
  );
}

if (exit === 0) console.log("✓ all forge_read single-owner assertions passed");
process.exit(exit);
