/**
 * #1862 (b) — a stringified JSON array arriving as one `outOfScope` entry is
 * split into its members by the fence bound, and anything the bound cannot read
 * as a list of paths is kept as ONE entry, unchanged.
 *
 * Driven through `boundOutOfScope` directly, which PM decision 5 names as the
 * seam: Pi's schema check (`Type.Array(Type.String(...))`, no `Type.Union`)
 * refuses a call whose `outOfScope` is a bare string, so no tool-boundary test
 * can produce the shape. `test-plan-outofscope-bound-1744.ts` is the existing
 * home for this module's cases and drives it the same way.
 *
 * The base behaviour this replaces: `splitFenceList` refused the entry (its
 * segments carry quotes and brackets, so they fail `plannedPathProblem`) and
 * `clipFenceEntryOf` then cut it at `WORKSTREAM_FENCE_MAX` — one entry that
 * fences nothing, clipped. Every assertion below is therefore RED on the base
 * commit, and the base run was observed.
 */

import { boundOutOfScope } from "../src/plan-fence-bound.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.log(`✗ ${msg}`);
    exit = 1;
  }
}

// ────────────────────────────── 1. the field shape: a planner's array written
// as one stringified value becomes its members, IN ORDER, with the entries
// around it where they were.
{
  const out = boundOutOfScope(['["docs/","tests/"]', "src/a.ts"]);
  assert(
    JSON.stringify(out.entries) === JSON.stringify(["docs/", "tests/", "src/a.ts"]),
    `a stringified array splits into its members (got ${JSON.stringify(out.entries)})`,
  );
}

// ────────────────────────────── 2. a single-member array splits too — the
// developer reads `docs/`, not `["docs/"]`, and one entry fences as one entry
// either way.
{
  const out = boundOutOfScope(['["docs/"]']);
  assert(
    JSON.stringify(out.entries) === JSON.stringify(["docs/"]),
    `a one-member array becomes its member (got ${JSON.stringify(out.entries)})`,
  );
}

// ────────────────────────────── 3. every member is judged by the planner's own
// path grammar, exactly as a comma-list segment is. A member with a glob is not
// a member (`tests/**` is a fence spelling the FENCE grammar owns and the path
// grammar refuses), so the whole value stays one entry rather than being
// half-split into a list that silently means something different.
{
  const glob = boundOutOfScope(['["docs/","tests/**"]']);
  assert(
    glob.entries.length === 1 && glob.entries[0] === '["docs/","tests/**"]',
    `an array with a glob member is kept whole (got ${JSON.stringify(glob.entries)})`,
  );
  const prose = boundOutOfScope(['["docs/","tests/**"]']);
  assert(
    prose.entries.length === 1,
    `a second refused member keeps the whole value (got ${JSON.stringify(prose.entries)})`,
  );
  // The mirror case: a member the grammar ALREADY accepts as a name with a
  // space in it (`docs/my file.md` is a real Next.js-style declaration) is a
  // member. Refusing every spaced string would refuse real paths.
  const spaced = boundOutOfScope(['["docs/my file.md","tests/"]']);
  assert(
    JSON.stringify(spaced.entries) === JSON.stringify(["docs/my file.md", "tests/"]),
    `an array whose member is a real path containing a space still splits (got ${JSON.stringify(spaced.entries)})`,
  );
}

// ────────────────────────────── 4. shapes the bound cannot read stay exactly
// as they came — no structure invented, no partial split.
{
  // A SENTENCE cannot be told from a spaced real path by shape alone: the
  // planner's grammar deliberately admits `docs/my file.md` (Next.js routes,
  // `app/(group)/page.tsx`), so an array member with a space in it is admitted
  // too. What refuses a member is the grammar's own refusals — a glob, a shell
  // character, an absolute path, a `..` segment, an over-long string — and this
  // case pins that the split is judged by the SAME predicate the comma-list arm
  // uses, not by a stricter one the bound invents.
  const refused = [
    '["docs/","/etc/passwd"]',
    '["docs/","../secret"]',
    '["docs/","src/$(id).ts"]',
    '["docs/","-rf"]',
  ];
  for (const entry of refused) {
    const out = boundOutOfScope([entry]);
    assert(
      out.entries.length === 1 && out.entries[0] === entry,
      `${entry} — a member the path grammar refuses keeps the whole value as one entry (got ${JSON.stringify(out.entries)})`,
    );
  }
}

// ────────────────────────────── 5. the split is not a licence to drop the
// bound's other jobs: a split member that duplicates another one collapses, and
// a split member's collapse is COUNTED (an uncounted one is a fence that
// silently vanished). Duplicates are only counted for split members, so the two
// members of one array are the case that bills.
{
  const out = boundOutOfScope(['["docs/","tests/","docs/"]']);
  assert(
    JSON.stringify(out.entries) === JSON.stringify(["docs/", "tests/"]),
    `a member duplicating another member collapses (got ${JSON.stringify(out.entries)})`,
  );
  assert(
    out.thisPass.duplicate === 1,
    `and the collapse is counted as a duplicate, not silently gone (got ${JSON.stringify(out.thisPass)})`,
  );
}

// ────────────────────────────── 6. a member over the path bound is not a
// member: a 400-character "path" inside brackets is a sentence, same rule as
// the comma-list arm.
{
  const long = "a".repeat(200);
  const out = boundOutOfScope([`["${long}/${long}","docs/"]`]);
  assert(
    out.entries.length === 1,
    `an array whose member is over the path bound is kept whole (got ${out.entries.length} entries)`,
  );
}

// ────────────────────────────── 7. an entry the array arm leaves alone reaches
// the pre-existing arms exactly as it did: the over-long clip still fires on the
// same call that carries an array.
{
  const longWord = "x".repeat(600);
  const out = boundOutOfScope([longWord, '["docs/"]']);
  assert(
    out.thisPass.clipped === 1,
    `a long prose entry is still clipped beside a split array (got ${JSON.stringify(out.thisPass)})`,
  );
  assert(
    out.entries.includes("docs/"),
    `and the array member is kept (got ${JSON.stringify(out.entries.map((e) => e.slice(0, 12)))})`,
  );
}

process.exit(exit);
