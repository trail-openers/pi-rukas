/**
 * test-child-guards-loaded-hooks.ts — the LOADED hook set of the child-guards
 * companion (#926), split out of `test-child-guards-extension.ts` along the seam
 * of one mechanism per file (AGENTS.md §12: split, never compress).
 *
 * `test-child-guards-extension.ts` keeps the structural half (the exact guard
 * set, the argv shape, the pre-spawn preflight); this file drives the hooks the
 * companion actually installs — how many, what they refuse, that a throwing
 * handler fails closed rather than letting a command through, and that the
 * companion's guard HOOKS all stand down under PI_ENSEMBLE_SUBAGENT_MODE=1
 * (where the full pi-rukas extension registers the same guards and a second set
 * would double-run the merge guard's gh/git exec chain). The companion is not
 * hook-only: it is also the single owner of the `forge_read` tool (#2160), which
 * it registers whenever this child can use the tool — a stripped role with a
 * parent-served broker socket — see the tool rows and section 5 below.
 *
 * Env pins go through `withEnv`, which restores exactly what was there
 * (including an absent variable), so nothing leaks into the next test file.
 * The counted cases pin `PIN_CHILD` the way `test-write-fence-hook.ts` does:
 * the companion's hook set is scoped two ways over and above the guards —
 * `PI_ENSEMBLE_ROLE` (the #1113 push ban and the #2140 reviewer bash bound)
 * and `PI_ENSEMBLE_WRITE_ROOT` (the #1655 fence registers its own `tool_call`
 * hook whenever the dispatch set a root) — and a process this test happens to
 * run inside carries all three, which shifts every count and leaves a hook
 * behind under `PI_ENSEMBLE_SUBAGENT_MODE=1`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import childGuards, { failClosedPi } from "../src/child-guards.ts";
import { registerMergeGuard } from "../src/merge-guard.ts";
import { withEnv } from "./lib/env-scope.ts";
import { assert } from "./merge-guard-helpers.ts";
import { type Handler, dispatch, makeFakePi } from "./test-child-guards-helpers.ts";

let exit = 0;
function check(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// Every count below is only stable with the whole role- and fence-scoped set
// cleared: the guards are role-scoped in two places and the fence registers on
// the write root alone, so an ambient developer dispatch environment (role and
// root both set, as a /work child's shell has them) adds two hooks to each.
const PIN_CHILD = {
  PI_ENSEMBLE_ROLE: undefined,
  PI_ENSEMBLE_WRITE_ROOT: undefined,
  PI_ENSEMBLE_WRITE_REPO: undefined,
  PI_ENSEMBLE_WRITE_SCRATCH: undefined,
  PI_ENSEMBLE_WRITE_FENCE: undefined,
  // #2160 — the tool's registration is gated on the broker pair the parent
  // hands down (its path AND its per-child secret), so a count is only stable
  // with an ambient pair cleared too.
  PI_ENSEMBLE_FORGE_READ_SOCKET: undefined,
  PI_ENSEMBLE_FORGE_READ_SECRET: undefined,
};

/** The env of a helper child whose parent DID serve a forge-read broker. */
const PIN_FORGE_CHILD = {
  ...PIN_CHILD,
  PI_ENSEMBLE_ROLE: "developer",
  PI_ENSEMBLE_FORGE_READ_SOCKET: "/tmp/pi-rukas-forge-read-test/broker.sock",
  PI_ENSEMBLE_FORGE_READ_SECRET: "0123456789abcdef".repeat(4),
};

// ============================================================
// 1. Loading with no SUBAGENT_MODE: the mode-independent guards, the one
//    tool, no commands.
// ============================================================
await withEnv(PIN_CHILD, async () => {
  const fake = makeFakePi();
  childGuards(fake as unknown as ExtensionAPI);
  const n = fake.handlers.tool_call?.length ?? 0;
  check(
    n === 8,
    `registers exactly 8 tool_call hooks (the mode-independent guards incl. #1105 review-accept, #1113 developer-push, #1666 vipune-write, #1788 public-hygiene and #2140 reviewer-bash-timeout, oo-rewrite excluded; got ${n})`,
  );
  // A child with no broker socket gets no tool at all — the tool's registration
  // and its activation share one predicate, so the always-refuses state is not
  // reachable (section 5 pairs the two halves).
  check(
    fake.registeredTools.length === 0,
    `registers no tool without a parent broker socket (got ${JSON.stringify(fake.registeredTools)})`,
  );
  check(fake.registeredCommands.length === 0, "registers no commands");
});

// ============================================================
// 2. The loaded hooks refuse the merge (no ledger → gh pr view fails →
//    refused) and issue creation, and leave a read alone.
// ============================================================
await withEnv(PIN_CHILD, async () => {
  const fake = makeFakePi();
  childGuards(fake as unknown as ExtensionAPI);
  const merge = await dispatch(fake, "bash", "gh pr merge 5 --squash");
  const m = merge as { block?: boolean; reason?: string } | undefined;
  check(m?.block === true, "loaded hooks refuse `gh pr merge 5 --squash` (no ledger → refused)");
  check(
    m && m.reason !== undefined && m.reason.length > 0,
    "the merge refusal carries a reason (fail-closed message)",
  );

  const issue = await dispatch(fake, "bash", "gh issue create -t x");
  const i = issue as { block?: boolean } | undefined;
  check(i?.block === true, "loaded hooks refuse `gh issue create -t x`");

  const view = await dispatch(fake, "bash", "gh pr view 5");
  check(view === undefined, "loaded hooks ignore `gh pr view 5` (a read stays open)");
});

// ============================================================
// 2a. Fail-closed wrapper (#926 fix round): a guard whose tool_call handler
//     THROWS must never let a command through — Pi's emitToolCall has no
//     per-handler try/catch, so the companion wraps the guard pi with
//     failClosedPi and a thrown handler becomes a { block: true, reason }
//     refusal, not an aborted turn.
// ============================================================
await withEnv(PIN_CHILD, async () => {
  const makeWrapped = (behaviour: "throw" | "block" | "inert") => {
    const handlers: Handler[] = [];
    const spyPi = {
      on(event: string, fn: Handler) {
        if (event === "tool_call") handlers.push(fn);
      },
    } as unknown as ExtensionAPI;
    const underlying: Handler = () => {
      if (behaviour === "throw") throw new Error("boom");
      if (behaviour === "block") return { block: true, reason: "inner" };
      return undefined;
    };
    failClosedPi(spyPi).on("tool_call", underlying);
    return handlers;
  };

  const throwing = makeWrapped("throw");
  const results = await Promise.all(throwing.map((h) => h("x", {})));
  check(
    results.length === 1 &&
      (results[0] as { block?: boolean })?.block === true &&
      /boom/.test((results[0] as { reason?: string })?.reason ?? ""),
    "fail-closed: a throwing guard → block with the reason naming the error, never a rethrow",
  );

  const blocking = makeWrapped("block");
  const rBlock = await Promise.all(blocking.map((h) => h("x", {})));
  check(
    rBlock.length === 1 && (rBlock[0] as { block?: boolean })?.block === true,
    "fail-closed: a well-behaved guard's refusal passes through unchanged",
  );

  const inert = makeWrapped("inert");
  const rInert = await Promise.all(inert.map((h) => h("x", {})));
  check(
    rInert.every((res) => res === undefined),
    "fail-closed: a no-op handler still returns undefined (the wrapper only converts thrown errors)",
  );
});

// ============================================================
// 2b. The merge refusal through the GUARD'S OWN EXEC SEAM (stubbed): no
//     ledger → gh pr view fails → refused. Same hook body the companion
//     registers, driven offline as test-merge-guard.ts drives it.
// ============================================================
{
  const stubExec = async (cmd: string): Promise<{ stdout: string }> => {
    if (cmd.includes("gh pr view")) throw new Error("gh: no pull requests found (stub: no ledger)");
    return { stdout: "" };
  };
  const fake = makeFakePi();
  registerMergeGuard(fake as unknown as ExtensionAPI, { execFn: stubExec as never });
  const merge = await dispatch(fake, "bash", "gh pr merge 5 --squash");
  const m = merge as { block?: boolean; reason?: string } | undefined;
  check(m?.block === true, "merge guard (stubbed exec, no ledger) refuses a merge");
  check(
    m?.reason !== undefined && m.reason.length > 0,
    "the stubbed-exec refusal is fail-closed with a named reason",
  );
}

// ============================================================
// 3. Destructive git: the refused-example from the destructive guard's own
//    test, reached through the companion's hook set.
// ============================================================
await withEnv(PIN_CHILD, async () => {
  const fake = makeFakePi();
  childGuards(fake as unknown as ExtensionAPI);
  const r = await dispatch(fake, "bash", "git reset --hard");
  check((r as { block?: boolean })?.block === true, "loaded hooks refuse `git reset --hard`");
  const ok = await dispatch(fake, "bash", "git status --porcelain");
  check(ok === undefined, "loaded hooks allow `git status --porcelain` (a read stays open)");
});

// ============================================================
// 4. NO-OP: PI_ENSEMBLE_SUBAGENT_MODE=1 → zero guard hooks registered. The
//    tool is NOT part of the no-op: a strict child loads both this companion
//    and the forwarded extension, and Pi de-duplicates `forge_read` by name, so
//    registering it here too costs nothing and keeps the trust-mode child (no
//    forwarded extension at all) from being the only child without the tool.
// ============================================================
await withEnv(
  { ...PIN_FORGE_CHILD, PI_ENSEMBLE_SUBAGENT_MODE: "1" },
  async () => {
    const fake = makeFakePi();
    childGuards(fake as unknown as ExtensionAPI);
    const n = fake.handlers.tool_call?.length ?? 0;
    check(
      n === 0,
      `no-op under PI_ENSEMBLE_SUBAGENT_MODE=1: zero hooks registered (got ${n})`,
    );
    check(
      fake.registeredTools.length === 1 && fake.registeredTools[0] === "forge_read",
      `no-op still registers forge_read and nothing else (got ${JSON.stringify(fake.registeredTools)})`,
    );
    check(
      fake.registeredCommands.length === 0,
      "no-op registers no commands (the guard no-op is not a tool/command no-op)",
    );
  },
);

// ============================================================
// 5. #2160 — the tool's REGISTRATION and its ACTIVATION are one predicate.
//    A child that gets the tool can always reach a broker; a child that cannot
//    is never offered it. Ops is the negative arm: it keeps its own login, so
//    the spawn never gives it a socket and the companion never registers the
//    tool (agents.json does not grant it either).
// ============================================================
await withEnv(PIN_FORGE_CHILD, async () => {
  const fake = makeFakePi();
  childGuards(fake as unknown as ExtensionAPI);
  check(
    fake.registeredTools.length === 1 && fake.registeredTools[0] === "forge_read",
    `a stripped child with a broker socket registers exactly one tool, forge_read (got ${JSON.stringify(fake.registeredTools)})`,
  );
});
await withEnv({ ...PIN_FORGE_CHILD, PI_ENSEMBLE_ROLE: "ops" }, async () => {
  const fake = makeFakePi();
  childGuards(fake as unknown as ExtensionAPI);
  // Even handed a socket by a caller that should not have, ops — the role that
  // keeps its login — is not given the proxy.
  check(
    fake.registeredTools.length === 0,
    `ops registers no forge_read even with a socket present (got ${JSON.stringify(fake.registeredTools)})`,
  );
});
await withEnv({ ...PIN_CHILD, PI_ENSEMBLE_ROLE: "developer" }, async () => {
  const fake = makeFakePi();
  childGuards(fake as unknown as ExtensionAPI);
  check(
    fake.registeredTools.length === 0,
    `a stripped child whose bind FAILED registers no forge_read (got ${JSON.stringify(fake.registeredTools)})`,
  );
});
// #2160 adversarial round 1 — HALF a pair is no pair. A child handed the socket
// but not the key has nothing to authenticate whoever answers with, so its every
// call would be a refusal: registration refuses, exactly as it does for a child
// with no broker at all. The converse (a key and no path) is the same case.
await withEnv(
  { ...PIN_FORGE_CHILD, PI_ENSEMBLE_FORGE_READ_SECRET: undefined },
  async () => {
    const fake = makeFakePi();
    childGuards(fake as unknown as ExtensionAPI);
    check(
      fake.registeredTools.length === 0,
      `a socket without its secret registers no forge_read (got ${JSON.stringify(fake.registeredTools)})`,
    );
  },
);
await withEnv(
  { ...PIN_FORGE_CHILD, PI_ENSEMBLE_FORGE_READ_SOCKET: undefined },
  async () => {
    const fake = makeFakePi();
    childGuards(fake as unknown as ExtensionAPI);
    check(
      fake.registeredTools.length === 0,
      `a secret without its socket registers no forge_read (got ${JSON.stringify(fake.registeredTools)})`,
    );
  },
);

if (exit === 0) console.log("✓ all loaded-hook assertions passed");
process.exit(exit);
