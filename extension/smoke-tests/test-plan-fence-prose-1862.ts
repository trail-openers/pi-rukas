/**
 * #1862 (a), the fence-bound half: a PROSE `outOfScope` entry is dropped at the
 * tool boundary when the sentence names a path that covers a path THIS
 * workstream declares itself — and only then.
 *
 * The field case, from the cycle the issue names: a docs workstream's
 * `"Every file under agents/ and tests/ — this workstream documents, it does not
 * implement"` survived a merge into the workstream whose `paths` are under
 * `agents/` and `tests/`. Read as a fence the sentence matches nothing; read as
 * an instruction in the developer's prompt it forbids the files the issue asked
 * for, and the develop gate's fence arm then judges each of them a violation.
 *
 * Driven through `workstreamFromArgs`, the ONE place a reported `outOfScope`
 * becomes a stored one, so the assertion is about what a workstream actually
 * carries — not about a helper's private answer.
 *
 * The controls are the load-bearing part. A rule that deletes fences it cannot
 * read is worse than a useless fence, so every case that must NOT drop anything
 * is pinned beside the case that must.
 */

import { workstreamFromArgs } from "../src/work-driver-plan-workstreams.ts";
import type { WorkstreamArgs } from "../src/plan-workstream-schema.ts";
import { VALID } from "./lib/plan-outofscope-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.log(`✗ ${msg}`);
    exit = 1;
  }
}

const FIELD =
  "Every file under agents/ and tests/ — this workstream documents, it does not implement";

function ws(over: Partial<WorkstreamArgs>): WorkstreamArgs {
  return {
    ...VALID,
    id: over.id ?? "implement",
    scope: over.scope ?? "implement the change",
    paths: over.paths ?? ["tests/test_x.py", "agents/x.md"],
    outOfScope: over.outOfScope ?? [],
  };
}

// ────────────────────────────── 1. the field case: the sentence is gone from a
// workstream that owns the directories it names, and the OTHER exclusions stay.
{
  const w = workstreamFromArgs(
    ws({ outOfScope: [FIELD, ".ci/", "nothing else"] }),
  );
  assert(
    !w.outOfScope.includes(FIELD),
    `the prose fence over the workstream's own directories is dropped (got ${JSON.stringify(w.outOfScope)})`,
  );
  assert(
    w.outOfScope.includes(".ci/") && w.outOfScope.includes("nothing else"),
    `and the entries naming nothing it declared survive (got ${JSON.stringify(w.outOfScope)})`,
  );
}

// ────────────────────────────── 2. the controls: a rule this side of the fence
// has to refuse every one of these.
{
  // A sibling's files — the #572 cross-declaration contract. The sentence names
  // `src/` and the workstream declares nothing under `src/`.
  const sibling = workstreamFromArgs(
    ws({
      paths: ["docs/readme.md"],
      outOfScope: ["Every file under src/ — owned by the implement workstream"],
    }),
  );
  assert(
    sibling.outOfScope.length === 1,
    `a prose fence over a SIBLING's directory is kept (got ${JSON.stringify(sibling.outOfScope)})`,
  );

  // Prose that names no path at all: nothing to compare it against.
  const vague = workstreamFromArgs(
    ws({ paths: ["docs/readme.md"], outOfScope: ["nothing else", "no new dependencies"] }),
  );
  assert(
    vague.outOfScope.length === 2,
    `prose naming no path is kept (got ${JSON.stringify(vague.outOfScope)})`,
  );

  // A substring is not a token: prose about `docs` cannot name `docsfoo/`.
  const lookalike = workstreamFromArgs(
    ws({ paths: ["docsfoo/x.md"], outOfScope: ["Everything under docs/ is frozen"] }),
  );
  assert(
    lookalike.outOfScope.length === 1,
    `prose naming a directory that only LOOKS like a declared one is kept (got ${JSON.stringify(lookalike.outOfScope)})`,
  );

  // A path-shaped entry is `fenceMatches`' business, not this rule's: a real
  // path fence the planner wrote survives this pass whatever it covers (the
  // fold's containment arm, workstream-fold-self-fence.ts, is the one that
  // judges those).
  const pathShaped = workstreamFromArgs(ws({ outOfScope: ["tests/"] }));
  assert(
    pathShaped.outOfScope.includes("tests/"),
    `a path-shaped entry is not dropped by the prose rule (got ${JSON.stringify(pathShaped.outOfScope)})`,
  );

  // A PROTECTED declaration is never a reason to open a fence.
  const protectedWs = workstreamFromArgs(
    ws({ paths: ["agents.json", "tests/test_x.py"], outOfScope: [FIELD] }),
  );
  assert(
    // The em-dash sentence is ONE entry before the bound touches it; the bound's
    // clip arm cuts it at a space and the second half survives as its own entry.
    // What this case pins is the first half going while `agents.json` — protected,
    // so not a reason to open a fence — stays fenced.
    !protectedWs.outOfScope.some((e) => e.startsWith("Every file under agents/")),
    `the sentence goes for the unprotected tests/, and nothing drops because of the protected agents.json (got ${JSON.stringify(protectedWs.outOfScope)})`,
  );

  const protectedOnly = workstreamFromArgs(
    ws({ paths: [".github/workflows/ci.yml"], outOfScope: ["All files under .github/"] }),
  );
  assert(
    protectedOnly.outOfScope.length === 1,
    `a fence naming only a PROTECTED declaration survives (got ${JSON.stringify(protectedOnly.outOfScope)})`,
  );
}

// ────────────────────────────── 3. a clip record never outlives the entry it
// describes (#1744's rule, applied to this drop): a record whose entry the prose
// rule removed goes with it, and the records of SURVIVING entries do not.
{
  // One sentence carrying a token the workstream declares, and long enough to
  // clip: it is BOTH a clip and a self-fence, so it is the case that could leave
  // a ` …[clipped]` marker hanging on an entry that is not in the list.
  const selfFenceSentence = `Every file under tests/ — ${"x".repeat(600)}`;
  const w = workstreamFromArgs(ws({ outOfScope: [selfFenceSentence] }));
  assert(
    w.outOfScope.length === 0,
    `a clipped prose self-fence leaves nothing behind (got ${JSON.stringify(w.outOfScope.map((e) => e.slice(0, 20)))})`,
  );
  assert(
    w.outOfScopeClipped?.some((r) => r.kind === "clipped" && r.entry === selfFenceSentence) !==
      true,
    `and its clip record goes with it (got ${JSON.stringify(w.outOfScopeClipped?.map((r) => r.kind))})`,
  );

  const mixedLong = `the legacy layer ${"which must not be touched ".repeat(24)}`;
  const mixed = workstreamFromArgs(ws({ outOfScope: [mixedLong, FIELD] }));
  assert(
    mixed.outOfScopeClipped?.some((r) => r.kind === "clipped") === true,
    `the surviving long entry keeps its clip record (got ${JSON.stringify(mixed.outOfScopeClipped?.map((r) => r.kind))})`,
  );
  assert(
    !mixed.outOfScope.includes(FIELD),
    `and the prose self-fence still goes in the same call (got ${JSON.stringify(mixed.outOfScope.map((e) => e.slice(0, 20)))})`,
  );
}

process.exit(exit);
