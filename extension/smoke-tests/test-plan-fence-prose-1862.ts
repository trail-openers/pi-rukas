/**
 * #1862 (a), the fold's half: a PROSE `outOfScope` entry goes in `foldTwo` when
 * the sentence names a path that covers a path the MERGED workstream declares
 * itself — and only then.
 *
 * The field case, from the cycle the issue names: a docs workstream's
 * `"Every file under agents/ and tests/ — this workstream documents, it does not
 * implement"` survived a merge into the workstream whose `paths` are under
 * `agents/` and `tests/`. Read as a fence the sentence matches nothing; read as
 * an instruction in the developer's prompt it forbids the files the issue asked
 * for, and the develop gate's fence arm then judges each of them a violation.
 *
 * #1862's scope cut is load-bearing for WHERE these cases live: the drop lives
 * in `foldTwo` and nowhere else. A planner-authored self-contradiction on a
 * SINGLE workstream is left in place — the `contradictory-fence` corrective
 * (#1167) steers the planner on it — so the only site that removes a fence is
 * the one that created the contradiction by unioning two halves. Driven through
 * `foldTwo` directly, so the assertion is about what a merged workstream
 * actually carries.
 *
 * The controls are the load-bearing part. A rule that deletes fences it cannot
 * read is worse than a useless fence, so every case that must NOT drop anything
 * is pinned beside the case that must.
 */

import type { Workstream } from "../src/workflow-state-schema.ts";
import { foldMerged, foldSelfFenceNotes } from "./lib/fold-two-helpers.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.log(`✗ ${msg}`);
    exit = 1;
  }
}

/** The SURVIVING half — the workstream whose declared paths the merged fence
 * list is judged against (`foldTwo` reads `a.id` and the union of both halves'
 * paths, so this is the half the controls are about). */
const implement = (over: Partial<Workstream> = {}): Workstream => ({
  id: "implement",
  scope: "implement the change",
  paths: over.paths ?? ["tests/test_x.py", "agents/x.md"],
  outOfScope: over.outOfScope ?? [],
});

/** The ABSORBED half — the docs workstream that carries the prose fence. */
const document = (over: Partial<Workstream> = {}): Workstream => ({
  id: "document",
  scope: "document the change",
  paths: over.paths ?? ["docs/readme.md"],
  outOfScope: over.outOfScope ?? [],
});

const FIELD =
  "Every file under agents/ and tests/ — this workstream documents, it does not implement";

// ────────────────────────────── 1. the field case: the sentence is gone from a
// merged workstream that owns the directories it names, and the OTHER exclusions
// stay.
{
  const merged = foldMerged(implement(), document({ outOfScope: [FIELD, ".ci/", "nothing else"] }));
  assert(
    !merged.outOfScope.includes(FIELD),
    `the prose fence over the merged workstream's own directories is dropped (got ${JSON.stringify(merged.outOfScope)})`,
  );
  assert(
    merged.outOfScope.includes(".ci/") && merged.outOfScope.includes("nothing else"),
    `and the entries naming nothing it declared survive (got ${JSON.stringify(merged.outOfScope)})`,
  );
}

// ────────────────────────────── 2. the controls: a rule this side of the fence
// has to refuse every one of these. The SECURITY half of the contract: a drop is
// a scope widening, so an entry that protects ANYONE but the merged workstream —
// a sibling, a protected path, an undeclared subtree — is kept WHOLE. A fence is
// one instruction; the driver cannot remove half a sentence.
{
  // A sibling's files — the #572 cross-declaration contract. The sentence names
  // `src/` and neither half declares anything under `src/`.
  const sibling = foldMerged(
    implement({ paths: ["docs/readme.md"] }),
    document({ outOfScope: ["Every file under src/ — owned by the implement workstream"] }),
  );
  assert(
    sibling.outOfScope.length === 1,
    `a prose fence over a SIBLING's directory is kept (got ${JSON.stringify(sibling.outOfScope)})`,
  );

  // Prose that names no path at all: nothing to compare it against.
  const vague = foldMerged(
    implement({ paths: ["docs/readme.md"] }),
    document({ outOfScope: ["nothing else", "no new dependencies"] }),
  );
  assert(
    vague.outOfScope.length === 2,
    `prose naming no path is kept (got ${JSON.stringify(vague.outOfScope)})`,
  );

  // A substring is not a token: prose about `docs` cannot name `docsfoo/`. The
  // absorbed half declares nothing under `docs/`, so the ONLY thing in the
  // merged union the sentence could name is the lookalike directory — and a rule
  // that read a prefix as a path would open this fence.
  const lookalike = foldMerged(
    implement({ paths: ["docsfoo/x.md", "src/legacy/a.ts"] }),
    document({ paths: [], outOfScope: ["Everything under docs/ and src/legacy/ is frozen"] }),
  );
  assert(
    lookalike.outOfScope.length === 1,
    `prose naming a directory that only LOOKS like a declared one is kept (got ${JSON.stringify(lookalike.outOfScope)})`,
  );

  // A path-shaped entry goes by the CONTAINMENT arm (the plan-quality gate's own
  // rule, reached through the shared `selfFenceEntryDrop`) and an undeclared one
  // stays — one entry, one grammar (#1725).
  const pathShaped = foldMerged(implement(), document({ outOfScope: ["tests/", "src/legacy/"] }));
  assert(
    !pathShaped.outOfScope.includes("tests/") && pathShaped.outOfScope.includes("src/legacy/"),
    `a directory fence over the merged subtree goes by the containment arm while an undeclared one stays (got ${JSON.stringify(pathShaped.outOfScope)})`,
  );

  // MIXED self + sibling: the sentence names TWO directories the merged
  // workstream owns and ONE it does not. Before #1862 round 1 the fold's prose
  // reader dropped the entry as soon as one token was owned, which silently
  // removed the sibling's protection with it. One unowned token holds the whole
  // entry.
  const mixedSibling = foldMerged(
    implement(),
    document({ outOfScope: ["Every file under agents/, tests/ and src/legacy/ is frozen"] }),
  );
  assert(
    mixedSibling.outOfScope.length === 1,
    `a mixed self+sibling sentence SURVIVES whole — the sibling's path holds the fence (got ${JSON.stringify(mixedSibling.outOfScope)})`,
  );

  // MIXED self + protected: the same rule from the other side. `.github/` is
  // protected, so naming it is never a reason to open a fence, and the rest of
  // the sentence goes with it.
  const mixedProtected = foldMerged(
    implement({ paths: ["tests/test_x.py"] }),
    document({ outOfScope: ["Every file under tests/ and .github/workflows/ is frozen"] }),
  );
  assert(
    mixedProtected.outOfScope.length === 1,
    `a mixed self+protected sentence SURVIVES whole (got ${JSON.stringify(mixedProtected.outOfScope)})`,
  );

  // A PROTECTED declaration is never a reason to open a fence, even when every
  // OTHER token in the sentence is owned. The field's sentence names `agents/`
  // and `tests/`; here `agents.json` is declared too, and the sentence is held
  // by the protected spelling rather than opened by it.
  const protectedWs = foldMerged(
    implement({ paths: ["agents.json", "tests/test_x.py"] }),
    document({ outOfScope: [FIELD] }),
  );
  assert(
    protectedWs.outOfScope.some((e) => e.startsWith("Every file under agents/")),
    `the sentence survives because it names a protected path the merged workstream declares (got ${JSON.stringify(protectedWs.outOfScope)})`,
  );

  const protectedOnly = foldMerged(
    implement({ paths: [".github/workflows/ci.yml"] }),
    document({ outOfScope: ["All files under .github/"] }),
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
  // One sentence carrying a token the merged workstream declares, and long enough
  // that the tool boundary clipped it: it is BOTH a clip and a self-fence, so it
  // is the case that could leave a ` …[clipped]` marker hanging on an entry that
  // is not in the merged list.
  const selfFenceSentence = `Every file under tests/ — ${"x".repeat(600)}`;
  const clipped = foldMerged(
    implement(),
    document({ outOfScope: [selfFenceSentence.slice(0, 200) + " …[truncated]"] }),
  );
  // The sentence's clipped head still names `tests/`, so the fold removes it; the
  // point is that nothing is left pointing at an entry the list no longer holds.
  assert(
    !clipped.outOfScope.some((e) => e.startsWith("Every file under tests/")),
    `a clipped prose self-fence leaves nothing behind (got ${JSON.stringify(clipped.outOfScope.map((e) => e.slice(0, 24)))})`,
  );
  assert(
    !(clipped.outOfScopeClipped ?? []).some(
      (r) => r.kind === "clipped" && (r.entry as string).startsWith("Every file under tests/"),
    ),
    `and its clip record goes with it (got ${JSON.stringify(clipped.outOfScopeClipped?.map((r) => r.kind))})`,
  );

  const mixedLong = `the legacy layer ${"which must not be touched ".repeat(24)}`;
  const mixed = foldMerged(implement(), document({ outOfScope: [mixedLong, FIELD] }));
  assert(
    mixed.outOfScopeClipped?.some((r) => r.kind === "clipped") === true,
    `the surviving long entry keeps its clip record (got ${JSON.stringify(mixed.outOfScopeClipped?.map((r) => r.kind))})`,
  );
  assert(
    !mixed.outOfScope.includes(FIELD),
    `and the prose self-fence still goes in the same fold (got ${JSON.stringify(mixed.outOfScope.map((e) => e.slice(0, 24)))})`,
  );
}

// ────────────────────────────── 4. every drop is RECORDED, not just applied:
// the fold's own notes name each removal, so the state file says which fence
// went (a fence the merge opened and nothing named is the disclosure failure
// this issue is about).
{
  const notes = foldSelfFenceNotes(implement(), document({ outOfScope: [FIELD, "tests/"] }));
  assert(
    notes.length === 2 && notes.every((n) => n.startsWith("self-fence dropped: ")),
    `both removals are recorded on the fold's own note channel (got ${JSON.stringify(notes)})`,
  );
  assert(
    notes.every((n) => n.includes("(merged workstream)")),
    `and each note says the authority that opened it was the merge (got ${JSON.stringify(notes)})`,
  );
}

// ────────────────────────────── 5. the SCOPE CUT: a self-fence the planner wrote
// itself on a SINGLE workstream is NOT dropped anywhere. The tool boundary used
// to delete it, which hid the contradiction from the #1167 corrective; now it
// stays in the stored list and the gate steers the planner on it.
{
  const single = implement({ outOfScope: [FIELD, "tests/"] });
  assert(
    single.outOfScope.includes(FIELD) && single.outOfScope.includes("tests/"),
    `an un-merged workstream keeps every fence the planner wrote, self-contradictory or not (got ${JSON.stringify(single.outOfScope)})`,
  );
}

process.exit(exit);
