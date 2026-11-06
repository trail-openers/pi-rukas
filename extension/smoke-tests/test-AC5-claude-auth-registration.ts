#!/usr/bin/env bun
/**
 * AC5 — the auth guard is registered exactly once, in the shared mode-independent
 * block (`registerModeIndependentGuards`, subagent-guard-guards.ts), and the two
 * canaries that define "what a child loads" are updated with it.
 *
 * That block is the single list both child entry points call — the trust-mode
 * companion (`child-guards.ts`) and the strict/headless path. The canaries are
 * what make the block auditable, and both go stale silently when a guard is
 * added: `test-child-guards-loaded-hooks.ts` pins the companion's exact hook
 * COUNT, `test-child-guards-extension.ts` pins the expected NAME set and refuses
 * any registration outside it.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import childGuards from "../src/child-guards.ts";
import { resetPublicHygieneRegistrationForTests } from "../src/public-hygiene-guard.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

const FILE = "test-AC5-claude-auth-registration.ts";
const realExit = process.exit;

const SRC = path.resolve(import.meta.dirname, "..", "src");
const TESTS = path.resolve(import.meta.dirname);
const read = (dir: string, f: string) => readFileSync(path.join(dir, f), "utf8");

/**
 * Assembled, not written as one literal: this file's own source must not match
 * the shape it asks of `src/`, or the canary is satisfied by stating it.
 */
const NAME = `register${"ClaudeAuth"}Guard`;
const CALL = new RegExp(`${NAME}\\s*\\(\\s*pi\\b`);

/** Companion env: no write-fence hook, no opt-out, no subagent-mode no-op. */
const CHILD_ENV: Record<string, string | undefined> = {
  PI_ENSEMBLE_ROLE: "developer",
  PI_ENSEMBLE_TRUST_MODE: "1",
  PI_ENSEMBLE_SANDBOX_MODE: undefined,
  PI_ENSEMBLE_SUBAGENT_MODE: undefined,
  PI_ENSEMBLE_WRITE_ROOT: undefined,
  PI_ENSEMBLE_WRITE_FENCE: "0",
  PI_ENSEMBLE_ALLOW_CLAUDE_AUTH: undefined,
  PI_ENSEMBLE_PUBLIC_DENYLIST: "/nonexistent/pi-rukas-ac5-denylist",
};

async function withChildEnv<T>(body: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(CHILD_ENV)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await body();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Lazy: a missing guard module is a red this file reports, not a load error. */
async function blockFn() {
  return (await import("../src/subagent-guard-guards.ts")).registerModeIndependentGuards;
}

function countHooks(register: (pi: ExtensionAPI) => void) {
  const handlers: Array<(e: unknown, c: unknown) => unknown> = [];
  const pi = {
    on: (event: string, fn: (e: unknown, c: unknown) => unknown) => {
      if (event === "tool_call") handlers.push(fn);
    },
  } as unknown as ExtensionAPI;
  register(pi);
  return handlers.length;
}

// ── 1. In the block, once, and nowhere else.
const block = read(SRC, "subagent-guard-guards.ts");
const calls = block.match(new RegExp(CALL.source, "g")) ?? [];
assert(
  calls.length === 1,
  `${FILE}: the shared block calls ${NAME}(pi) exactly once (got ${calls.length})`,
);
assert(
  block.indexOf("export function registerModeIndependentGuards") <
    block.search(new RegExp(CALL.source)),
  `${FILE}: the call is inside registerModeIndependentGuards — the block both child entry points load`,
);
for (const [file, why] of [
  ["child-guards.ts", "the block is the companion's single list"],
  ["parent-guards.ts", "a second site would run the scan twice per command"],
] as const) {
  assert(
    !CALL.test(read(SRC, file)),
    `${FILE}: ${file} does NOT register it directly — ${why}`,
  );
}

// ── 2. One hook per registration, in the set a child actually loads.
const counts = await withChildEnv(async () => {
  const block = await blockFn();
  resetPublicHygieneRegistrationForTests();
  const first = countHooks(block);
  const second = countHooks(block);
  resetPublicHygieneRegistrationForTests();
  return { first, second, companion: countHooks(childGuards) };
});
// Today: 7 hooks (6 guards + the review-accept hook issue-creation registers).
// The auth guard is the 8th, in the block AND in the companion it feeds.
assert(
  counts.first === 8,
  `${FILE}: registerModeIndependentGuards installs 8 tool_call hooks (got ${counts.first})`,
);
assert(
  counts.companion === 8,
  `${FILE}: the companion a trust-mode child loads installs 8 tool_call hooks (got ${counts.companion})`,
);
assert(
  counts.second <= counts.first,
  `${FILE}: a second block call adds no duplicate hook (first ${counts.first}, repeat ${counts.second}) — the new guard is idempotent per process, like the hygiene guard`,
);

// ── 3. The two canaries were updated, or they stop meaning anything.
const loaded = read(TESTS, "test-child-guards-loaded-hooks.ts");
const pinned = [...loaded.matchAll(/n === (\d+)/g)].map((m) => Number(m[1]));
assert(
  pinned.includes(8),
  `${FILE}: test-child-guards-loaded-hooks.ts must pin the companion's hook count at 8; it pins ${pinned.join("/") || "nothing"}`,
);
const structural = read(TESTS, "test-child-guards-extension.ts");
assert(
  structural.includes(`"${NAME}"`),
  `${FILE}: test-child-guards-extension.ts lists "${NAME}" in its expected set (its strays check refuses a block member it does not know)`,
);

process.exit = realExit;
console.log(`exit ${exit}`);
realExit(exit);
