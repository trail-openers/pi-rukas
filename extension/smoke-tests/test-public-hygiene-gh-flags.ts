#!/usr/bin/env bun
/**
 * public-hygiene-gh-flags (#1792 final round) — the literal per-(noun, verb)
 * flag tables `scanGhPublish` now looks up instead of filtering on every call
 * are pinned against the derived rule that generated them.
 *
 * The literals exist for a reason (one lookup per publish instead of three
 * `Object.fromEntries(Object.entries(…).filter(…))` chains), and a literal is
 * exactly the shape that drifts from the rule it claims to encode: an entry
 * edited by hand, a verb added to `GH_PUBLISH_VERBS` with no table, a `-n`
 * landing on the wrong side for one release verb. Each case here is a difference
 * between the table and the rule, and the only honest answer is a failure.
 *
 * The behavioural half matters as much as the equality half: the tables are read
 * through `scanGhPublish`, so the assertions are on what a command actually
 * contributes. All terms are synthetic — this repository is public.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type GhFlagPair,
  GH_PUBLISH_FLAGS,
  buildGhFlagTables,
  ghFlagKey,
} from "../src/public-hygiene-gh-flags.ts";
import { scanGhPublish, ghPublishNoun } from "../src/public-hygiene-verbs.ts";
import type { PublishScan } from "../src/public-hygiene-types.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

/** Every (noun, verb) pair the scan admits. DERIVED from the scan's own verb
 * set rather than listed by hand, so a verb added to `GH_PUBLISH_VERBS` with no
 * table fails here instead of looking up `undefined` at runtime. */
function admittedPairs(): [string, string][] {
  const pairs: [string, string][] = [];
  for (const noun of ["issue", "pr", "release"]) {
    for (const verb of ["create", "edit", "comment", "review"]) {
      const argv = ["gh", noun, verb];
      if (ghPublishNoun(argv) === noun) pairs.push([noun, verb]);
    }
  }
  return pairs;
}

const PAIRS: readonly (readonly [string, string])[] = admittedPairs();

// ── 0. The pair list is not empty, and covers the release verbs (so a broken
// derivation cannot make block 1 vacuously true).
{
  const keys = PAIRS.map(([n, v]) => ghFlagKey(n, v));
  assert(
    keys.includes("release-create") && keys.includes("release-edit"),
    `the pairs cover both release verbs (got ${keys.join(", ")})`,
  );
  assert(PAIRS.length >= 7, `the pairs cover every publish noun and verb (${PAIRS.length})`);
}

// ── 1. Every pair has a table, and every table is what the rule derives.
{
  for (const [noun, verb] of PAIRS) {
    const key = ghFlagKey(noun, verb);
    const actual: GhFlagPair | undefined = GH_PUBLISH_FLAGS[key];
    assert(actual !== undefined, `the table has an entry for ${key}`);
    // The FILE table's KEY ORDER is part of the behaviour this module pins: a
    // cluster of the long form before the short form is the shape that lets a
    // `-n` cluster shadow `--notes-file` in `fileFlagOf`'s first-match loop. The
    // rule appends in source order, so the comparison is order-sensitive on purpose.
    const expected = buildGhFlagTables(noun, noun === "release" && verb === "edit");
    assert(
      JSON.stringify(actual?.file) === JSON.stringify(expected.file),
      `${key}: the FILE table matches the rule (got ${JSON.stringify(actual?.file)})`,
    );
    assert(
      JSON.stringify(actual?.text) === JSON.stringify(expected.text),
      `${key}: the TEXT table matches the rule (got ${JSON.stringify(actual?.text)})`,
    );
    // A word claimed by BOTH readers is the bug that reads a PATH as prose and
    // never opens the file (#1792): the two tables must be disjoint.
    const overlap = Object.keys(actual?.file ?? {}).filter((f) => f in (actual?.text ?? {}));
    assert(overlap.length === 0, `${key}: no flag is claimed by both readers (${overlap})`);
  }
}

// ── 2. `-n` is the rule's whole point, so it is asserted in both directions.
{
  assert(
    "-n" in (GH_PUBLISH_FLAGS["release-create"]?.text ?? {}),
    "release create: -n is the notes TEXT",
  );
  assert(
    !("-n" in (GH_PUBLISH_FLAGS["release-create"]?.file ?? {})),
    "release create: -n is not a file flag",
  );
  assert(
    "-n" in (GH_PUBLISH_FLAGS["release-edit"]?.file ?? {}),
    "release edit: -n is the notes FILE",
  );
  assert(
    !("-n" in (GH_PUBLISH_FLAGS["release-edit"]?.text ?? {})),
    "release edit: -n is not a text flag",
  );
  for (const noun of ["issue", "pr"]) {
    assert(
      !("-n" in (GH_PUBLISH_FLAGS[noun]?.text ?? {})) &&
        !("-n" in (GH_PUBLISH_FLAGS[noun]?.file ?? {})),
      `${noun}: -n is the no-body switch, read by neither reader`,
    );
    assert(
      !("--notes" in (GH_PUBLISH_FLAGS[noun]?.text ?? {})),
      `${noun}: --notes is not a gh ${noun} flag`,
    );
  }
  // `-F` is the OTHER dual: a body file for issue/pr, a notes file for both
  // release verbs (gh 2.102.0). It is never inline prose.
  for (const key of ["issue", "pr", "release-create", "release-edit"]) {
    assert("-F" in (GH_PUBLISH_FLAGS[key]?.file ?? {}), `${key}: -F is a FILE flag`);
    assert(!("-F" in (GH_PUBLISH_FLAGS[key]?.text ?? {})), `${key}: -F is not a text flag`);
  }
}

const dir = mkdtempSync(path.join(tmpdir(), "hygiene-gh-flags-"));
const NOTES_TEXT = "release notes body SYNTHETIC-TERM";
writeFileSync(path.join(dir, "notes.md"), NOTES_TEXT, "utf8");

function fresh(): PublishScan {
  return { publishes: false, texts: [], problems: [] } as unknown as PublishScan;
}

const textsOf = (scan: PublishScan): string[] => scan.texts.map((t) => t.text);

// ── 3. Behaviour through the reader: the file/text split the tables encode is
// the split `scanGhPublish` actually applies. These are the shapes the old
// per-call filter chains decided, and the whole point is that the lookup decides
// them identically.
{
  // `-Fnotes.md` (glued short FILE) is opened, not scanned as prose: the text
  // list carries the file's CONTENTS, which only `readPublishFile` produces.
  const glued = fresh();
  scanGhPublish(["gh", "issue", "create", "-Fnotes.md"], dir, glued);
  assert(
    textsOf(glued).includes(NOTES_TEXT),
    `-Fnotes.md is read as a FILE (got ${JSON.stringify(textsOf(glued))})`,
  );
  assert(
    !textsOf(glued).includes("notes.md"),
    "and the PATH never reaches the text list as inline prose",
  );

  // The same file flag on a release publish.
  const rel = fresh();
  scanGhPublish(["gh", "release", "create", "-F", "notes.md"], dir, rel);
  assert(
    textsOf(rel).includes(NOTES_TEXT),
    `release create -F notes.md is read as a FILE (got ${JSON.stringify(textsOf(rel))})`,
  );

  // `-n` for release create is TEXT: the literal is scanned, nothing is opened.
  const nText = fresh();
  scanGhPublish(["gh", "release", "create", "-nhello"], dir, nText);
  assert(
    textsOf(nText).includes("hello"),
    `release create -nhello is the notes text (got ${JSON.stringify(textsOf(nText))})`,
  );

  // `-n` for release edit is a FILE: the literal would be a nonexistent path, so
  // a reader that treated it as text would report `hello` and never fail.
  const nFile = fresh();
  scanGhPublish(["gh", "release", "edit", "v1.0.0", "-n", "notes.md"], dir, nFile);
  assert(
    textsOf(nFile).includes(NOTES_TEXT),
    `release edit -n notes.md is the notes FILE (got ${JSON.stringify(textsOf(nFile))})`,
  );
  assert(
    !textsOf(nFile).includes("notes.md"),
    "and the notes path is not scanned as prose",
  );

  // `--notes` stays TEXT for both release verbs, and `--notes-file` a FILE.
  const notes = fresh();
  scanGhPublish(["gh", "release", "edit", "v1", "--notes", "inline prose"], dir, notes);
  assert(
    textsOf(notes).includes("inline prose"),
    "--notes is the notes text for release edit",
  );

  // An issue's `-n` is a switch: its own name is never collected as prose.
  const switchy = fresh();
  scanGhPublish(["gh", "issue", "create", "--title", "hi", "-n"], dir, switchy);
  assert(
    textsOf(switchy).length === 1 && textsOf(switchy)[0] === "hi",
    `an issue's -n contributes no text (got ${JSON.stringify(textsOf(switchy))})`,
  );
}

rmSync(dir, { recursive: true, force: true });
process.exit(exit);
