#!/usr/bin/env bun
/**
 * #1698 — the fix-pass fence admits (a) a file this cycle already created that
 * a finding names, and (b) the file a driver-dispatched corrective round's own
 * evidence named, while still refusing an unrelated new file, a protected
 * path, and a finding-named file in a non-anchored directory.
 *
 * Two reproductions (#1064): a develop round 1
 * creates a file; the adversarial finding names it; the fix pass edits it to
 * satisfy the finding — and `namedPaths` refused, because the candidate set
 * was the tree tracked AT base and a file the cycle created is never in it.
 * And in the second reproduction the driver dispatched a corrective round whose evidence told
 * the child to change a file, then capped the cycle for changing it, because
 * `headBefore` predates the round and the round's commit landed in the
 * fix-pass stray set.
 *
 * #1760 narrowed (b) to the shape the driver can actually PROVE. A file is
 * admitted through the corrective route only when it clears route (a)'s
 * provenance (tracked at base or committed by the cycle before the pass) and
 * route (a)'s directory anchor, AND it sits in the round's own commit window,
 * AND the round's evidence names it, AND the round's budget is not spent. So
 * every case below plants the corrective file at base, beside a declared path,
 * and the boundedness cases vary exactly one of the five conditions.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type GitRead, defaultExec } from "../src/work-driver-adversarial-fix-git.ts";
import type { PassPlan } from "../src/work-driver-adversarial-fix-scope.ts";
import { planFixPass, postPassFault } from "../src/work-driver-adversarial-fix-scope.ts";
import { pendingFixes, runAdversarialFixPass } from "../src/work-driver-adversarial-fix.ts";
import { parkFixPass } from "../src/work-driver-adversarial-plumb.ts";
import type { CycleContext } from "../src/work-driver-context.ts";
import type { CorrectiveRoundEvent } from "../src/workflow-state-events-corrective.ts";
import type { WorkState } from "../src/workflow-state.ts";
import { devCommit, devOk, fixState, git, repoWithFile } from "./lib/adversarial-fix-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** devCommit for a file in a directory the fixture repo does not have yet. */
function commitNew(dir: string, file: string, body: string): void {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  devCommit(dir, file, body);
}

/**
 * Commit files TRACKED AT BASE — the provenance the corrective route shares
 * with route (a) (#1760). A file the round merely invented is not the cycle's
 * work and the admission refuses it, so an admitted file has to exist before
 * the pass starts, in a directory that also holds a declared path.
 */
function trackAtBase(dir: string, files: Record<string, string>): void {
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), body);
  }
  git(dir, "add -A");
  git(dir, 'commit -q -m "tracked at base"');
}

/** The commit a worktree is at right now — what a corrective record stores. */
const headNow = (dir: string): string => git(dir, "rev-parse HEAD").trim();

/** One `corrective-round` record as the driver writes it, baseline included. */
function round(id: string, lines: string[], headAtRound?: string): CorrectiveRoundEvent {
  return {
    kind: "corrective-round",
    at: 1,
    step: "develop",
    workstreamId: id,
    attempt: 1,
    command: "sh check.sh",
    evidenceLines: lines,
    ...(headAtRound === undefined ? {} : { headAtRound }),
  };
}

/**
 * An early assert for a fence read that must succeed: a failed pre-pass read
 * means the FIXTURE is broken, not the rule under test, so there is nothing
 * left to assert and the case stops here instead of reading a `planned.value`
 * that does not exist.
 */
function must<T>(read: GitRead<T>, label: string): T {
  if (!read.ok) {
    assert(false, `${label}: the read failed (${read.reason})`);
    throw new Error(`${label}: ${read.reason}`);
  }
  return read.value;
}

process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_ADVERSARIAL_EMPTY_SKIP = "0";

async function runPass(dir: string, st: WorkState, onDev: (d: string, call: number) => void) {
  let calls = 0;
  const ctx: CycleContext = {
    host: { sendUserMessage: () => {}, emit: () => {} },
    // A cycle ctx's sink is required; a test records nothing, so a fresh empty
    // watermark is the honest value (it is what `createEmitSink` starts with).
    emitSink: { emit: () => {}, fingerprints: [] },
    repoRoot: dir,
    issue: 1698,
    issueBodyFetcherFn: async () => ({ stdout: "mock" }),
    dispatchFn: async (_pi, spec) => {
      if (spec.role === "developer") {
        calls++;
        onDev(dir, calls);
      }
      return devOk(spec.role);
    },
  };
  const out = await runAdversarialFixPass(ctx, st, pendingFixes(st.eventLog), Date.now());
  const tail = out.eventLog[out.eventLog.length - 1];
  return {
    out,
    applied: tail?.kind === "adversarial-fix-applied",
    parked: tail?.kind === "cap-hit" ? (tail.evidence ?? "") : "",
  };
}

/**
 * The scaffold every 2b case shares: a repo whose declared scope is
 * `a.txt` plus `lib/main.ts` (so `lib/` is an ANCHORED directory and route
 * (a)'s candidate set covers `lib/` files planted at base), planned for one
 * pass. Each case then varies ONE condition of the corrective route.
 */
async function correctiveScaffold(
  label: string,
  atBase: Record<string, string> = {},
): Promise<{ dir: string; st: WorkState; planned: PassPlan[] }> {
  const dir = repoWithFile(label);
  trackAtBase(dir, { "lib/main.ts": "export const m = 1;\n", ...atBase });
  const st = fixState(dir, ["a.txt", "lib/main.ts"], "a.txt: change one to two");
  const planned = must(
    await planFixPass(defaultExec, dir, st.pipelineState, [
      { workstreamId: "default", findings: "a.txt: change one to two" },
    ]),
    label,
  );
  return { dir, st, planned };
}

/** The pass's own declared edit, committed before the round is recorded. */
const passEdit = (dir: string): void => devCommit(dir, "a.txt", "two\n");

const x = (f: string): string => `\u2717 ${f}:12 expected two`;

// 1 — round 1 created pkg/new.ts (a commit after base); a finding names it;
// the fix pass edits it. The pass applies: the cycle-created file is a
// widening candidate because `committedChanges(base..headBefore)` joins the
// tree tracked at base. Before #1698 this parked fix-pass-park.
{
  const dir = repoWithFile("1698-cycle-created");
  try {
    trackAtBase(dir, { "pkg/existing.ts": "export {};\n" });
    // fixState records base at THIS commit; the round-1 commit below is after it.
    const st = fixState(dir, ["pkg/existing.ts"], "pkg/existing.ts: fix; pkg/new.ts: and this");
    devCommit(dir, "pkg/new.ts", "export const n = 1;\n");
    const r = await runPass(dir, st, (d) => devCommit(d, "pkg/new.ts", "export const n = 2;\n"));
    assert(
      r.applied,
      `1: a finding naming a file this cycle created admits the fix-pass edit (got "${r.parked}")`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 2 — a corrective round the driver dispatched INSIDE the fix pass edits the
// file its own evidence named. The cycle does not park: the driver cannot
// order the edit and then cap the cycle for making it. The verify command is
// the #1667 stand-in shape: it fails with a ✗ line naming tools/fixme.ts
// until that file carries the value; the corrective developer (the second
// developer dispatch) writes exactly that. #1760: the file is TRACKED AT BASE
// beside a declared path, because the route keeps route (a)'s provenance and
// anchor — the invented-file refusal is case 2b/G.
{
  const dir = repoWithFile("1698-corrective");
  try {
    writeFileSync(
      path.join(dir, "check.sh"),
      '#!/bin/sh\n# Green at base (a.txt is still "one"); fails only once the fix pass\n# made its declared edit, until the file the verify output names carries it.\nif [ "$(cat a.txt)" = "two" ] && ! grep -q two tools/fixme.ts 2>/dev/null; then\n  echo "FAILED: fixme"\n  echo "\u2717 tools/fixme.ts:57 expected two"\n  exit 1\nfi\nexit 0\n',
    );
    writeFileSync(path.join(dir, ".pi", "verify-cmd"), "sh check.sh\n");
    trackAtBase(dir, { "tools/helper.ts": "one\n", "tools/fixme.ts": "one\n" });
    // tools/helper.ts is declared, so `tools/` is anchored and tools/fixme.ts
    // is the neighbour the round is allowed to repair.
    const st = fixState(dir, ["a.txt", "tools/helper.ts"], "a.txt: change one to two");
    const r = await runPass(dir, st, (d, call) => {
      if (call === 1) devCommit(d, "a.txt", "two\n");
      else devCommit(d, path.join("tools", "fixme.ts"), "two\n");
    });
    assert(
      r.out.eventLog.some((e) => e.kind === "corrective-round"),
      "2: the corrective round actually ran (the fixture exercises the real path)",
    );
    assert(
      r.applied,
      `2: the corrective round's evidence-named file is not a fix-pass stray (got "${r.parked}")`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 2b — the fence-level half of (b) and its bounds. The admitted file clears
// route (a)'s provenance and anchor AND sits in the round's own commit window;
// each case below breaks exactly one of the five conditions.
{
  // A — named by the evidence, tracked at base, anchored, committed AFTER the
  // round's baseline: admitted, and the admission is disclosed.
  const { dir, st, planned } = await correctiveScaffold("1698-corrective-fence", {
    "lib/ordered.ts": "export const o = 1;\n",
  });
  try {
    passEdit(dir);
    const events = [round("default", [x("lib/ordered.ts")], headNow(dir))];
    devCommit(dir, "lib/ordered.ts", "export const o = 2;\n");
    const post = await postPassFault(defaultExec, planned, st.pipelineState.baseSha ?? "", events);
    assert(
      post.reason === undefined,
      `2b/A: a file the round named, that the cycle made, in an anchored directory, committed after its baseline, is admitted (got "${post.reason}")`,
    );
    assert(
      post.admissions.some((a) => a.includes("lib/ordered.ts")),
      `2b/A: the admission is disclosed (got ${JSON.stringify(post.admissions)})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // B — a file no evidence line names is still a stray, however tidy it looks.
  const b = await correctiveScaffold("1698-corrective-stray", {
    "lib/ordered.ts": "export const o = 1;\n",
  });
  try {
    passEdit(b.dir);
    commitNew(b.dir, "lib/wandered.ts", "export const w = 1;\n");
    const post = await postPassFault(defaultExec, b.planned, b.st.pipelineState.baseSha ?? "", [
      round("default", [x("lib/ordered.ts")], headNow(b.dir)),
    ]);
    assert(
      post.reason?.includes("lib/wandered.ts") === true,
      `2b/B: a corrective developer that wanders off its evidence still parks (got "${post.reason}")`,
    );
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }

  // C — a file the evidence names but the PASS wrote, before the round began,
  // is not the round's work. It parks under the WINDOW bound, naming it, while
  // its post-round sibling is admitted.
  const c = await correctiveScaffold("1698-corrective-pre-round", {
    "lib/early.ts": "export const e = 1;\n",
    "lib/ordered.ts": "export const o = 1;\n",
  });
  try {
    devCommit(c.dir, "lib/early.ts", "export const e = 2;\n");
    passEdit(c.dir);
    const baseline = headNow(c.dir);
    devCommit(c.dir, "lib/ordered.ts", "export const o = 2;\n");
    const post = await postPassFault(defaultExec, c.planned, c.st.pipelineState.baseSha ?? "", [
      round("default", [x("lib/early.ts"), x("lib/ordered.ts")], baseline),
    ]);
    assert(
      post.reason?.includes("lib/early.ts") === true &&
        !post.admissions.some((a) => a.includes("lib/early.ts")) &&
        post.admissions.some((a) => a.includes("lib/ordered.ts")),
      `2b/C: the pre-round file is refused while its post-round sibling is admitted (reason "${post.reason}", admissions ${JSON.stringify(post.admissions)})`,
    );
    assert(
      post.reason?.includes("not committed after the corrective round") === true,
      `2b/C: the park names the corrective bound it refused under (got "${post.reason}")`,
    );
  } finally {
    rmSync(c.dir, { recursive: true, force: true });
  }

  // D — no baseline at all (a record from before #1698(b), or a HEAD the driver
  // could not read) admits nothing, and says which.
  const d = await correctiveScaffold("1698-corrective-no-baseline", {
    "lib/ordered.ts": "export const o = 1;\n",
  });
  try {
    passEdit(d.dir);
    devCommit(d.dir, "lib/ordered.ts", "export const o = 2;\n");
    const post = await postPassFault(defaultExec, d.planned, d.st.pipelineState.baseSha ?? "", [
      round("default", [x("lib/ordered.ts")]),
    ]);
    assert(
      post.reason?.includes("lib/ordered.ts") === true &&
        post.reason?.includes("no usable HEAD baseline") === true,
      `2b/D: a round with no valid headAtRound admits nothing and names it (got "${post.reason}")`,
    );
  } finally {
    rmSync(d.dir, { recursive: true, force: true });
  }

  // E — one round is a bounded authorisation: the fourth evidence-named file is
  // refused with the cap named, never taken silently.
  const e = await correctiveScaffold("1698-corrective-cap", {
    "lib/one.ts": "export const v = 1;\n",
    "lib/two.ts": "export const v = 1;\n",
    "lib/three.ts": "export const v = 1;\n",
    "lib/four.ts": "export const v = 1;\n",
  });
  try {
    passEdit(e.dir);
    const baseline = headNow(e.dir);
    const named = ["lib/one.ts", "lib/two.ts", "lib/three.ts", "lib/four.ts"];
    for (const f of named) devCommit(e.dir, f, "export const v = 2;\n");
    const post = await postPassFault(defaultExec, e.planned, e.st.pipelineState.baseSha ?? "", [
      round("default", named.map(x), baseline),
    ]);
    assert(
      named.some((f) => post.reason?.includes(f)) === true &&
        post.reason?.includes("already admitted its 3") === true,
      `2b/E: the fourth evidence-named file is refused with the cap named (got "${post.reason}")`,
    );
    assert(
      post.admissions.length === 3 &&
        named.filter((f) => post.admissions.some((a) => a.includes(f))).length === 3,
      `2b/E: exactly CORRECTIVE_ADMIT_MAX admissions are disclosed (got ${JSON.stringify(post.admissions)})`,
    );
  } finally {
    rmSync(e.dir, { recursive: true, force: true });
  }

  // F (#1760) — the anchor. A file the round really did commit after its
  // baseline, named by its evidence, but sitting in a directory no declared and
  // no already-changed path touches: refused, and the refusal says the anchor.
  const f = await correctiveScaffold("1698-corrective-unanchored", {
    "vendor/loose.ts": "export const l = 1;\n",
  });
  try {
    passEdit(f.dir);
    const baseline = headNow(f.dir);
    devCommit(f.dir, "vendor/loose.ts", "export const l = 2;\n");
    const post = await postPassFault(defaultExec, f.planned, f.st.pipelineState.baseSha ?? "", [
      round("default", [x("vendor/loose.ts")], baseline),
    ]);
    assert(
      post.reason?.includes("vendor/loose.ts") === true &&
        post.reason?.includes("holds no declared and no already-changed path") === true,
      `2b/F: a post-round file outside every anchored directory is refused under the anchor (got "${post.reason}")`,
    );
    assert(
      post.admissions.length === 0,
      `2b/F: nothing is admitted from an unanchored directory (got ${JSON.stringify(post.admissions)})`,
    );
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }

  // G (#1760) — the provenance. A file the round INVENTS after its baseline and
  // whose path its evidence names: the driver ordered the edit, but the cycle
  // never owned the file, so the route refuses it as not the round's to admit.
  const g = await correctiveScaffold("1698-corrective-invented", {
    "lib/ordered.ts": "export const o = 1;\n",
  });
  try {
    passEdit(g.dir);
    const baseline = headNow(g.dir);
    commitNew(g.dir, "lib/ghost.ts", "export const h = 2;\n");
    const post = await postPassFault(defaultExec, g.planned, g.st.pipelineState.baseSha ?? "", [
      round("default", [x("lib/ghost.ts")], baseline),
    ]);
    assert(
      post.reason?.includes("lib/ghost.ts") === true &&
        post.reason?.includes("the round is not its author") === true,
      `2b/G: a file outside the candidate set is refused even when the evidence names it and the round committed it (got "${post.reason}")`,
    );
  } finally {
    rmSync(g.dir, { recursive: true, force: true });
  }
}

// 3 — the fix pass's own NEW file, named by no finding and no spec slot and
// outside the declared paths, is still refused: (a) admits only what the
// cycle already committed, not what the pass invents.
{
  const dir = repoWithFile("1698-unrelated-new");
  try {
    trackAtBase(dir, { "pkg/existing.ts": "export {};\n" });
    const st = fixState(dir, ["pkg/existing.ts"], "pkg/existing.ts: fix it");
    const r = await runPass(dir, st, (d) => {
      devCommit(d, "pkg/existing.ts", "export const e = 2;\n");
      commitNew(d, path.join("tests", "pass-own.test.ts"), "export const t = 1;\n");
    });
    assert(
      !r.applied && r.parked.includes("pass-own.test.ts"),
      `3: the fix pass's own new file outside the declared paths is still refused (got "${r.parked}")`,
    );
    assert(
      !r.applied && r.parked.includes("No finding names"),
      `3: the park says no finding names the invented file (got "${r.parked}")`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 4 — protected paths stay refused even when a finding names them AND the
// corrective round's evidence names them: neither widening reaches them.
{
  const dir = repoWithFile("1698-protected");
  try {
    trackAtBase(dir, { "agents.json": "{}\n" });
    const st = fixState(dir, ["a.txt"], "a.txt: fix; agents.json: and this");
    const planned = must(
      await planFixPass(defaultExec, dir, st.pipelineState, [
        { workstreamId: "default", findings: "a.txt: fix; agents.json: and this" },
      ]),
      "4",
    );
    devCommit(dir, "a.txt", "two\n");
    devCommit(dir, "agents.json", '{"auto": true}\n');
    const post = await postPassFault(defaultExec, planned, st.pipelineState.baseSha ?? "", [
      round("default", ["\u2717 agents.json:3 must stay {}"], git(dir, "rev-parse HEAD~1").trim()),
    ]);
    assert(
      post.reason?.includes("agents.json") === true,
      `4: a protected path is refused even when the finding and the corrective evidence name it (got "${post.reason}")`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 5 — a finding naming a tracked file in a NON-anchored directory still parks:
// the directory-anchor condition survives the widening.
{
  const dir = repoWithFile("1698-unanchored");
  try {
    trackAtBase(dir, { "lib/verify.ts": "export {};\n", "src/a.ts": "export {};\n" });
    const st = fixState(dir, ["src/a.ts"], "src/a.ts: fix; lib/verify.ts: and this");
    const r = await runPass(dir, st, (d) => {
      devCommit(d, "src/a.ts", "export const a = 2;\n");
      devCommit(d, "lib/verify.ts", "export const v = 2;\n");
    });
    assert(
      !r.applied && r.parked.includes("lib/verify.ts"),
      `5: a finding-named file in a non-anchored directory still parks (got "${r.parked}")`,
    );
    assert(
      !r.applied && r.parked.includes("does not widen the fence"),
      `5: the park states the widening rule it refused under (got "${r.parked}")`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 6 — a PARKED pass still discloses what it admitted. The refusals reach the
// handoff through the park reason; the authorisations reached it through
// nothing at all, so a fence that widened looked identical to one that did not.
{
  const dir = repoWithFile("1698-admissions-survive-park");
  try {
    const st = fixState(dir, ["a.txt"], "a.txt: fix");
    const parked = parkFixPass(
      st,
      [{ workstreamId: "default", round: 1, findings: "a.txt: change one to two" }],
      "the pass changed something outside its fence",
      Date.now(),
      ["default: lib/ordered.ts admitted — the corrective round's evidence named it"],
    );
    const report = (parked.pipelineState.plumbReports ?? []).at(-1)?.body ?? "";
    assert(
      report.includes("lib/ordered.ts") && report.includes("What the pass admitted"),
      `6: the parked report carries the admission alongside the refusal (got "${report}")`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
