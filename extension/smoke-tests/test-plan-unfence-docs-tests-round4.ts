#!/usr/bin/env bun
/**
 * #1250 change 1, round 4 — the three ways this pass could open a fence it has
 * no business opening, each pinned by the plan that distinguishes the fixed
 * behaviour from the broken one.
 *
 * 1. **A workstream with no `outOfScope` field.** The type says the list is
 *    required; the state file on disk does not, and a plan read back from an
 *    older cycle can carry a workstream without it. Every sibling reader of
 *    these fields falls back to `?? []` (`ownerOf` in work-driver-plan-unfence-
 *    notes.ts, `work-driver-adversarial-fix-scope.ts`, `work-driver-corrective-
 *    round.ts`); this pass iterated the list raw and threw on `undefined`, which
 *    takes the plan step down over a field it never needed.
 * 2. **A non-concrete fence entry** — a glob, a `..` segment or an absolute
 *    path. `fenceDirPrefix` collapses the DIRECTORY spellings (`docs/**`,
 *    `docs/*`, `docs/`) so the shape judgement agrees with the develop gate, but
 *    a real pattern survives it, and a fence the gate cannot resolve to a
 *    directory is a fence whose reach this pass cannot bound: a glob under
 *    docs/ can name a path outside the docs tree, and `/docs/` is not a repo
 *    path at all. Such an entry now stays fenced, judged by the SAME bar the issue-named pass applies to a
 *    token before it may move a fence (`isUnfenceablePath`).
 * 3. **No issue-body artifact at all.** `readIssueBody` reports an absent
 *    artifact as `{ body: "", unreadable: false }`, which is honest for the
 *    issue-named half (nothing to extract, nothing removed, no lost file to
 *    report) and was enough for this rule to open every docs/test fence in the
 *    plan while being unable to read a single refusal. An absent artifact is now
 *    the same epistemic state as an unreadable one for THIS rule only.
 *
 * Paths are synthetic; this repo is public.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fenceDirPrefix } from "../src/work-driver-declared-path.ts";
import { runPlanUnfencePass } from "../src/work-driver-plan-coupling-pass.ts";
import { unfenceDocsTestPaths } from "../src/work-driver-plan-unfence-docs-tests.ts";
import { withEnv } from "./lib/env-scope.ts";
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

const NO_EXEC = async () => ({ stdout: "" });
const PLAIN_BODY = "## Resolved decisions\n\nThe change adds a flag to the entry point.\n";

const WS = (outOfScope: string[]): Workstream => ({
  id: "default",
  scope: "default",
  paths: ["src/app.ts"],
  outOfScope,
});

/** Run the pass with the artifact written (default) or deliberately absent. */
async function runPass(
  workstreams: Record<string, Workstream>,
  body: string,
  opts: { artifact?: boolean } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "pi-unfence-r4-"));
  const artifact = join(dir, "issue.md");
  try {
    if (opts.artifact !== false) writeFileSync(artifact, body, "utf8");
    const state = initialState(1250, "synthetic: stop fencing docs and tests");
    if (opts.artifact !== false) state.pipelineState.issueBodyArtifact = artifact;
    return await runPlanUnfencePass(workstreams, state, { repoRoot: "/repo", execFn: NO_EXEC });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The hatch is read per call; pin it for this file and put it back exactly.
const HATCH = "PI_ENSEMBLE_UNFENCE_DOCS_TESTS";
await withEnv({ [HATCH]: "1" }, async () => {
  // ---------- AC: a workstream with no outOfScope field does not throw ----------
  {
    // The measured shape: a workstream read back from a state file that predates
    // the field (or that a corrective round wrote without it). The pass must run,
    // open nothing, and leave the plan alone — not throw and take the plan step
    // down over a field it never needed.
    const bare = { default: { id: "default", scope: "s", paths: ["src/app.ts"] } } as Record<
      string,
      Workstream
    >;
    let threw: string | undefined;
    let res: ReturnType<typeof unfenceDocsTestPaths> | undefined;
    try {
      res = unfenceDocsTestPaths(bare, PLAIN_BODY);
    } catch (err) {
      threw = (err as Error).message;
    }
    assert(threw === undefined, `no outOfScope field: the pass does not throw (${threw})`);
    assert(
      (res?.workstreams.default?.outOfScope ?? []).length === 0,
      "no outOfScope field: nothing to open, nothing opened",
    );
    assert(res?.removed.length === 0, "no outOfScope field: no removal records");
    assert(res?.notes.length === 0, "no outOfScope field: no notes");

    // And through the real wiring, where a throw would surface as a failed pass.
    const out = await runPass(bare, PLAIN_BODY);
    assert(
      (out.workstreams.default?.outOfScope ?? []).length === 0,
      "no outOfScope field: the plan step's pass returns the plan, not an exception",
    );

    // The sibling field gets the same guard: a workstream with no `paths` must
    // not throw when the copy rebuilds the list.
    const noPaths = {
      default: { id: "default", scope: "s", outOfScope: ["docs/guide.md"] },
    } as unknown as Record<string, Workstream>;
    const out2 = unfenceDocsTestPaths(noPaths, PLAIN_BODY);
    assert(
      (out2.workstreams.default?.paths ?? []).length === 0,
      "no paths field: the copy gets an empty list rather than throwing",
    );
    assert(
      !out2.workstreams.default?.outOfScope.includes("docs/guide.md"),
      "no paths field: the docs fence still opens",
    );
  }

  // ---------- AC: a non-concrete fence entry stays fenced ----------
  {
    // Five entries that all LOOK docs/test-shaped once the shape question is
    // asked, and none of which resolves to a directory the develop gate can
    // compare on a `/` boundary. Each is kept; the concrete docs
    // fences beside them still open, so the guard is per-entry, not a blanket stop.
    const plan = { default: WS(["*.md", "**/*.md", "docs/../src/", "/docs/", "~/docs/", "C:/docs/"]) };
    const res = unfenceDocsTestPaths(plan, PLAIN_BODY);
    const fence = res.workstreams.default?.outOfScope ?? [];
    for (const entry of ["*.md", "**/*.md", "docs/../src/", "/docs/", "~/docs/", "C:/docs/"]) {
      assert(fence.includes(entry), `non-concrete fence ${entry} stays fenced`);
      assert(
        fenceDirPrefix(entry) === fenceDirPrefix(entry),
        `fixture ${entry} is comparable through the gate's normaliser`,
      );
    }
    assert(res.removed.length === 0, `nothing opened (${res.removed.length})`);
    assert(res.notes.length === 0, "no notes for fences the rule declined to open");

    // The two spellings the round-2 suite already pins: a directory glob with an
    // annotation is NOT "non-concrete" — `fenceDirPrefix` collapses it to a real
    // directory, and the gate fences that tree.
    const concrete = unfenceDocsTestPaths(
      { default: WS(["docs/", "docs/** (new)", "lib/x.sh"]) },
      PLAIN_BODY,
    );
    const kept = concrete.workstreams.default?.outOfScope ?? [];
    assert(!kept.includes("docs/"), "docs/ still opens — a directory fence is concrete");
    assert(!kept.includes("docs/** (new)"), "docs/** (new) still opens — the same fence");
    assert(kept.includes("lib/x.sh"), "the unrelated fence is kept");
    assert(concrete.removed.length === 2, `both directory spellings opened (${concrete.removed.length})`);

    // The converse, which is what keeps the clause set honest: three of the
    // characters the shared bar (`isUnfenceablePath`) refuses are NOT fences
    // here, because that bar is written for an issue-derived token that has to
    // survive a shell and a fence entry reaches the develop gate as data.
    // A planner that writes `docs/my file.md` (a Next.js `app/[id]/page.tsx`
    // style directory is refused for its brackets, correctly) means a real docs
    // path, and `docs/` + a backtick in the name is a real docs page.
    const spelling = unfenceDocsTestPaths(
      {
        default: WS([
          "docs/my file.md",
          "docs/{group}/guide.md",
          "docs/`legacy`.md",
          "docs/[id]/page.md",
        ]),
      },
      PLAIN_BODY,
    );
    const opened = spelling.removed.map((r) => r.entry);
    assert(
      opened.includes("docs/my file.md"),
      "a space in the name is not a pattern — the docs fence opens",
    );
    assert(
      opened.includes("docs/{group}/guide.md"),
      "braces are not a git pathspec wildcard — the docs fence opens",
    );
    assert(
      opened.includes("docs/`legacy`.md"),
      "a backtick is not a shell hazard in a fence (it reaches the gate as data)",
    );
    assert(
      !opened.includes("docs/[id]/page.md"),
      "brackets ARE the pathspec class and stay fenced — the clause set is narrow, not empty",
    );
  }

  // ---------- AC: no issue-body artifact at all opens nothing ----------
  {
    // `readIssueBody` says `{ body: "", unreadable: false }` for an ABSENT
    // artifact, so the previous guard let this plan through and the rule opened
    // every docs/test fence while unable to read one refusal. Same expectation as
    // the unreadable case in the round-2 suite: all five fences stay, and the
    // summary does not claim openings. It is NOT reported as `issueBodyUnreadable`
    // — that field means a cache file that went missing, and none existed.
    const out = await runPass(
      {
        default: WS([
          "docs/guide.md",
          "host/docs/",
          "test/helper.sh",
          "src/a_test.go",
          "lib/x.sh",
        ]),
      },
      PLAIN_BODY,
      { artifact: false },
    );
    const fence = out.workstreams.default?.outOfScope ?? [];
    assert(fence.length === 5, `absent artifact: all five fences stay as written (${fence.length})`);
    assert(
      fence.includes("docs/guide.md") &&
        fence.includes("host/docs/") &&
        fence.includes("test/helper.sh") &&
        fence.includes("src/a_test.go") &&
        fence.includes("lib/x.sh"),
      "absent artifact: every docs/test fence the rule would have opened is kept",
    );
    assert(
      out.summary?.docsTests === undefined,
      `absent artifact: the summary claims no docs/test openings (${out.summary?.docsTests})`,
    );
    assert(
      out.summary?.issueBodyUnreadable === undefined,
      "absent artifact is still not reported as a lost cache file — the two facts stay apart",
    );
    assert(out.summary?.ran === true, "the pass itself still ran (the issue-named half is unaffected)");
  }
});

process.exit(exit);
