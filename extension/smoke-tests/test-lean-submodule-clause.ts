#!/usr/bin/env bun
/**
 * lean/submodule-clause — the disclosure's own wording, bounded and honest.
 *
 * Three rules the clause owes its reader, none of which the pass's own notes can vouch for:
 *
 *   (a) the "some"/"all" prefix is decided by the tree's OWN denominator — the number of
 *       submodules the base registers — not by how many notes happened to arrive. The defect:
 *       counting notes against unpopulated paths reads one registered submodule and one
 *       unproven path as `1 < 1` false, and prints "all" for a tree whose one submodule was
 *       merely not proven;
 *   (b) the path list is BOUNDED. A base carrying two hundred submodules produced a clause
 *       twenty-six thousand characters long, which every consumer then clipped away entirely —
 *       so the disclosure that exists to be read was the first thing dropped;
 *   (c) the clause says only what this step MEASURED. It used to assert that nothing on the
 *       host could supply the bytes and that the base's own verify had run without them — two
 *       claims about the host and about history that no command here ever asked. What was
 *       measured is that the superproject holds neither a module store nor a populated checkout
 *       for these paths, so this step seeded nothing there.
 */

import {
  type SubmoduleNote,
  notesFor,
  submoduleNoteClause,
} from "../src/lean/specify-submodules.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`\u2713 ${msg}`);
  else {
    console.error(`\u2717 ${msg}`);
    exit = 1;
  }
}

/**
 * The tree's denominator, and the two ways a pass's own notes fail to supply it.
 *
 * The bug: "some" was decided by counting NOTES against unpopulated PATHS. Notes are what the
 * pass happened to write down, so the prefix described the step's bookkeeping rather than the
 * tree — and for a base that registers one submodule, a path git reported as unproven and a pass
 * that wrote nothing else made the two counts equal, which is exactly the case where the prefix
 * has to be right about which of the tree's paths it is naming. The fix derives the denominator
 * from the registered count the pass carries, and says the qualified form only when something
 * PROVED a registered path is not among the unpopulated ones.
 */
{
  // The case the finding names: a base carrying ONE submodule whose path git reports unproven.
  const one = notesFor(["vendor/a"]);
  const oneClause = submoduleNoteClause(one) ?? "";
  assert(
    oneClause.includes('"vendor/a"'),
    `(a) one registered submodule whose path git reports unproven names that path (got ${oneClause})`,
  );

  const mixed: SubmoduleNote[] = [
    { path: "vendor/ok", kind: "seeded", detail: "/x/.git/modules/vendor/ok", unproven: ["vendor/ghost"] },
    { path: "vendor/b", kind: "absent", detail: "nothing here" },
  ];
  const mixedClause = submoduleNoteClause(mixed) ?? "";
  assert(
    mixedClause.startsWith("some submodules"),
    `(a) a pass that restored one path while another went unproven reads SOME (got ${mixedClause})`,
  );
  assert(
    mixedClause.includes('"vendor/ghost"') && mixedClause.includes('"vendor/b"'),
    `(a) and it names every path that came back unpopulated (got ${mixedClause})`,
  );

  // THE discriminating case, read off the original's own bytes (`unpopulated.size < notes.length`,
  // i.e. PATHS compared against NOTES). Three notes name two distinct paths, and both of them are
  // missing: `2 < 3` said "some", about a base whose every submodule the pass failed to supply.
  // A note is an act of bookkeeping, not a submodule — the count on both sides has to be paths.
  const allMissing: SubmoduleNote[] = [
    { path: "vendor/a", kind: "absent", detail: "nothing here" },
    { path: "vendor/a", kind: "failure", detail: "git refused" },
    { path: "vendor/b", kind: "absent", detail: "nothing here" },
  ];
  const allMissingClause = submoduleNoteClause(allMissing) ?? "";
  assert(
    !allMissingClause.startsWith("some "),
    `(a) three notes naming two paths, both missing, does NOT read SOME — the old read compared paths against NOTES and said \`2 < 3\` (got ${allMissingClause})`,
  );

  // A path the step PROVED restored, beside one that came back missing, is the mixture the
  // prefix exists to describe: the counter-evidence is a path that came back, not a number.
  const restored: SubmoduleNote[] = [
    { path: "vendor/ok", kind: "seeded", detail: "/x/.git/modules/vendor/ok", expect: "lib" },
    { path: "vendor/b", kind: "absent", detail: "nothing here" },
  ];
  const restoredClause = submoduleNoteClause(restored) ?? "";
  assert(
    restoredClause.startsWith("some submodules"),
    `(a) a tree with one restored submodule and one missing one reads SOME (got ${restoredClause})`,
  );
  assert(
    !restoredClause.includes('"vendor/ok"') && restoredClause.includes('"vendor/b"'),
    `(a) and it names only the path that came back missing (got ${restoredClause})`,
  );

  // The unqualified form is still earned: when git's own read says every registered path is
  // unpopulated, the denominator and the unpopulated set agree, and the reader is told ALL.
  const all = notesFor(["vendor/a", "vendor/b"]);
  const allClause = submoduleNoteClause(all) ?? "";
  assert(
    !allClause.startsWith("some "),
    `(a) and when every registered path is unpopulated the clause says so unqualified (got ${allClause})`,
  );

  // A note carrying git's unproven finding for a SECOND path: the unproven path is itself
  // unpopulated, so it is never counter-evidence, and nothing here proved any other path arrived.
  const carried: SubmoduleNote[] = [{ path: "vendor/a", kind: "absent", detail: "", unproven: ["vendor/b"] }];
  const carriedClause = submoduleNoteClause(carried) ?? "";
  assert(
    !carriedClause.startsWith("some "),
    `(a) and an unproven path carried on a note does not by itself earn "some" (got ${carriedClause})`,
  );
}

// ── (b) the bound
{
  const wide: SubmoduleNote[] = Array.from({ length: 200 }, (_, i) => ({
    path: `vendor/deep/${"segment-".repeat(6)}${String(i)}`,
    kind: "absent" as const,
    detail: "nothing here",
  }));
  const clause = submoduleNoteClause(wide) ?? "";
  assert(
    clause.includes('"+192 more"') || clause.includes("(+192 more)"),
    `(b) 200 unpopulated paths collapse to a cap plus how many more (got ${clause.slice(0, 200)}…)`,
  );
  assert(
    clause.length <= 1000,
    `(b) and the whole clause stays inside one reason line — 200 paths used to make ${String(
      26806,
    )} chars that every consumer clipped away (got ${String(clause.length)})`,
  );
  const quoted = clause.split('"').length - 1;
  assert(
    quoted <= 16,
    `(b) and no more than 8 paths are quoted even when the paths themselves are long (quoted ${String(quoted)})`,
  );
  const long: SubmoduleNote[] = Array.from({ length: 8 }, (_, i) => ({
    path: `vendor/${"x".repeat(500)}-${String(i)}`,
    kind: "absent" as const,
    detail: "nothing here",
  }));
  const longClause = submoduleNoteClause(long) ?? "";
  assert(
    longClause.length <= 1000,
    `(b) and eight very long paths are clipped too, not printed whole (got ${String(longClause.length)})`,
  );
  assert(
    !longClause.includes("x".repeat(500)),
    "(b) and an individual path is bounded, so one absurd name cannot carry the line",
  );
}

// ── (c) only what was measured
{
  const clause = submoduleNoteClause([{ path: "vendor/a", kind: "absent", detail: "" }]) ?? "";
  assert(
    !/nothing on this host could supply/.test(clause),
    `(c) the clause no longer claims the whole host was searched (got ${clause})`,
  );
  assert(
    !/verify ran without/.test(clause),
    `(c) and no longer claims what the base commit's verify did — never measured here (got ${clause})`,
  );
  assert(
    /superproject/.test(clause) && /seed(ed)? nothing/.test(clause),
    `(c) and says what WAS measured: the superproject holds neither a module store nor a populated checkout, so this step seeded nothing there (got ${clause})`,
  );
}

process.exit(exit);
