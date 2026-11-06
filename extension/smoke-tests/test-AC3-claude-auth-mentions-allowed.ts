#!/usr/bin/env bun
/**
 * AC3 — the auth guard does not overreach. `claude auth status`,
 * `claude --version`, a `grep` whose PATTERN is the refused command, and a gh
 * issue/PR body that MENTIONS it all still run.
 *
 * The mention cases are where this guard would most plausibly misfire: every
 * other command-matching guard in this harness distinguishes "runs the verb"
 * from "names the verb" (`git-push-command.ts`'s prose rule, the review-accept
 * guard's substring-only reading), and a matcher built on a plain
 * `command.includes("claude auth logout")` passes AC1 and AC2 while failing the
 * last two cases here.
 *
 * The gh body is written to a scratch file and passed with `--body-file`:
 * that is the one publish shape the public-hygiene guard reads without a real
 * `gh` call, so a refusal here can only come from a guard that mis-reads the
 * text.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import childGuards from "../src/child-guards.ts";
import { resetPublicHygieneRegistrationForTests } from "../src/public-hygiene-guard.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

const FILE = "test-AC3-claude-auth-mentions-allowed.ts";
const realExit = process.exit;

const OPT_OUT = "PI_ENSEMBLE_ALLOW_CLAUDE_AUTH";

const dir = mkdtempSync(path.join(tmpdir(), "ac3-claude-auth-"));
const bodyFile = path.join(dir, "body.md");
writeFileSync(
  bodyFile,
  "## Fix\n\nThe docs now explain that `claude auth logout` wipes the token and how to\n" +
    "recover it with `claude auth login`. Neither command is run by this PR.\n",
  "utf8",
);

async function refuse(command: string) {
  const env: Record<string, string | undefined> = {
    PI_ENSEMBLE_ROLE: "developer",
    PI_ENSEMBLE_TRUST_MODE: "1",
    PI_ENSEMBLE_SANDBOX_MODE: undefined,
    PI_ENSEMBLE_SUBAGENT_MODE: undefined,
    PI_ENSEMBLE_WRITE_ROOT: undefined,
    [OPT_OUT]: undefined,
    PI_ENSEMBLE_PUBLIC_DENYLIST: "/nonexistent/pi-rukas-ac3-denylist",
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
      handlers.map((h) => h({ toolName: "bash", input: { command } }, {})),
    );
    return results.find((r) => (r as { block?: boolean })?.block === true) as
      | { block?: boolean; reason?: string }
      | undefined;
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const ALLOWED: Array<[string, string]> = [
  ["the read-only auth command", "claude auth status"],
  ["a plain version query", "claude --version"],
  ["grep whose pattern IS the refused command", 'grep "claude auth logout" notes.md'],
  ["rg whose pattern IS the refused command", "rg 'claude auth login' docs"],
  ["a gh issue body that mentions the command", `gh issue edit 3 --body-file ${bodyFile}`],
  ["a gh PR comment that mentions the command", `gh pr comment 4 --body-file ${bodyFile}`],
];

for (const [label, command] of ALLOWED) {
  const shown = command.includes(bodyFile) ? command.replace(dir, "<tmp>") : command;
  const refusal = await refuse(command);
  assert(
    refusal === undefined,
    `${FILE}: stays allowed — ${label}: \`${shown}\` (got ${refusal ? `block: ${String(refusal.reason).slice(0, 70)}`.replace(dir, "<tmp>") : "no refusal"})`,
  );
}

// The guard is a refusal, not a ban on the `claude` binary: the mutation itself
// must still be refused, or the three cases above pass by the guard being inert.
const stillRefused = await refuse("claude auth logout");
assert(
  stillRefused?.block === true,
  `${FILE}: \`claude auth logout\` IS refused (the allow-list above is not an inert guard)`,
);

rmSync(dir, { recursive: true, force: true });
process.exit = realExit;
console.log(`exit ${exit}`);
realExit(exit);
