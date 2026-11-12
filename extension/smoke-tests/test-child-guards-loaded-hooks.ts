/**
 * test-child-guards-loaded-hooks.ts — the LOADED hook set of the child-guards
 * companion (#926), split out of `test-child-guards-extension.ts` along the seam
 * of one mechanism per file (AGENTS.md §12: split, never compress).
 *
 * `test-child-guards-extension.ts` keeps the structural half (the exact guard
 * set, the argv shape, the pre-spawn preflight); this file drives the hooks the
 * companion actually installs — how many, what they refuse, that a throwing
 * handler fails closed rather than letting a command through, and that the
 * companion no-ops entirely under PI_ENSEMBLE_SUBAGENT_MODE=1 (where the full
 * pi-rukas extension registers the same guards and a second set would
 * double-run the merge guard's gh/git exec chain).
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
 *
 * The two hooks that survive the subagent-mode no-op are the #1655 write fence
 * and the #2200 deletion rule: the full pi-rukas extension never registers
 * either, so for a strict/headless child this companion is their only
 * registration site, and a second one would double-refuse. The counted set is
 * therefore the eight mode-independent guards plus those two, and the no-op
 * count is exactly those two — pinned so a guard that moved above or below the
 * no-op shows up here rather than as a silent shift.
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
};

// ============================================================
// 1. Loading with no SUBAGENT_MODE: the mode-independent guards, no tools,
//    no commands.
// ============================================================
await withEnv(PIN_CHILD, async () => {
  const fake = makeFakePi();
  childGuards(fake as unknown as ExtensionAPI);
  const n = fake.handlers.tool_call?.length ?? 0;
  check(
    n === 9,
    `registers exactly 9 tool_call hooks (the mode-independent guards incl. #1105 review-accept, #1113 developer-push, #1666 vipune-write, #1788 public-hygiene and #2140 reviewer-bash-timeout, plus the #1655 write fence and the #2200 deletion rule; oo-rewrite excluded; got ${n})`,
  );
  check(fake.registeredTools.length === 0, "registers no tools (hook-only companion)");
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
// 4. NO-OP: PI_ENSEMBLE_SUBAGENT_MODE=1 → only the two hooks the full pi-rukas
//    extension does not register survive (the #1655 fence and the #2200 deletion
//    rule); the mode-independent guards must not be installed a second time.
// ============================================================
await withEnv({ ...PIN_CHILD, PI_ENSEMBLE_SUBAGENT_MODE: "1" }, async () => {
  const fake = makeFakePi();
  childGuards(fake as unknown as ExtensionAPI);
  const n = fake.handlers.tool_call?.length ?? 0;
  // The #2200 deletion rule always registers; the #1655 fence registers only when
  // the dispatch set a root, which `PIN_CHILD` clears. One hook is the honest count
  // for an unfenced child, and zero would mean the deletion rule had gone missing.
  check(
    n === 1,
    `no-op under PI_ENSEMBLE_SUBAGENT_MODE=1: only the #2200 deletion rule survives (the guards no-op, the fence has no root here; got ${n})`,
  );
  check(
    fake.registeredTools.length === 0 && fake.registeredCommands.length === 0,
    "no-op registers nothing else",
  );
});

if (exit === 0) console.log("✓ all loaded-hook assertions passed");
process.exit(exit);
