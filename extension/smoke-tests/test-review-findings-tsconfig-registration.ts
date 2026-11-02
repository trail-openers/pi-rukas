#!/usr/bin/env bun
/**
 * #1934 — the tsconfig.smoke-tests.json `include` list cannot fail to fail.
 *
 * WHAT REGISTRATION BUYS, precisely. This project type-checks the merge-guard
 * test seam through a SECOND project file, `extension/tsconfig.smoke-tests.json`,
 * whose `include` names each clean test file by hand (the whole smoke-tests tree
 * carries a pre-existing type-error backlog `tsconfig.json` never saw). The list
 * is a **typecheck ratchet, not the runner**: `verify-loop.sh` receives whatever
 * file list the caller expands (its own comment: "The caller expands the glob; the
 * script receives the file list"), so an unregistered `test-*.ts` still EXECUTES.
 * Registration buys tsc coverage for the file and nothing more — which is still
 * what went wrong on the sibling branch, where two test files shipped named
 * nowhere and were therefore never type-checked.
 *
 * THE HOLE THIS CLOSES is that the list has no failure mode of its own. Measured,
 * not assumed: a `tsc -p` run over a JSONC whose `include` names a file that does
 * not exist prints nothing and exits **0** (the diagnostic people expect, TS1435,
 * was NOT reproducible here and is not claimed). So misspell one entry and that
 * file is simply never judged while the type-check stays green — the same
 * silent-unjudged shape as never listing it at all.
 *
 * THIS GATE CLOSES IT IN BOTH DIRECTIONS:
 *   (a) every explicit, non-glob entry in `include` resolves to a real file, so
 *       a bogus / renamed / deleted-path entry reddens here rather than going
 *       silently unjudged;
 *   (b) every test file THIS branch added is listed, so a new test cannot ship
 *       outside the type-check by never being named.
 *
 * The file is read as TEXT, never parsed: it is JSONC — the comment block above
 * `include` is the project's rationale and `JSON.parse` throws on it — so the
 * scan is an anchored text walk over the `"include": [ … ]` array. Anchored, so
 * a `"files"` or `"exclude"` array elsewhere in the file is not mistaken for it;
 * and if the anchor itself is gone, that is reported as the failure it is rather
 * than as "nothing to check".
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const EXT_ROOT = path.join(import.meta.dirname, "..");
const TSCONFIG = process.env.PI_TSCONFIG_UNDER_TEST ?? path.join(EXT_ROOT, "tsconfig.smoke-tests.json");

/** Strip `//` and block comments the way the scanner needs to: a string is a
 * string, so a `//` inside one (a path, a URL) does not start a comment. This
 * is NOT a JSON parser — it only lets the entry scan see the array's real
 * extent, which is why it never validates the rest of the document. */
function withoutComments(src: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let escaped = false;
  while (i < src.length) {
    const c = src[i];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** The string entries of the `"include": [ … ]` array, in file order. */function includeEntries(src: string): { found: boolean; entries: string[] } {
  const stripped = withoutComments(src);
  const anchor = stripped.match(/"include"\s*:\s*\[/);
  if (!anchor || anchor.index === undefined) return { found: false, entries: [] };
  const body = stripped.slice(anchor.index + anchor[0].length);
  const end = body.indexOf("]");
  if (end < 0) return { found: false, entries: [] };
  // `exec` driven from the loop BODY, not by an assignment in the condition:
  // the latter is the shape Biome refuses and a reader has to re-read.
  const entries: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  re.lastIndex = 0;
  for (;;) {
    const m = re.exec(body.slice(0, end));
    if (m === null) break;
    // `m[1]` is the capture group; it is only `undefined` when the whole match
    // is empty, which the `"…"` pattern cannot produce, so `?? ""` keeps the
    // type honest without hiding a real absence (an empty entry fails (a) as a
    // missing file, which is the loud direction).
    entries.push(m[1] ?? "");
  }
  return { found: true, entries };
}

const raw = readFileSync(TSCONFIG, "utf8");
const { found, entries } = includeEntries(raw);
assert(
  found,
  'tsconfig-registration: `"include": [` is present and closed in tsconfig.smoke-tests.json',
);

/** The entry this gate itself is registered under. It is exempt from (a): the
 * file is written in the same commit that lists it, so requiring it to exist
 * BEFORE this commit would make the very act of registering it a red. It is
 * still checked by the scan's own self-witness below, and (b) requires it. */
const SELF = "smoke-tests/test-review-findings-tsconfig-registration.ts";

// (a) Every explicit, non-glob entry resolves to a real file — every entry
// this branch did not add, plus any earlier entry that has since gone stale.
const addedSet = new Set(branchAddedTestFiles().paths);
const explicit = entries.filter((e) => !e.includes("*") && e !== SELF && !addedSet.has(e));
const missing = explicit.filter((e) => !existsSync(path.join(EXT_ROOT, e)));
// The stale entry this gate found on the branch it was written for, recorded
// rather than deleted: `test-plan-gate-judges-reported-1862.ts` sits in
// `include` and exists in no tree of this repository at any commit, so its
// presence there has always been a no-op. It is a pre-existing entry on the
// mainline the sibling branch also reviews, and #1934 does not own it — so the
// ratchet is pinned at the set below rather than silently widened. A NEW stale
// entry, or any change to this set, reddens (a).
const KNOWN_STALE_ENTRIES = new Set(["smoke-tests/test-plan-gate-judges-reported-1862.ts"]);
const novel = missing.filter((e) => !KNOWN_STALE_ENTRIES.has(e));
assert(
  novel.length === 0,
  `tsconfig-registration (a): every pre-existing explicit entry resolves to a file, modulo the pinned stale set (${explicit.length} checked; unexpected=${JSON.stringify(novel)})`,
);
const stillStale = [...KNOWN_STALE_ENTRIES].filter(
  (e) => entries.includes(e) && existsSync(path.join(EXT_ROOT, e)),
);
assert(
  stillStale.length === 0,
  `tsconfig-registration (a): the pinned stale entries are still stale — delete the pin when one is fixed (${JSON.stringify(stillStale)})`,
);

// (a2) Every GLOB entry in `include` matches at least one real file. Arm (a)
// skips anything containing `*`, so before this a glob that matched nothing was
// invisible to BOTH the gate and the compiler: `tsc -p` over such an entry
// prints nothing and exits 0 (the same silent-unjudged shape as a misspelt
// explicit path), and the list keeps the entry as if it were doing work. A
// glob is registered precisely to pull a set of files into the type-check, so
// an empty match means the type-check silently excludes them all.
//
// How many real files an `include` glob entry resolves to, counted from the
// tsconfig's own directory the way tsc resolves it. Implemented over the file
// system rather than a shell: an entry is untrusted text this gate reads out of
// a config file, and handing it to `bash -c` would make the gate a command
// injection surface for the very file it audits. Only `*` is honoured as a
// wildcard (every glob entry this project has uses it). `**` is expanded the
// way TypeScript's `include` expands it — a `**/` segment also matches ZERO
// directories, so `scripts/**/*.ts` reaches `scripts/a.ts`. A matcher that
// required `**` to consume a directory reported this project's own
// `src/**/*` and `scripts/**/*` as empty, which would have made the gate fail
// on entries that are working. The gate's complaint is about an entry that
// could match and does not, so an entry whose WHOLE match set is empty is what
// reddens below, not one traversal step.
function globMatches(pattern: string): number {
  // Translate the entry to a regular expression over a whole repo-relative path,
  // which is what makes the semantics stateable instead of hopeful:
  //   `**/`  -> `(?:.*/)?`   a directory path, OR nothing — TS lets the last
  //                          segment of `scripts/**/*.ts` name `scripts/a.ts`,
  //                          and this project's real `scripts/**/*` judges the
  //                          two files directly under `scripts/`.
  //   `**`   -> `.*`         crosses `/`.
  //   `*`    -> `[^/]*`      stays inside one segment.
  //   `?`    -> `[^/]`       one character inside one segment.
  // Three earlier readings of this all failed the same way and for the same
  // reason — they treated `**` as a thing that must consume a directory (and,
  // before that, as a literal directory), so this project's own `src/**/*` and
  // `scripts/**/*` came back empty. Those two entries are the positive controls:
  // `tsc --listFilesOnly` judges files under both, so any translation that
  // calls them empty is wrong, and a ratchet whose first red is a working entry
  // gets its first assertion edited rather than its bug fixed.
  const body = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000DIR\u0000")
    .replace(/\*+/g, (m) => (m.length > 1 ? ".*" : "[^/]*"))
    .replace(/\?/g, "[^/]")
    .replace(/\u0000DIR\u0000/g, "(?:.*/)?");
  const re = new RegExp(`^${body}$`);
  let count = 0;
  const seen = new Set<string>();
  const walk = (dir: string, depth: number) => {
    if (depth > 24) return; // a symlink cycle would otherwise recurse forever
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      const rel = path.relative(EXT_ROOT, full);
      let isFile = false;
      try {
        isFile = statSync(full).isFile();
      } catch {
        continue;
      }
      if (isFile) {
        if (re.test(rel) && !seen.has(rel)) {
          seen.add(rel);
          count++;
        }
        continue;
      }
      if (name === "node_modules" || name === ".git") continue;
      walk(full, depth + 1);
    }
  };
  walk(EXT_ROOT, 0);
  return count;
}
const globs = entries.filter((e) => e.includes("*"));
// Each entry's scan is judged INDIVIDUALLY, and a throw is a named red for THAT
// entry rather than an exception that ends the run. The pattern is untrusted
// text read out of a config file, and `new RegExp` is the one step that can
// reject: an entry carrying a stray `(` or a dangling `\` throws `SyntaxError`
// out of `globMatches`, and unhandled that aborts the whole file — the same
// silent-green shape as a setup throw outside a `try`, where the run reports
// every other check green and this one never ran. `RegExp` validity is also
// asserted separately below so a broken pattern is named as a broken pattern
// and not only as "no files matched".
assert(
  globs.length > 0,
  `tsconfig-registration (a2): \`include\` carries glob entries to judge (found ${globs.length})`,
);
const globProblems: string[] = [];
const globCounts = new Map<string, number>();
for (const g of globs) {
  try {
    globCounts.set(g, globMatches(g));
  } catch (err) {
    globProblems.push(`${g}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
// A malformed pattern is a CONFIGURATION fault and must be said as one: a
// throw from `new RegExp` would otherwise be swallowed into the empty-match
// bucket below and blamed on the entry matching nothing.
assert(
  globProblems.length === 0,
  `tsconfig-registration (a2): every glob entry compiles as a pattern (${JSON.stringify(globProblems)})`,
);
const emptyGlobs = globs.filter((g) => (globCounts.get(g) ?? -1) === 0);
assert(
  emptyGlobs.length === 0,
  `tsconfig-registration (a2): every glob entry matches at least one real file (${JSON.stringify(globs)}; empty=${JSON.stringify(emptyGlobs)})`,
);
// The positive controls, asserted rather than described. `src/**/*` and
// `scripts/**/*` are the two entries this project depends on being NON-EMPTY:
// `tsc --listFilesOnly` judges files under both, so an empty count means this
// gate's own matcher is wrong, not that the config is. Without these two lines
// the (a2) arm above passed vacuously whenever the entry scan yielded nothing
// — a matcher that returns 0 for everything is green, exactly the failure mode
// the header says three earlier readings had.
for (const control of ["src/**/*", "scripts/**/*"]) {
  assert(
    (globCounts.get(control) ?? 0) > 0,
    `tsconfig-registration (a2) self-witness: the positive control \`${control}\` matches NON-ZERO files (count=${String(globCounts.get(control))})`,
  );
}

// (b) Every test file this branch added is listed. `include` is relative to the
// tsconfig's own directory (`extension/`), so the branch paths are rebased
// before comparison.
function branchAddedTestFiles(): { ok: boolean; paths: string[] } {
  const repoRoot = path.join(EXT_ROOT, "..");
  const base = process.env.PI_ENSEMBLE_TSCONFIG_BASE ?? "origin/main";
  let out = "";
  try {
    const mergeBase = execFileSync("git", ["-C", repoRoot, "merge-base", base, "HEAD"], {
      encoding: "utf8",
    }).trim();
    out = execFileSync("git", ["-C", repoRoot, "diff", "--name-only", mergeBase, "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    // No base to compare against (shallow clone, missing remote ref). (b) then
    // checks nothing, and says so — a gate that silently narrows is the defect
    // this file exists to prevent.
    return { ok: false, paths: [] };
  }
  return {
    ok: true,
    paths: out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^extension\/smoke-tests\/(test-.*|lib\/.*)\.ts$/.test(l))
      .map((l) => l.slice("extension/".length)),
  };
}

// The self-check first: if the anchor scan broke, `entries` empties and (b)
// would pass vacuously on a branch that added files, which is the failure mode
// this file exists to prevent.
assert(
  entries.includes(SELF),
  `tsconfig-registration: this file is listed in \`include\` (${SELF})`,
);
const added = branchAddedTestFiles();
assert(
  added.ok,
  "tsconfig-registration (b): the branch diff against the base is readable, so the registration check is actually judging something",
);
const listed = new Set(entries);
const unlisted = added.ok ? added.paths.filter((p) => !listed.has(p)) : [];
// The one legitimate reason a branch-touched test sits outside this project is
// that it carries the pre-existing type-error backlog — which is why the file
// is a ratchet and not the whole tree (its own header says so). A file named
// here is a claim about the backlog, so it is named, not silently skipped.
const BACKLOG_EXEMPT = new Set(["smoke-tests/test-review-accept-layers.ts"]);
const unregistered = unlisted.filter((p) => !BACKLOG_EXEMPT.has(p));
assert(
  unregistered.length === 0,
  `tsconfig-registration (b): every test/lib file this branch added is in \`include\` or declared backlog-exempt (${added.paths.length} added; unregistered=${JSON.stringify(unregistered)})`,
);

process.exit(exit);
