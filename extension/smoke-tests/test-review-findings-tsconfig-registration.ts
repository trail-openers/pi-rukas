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
/** Resolved ONCE, high in the file: (a) needs its set of branch-added paths and
 * (b) needs the whole result, and two calls would run the same four git probes
 * twice and could disagree if the clone moved in between. */
const added = branchAddedTestFiles();
const addedPaths = added.ok ? added.paths : [];
const addedSet = new Set(addedPaths);
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
// No `try` around the scan, and no "every glob compiles" assertion. The earlier
// shape had both, on the stated belief that `new RegExp` is "the one step that
// can reject" for an entry carrying a stray `(` or a dangling `\`. Measured
// false: generating every RegExp source the escaper above produces for this
// project's glob entries, plus `src/**)/*` (the candidate a lens review asserted
// WAS reachable) and six other paren/brace shapes, reached the `catch` ZERO times
// out of nine. The escaper is the reason, and it is the whole reason: its first
// step escapes `()` (among `.+^${}()|[\]\`), so by the time `RegExp` sees the
// string there is no metacharacter left unescaped and no unbalanced group to
// reject. A `catch` on an unreachable path is worse than no `catch`: it converts
// a hypothetical fault into a branch no test can redden, and the assertion built
// on it (`globProblems.length === 0`) is green whether or not the code it judges
// exists. An entry that matched nothing is still judged, and named, by the empty
// check below — which is the failure this gate actually exists for.
assert(
  globs.length > 0,
  `tsconfig-registration (a2): \`include\` carries glob entries to judge (found ${globs.length})`,
);
const globCounts = new Map<string, number>();
for (const g of globs) {
  globCounts.set(g, globMatches(g));
}
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
/** The base `branchAddedTestFiles` compares against, or why it could not be
 * named. Every arm is REPORTED, not swallowed: the whole reason (b) exists is
 * that a registration check which quietly judges nothing reads as one that
 * passed, and the arm that used to answer "no base" was a bare `catch` that
 * printed nothing about WHICH precondition failed. */
type BaseResolution =
  /** The base ref `git merge-base` resolved against, for the message. */
  | { ok: true; base: string; paths: string[] }
  | { ok: false; reason: string };

/** Run one git command, returning its stdout, or a named reason it failed.
 * `--quiet` is not enough on its own: `git rev-parse --verify --quiet` on a
 * missing object exits 0 and prints NOTHING, so every caller of this tests the
 * stdout and not only the exit code — a check on "the command did not throw"
 * would treat a `git merge-base <base> HEAD` against a shallow checkout as a
 * success and hand back an empty base. */
function gitOut(repoRoot: string, args: string[]): { out?: string; reason: string } {
  try {
    return { out: execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" }), reason: "" };
  } catch (err) {
    const detail = String((err as Error)?.message ?? err).split("\n")[0] ?? "";
    return { reason: `\`git ${args.join(" ")}" failed: ${detail}`.slice(0, 220) };
  }
}

/** Every ref in the clone that points at the mainline, by name. A `git
 * for-each-ref` over BOTH namespaces, because the two are set by different
 * things: `refs/remotes/origin/<m>` exists when the remote-tracking ref was
 * fetched, `refs/heads/<m>` when the branch was checked out locally. Neither is
 * a precondition the previous code was willing to assume and none was reported.
 */
function mainlineRefs(repoRoot: string, mainline: string): string[] {
  const res = gitOut(repoRoot, [
    "for-each-ref",
    "--format=%(refname)",
    `refs/remotes/*/${mainline}`,
    `refs/heads/${mainline}`,
  ]);
  if (!res.out) return [];
  return res.out.split("\n").map((l) => l.trim()).filter((l) => l !== "");
}

/** Resolve the ref (s) compares HEAD against. Explicit `PI_ENSEMBLE_TSCONFIG_BASE`
 * wins; otherwise the first of `origin/<m>`, `remotes/origin/<m>`, `<m>` that
 * resolves, where `<m>` is the clone's own mainline — and the mainline itself
 * comes from `origin/HEAD`, then `git symbolic-ref HEAD`, rather than from a
 * hard-coded `main`.
 *
 * WHY NOT THE SINGLE HARD-CODED `origin/main` THIS USED TO ASSUME, and what it
 * cost: the CI checkout is `actions/checkout@v7` at its default `fetch-depth: 1`,
 * which fetches only the PR merge ref — so `origin/main` is not a valid object
 * there, `git merge-base` throws, the `catch` returned `{ ok: false }`, and the
 * one assertion that says "(b) is judging something" was red on EVERY CI run of
 * this file while the file's own green count hid that (b) had never run. It is
 * not a checkout bug to route around (and `.github/` is a protected path this
 * change must not edit): it is the assumption being load-bearing. The fix is to
 * resolve whatever base the clone ACTUALLY has and, when it has none, to name
 * the reason — fail-closed, never silently green.
 */
function resolveBaseRef(repoRoot: string): { base?: string; reason: string } {
  const forced = process.env.PI_ENSEMBLE_TSCONFIG_BASE;
  if (forced !== undefined && forced !== "") {
    const verify = gitOut(repoRoot, ["rev-parse", "--verify", "--quiet", `${forced}^{commit}`]);
    return verify.out?.trim()
      ? { base: forced, reason: "" }
      : { reason: `PI_ENSEMBLE_TSCONFIG_BASE=${JSON.stringify(forced)} is not a commit` };
  }
  // The mainline's NAME, from the two places a clone records it. A detached
  // checkout with no `origin/HEAD` yields neither, which is reported below
  // rather than answered with a guess at `main`.
  const candidates: string[] = [];
  for (const args of [
    ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
    ["symbolic-ref", "--quiet", "HEAD"],
  ]) {
    const res = gitOut(repoRoot, args);
    const ref = res.out?.trim();
    if (ref) candidates.push(ref.replace(/^refs\/(remotes\/)?/, "").replace(/^origin\//, ""));
  }
  const mainlines = [...new Set(candidates.filter((c) => c !== ""))];
  if (mainlines.length === 0) {
    return {
      reason:
        "this clone names no mainline: no refs/remotes/origin/HEAD and HEAD is detached, " +
        "so there is no <m> to compare against. Set PI_ENSEMBLE_TSCONFIG_BASE to a commit " +
        "this branch diverged from (a shallow CI checkout that fetched only the PR ref " +
        "lands here, and (b) then judges nothing).",
    };
  }
  for (const m of mainlines) {
    for (const ref of mainlineRefs(repoRoot, m)) {
      const verify = gitOut(repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      if (verify.out?.trim()) return { base: ref, reason: "" };
    }
  }
  return {
    reason: `no mainline ref resolves in this clone: looked for ${JSON.stringify(
      mainlines.flatMap((m) => [`origin/${m}`, m]),
    )} — a fetch-depth:1 checkout that took only the PR ref has neither, so (b) judges " +
      "nothing. Set PI_ENSEMBLE_TSCONFIG_BASE to a reachable commit.`,
  };
}

function branchAddedTestFiles(): BaseResolution {
  const repoRoot = path.join(EXT_ROOT, "..");
  const resolved = resolveBaseRef(repoRoot);
  if (!resolved.base) return { ok: false, reason: resolved.reason };
  const mergeBase = gitOut(repoRoot, ["merge-base", resolved.base, "HEAD"]);
  const baseSha = mergeBase.out?.trim();
  if (!baseSha) {
    return {
      ok: false,
      reason: `\`git merge-base ${resolved.base} HEAD\` produced nothing (${mergeBase.reason || "empty output"}) — HEAD may not share history with the base`,
    };
  }
  const diff = gitOut(repoRoot, ["diff", "--name-only", baseSha, "HEAD"]);
  // `out === undefined` is the failure; the EMPTY string is the legitimate
  // answer for a HEAD that is the base (a shallow checkout whose only object is
  // HEAD, or a branch with no test-file changes). `!diff.out` would call a real
  // empty diff a fault and print a reason that blames a readable diff.
  if (diff.out === undefined) {
    return { ok: false, reason: `the diff against ${baseSha} could not be read: ${diff.reason}` };
  }
  return {
    ok: true,
    base: `${resolved.base}@${baseSha.slice(0, 12)}`,
    paths: diff.out
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
assert(
  added.ok,
  `tsconfig-registration (b): the branch diff against the base is readable, so the registration check is actually judging something${added.ok ? ` (base=${JSON.stringify(added.base)})` : ` — ${added.reason}`}`,
);
const listed = new Set(entries);
const unlisted = addedPaths.filter((p) => !listed.has(p));
// The one legitimate reason a branch-touched test sits outside this project is
// that it carries the pre-existing type-error backlog — which is why the file
// is a ratchet and not the whole tree (its own header says so). A file named
// here is a claim about the backlog, so it is named, not silently skipped.
const BACKLOG_EXEMPT = new Set(["smoke-tests/test-review-accept-layers.ts"]);
const unregistered = unlisted.filter((p) => !BACKLOG_EXEMPT.has(p));
assert(
  unregistered.length === 0,
  `tsconfig-registration (b): every test/lib file this branch added is in \`include\` or declared backlog-exempt (${addedPaths.length} added; unregistered=${JSON.stringify(unregistered)})`,
);

process.exit(exit);
