#!/usr/bin/env bun
/**
 * AC2 — a wrapped `claude auth logout` / `claude auth login` is refused exactly
 * as the bare one is: behind `bash -c`, `env`, `timeout`, `sudo`, inside
 * `$( … )`, and after a `;` or `&&` chain.
 *
 * Same entry point as AC1 (the `child-guards.ts` companion), so the assertion
 * is about the guard's command reading, not about its placement. Each shape is
 * one the harness's other guards already see through — `bash-command-parser.ts`
 * strips the same wrapper set for the destructive-git matcher — so a refusal
 * that only reads word 0 fails here and nowhere else.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import childGuards from "../src/child-guards.ts";
import { resetPublicHygieneRegistrationForTests } from "../src/public-hygiene-guard.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

const FILE = "test-AC2-claude-auth-wrapped-forms.ts";
const realExit = process.exit;

const OPT_OUT = "PI_ENSEMBLE_ALLOW_CLAUDE_AUTH";

/** One shape per wrapper the criterion names, plus the chains. */
const REFUSED: Array<[string, string]> = [
  ["bash -c", `bash -c "claude auth logout"`],
  ["sh -c single-quoted", `sh -c 'claude auth login'`],
  ["env wrapper", `env FOO=1 claude auth logout`],
  ["timeout wrapper", `timeout 30 claude auth login`],
  ["sudo wrapper", `sudo claude auth logout`],
  ["command substitution", `echo $(claude auth logout)`],
  ["semicolon chain", `git status; claude auth logout`],
  ["&& chain", `true && claude auth login`],
];

const ALLOWED: Array<[string, string]> = [
  ["read-only auth status", "claude auth status"],
  ["version flag", "claude --version"],
];

async function refuse(command: string) {
  const saved: Record<string, string | undefined> = {};
  const env: Record<string, string | undefined> = {
    PI_ENSEMBLE_ROLE: "developer",
    PI_ENSEMBLE_TRUST_MODE: "1",
    PI_ENSEMBLE_SANDBOX_MODE: undefined,
    PI_ENSEMBLE_SUBAGENT_MODE: undefined,
    PI_ENSEMBLE_WRITE_ROOT: undefined,
    [OPT_OUT]: undefined,
    PI_ENSEMBLE_PUBLIC_DENYLIST: "/nonexistent/pi-rukas-ac2-denylist",
  };
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

for (const [label, command] of REFUSED) {
  const refusal = await refuse(command);
  assert(
    refusal?.block === true,
    `${FILE}: wrapped form refused — ${label}: \`${command}\` (got ${refusal ? "block" : "no refusal"})`,
  );
  assert(
    /claude auth status/.test(refusal?.reason ?? ""),
    `${FILE}: the ${label} refusal names the remedy \`claude auth status\``,
  );
}

for (const [label, command] of ALLOWED) {
  const refusal = await refuse(command);
  assert(
    refusal === undefined,
    `${FILE}: \`${command}\` (${label}) stays allowed (got ${refusal ? String(refusal.reason).slice(0, 60) : "no refusal"})`,
  );
}

process.exit = realExit;
console.log(`exit ${exit}`);
realExit(exit);
