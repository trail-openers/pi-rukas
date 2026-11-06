#!/usr/bin/env bun
/**
 * AC1 — `claude auth logout` / `claude auth login` are refused by a
 * mode-independent child guard, for EVERY role, in trust, sandbox and strict
 * modes, and the refusal names the remedy.
 *
 * Driven through the real entry point a child actually loads: the
 * `child-guards.ts` companion, which is the only guard surface a trust-mode
 * child gets (#926). `registerModeIndependentGuards` runs ahead of every
 * trust/sandbox bypass there, so a guard added to that block is visible in all
 * three modes; nothing that lives behind them is.
 *
 * The new guard is reached by dynamic import: an absent module is itself the
 * failure this file reports, not a load error.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import childGuards from "../src/child-guards.ts";
import { resetPublicHygieneRegistrationForTests } from "../src/public-hygiene-guard.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

const FILE = "test-AC1-claude-auth-guard-blocks.ts";
const realExit = process.exit;

const GUARD_MODULE = "../src/claude-auth-guard.ts";

const OPT_OUT = "PI_ENSEMBLE_ALLOW_CLAUDE_AUTH";

/** The three modes a child runs in: the two defaults and the strict opt-in. */
const MODES: Array<[string, Record<string, string | undefined>]> = [
  ["trust", { PI_ENSEMBLE_TRUST_MODE: "1", PI_ENSEMBLE_SANDBOX_MODE: undefined }],
  ["sandbox", { PI_ENSEMBLE_SANDBOX_MODE: "1", PI_ENSEMBLE_TRUST_MODE: undefined }],
  ["strict", { PI_ENSEMBLE_TRUST_MODE: undefined, PI_ENSEMBLE_SANDBOX_MODE: undefined }],
];

const ROLES = [
  "developer",
  "ops",
  "explore",
  "adversarial-developer",
  "code-review-specialist",
] as const;

/** Env every block pins: no opt-out, no unrelated guard noise. */
const PINNED: Record<string, string | undefined> = {
  [OPT_OUT]: undefined,
  PI_ENSEMBLE_SUBAGENT_MODE: undefined,
  PI_ENSEMBLE_WRITE_ROOT: undefined,
  PI_ENSEMBLE_PUBLIC_DENYLIST: "/nonexistent/pi-rukas-ac1-denylist",
};

function fakePi() {
  const handlers: Array<(e: unknown, c: unknown) => unknown> = [];
  const pi = {
    on(event: string, fn: (e: unknown, c: unknown) => unknown) {
      if (event === "tool_call") handlers.push(fn);
    },
  };
  return { pi: pi as unknown as ExtensionAPI, handlers };
}

/** Load the companion the way spawn does, with the child's env, and fire one bash call. */
async function refuse(command: string, env: Record<string, string | undefined>) {
  const all = { ...PINNED, ...env };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(all)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    resetPublicHygieneRegistrationForTests();
    const { pi, handlers } = fakePi();
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

const guard = await import(GUARD_MODULE).catch(() => undefined);
assert(
  guard !== undefined && typeof guard.registerClaudeAuthGuard === "function",
  `${FILE}: ${GUARD_MODULE} exports registerClaudeAuthGuard (the mode-independent hook)`,
);

for (const [mode, modeEnv] of MODES) {
  for (const role of ROLES) {
    for (const verb of ["logout", "login"]) {
      const command = `claude auth ${verb}`;
      const refusal = await refuse(command, { PI_ENSEMBLE_ROLE: role, ...modeEnv });
      assert(
        refusal?.block === true,
        `${FILE}: ${mode}/${role} refuses \`${command}\` (got ${refusal ? "block" : "no refusal"})`,
      );
      const reason = refusal?.reason ?? "";
      // Actionable, not just "no": it names the read-only command to run instead.
      assert(
        /claude auth status/.test(reason),
        `${FILE}: the refusal for \`${command}\` (${mode}/${role}) names the remedy \`claude auth status\``,
      );
      assert(
        reason.includes(OPT_OUT),
        `${FILE}: the refusal for \`${command}\` (${mode}/${role}) names the operator's opt-out`,
      );
    }
  }
}

// One refusal, so a guard that only reads the visible argv still passes AC1 and
// AC2 and fails here; the wrapped forms are AC2's job.
for (const command of ["claude --version", "claude auth status", "npm test"]) {
  const refusal = await refuse(command, {
    PI_ENSEMBLE_ROLE: "developer",
    PI_ENSEMBLE_TRUST_MODE: "1",
  });
  assert(
    refusal === undefined,
    `${FILE}: trust/developer leaves \`${command}\` alone (got ${refusal ? String(refusal.reason).slice(0, 60) : "no refusal"})`,
  );
}

process.exit = realExit;
console.log(`exit ${exit}`);
realExit(exit);
