#!/usr/bin/env bun
/**
 * #784 — annotation stripping in `normaliseScopePath` (the module-local
 * fence-side normaliser in work-driver-scope-fanout.ts).
 *
 * `normaliseScopePath` is module-local (not exported), so this test exercises
 * it through `runScopeFanoutGate`'s observable behaviour — the same seam the
 * gate's other tests use — and pins the paren-strip rule the issue asks to
 * mirror from `normaliseDeclaredPath`, including:
 *
 *   - balanced trailing annotations ("(new)" / "(no changes)") are stripped,
 *     on BOTH the in-scope `paths` side and the `outOfScope` fence side;
 *   - an UNTERMINATED trailing parenthetical (the 778.json shape — no
 *     closing paren) is stripped from the first " (" to end of string;
 *   - a parenthetical INSIDE a real filename ("docs/notes (draft).md")
 *     survives (mirror of test-workstream-path-normalise.ts's canary);
 *   - directory-style fence entries keep working after the strip
 *     (trailing-slash handling + the startsWith(declared + "/") arm);
 *   - the `work-driver-verify-develop-helpers.ts` export (a SEPARATE symbol)
 *     is byte-for-byte unchanged: its "src/a.ts (new)" output is still
 *     UNSTRIPPED, i.e. it does not do annotation stripping.
 */

import { runScopeFanoutGate } from "../src/work-driver-scope-fanout.ts";
import { normaliseScopePath as helperNormaliseScopePath } from "../src/work-driver-verify-develop-helpers.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

type WS = { id: string; scope: string; paths: string[]; outOfScope: string[] };

function run(ws: WS, changed: string[]) {
  const failures: string[] = [];
  const notes: string[] = [];
  runScopeFanoutGate(
    { a: ws },
    new Map([["a", new Set(changed)] as [string, Set<string>]]),
    failures,
    notes,
  );
  return { failures, notes };
}

const FENCE = /developer touched out-of-scope path .+ — declared fence violated/;

// ------------------------------------------ annotation stripping — FENCE side
//
// A fence entry annotated "(new)" used to be dead text (never matching a git
// path); after the strip it must match, i.e. produce a fence failure when the
// file is touched and undeclared.

{
  const { failures } = run(
    { id: "a", scope: "x", paths: ["other.ts"], outOfScope: ["fenced.ts (new)"] },
    ["fenced.ts"],
  );
  assert(
    failures.some((f) => FENCE.test(f) && /fenced\.ts/.test(f)),
    `fence-side: "fenced.ts (new)" is stripped and matches a touched fenced.ts (got: ${failures.join("; ")})`,
  );
}
{
  const { failures } = run(
    { id: "a", scope: "x", paths: ["other.ts"], outOfScope: ["fenced.ts (no changes)"] },
    ["fenced.ts"],
  );
  assert(
    failures.some((f) => FENCE.test(f) && /fenced\.ts/.test(f)),
    `fence-side: "fenced.ts (no changes)" is stripped and matches (got: ${failures.join("; ")})`,
  );
}

// --------------------------------------------------- annotation stripping —
// the IN-SCOPE paths side: an annotated path entry must still cover its file
// (the file counts as declared — no fence hit, no undeclared fanout).

{
  const { failures, notes } = run(
    { id: "a", scope: "x", paths: ["own.ts (new)"], outOfScope: [] },
    ["own.ts", "b1.ts", "b2.ts", "b3.ts", "b4.ts", "b5.ts", "b6.ts", "b7.ts", "b8.ts"],
  );
  // 8 undeclared vs limit max(1*3, 6) = 6 → fanout failure IS expected, but
  // own.ts itself must NOT be among the undeclared files listed.
  const fanout = failures.find((f) => f.startsWith("scope fanout:"));
  assert(
    !!fanout && !/own\.ts/.test(fanout),
    `in-scope side: "own.ts (new)" still covers own.ts — it is declared, not counted undeclared (got: ${failures.join("; ")})`,
  );
  assert(
    !!fanout &&
      fanout.startsWith("scope fanout: 8 undeclared file(s) changed vs 1 declared"),
    `in-scope side: declared count is 1 for an annotated path entry (got: ${fanout ?? "no fanout failure"})`,
  );
  assert(
    notes.length === 0,
    `in-scope side: no notes for a fully-declared touch (got: ${notes.join("; ")})`,
  );
}

// --------------------------------------------- unterminated trailing paren
//
// 778.json shape: the fence entry's annotation has no closing paren. A naive
// balanced-only strip leaves the annotation in the entry, so it can never
// match — pin that the unterminated form is stripped down to the path.

{
  const fenceEntry =
    "extension/smoke-tests/test-work-driver-mechanized-commit.ts (any change to what consolidation stages — work-driver-integrate.ts / work-driver-cherry-pick.ts — is out of scope; do not add the “moved”/“covered” schema shape — that is task-c)";
  const { failures } = run(
    { id: "a", scope: "x", paths: ["other.ts"], outOfScope: [fenceEntry] },
    ["extension/smoke-tests/test-work-driver-mechanized-commit.ts"],
  );
  assert(
    failures.some((f) =>
      /developer touched out-of-scope path extension\/smoke-tests\/test-work-driver-mechanized-commit\.ts/.test(
        f,
      ),
    ),
    `unterminated: an unbalanced " (…" annotation is stripped, so the fence entry matches (got: ${failures.join("; ")})`,
  );
}

// ------------------------------------ unterminated, NO closing paren at all
//
// The issue's "unterminated" shape is a fence entry whose annotation has no
// closing paren anywhere (the 778.json prose describes this). Pass 1 (balanced
// "(…)") cannot fire, so this pins pass 2 — the " (…" to end-of-string strip.
// A naive balanced-only strip leaves the annotation in the entry and the
// fence can never match the touched file.
{
  const fenceEntry =
    "extension/smoke-tests/test-work-driver-mechanized-commit.ts (any change to what consolidation stages — work-driver-integrate.ts / work-driver-cherry-pick.ts — is out of scope; do not add the moved/covered schema shape — that is task-c";
  const { failures } = run(
    { id: "a", scope: "x", paths: ["other.ts"], outOfScope: [fenceEntry] },
    ["extension/smoke-tests/test-work-driver-mechanized-commit.ts"],
  );
  assert(
    failures.some((f) =>
      /developer touched out-of-scope path extension\/smoke-tests\/test-work-driver-mechanized-commit\.ts/.test(
        f,
      ),
    ),
    `unterminated (no close): a " (…" annotation with NO closing paren is stripped, so the fence entry matches (got: ${failures.join("; ")})`,
  );
}

// --------------------------------------- parenthetical INSIDE a real filename
//
// Mirror of test-workstream-path-normalise.ts's canary: "docs/notes
// (draft).md" has content AFTER the parenthetical, so it is a filename, not a
// trailing annotation — the strip must leave it intact, and a touched
// "docs/notes (draft).md" must not match a bare "docs/notes" fence entry…
// rather: the fence entry EQUAL to that filename must still match it.

{
  const fname = "docs/notes (draft).md";
  const { failures } = run(
    { id: "a", scope: "x", paths: ["other.ts"], outOfScope: [fname] },
    [fname],
  );
  assert(
    failures.some((f) => /developer touched out-of-scope path docs\/notes \(draft\)\.md/.test(f)),
    `canary: "docs/notes (draft).md" survives the strip (only a TRAILING annotation is stripped) (got: ${failures.join("; ")})`,
  );
}

// ------------------------------------------------------ directory-style fence
//
// matchesScopePath has a startsWith(declared + "/") arm; the strip must not
// break trailing-slash handling or directory-prefix fencing.

{
  const { failures } = run(
    { id: "a", scope: "x", paths: ["other.ts"], outOfScope: ["src/foo/"] },
    ["src/foo/bar.ts"],
  );
  assert(
    failures.some((f) => /developer touched out-of-scope path src\/foo\/bar\.ts/.test(f)),
    `directory fence: "src/foo/" (trailing slash) still fences the whole tree (got: ${failures.join("; ")})`,
  );
}
{
  const { failures } = run(
    { id: "a", scope: "x", paths: ["other.ts"], outOfScope: ["src/foo (new)"] },
    ["src/foo/bar.ts"],
  );
  assert(
    failures.some((f) => /developer touched out-of-scope path src\/foo\/bar\.ts/.test(f)),
    `directory fence: annotated "src/foo (new)" strips to "src/foo" and still fences the tree (got: ${failures.join("; ")})`,
  );
}

// ----------------------------------- helpers normaliser: byte-for-byte guard
//
// The exported normaliseScopePath in work-driver-verify-develop-helpers.ts is
// a SEPARATE symbol used for diff-side path collection. It must remain
// unchanged — no annotation stripping — pinned here by asserting its output
// for an annotated input is still UNSTRIPPED.

{
  const got = helperNormaliseScopePath("src/a.ts (new)");
  assert(
    got === "src/a.ts (new)",
    `helpers: exported normaliseScopePath is unchanged — "src/a.ts (new)" stays unstripped (got: ${JSON.stringify(got)})`,
  );
}
{
  const got = helperNormaliseScopePath("./src/a.ts/");
  assert(
    got === "src/a.ts",
    `helpers: exported normaliseScopePath still does its bare ./ + trailing-slash normalisation (got: ${JSON.stringify(got)})`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
