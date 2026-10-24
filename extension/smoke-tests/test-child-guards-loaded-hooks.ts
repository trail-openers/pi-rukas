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
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { default as childGuards, failClosedPi } from "../src/child-guards.ts";
import { registerMergeGuard } from "../src/merge-guard.ts";
import { assert } from "./merge-guard-helpers.ts";
import { type Handler, dispatch, makeFakePi } from "./test-child-guards-helpers.ts";

// ============================================================
// 1. Loading with no SUBAGENT_MODE: the mode-independent guards, no tools,
//    no commands.
// ============================================================
{
  const fake = makeFakePi();
  childGuards(fake as unknown as ExtensionAPI);
  const n = fake.handlers.tool_call?.length ?? 0;
  assert(
    n === 7,
    `registers exactly 7 tool_call hooks (the mode-independent guards incl. #1105 review-accept, #1113 developer-push, #1666 vipune-write and #1788 public-hygiene, oo-rewrite excluded; got ${n})`,
  );
  assert(fake.registeredTools.length === 0, "registers no tools (hook-only companion)");
  assert(fake.registeredCommands.length === 0, "registers no commands");
}

// ============================================================
// 2. The loaded hooks refuse the merge (no ledger, real exec → gh fails
//    → refused) and issue creation, and leave a read alone.
// ============================================================
{
  const fake = makeFakePi();
  childGuards(fake as unknown as ExtensionAPI);
  const merge = await dispatch(fake, "bash", "gh pr merge 5 --squash");
  const m = merge as { block?: boolean; reason?: string } | undefined;
  assert(m?.block === true, "loaded hooks refuse `gh pr merge 5 --squash` (no ledger → refused)");
  assert(
    m && m.reason !== undefined && m.reason.length > 0,
    "the merge refusal carries a reason (fail-closed message)",
  );

  const issue = await dispatch(fake, "bash", "gh issue create -t x");
  const i = issue as { block?: boolean } | undefined;
  assert(i?.block === true, "loaded hooks refuse `gh issue create -t x`");

  const view = await dispatch(fake, "bash", "gh pr view 5");
  assert(view === undefined, "loaded hooks ignore `gh pr view 5` (a read stays open)");
}

// ============================================================
// 2a. Fail-closed wrapper (#926 fix round): a guard whose tool_call handler
//     THROWS must never let a command through — Pi's emitToolCall has no
//     per-handler try/catch, so the companion wraps the guard pi with
//     failClosedPi and a thrown handler becomes a { block: true, reason }
//     refusal, not an aborted turn.
// ============================================================
{
  // Drive the wrapper directly: pass a throwing/blocking/inert handler through
  // failClosedPi and verify the wrapped handler's behaviour.
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
    const wrapped = failClosedPi(spyPi);
    wrapped.on("tool_call", underlying);
    return handlers;
  };

  // A throwing handler → block with the reason naming the error.
  const throwing = makeWrapped("throw");
  const results = await Promise.all(throwing.map((h) => h("x", {})));
  assert(
    results.length === 1 &&
      (results[0] as { block?: boolean })?.block === true &&
      /boom/.test((results[0] as { reason?: string })?.reason ?? ""),
    "fail-closed: a throwing guard → block with the reason naming the error, never a rethrow",
  );

  // A well-behaved block passes through unchanged.
  const blocking = makeWrapped("block");
  const rBlock = await Promise.all(blocking.map((h) => h("x", {})));
  assert(
    rBlock.length === 1 && (rBlock[0] as { block?: boolean })?.block === true,
    "fail-closed: a well-behaved guard's refusal passes through unchanged",
  );

  // Inert: a no-op handler still returns undefined.
  const inert = makeWrapped("inert");
  const rInert = await Promise.all(inert.map((h) => h("x", {})));
  assert(
    rInert.every((res) => res === undefined),
    "fail-closed: a no-op handler still returns undefined (the wrapper only converts thrown errors)",
  );
}

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
  assert(
    m?.block === true,
    "merge guard (stubbed exec, no ledger) refuses `gh pr merge 5 --squash`",
  );
  assert(
    m?.reason !== undefined && m.reason.length > 0,
    "the stubbed-exec refusal is fail-closed with a named reason",
  );
}

// ============================================================
// 3. Destructive git: the refused-example from the destructive guard's own
//    test, reached through the companion's hook set.
// ============================================================
{
  const fake = makeFakePi();
  childGuards(fake as unknown as ExtensionAPI);
  const r = await dispatch(fake, "bash", "git reset --hard");
  assert((r as { block?: boolean })?.block === true, "loaded hooks refuse `git reset --hard`");
  const ok = await dispatch(fake, "bash", "git status --porcelain");
  assert(ok === undefined, "loaded hooks allow `git status --porcelain` (a read stays open)");
}

// ============================================================
// 4. NO-OP: PI_ENSEMBLE_SUBAGENT_MODE=1 → zero hooks registered (the full
//    pi-rukas extension registers the guards there; a second set would
//    double-run the merge guard's gh/git exec chain).
// ============================================================
{
  process.env.PI_ENSEMBLE_SUBAGENT_MODE = "1";
  const fake = makeFakePi();
  childGuards(fake as unknown as ExtensionAPI);
  const n = fake.handlers.tool_call?.length ?? 0;
  assert(n === 0, `no-op under PI_ENSEMBLE_SUBAGENT_MODE=1: zero hooks registered (got ${n})`);
  assert(
    fake.registeredTools.length === 0 && fake.registeredCommands.length === 0,
    "no-op registers nothing else",
  );
  process.env.PI_ENSEMBLE_SUBAGENT_MODE = undefined;
}
