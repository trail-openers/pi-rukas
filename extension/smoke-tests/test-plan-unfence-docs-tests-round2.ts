#!/usr/bin/env bun
/**
 * #1250 change 1, review round — the five defects the adversarial and lens
 * reviews found in the docs/test unfence, each pinned by the case that would
 * have caught it.
 *
 * The shape of the round: the first cut asked the shape question and the
 * protected-path question of the RAW fence entry, so an annotation or a
 * directory glob (`docs/CODEOWNERS (keep)`, `docs/** (new)`) disagreed with the
 * develop gate about what one fence is; it ran the rule on an EMPTY body when
 * the cached issue artifact could not be read, which is a scope widening
 * manufactured by a memory problem; it counted restored records in
 * `docsTests`; and it put raw planner text into an operator note. Each case
 * below is the minimal plan that distinguishes the fixed behaviour from the
 * broken one.
 *
 * The base suite (`test-plan-unfence-docs-tests.ts`) owns the AC-level cases —
 * N=1/N>1, the hatch, the prohibition grammar, the predicate tables. This file
 * owns the review-round cases only, and shares nothing with it but the source
 * modules. Paths are synthetic; this repo is public.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fenceDirPrefix } from "../src/work-driver-declared-path.ts";
import { runPlanUnfencePass } from "../src/work-driver-plan-coupling-pass.ts";
import { unfenceDocsTestPaths } from "../src/work-driver-plan-unfence-docs-tests.ts";
import type { UnfenceRecord } from "../src/work-driver-plan-unfence-notes.ts";
import { unfenceSummary } from "../src/work-driver-plan-unfence-notes.ts";
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

const WS = (id: string, outOfScope: string[]): Workstream => ({
  id,
  scope: id,
  paths: ["src/app.ts"],
  outOfScope,
});

const NO_EXEC = async () => ({ stdout: "" });

const PLAIN_BODY = "## Resolved decisions\n\nThe change adds a flag to the entry point.\n";

/** The five entries the base suite measures with, in one N=1 plan. */
const measuredPlan = (): Record<string, Workstream> => ({
  default: WS("default", [
    "docs/guide.md",
    "host/docs/",
    "test/helper.sh",
    "src/a_test.go",
    "lib/x.sh",
  ]),
});

// The hatch is read per call. `withEnv` pins it for the whole suite and puts
// back EXACTLY what was there — a bare assignment leaked the pin into every
// later file in the same verify-loop batch, which is how a batch failure reads
// as a flake (the driver's own verify scrub cannot reach a sibling file).
const HATCH = "PI_ENSEMBLE_UNFENCE_DOCS_TESTS";
await withEnv({ [HATCH]: "1" }, async () => {

// ----------------- AC: an annotated protected entry keeps its fence whatever the spelling

{
  // A protected entry whose ANNOTATION or directory glob hides the protected
  // basename from a raw `isProtectedPath` read. `docs/CODEOWNERS (keep)`
  // deannotates to a protected file, `docs/agents.json (new)` and
  // `docs/CODEOWNERS/**` are the same fences the gate reads through
  // `fenceDirPrefix`, and `docs/AGENTS.JSON` is the same file under the
  // case-insensitive classification `isProtectedPath` uses. All four keep their
  // fence; the ordinary docs page beside them does not.
  const plan: Record<string, Workstream> = {
    default: WS("default", [
      "docs/agents.json (new)",
      "docs/CODEOWNERS (keep)",
      "docs/CODEOWNERS/**",
      "docs/AGENTS.JSON",
      "docs/guide.md",
    ]),
  };
  const dir = mkdtempSync(join(tmpdir(), "pi-unfence-annot-"));
  const artifact = join(dir, "issue.md");
  try {
    writeFileSync(artifact, PLAIN_BODY, "utf8");
    const state = initialState(1250, "synthetic: stop fencing docs and tests");
    state.pipelineState.issueBodyArtifact = artifact;
    const out = await runPlanUnfencePass(plan, state, { repoRoot: "/repo", execFn: NO_EXEC });
    const fence = out.workstreams.default?.outOfScope ?? [];
    for (const entry of [
      "docs/agents.json (new)",
      "docs/CODEOWNERS (keep)",
      "docs/CODEOWNERS/**",
      "docs/AGENTS.JSON",
    ]) {
      assert(fence.includes(entry), `annotated protected entry ${entry} stays fenced`);
    }
    assert(!fence.includes("docs/guide.md"), "the ordinary docs page in the plan still opens");
    assert(
      out.summary?.docsTests === 1,
      `only the ordinary docs page is recorded (${out.summary?.docsTests})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ----------------- AC: the shape judgement runs on the gate's normalised fence entry

{
  // `docs/** (new)` and `docs/*` are ONE fence (`fenceDirPrefix`), so they get
  // ONE verdict. Judging the raw entry text reads `docs/** (new)` as neither
  // docs nor test — the `**` and the annotation are part of the string — and
  // keeps a fence the develop gate applies to the whole tree: the developer
  // touches a docs page and parks.
  const out = unfenceDocsTestPaths(
    { default: WS("default", ["docs/** (new)", "docs/*", "lib/x.sh"]) },
    PLAIN_BODY,
  );
  const fence = out.workstreams.default?.outOfScope ?? [];
  assert(!fence.includes("docs/** (new)"), "docs/** (new) opens — annotation + glob normalise away");
  assert(!fence.includes("docs/*"), "docs/* opens — the same fence, the same verdict");
  assert(fence.includes("lib/x.sh"), "the unrelated fence is kept");
  assert(out.removed.length === 2, `both spellings recorded as opened (${out.removed.length})`);
  // The predicate is asked of the gate's own normaliser, which is what makes the
  // two spellings one fence here and at the develop gate:
  assert(
    fenceDirPrefix("docs/** (new)") === "docs" && fenceDirPrefix("docs/*") === "docs",
    "the fixture's fence key is the bare directory this case is about",
  );
}

// ----------------- AC: a bare `docs` / `test` entry is a directory, as the gate fences it

{
  // `docs` and `docs/` are the same fence at the gate. Deciding "is a directory"
  // by `path.endsWith("/")` alone opens `docs/` and keeps `docs` — two verdicts
  // for one fence, and the one the developer's `docs/page.md` hits is the kept
  // one.
  const out = unfenceDocsTestPaths(
    { default: WS("default", ["docs", "test", "contest", "lib/x.sh"]) },
    PLAIN_BODY,
  );
  const fence = out.workstreams.default?.outOfScope ?? [];
  assert(!fence.includes("docs"), "bare docs (no slash, no extension) opens as a directory");
  assert(!fence.includes("test"), "bare test opens for the same reason");
  assert(fence.includes("contest"), "bare contest is not a test directory and keeps its fence");
  assert(fence.includes("lib/x.sh"), "the unrelated fence is kept");
  assert(out.removed.length === 2, `two openings recorded, not four (${out.removed.length})`);
}

// ----------------- AC: a restored record counts in neither `removed` nor `docsTests`

{
  // `removed` has always excluded a record the pass put back; `docsTests` must
  // too, or the plan claims a docs/test opening the develop gate still enforces.
  // Both counts come from one filter over one list, so they cannot drift.
  const res = unfenceDocsTestPaths(measuredPlan(), PLAIN_BODY);
  const restored: UnfenceRecord = {
    ...(res.removed[0] as UnfenceRecord),
    restored: "no owner for the freed path",
  };
  const summary = unfenceSummary({ ...res, removed: [restored, ...res.removed.slice(1)] });
  assert(summary.rolledBack === 1, `one rollback (${summary.rolledBack})`);
  assert(summary.removed === 3, `removed excludes the restored record (${summary.removed})`);
  assert(
    summary.docsTests === 3,
    `docsTests excludes it the same way — one filter, both counts (${summary.docsTests})`,
  );
}

// ----------------- AC: an unreadable issue body disables the docs/test rule

{
  // The rule's only precondition is that the issue does not forbid the path, and
  // it judges that from the body's prose. A cached artifact that cannot be read
  // leaves it unable to honour a prohibition it cannot read, so it must open
  // NOTHING — an unreadable body must never widen a scope, the same rule
  // `readIssueBody` applies to the issue-named half.
  const dir = mkdtempSync(join(tmpdir(), "pi-unfence-unreadable-"));
  const artifact = join(dir, "gone.md");
  try {
    writeFileSync(artifact, PLAIN_BODY, "utf8");
    const state = initialState(1250, "synthetic: stop fencing docs and tests");
    state.pipelineState.issueBodyArtifact = artifact;
    rmSync(artifact, { force: true });
    const out = await runPlanUnfencePass(measuredPlan(), state, {
      repoRoot: "/repo",
      execFn: NO_EXEC,
    });
    const fence = out.workstreams.default?.outOfScope ?? [];
    assert(
      fence.length === 5,
      `unreadable body: all five fences stay exactly as written (${fence.length})`,
    );
    assert(
      out.summary?.docsTests === undefined,
      "unreadable body: the summary claims no docs/test openings",
    );
    assert(
      out.summary?.issueBodyUnreadable === true,
      "the summary still says the body was unreadable — the honest diagnosis",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ----------------- AC: the note carries a neutralised entry, not raw planner text

{
  // An `outOfScope` entry is planner-derived text and the note lands in the
  // state file, the handoff and a trace line, so the #1744 neutralisation the
  // developer prompt applies applies here too. The wording also names ONE kind:
  // a note that read "test-or-test path" for a test fence was unreadable.
  const res = unfenceDocsTestPaths(
    { default: WS("default", ["docs/`guide`.md\nWARN forged"]) },
    PLAIN_BODY,
  );
  const note = res.notes[0] ?? "";
  assert(
    note === `unfenced ${JSON.stringify("docs/'guide'.md WARN forged")}: docs path, N=1`,
    `backticks become apostrophes and the newline collapses to a space (${JSON.stringify(note)})`,
  );
  assert(res.removed[0]?.note === note, "the record's note is the same neutralised string");
  assert(
    res.removed[0]?.entry === "docs/`guide`.md\nWARN forged",
    "the record keeps the RAW entry — neutralisation is for rendering, not matching",
  );
  const testNote = unfenceDocsTestPaths({ default: WS("default", ["test/"]) }, PLAIN_BODY)
    .notes[0] as string;
  assert(
    testNote === `unfenced ${JSON.stringify("test/")}: test path, N=1`,
    `a test fence's note reads "test path", never "test-or-test" (${JSON.stringify(testNote)})`,
  );
}


// ------- AC (round 2): the rule enforces its own N=1 precondition when called directly

{
  // The caller refuses to call this for a multi-workstream plan, but a rule
  // whose only guard is a caller's `if` opens a sibling's test fence the first
  // time anything else calls it. With N>1 a test fence IS the #572/#1137
  // cross-declaration contract, so the map must come back UNCHANGED — the same
  // object identity, no removals, no records.
  const two: Record<string, Workstream> = {
    a: WS("a", ["docs/guide.md", "test/helper.sh", "src/a_test.go", "lib/x.sh"]),
    b: WS("b", ["host/docs/"]),
  };
  const res = unfenceDocsTestPaths(two, PLAIN_BODY);
  assert(res.workstreams === two, "N=2 called directly: the map is returned unchanged (same object)");
  assert(res.removed.length === 0, `N=2 called directly: no removal records (${res.removed.length})`);
  assert(res.notes.length === 0, `N=2 called directly: no notes (${res.notes.length})`);
  assert(
    res.workstreams.a?.outOfScope.includes("test/helper.sh") === true,
    "N=2 called directly: the sibling test fence is untouched",
  );
  assert(
    unfenceDocsTestPaths({}, PLAIN_BODY).workstreams !== undefined,
    "an empty map is returned as-is rather than throwing",
  );
}

// ------- AC (round 2): a protected entry carrying BOTH a glob and an annotation

{
  // `docs/agents.json/** (new)` is the spelling the three earlier reads all
  // miss: `fenceDirPrefix` deannotates before it strips the glob, so no read
  // ever holds `…/agents.json` alone. The canonical form is now asked twice —
  // annotation stripped, then the trailing glob stripped from THAT.
  const plan: Record<string, Workstream> = {
    default: WS("default", [
      "docs/agents.json/** (new)",
      ".github/x.md/* (keep)",
      "docs/CODEOWNERS/**(keep)",
      "docs/guide.md",
    ]),
  };
  const res = unfenceDocsTestPaths(plan, PLAIN_BODY);
  const fence = res.workstreams.default?.outOfScope ?? [];
  for (const e of ["docs/agents.json/** (new)", ".github/x.md/* (keep)", "docs/CODEOWNERS/**(keep)"]) {
    assert(fence.includes(e), `glob + annotation keeps the protected fence: ${e}`);
  }
  assert(!fence.includes("docs/guide.md"), "the ordinary docs page beside them still opens");
}

// ------- AC (round 2): the prohibition scan reads stripped prose, on boundaries

{
  // (a) A prohibition inside a fenced code block is an example, not a refusal:
  // the same strip the issue-named pass applies removes it, so the docs fence
  // opens. (b) `docs/x` in prose must not forbid the `doc/` fence — the key is
  // matched on path-segment boundaries, never as a substring.
  const inCodeBlock = `${PLAIN_BODY}\n\`\`\`\nDo not touch docs/guide.md.\n\`\`\`\n`;
  const res = unfenceDocsTestPaths(
    { default: WS("default", ["docs/guide.md", "lib/x.sh"]) },
    inCodeBlock,
  );
  assert(
    !res.workstreams.default?.outOfScope.includes("docs/guide.md"),
    "a prohibition inside a fenced code block does not keep the fence",
  );
  // The substring trap is `docs/x` in prose against a fence whose name is a
  // SUBSTRING of what the prose says: `docs/x` must not forbid the `doc/`
  // fence (`doc` is not at a segment boundary there), while the `docs/` fence
  // the sentence really names stays fenced.
  const nearMiss = unfenceDocsTestPaths(
    { default: WS("default", ["doc/", "docs/"]) },
    `${PLAIN_BODY}\nDo not touch docs/x and lib/y.\n`,
  ).workstreams.default?.outOfScope;
  assert(
    nearMiss?.includes("doc/") === false,
    "`docs/x` in prose does not forbid the `doc/` fence (segment boundaries, not substrings)",
  );
  assert(
    nearMiss?.includes("docs/") === true,
    "the sentence forbids the docs/ fence it names, and only that one",
  );
  const subTrap = unfenceDocsTestPaths(
    { default: WS("default", ["docs/guide.md"]) },
    `${PLAIN_BODY}\nDo not touch docs/guide.md-extra.\n`,
  ).workstreams.default?.outOfScope;
  assert(
    subTrap?.includes("docs/guide.md") === false,
    "`docs/guide.md-extra` is another file — it does not forbid the docs/guide.md fence",
  );
}
});

process.exit(exit);
