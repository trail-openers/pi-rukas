#!/usr/bin/env bun
/**
 * #1167 round 3 — the bounds and the validation the adversarial lens raised
 * against the round-2 unfence, each pinned by the case that reproduced it.
 *
 * A. **Unvalidated paths.** The issue body is untrusted prose, and every token
 *    its decision sections yielded entered `ws.paths` with no shape check. An
 *    absolute path, a `..` traversal, a glob or a metacharacter token is a
 *    scope the develop gate and the consolidation checks cannot verify — the
 *    same reason #1005 rejects such a path when the PLANNER writes it. The
 *    planner was validated; the issue was not.
 *
 * B. **Unbounded git fan-out.** Every identifier the issue named cost a serial
 *    `git grep` plus a `git show` per candidate, with no bound and no
 *    short-circuit. A 76-identifier issue body was 76+ subprocess spawns inside
 *    the plan step. Now: no fences → no I/O at all; a name no fence could carry
 *    → no grep; and a cap on what is resolved, with the remainder reported.
 *
 * C. **`git grep` exit 1 vs a real failure.** "No match" and "git broke" both
 *    resolved to an empty list, so a corrupt repository read as "this symbol is
 *    defined nowhere" and the pass declared the plan clean.
 *
 * D. **Shallow copy.** `{ ...ws }` shared the caller's own `paths` /
 *    `outOfScope` arrays, so the pass mutated the plan it was handed.
 */

import { planUnfenceEnabled, runPlanUnfencePass } from "../src/work-driver-plan-coupling-pass.ts";
import { type UnfenceExecFn, isGitGrepNoMatch } from "../src/work-driver-plan-unfence-git.ts";
import { unfenceIssueNamedPaths, unfenceSummary } from "../src/work-driver-plan-unfence.ts";
import type { Workstream } from "../src/workflow-state-schema.ts";
import { initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const WS = (id: string, paths: string[], outOfScope: string[]): Workstream => ({
  id,
  scope: id,
  paths,
  outOfScope,
});

/** A stub that records every argv it was called with. */
function recorder(definitions: Record<string, string[]> = {}, calls: string[][] = []) {
  const execFn: UnfenceExecFn = async (_cmd, opts) => {
    const argv = opts?.argv ?? [];
    calls.push(argv);
    if (argv[0] === "grep") {
      const name = argv[4] ?? "";
      return { stdout: (definitions[name] ?? []).map((f) => `${f}\n`).join("") };
    }
    if (argv[0] === "show") {
      const file = (argv[1] ?? "").split(":")[1] ?? "";
      const defining = Object.entries(definitions).find(([, files]) => files.includes(file))?.[0];
      return {
        stdout: defining
          ? `export function ${defining}(opts: unknown) {\n  return 1;\n}\n`
          : "//\n",
      };
    }
    return { stdout: "" };
  };
  return { execFn, calls };
}

// ------------------------------------- A: unvalidated paths never unfence or land

{
  const body = [
    "## Resolved decisions",
    "- The fix lives in /etc/passwd and ../secret.ts.",
    "- Also src/*.ts and src/evil.ts;rm -rf and src/`whoami`.ts.",
    "- And $(git rev-parse HEAD)/x.ts plus src/ok.ts.",
  ].join("\n");
  const plan = {
    default: WS(
      "default",
      ["src/a.ts"],
      ["/etc/passwd", "../secret.ts", "src/*.ts", "src/evil.ts", "src/ok.ts"],
    ),
  };
  const { execFn, calls } = recorder();
  const r = await unfenceIssueNamedPaths(plan, body, {
    execFn,
    repoRoot: "/repo",
    ref: "origin/main",
    defaultToSingle: true,
  });
  assert(
    !r.workstreams.default.paths.includes("/etc/passwd") &&
      !r.workstreams.default.paths.includes("../secret.ts"),
    "an absolute or ..-traversing token from the issue never enters ws.paths",
  );
  assert(
    !r.workstreams.default.paths.some(
      (p) => p.includes("*") || p.includes(";") || p.includes("$") || p.includes("`"),
    ),
    "no glob, metacharacter or command-substitution token is placed anywhere",
  );
  // `/etc/passwd`, `../secret.ts` and `src/*.ts` are rejected outright: they are
  // not paths the driver can verify, so no fence they name may be lifted.
  for (const keep of ["/etc/passwd", "../secret.ts", "src/*.ts"]) {
    assert(
      r.workstreams.default.outOfScope.includes(keep),
      `the fence on ${keep} survives — an unverifiable token cannot lift it`,
    );
  }
  // `src/evil.ts;rm` is the interesting case: the raw token is rejected, but the
  // extractor also splits it on `;` and the clean half IS a plain path the issue
  // named, so that fence goes. What must never happen — and what the assertions
  // either side of this one pin — is the raw token (`;` and all) reaching
  // `ws.paths` or a `git grep` argv.
  assert(
    !r.workstreams.default.paths.some((p) => p.includes(";")),
    "the raw metacharacter token itself is never placed, even though its clean half is",
  );
  assert(
    !r.workstreams.default.outOfScope.includes("src/ok.ts") &&
      r.workstreams.default.paths.includes("src/ok.ts"),
    "the one plain repo-relative path in the same list is still unfenced and placed (validation is a filter, not a veto)",
  );
  assert(
    r.warnings.some((w) => w.includes("/etc/passwd")),
    "the rejected token is reported, not dropped in silence",
  );
  assert(
    calls.filter((a) => a[0] === "grep").every((a) => !/[*;$`\\]|^\/|\.\./.test(a[4] ?? "")),
    "no rejected path token is ever handed to git grep as a search term",
  );
}

// ------------------------------- B1: no fences anywhere → no git process at all

{
  const body = "## Decisions\n- dispatchCore gains a host parameter and src/a.ts changes.";
  const { execFn, calls } = recorder({ dispatchCore: ["extension/src/dispatch.ts"] });
  const r = await unfenceIssueNamedPaths(
    { "task-a": WS("task-a", ["src/a.ts"], []), "task-b": WS("task-b", ["src/b.ts"], []) },
    body,
    { execFn, repoRoot: "/repo", ref: "origin/main" },
  );
  assert(
    calls.length === 0,
    "nothing fenced → zero git invocations (short-circuit before any I/O)",
  );
  assert(r.removed.length === 0 && r.notes.length === 0, "and the pass reports nothing, honestly");
}

// ---------------- B2: the identifier cap is real, bounded, and reports its remainder

{
  // 30 identifiers that all relate to a fence basename: the cap must stop at 15
  // and name what it skipped, so a pass that declined is distinguishable from a
  // pass that found nothing.
  const names = Array.from({ length: 30 }, (_, i) => `fenceSymbol${i}`);
  const body = `## Decisions\n- ${names.join(", ")} all change.`;
  const fences = names.map((n) => `src/${n}.ts`);
  const { execFn, calls } = recorder(Object.fromEntries(names.map((n) => [n, [`src/${n}.ts`]])));
  const r = await unfenceIssueNamedPaths(
    { default: WS("default", ["src/seed.ts"], fences) },
    body,
    { execFn, repoRoot: "/repo", ref: "origin/main", defaultToSingle: true },
  );
  const greps = calls.filter((a) => a[0] === "grep").length;
  assert(greps === 15, `at most 15 identifiers are grepped per pass (got ${greps})`);
  assert(
    r.warnings.some((w) => w.startsWith("identifier cap:") && w.includes("not resolved")),
    "the skipped remainder is recorded as a warning rather than dropped",
  );
}

// ---------------- B3: the bound is the cap, not a guess about where a name lives

{
  // Every identifier is grepped, up to the cap. The tempting optimisation —
  // "only grep names whose fence looks similar" — is not taken, because a
  // symbol's file is not derivable from its name (`dispatchCore` in
  // `dispatch.ts`, `parseReport` in `reportConsumer.ts`) and a name the filter
  // drops yields "we did not ask", which the plan cannot tell apart from "the
  // issue named no fence". What IS bounded: nothing is grepped at all when no
  // fence exists, and no more than the cap is grepped when it does.
  const names = Array.from({ length: 12 }, (_, i) => `zzzName${i}`);
  const body = `## Decisions\n- ${names.join(", ")} appear in prose.`;
  const { execFn, calls } = recorder();
  const r = await unfenceIssueNamedPaths(
    { default: WS("default", ["src/a.ts"], ["docs/", "src/other.ts"]) },
    body,
    { execFn, repoRoot: "/repo", ref: "origin/main", defaultToSingle: true },
  );
  const grepped = calls.filter((a) => a[0] === "grep").map((a) => a[4] ?? "");
  assert(
    names.every((n) => grepped.includes(n)),
    `prose names ARE grepped rather than silently skipped (${grepped.length}/${names.length})`,
  );
  assert(
    names.every((n) => r.warnings.some((w) => w.includes(`unresolved identifier ${n}:`))),
    "and every one is accounted for as unresolved — none vanished without a trace",
  );
}

// -------------------------- C: git grep exit-1-no-match vs a genuine git failure

{
  const body = "## Decisions\n- dispatchCore gains a host.";
  const plan = { default: WS("default", ["src/a.ts"], ["extension/src/dispatch.ts"]) };

  // The real executor's no-match shape: it THROWS with code 1 and empty stdout.
  const noMatch: UnfenceExecFn = async () => {
    throw Object.assign(new Error("Command failed: git grep ..."), { code: 1, stdout: "" });
  };
  const r1 = await unfenceIssueNamedPaths(plan, body, {
    execFn: noMatch,
    repoRoot: "/repo",
    ref: "origin/main",
    defaultToSingle: true,
  });
  assert(
    r1.workstreams.default.outOfScope.includes("extension/src/dispatch.ts"),
    "no match → the name is unresolved → the fence stays",
  );
  assert(
    r1.warnings.some((w) => w.startsWith("unresolved identifier dispatchCore:")),
    "a genuine no-match is reported as unresolved, which is the honest answer",
  );

  // A broken repository: exit 128 with stderr. Must NOT read as "defined nowhere".
  const broken: UnfenceExecFn = async () => {
    throw Object.assign(new Error("Command failed: git grep ...\nfatal: not a git repository"), {
      code: 128,
      stdout: "",
    });
  };
  const r2 = await unfenceIssueNamedPaths(plan, body, {
    execFn: broken,
    repoRoot: "/repo",
    ref: "origin/main",
    defaultToSingle: true,
  });
  assert(
    r2.workstreams.default.outOfScope.includes("extension/src/dispatch.ts"),
    "a git FAILURE keeps every fence (fail closed, same as no match — but for a different reason)",
  );
  assert(
    r2.warnings.some((w) => !w.startsWith("unresolved identifier ")),
    "the failure is reported as a warning, not as the 'unresolved identifier' answer a clean no-match earns",
  );

  // A bare `throw new Error("git grep exited 1")` — prose claiming exit 1 with
  // no code and no stdout field — is NOT evidence of emptiness.
  assert(
    isGitGrepNoMatch({ message: "git grep exited 1" }) === false,
    "a thrown error with no code and no stdout field is NOT treated as exit-1-no-match",
  );
  assert(
    isGitGrepNoMatch(Object.assign(new Error("x"), { code: 1, stdout: "" })) === true,
    "exit 1 with empty stdout IS git grep's no-match",
  );
  assert(
    isGitGrepNoMatch(Object.assign(new Error("x"), { code: 1, stdout: "src/a.ts\n" })) === false,
    "exit 1 that carried output is a failure, not a match list",
  );
  assert(
    isGitGrepNoMatch(Object.assign(new Error("killed"), { code: 1 })) === false,
    "a killed process is never read as 'no match'",
  );
}

// ------------------------------------------------- D: the input plan is not mutated

{
  const body = "## Decisions\n- dispatchCore lives in extension/src/dispatch.ts and gains a host.";
  // The removal has to land on the workstream that OWNS the path: the #572
  // cross-declaration contract has every OTHER workstream fence it, and only
  // the owner's own fence is the self-contradiction this pass removes.
  const plan = {
    "task-a": WS("task-a", ["src/a.ts"], ["docs/"]),
    "task-b": WS(
      "task-b",
      ["extension/src/dispatch.ts"],
      ["src/a.ts", "extension/src/dispatch.ts"],
    ),
  };
  const beforeA = JSON.stringify(plan["task-a"]);
  const beforeB = JSON.stringify(plan["task-b"]);
  const { execFn } = recorder({ dispatchCore: ["extension/src/dispatch.ts"] });
  const r = await unfenceIssueNamedPaths(plan, body, {
    execFn,
    repoRoot: "/repo",
    ref: "origin/main",
  });
  assert(
    JSON.stringify(plan["task-a"]) === beforeA && JSON.stringify(plan["task-b"]) === beforeB,
    "the caller's plan map is byte-identical after the pass (deep copy, not a shallow one)",
  );
  assert(
    r.workstreams["task-b"].paths !== plan["task-b"].paths &&
      r.workstreams["task-b"].outOfScope !== plan["task-b"].outOfScope,
    "the returned arrays are new objects, not the caller's own array references",
  );
  assert(
    !r.workstreams["task-b"].outOfScope.includes("extension/src/dispatch.ts") &&
      r.workstreams["task-b"].outOfScope.includes("src/a.ts"),
    "the repair itself still happened on the copy, and only to the entry the issue named",
  );
  assert(
    r.workstreams["task-a"].outOfScope.includes("docs/"),
    "the sibling workstream keeps the fences it alone wrote",
  );
}

// ------------------------- the rollback drops the note that described the removal

{
  const body = "## Decisions\n- dispatchCore changes.";
  const { execFn } = recorder({ dispatchCore: ["extension/src/dispatch.ts"] });
  const r = await unfenceIssueNamedPaths(
    {
      "task-a": WS("task-a", ["src/a.ts"], ["extension/src/dispatch.ts"]),
      "task-b": WS("task-b", ["docs/b.md"], []),
    },
    body,
    { execFn, repoRoot: "/repo", ref: "origin/main" },
  );
  assert(
    !r.notes.includes("unfenced extension/src/dispatch.ts: named by the issue"),
    "a rolled-back removal does not leave its `unfenced …` note behind (the plan would say two opposite things)",
  );
  assert(
    r.warnings.some((w) => w.includes("left fenced for placement")),
    "and the operator is told why the fence is still there",
  );
}

// -------------------------------------------------- the summary the operator sees

{
  const body = "## Decisions\n- dispatchCore changes.";
  const { execFn } = recorder({ dispatchCore: ["extension/src/dispatch.ts"] });
  const r = await unfenceIssueNamedPaths(
    {
      default: WS(
        "default",
        ["extension/src/app.ts"],
        ["extension/src/", "extension/src/dispatch.ts"],
      ),
    },
    body,
    { execFn, repoRoot: "/repo", ref: "origin/main", defaultToSingle: true },
  );
  const summary = unfenceSummary(r);
  assert(summary.ran === true && summary.removed === 1, "the summary counts the fence that went");
  assert(
    summary.kept === 0,
    "no kept-fence count when the file fence was removed outright (the directory entry was never consulted)",
  );
  assert(
    summary.rolledBack === 0,
    "nothing was rolled back — the sole workstream could own the path",
  );
  // `unresolved` counts names that genuinely had no definition in the stub, and
  // one is expected here: the sentence's ordinary English (`changes`) is
  // resolved like any symbol, because nothing can tell it apart from one. What
  // must be true is that the symbol that DID resolve is not among them.
  assert(
    !summary.warnings?.some((w) => w.includes("unresolved identifier dispatchCore:")),
    `the symbol that owns a fence is never reported unresolved (warnings: ${summary.warnings?.join(" | ") ?? "none"})`,
  );
  assert(summary.unresolved === 1, "and exactly the one prose name is counted, no more");
  assert(
    Array.isArray(summary.notes) && summary.notes.length > 0,
    "the notes ride along so the operator can read what happened, not just how many",
  );
  const unreadable = unfenceSummary(r, true);
  assert(unreadable.issueBodyUnreadable === true, "an unreadable issue body is a field of its own");
  assert(unfenceSummary(r).issueBodyUnreadable === undefined, "and absent when the body read fine");

  // A pass that removes nothing but DECLINES must still be legible: the issue
  // named one file, a broader directory fence covers it, and the fence stays.
  // A pass that removes nothing but DECLINES must still be legible. The issue
  // names `reportRunner`; its file is `extension/src/report-runner.ts`, which
  // the exact-match rule never removes a `reportRunner.ts` fence for — and a
  // broader directory fence covers the real file. The fence stays, and `kept=1`
  // is what distinguishes that from a pass that saw nothing at all.
  const declined = await unfenceIssueNamedPaths(
    { default: WS("default", ["src/app.ts"], ["extension/src/reportRunner.ts", "extension/src/"]) },
    "## Decisions\n- reportRunner gains a host parameter.",
    {
      execFn: recorder({ reportRunner: ["extension/src/report-runner.ts"] }).execFn,
      repoRoot: "/repo",
      ref: "origin/main",
      defaultToSingle: true,
    },
  );
  const declinedSummary = unfenceSummary(declined);
  assert(
    declinedSummary.removed === 0 && declinedSummary.kept === 1,
    `a declined unfence reads as kept=1, not as the all-zero record of a pass that saw nothing (kept=${declinedSummary.kept}, removed=${declinedSummary.removed})`,
  );
  assert(
    declined.workstreams.default.outOfScope.includes("extension/src/"),
    "and the directory fence the issue never spoke to is exactly where it was",
  );
}

// ------------------------------------------- the escape hatch leaves the plan alone

{
  const saved = process.env.PI_ENSEMBLE_PLAN_UNFENCE;
  try {
    assert(planUnfenceEnabled() === true, "the unfence is on by default");
    process.env.PI_ENSEMBLE_PLAN_UNFENCE = "0";
    assert(planUnfenceEnabled() === false, "PI_ENSEMBLE_PLAN_UNFENCE=0 turns it off");
    const body = "## Decisions\n- dispatchCore changes.";
    const plan = { default: WS("default", ["src/a.ts"], ["extension/src/dispatch.ts"]) };
    const { execFn, calls } = recorder({ dispatchCore: ["extension/src/dispatch.ts"] });
    const state = {
      ...initialState(1167, 1_000_000),
      pipelineState: {
        ...initialState(1167, 1_000_000).pipelineState,
        issueBodyArtifact: undefined,
      },
    };
    const out = await runPlanUnfencePass(plan, state, { repoRoot: "/repo", execFn });
    assert(out.workstreams === plan, "disabled: the pass hands the caller's map straight back");
    assert(out.summary === undefined, "and records no summary (there was no pass to summarise)");
    assert(calls.length === 0, "and no git process ran");
    assert(
      out.workstreams.default.outOfScope.includes("extension/src/dispatch.ts"),
      "the fence the issue contradicts is exactly where the planner left it",
    );
  } finally {
    if (saved === undefined) delete process.env.PI_ENSEMBLE_PLAN_UNFENCE;
    else process.env.PI_ENSEMBLE_PLAN_UNFENCE = saved;
  }
  assert(planUnfenceEnabled() === true, "the knob is restored for later suites");
}

console.log(exit === 0 ? "\nAll plan-unfence round-3 assertions passed." : "\nFAILURES above.");
process.exit(exit);
