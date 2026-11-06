#!/usr/bin/env bun
/**
 * AC4 — the operator's opt-out is one variable, honoured at registration, and
 * recorded in both inventories.
 *
 * `PI_ENSEMBLE_ALLOW_CLAUDE_AUTH=1` registers NO hook (the shape every other
 * mode-independent guard uses: `developerPushAllowed()` / `unreviewedMergeAllowed()`
 * return before `pi.on`, so the hook is inert for the whole session rather than
 * re-checking the env per call). The variable then has to appear in
 * `docs/configuration.md` and in `HEADLESS_INPUTS`, which is the machine-readable
 * list `--capabilities` prints and the contract `test-headless-inputs.ts` enforces:
 * a name `src/` reads but the list omits is an input a host can never set safely.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import childGuards from "../src/child-guards.ts";
import { HEADLESS_INPUTS } from "../src/headless/inputs.ts";
import { resetPublicHygieneRegistrationForTests } from "../src/public-hygiene-guard.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

const FILE = "test-AC4-claude-auth-opt-out.ts";
const realExit = process.exit;

const OPT_OUT = "PI_ENSEMBLE_ALLOW_CLAUDE_AUTH";
const SRC = path.resolve(import.meta.dirname, "..", "src");
const CONFIG = path.resolve(import.meta.dirname, "..", "..", "docs", "configuration.md");

/** Load the companion with `extra` applied to the env and report the hook count. */
async function load(extra: Record<string, string | undefined>) {
  const env: Record<string, string | undefined> = {
    PI_ENSEMBLE_ROLE: "developer",
    PI_ENSEMBLE_TRUST_MODE: "1",
    PI_ENSEMBLE_SANDBOX_MODE: undefined,
    PI_ENSEMBLE_SUBAGENT_MODE: undefined,
    PI_ENSEMBLE_WRITE_ROOT: undefined,
    PI_ENSEMBLE_PUBLIC_DENYLIST: "/nonexistent/pi-rukas-ac4-denylist",
    ...extra,
  };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    resetPublicHygieneRegistrationForTests();
    const handlers: Array<(e: unknown, c: unknown) => unknown> = [];
    const pi = {
      on: (event: string, fn: (e: unknown, c: unknown) => unknown) => {
        if (event === "tool_call") handlers.push(fn);
      },
    } as unknown as ExtensionAPI;
    childGuards(pi);
    const results = await Promise.all(
      handlers.map((h) =>
        h({ toolName: "bash", input: { command: "claude auth logout" } }, {}),
      ),
    );
    return results.find((r) => (r as { block?: boolean })?.block === true);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const guarded = await load({ [OPT_OUT]: undefined });
assert(
  (guarded as { block?: boolean })?.block === true,
  `${FILE}: with the opt-out unset, \`claude auth logout\` is refused (the guard is live)`,
);

const optedOut = await load({ [OPT_OUT]: "1" });
assert(
  optedOut === undefined,
  `${FILE}: ${OPT_OUT}=1 registers no hook — \`claude auth logout\` runs (got ${optedOut ? "block" : "no refusal"})`,
);

const entry = HEADLESS_INPUTS.find((e) => e.name === OPT_OUT);
assert(
  entry !== undefined,
  `${FILE}: ${OPT_OUT} has a HEADLESS_INPUTS entry (--capabilities must list it)`,
);
if (entry) {
  assert(
    entry.type === "boolean" && entry.default === false,
    `${FILE}: ${OPT_OUT} is a boolean defaulting to off (got type=${entry.type} default=${String(entry.default)})`,
  );
}

const doc = readFileSync(CONFIG, "utf8");
const row = doc.split("\n").find((l) => l.startsWith(`| \`${OPT_OUT}\` |`));
assert(row !== undefined, `${FILE}: docs/configuration.md has a \`| \`${OPT_OUT}\` |\` row`);
if (row) {
  assert(
    /\b1\b/.test(row) && /claude/i.test(row),
    `${FILE}: the configuration.md row says what setting it to 1 permits`,
  );
}

const guardFiles = ["claude-auth-guard.ts", "claude-auth-command.ts", "subagent-guard-guards.ts"];
const mentions = guardFiles.filter((f) => {
  try {
    return readFileSync(path.join(SRC, f), "utf8").includes(OPT_OUT);
  } catch {
    return false;
  }
});
assert(
  mentions.length > 0,
  `${FILE}: a file under extension/src reads ${OPT_OUT} by name (the docs and capabilities rows must be projections of a real read)`,
);

process.exit = realExit;
console.log(`exit ${exit}`);
realExit(exit);
