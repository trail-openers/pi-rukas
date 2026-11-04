#!/usr/bin/env bun
/**
 * Fixture-git-env ratchet — no smoke-test fixture spawns git with the inherited
 * environment (#1981).
 *
 * Git honours `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` / `GIT_COMMON_DIR`
 * and the rest of `GIT_LOCATION_VARS` AHEAD of `-C <path>` and ahead of `cwd`.
 * A fixture that makes commits with those inherited from the launching shell
 * therefore writes them into whoever's repository the variables name, and git
 * exits 0 doing it: no stderr, no failed assertion, only stray commits authored
 * `t <t@t>`. That is the shape #1981 was filed from — `test-headless-host-contract.ts`'s
 * own `mkRepo`/`gitCommit`/`headOf` helpers committed fixture history into a
 * real checkout.
 *
 * The braces are `lib/git-test-env.ts`: `gitTestEnv()` returns the isolated
 * config env AND deletes every location variable from the copy it hands back.
 * `env: gitTestEnv()` is the sanctioned form. It cannot be replaced by an
 * ambient `gitTestEnv()` call, because bun drops `process.env` mutations on
 * synchronous spawns — the env has to be threaded into the child options, which
 * is exactly what this gate checks.
 *
 * The runner-level `unset` in lib/verify-loop.sh stays the belt (out of scope
 * here, per the issue), but a fixture may not rely on it: `bun run <file>` —
 * how a diagnosing agent, an editor or a one-off repro invokes a test — inherits
 * the shell environment verbatim and never passes through the runner.
 *
 * **The check.** Every `.ts` under `extension/smoke-tests/` is scanned
 * recursively (test files, `lib/`, helpers), `*-live.ts` excluded as the offline
 * tier excludes it. A call to one of the spawn bindings with git as its
 * executable must carry an `env:` inside its own argument list, which is
 * delimited by paren depth so a following call cannot satisfy it. Two
 * exemptions, both narrow:
 *
 *   - a file whose call already names `GIT_LOCATION_VARS` / `scrubGitLocation`
 *     in its source: that call is being made under a scrub built at its own
 *     site, and the deletion is what matters, not which function performed it
 *     (an over-broad `delete k where k starts with "GIT_"` qualifies too);
 *   - an entry in ALLOWED, which is empty by construction: a git call with the
 *     inherited env has no safe shape, so a new offender fixes the call rather
 *     than joining a list. Read-only is not an exemption either — with `GIT_DIR`
 *     inherited, `rev-parse HEAD` answers from the wrong repository and the
 *     assertion built on it is silently about something else.
 *
 * **Scope: `lib/` gated now, the per-file suites by disclosed backlog.** A
 * shared `lib/` seam carries NO exemption — those are the helpers many fixtures
 * import, so one unscrubbed helper leaks through every caller at once, and
 * `git-worktree-fixture.ts`, `clean-repo-fixture.ts` and `headless-s5-git.ts`
 * are asserted in scope by name at the bottom of this file. The per-file suites
 * whose git calls predate #1981 are listed in `lib/fixture-git-env-backlog.ts`,
 * written from this scan's own output when the gate landed. That list is a
 * backlog, not an exemption channel: the assertion below fails if it GROWS, so
 * a fixture written today is judged by the rule and every conversion deletes
 * its own row. Converting the rest is the work AC2 scopes.
 *
 * **Proven in both directions** (AGENTS.md §6): the canaries below write a
 * fixture with one bare call and one threaded call into a temp dir and assert
 * the scanner reports the first and spares the second, plus the three call
 * shapes that must not be mistaken for a git spawn — `execp("true")`, `gh`
 * (which takes an `env` option and has no location vars) and a git hook that
 * names a script rather than git.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SCAN_EXEMPT, SCAN_EXEMPT_CEILING } from "./lib/fixture-git-env-backlog.ts";

const REPO_ROOT = path.join(import.meta.dirname, "..", "..");
const SMOKE_DIR = path.join(import.meta.dirname, ".");

/** The bindings that reach a real git child. */
const SPAWN_BINDINGS = ["spawnSync", "execFileSync", "execFileP", "execFile", "execSync", "execp"];

/**
 * `<binding>( [fallback||] "git" [delimiter]`. The delimiter keeps a fixture
 * that builds a git command out of concatenated string fragments out of the
 * scan: `execSync("git" + " status …")` names no executable at all.
 */
const GIT_CALL = new RegExp(
  `\\b(?:${SPAWN_BINDINGS.join("|")})\\s*\\(\\s*(?:fixtureGitExecutable\\(\\)\\s*\\|\\|\\s*)?["'\`]git["'\`]?\\s*[,)\\]]`,
);

/**
 * Files the scan never reads, named explicitly — an implicit exclusion is
 * indistinguishable from a gap (`test-file-size-limit.ts`'s lesson). The
 * generated trees hold fixtures OTHER tests write at run time: a gate that read
 * them would be judging whatever the last run left behind.
 */
const EXCLUDED_DIRS = new Set(["artifacts", "fixtures", "node_modules"]);

/** A comment line states rather than spawns, so it is never a site. */
const COMMENT = /^\s*(\*|\/\*|\/\/)/;

/** A call whose own argument list carries an `env:` option is scrubbed by contract. */
const ENV_OPT = /\benv\s*:/;

/** The markers of a call that scrubs the location vars at its own site. */
const SITE_SCRUB_MARKERS = [/GIT_LOCATION_VARS/, /scrubGitLocation/, /startsWith\("GIT_"/];

/**
 * Files allowed to spawn git without an `env:` option. EMPTY BY CONSTRUCTION:
 * there is no shape of an inherited `GIT_DIR` that a fixture survives, so a
 * violation is fixed by threading `env: gitTestEnv()` (or the file's own
 * scrubbed env), not by adding a row here.
 */
const ALLOWED: readonly string[] = [];

/** The text of one call: from the match to the line whose parens close it. */
function callWindow(lines: string[], from: number): string {
  let depth = 0;
  const out: string[] = [];
  for (let i = from; i < Math.min(from + 12, lines.length); i++) {
    const line = lines[i] as string;
    out.push(line);
    for (const ch of line) {
      if (ch === "(") depth++;
      else if (ch === ")" && --depth <= 0) return out.join("\n");
    }
    if (depth <= 0) return out.join("\n");
  }
  return out.join("\n");
}

/**
 * The unscrubbed git calls in one file's text. `siteScrubbed` says the file
 * builds a scrubbed env for its git calls at the site (it names the location
 * vars itself), which is the same deletion under a different name.
 */
export function findUnscrubbedGitCalls(
  text: string,
): { lineNo: number; line: string; siteScrubbed: boolean }[] {
  const lines = text.split("\n");
  const siteScrubbed = SITE_SCRUB_MARKERS.some((re) => re.test(text));
  const sites: { lineNo: number; line: string; siteScrubbed: boolean }[] = [];
  lines.forEach((line, i) => {
    if (COMMENT.test(line) || !GIT_CALL.test(line)) return;
    if (ENV_OPT.test(callWindow(lines, i))) return;
    sites.push({ lineNo: i + 1, line: line.trim(), siteScrubbed });
  });
  return sites;
}

function listTsFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry)) listTsFiles(full, out);
    }
    // `*-live.ts` is the offline tier's exclusion, applied here for the same
    // reason: it is not part of the run this ratchet guards.
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts") && !entry.endsWith("-live.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Every unscrubbed git call the ratchet sees, as `{ file, lineNo, line }`. */
export function scanSmokeTests(
  root: string,
): { file: string; lineNo: number; line: string }[] {
  const base = path.join(root, "extension", "smoke-tests");
  const here = path.join(import.meta.dirname, "test-fixture-git-env.ts");
  const offenders: { file: string; lineNo: number; line: string }[] = [];
  const allowed = new Set(ALLOWED);
  const exempt = new Set(SCAN_EXEMPT);
  for (const file of listTsFiles(base)) {
    // Keyed relative to the suite directory, so an entry is a bare test file
    // name or a `lib/…` path. A key in any other form silently exempts
    // nothing, which is the fail-open shape `test-file-size-limit.ts` names.
    const rel = path.relative(SMOKE_DIR, file).replace(/\\/g, "/");
    // This file documents the patterns it hunts, so it must not trip on them.
    if (file === here || allowed.has(rel) || exempt.has(rel)) continue;
    const text = readFileSync(file, "utf8");
    for (const s of findUnscrubbedGitCalls(text)) {
      if (s.siteScrubbed) continue;
      offenders.push({ file: `extension/smoke-tests/${rel}`, lineNo: s.lineNo, line: s.line });
    }
  }
  return offenders.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.lineNo - b.lineNo));
}

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ── The gate CAN fail, and does not over-match. A gate never observed red is
// worthless (AGENTS.md §6), so the scanner is driven over written fixtures.
{
  const fix = mkdtempSync(path.join(tmpdir(), "pi-fixture-git-env-"));
  try {
    writeFileSync(
      path.join(fix, "bad.ts"),
      [
        'import { execFileP } from "node:util";',
        'const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });',
        'await execFileP("git", ["commit", "-q", "-m", "x"], { cwd: repo });',
      ].join("\n"),
    );
    const bad = findUnscrubbedGitCalls(readFileSync(path.join(fix, "bad.ts"), "utf8"));
    assert(
      bad.length === 2 && bad.every((s) => !s.siteScrubbed),
      `canary: a fixture that spawns git with no env option is reported at each site (${bad.length})`,
    );

    writeFileSync(
      path.join(fix, "good.ts"),
      [
        'const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd, env: gitTestEnv() });',
        "await execFileP(",
        '  "git",',
        '  ["init", "-q", dir],',
        "  {",
        "    encoding: \"utf8\",",
        "    env: gitTestEnv(),",
        "  },",
        ");",
      ].join("\n"),
    );
    assert(
      findUnscrubbedGitCalls(readFileSync(path.join(fix, "good.ts"), "utf8")).length === 0,
      "canary: the same calls with an env option are clean, inline and multi-line alike",
    );

    // A non-git spawn, and one whose argument list ENDS before a later call's
    // env option: only an env inside the git call's own parens counts.
    writeFileSync(
      path.join(fix, "shapes.ts"),
      [
        'await execp("true", { cwd: dir });',
        'await execFileP("gh", ["pr", "view"], { cwd: dir, env: gitTestEnv() });',
        'execFileSync("git", ["rev-parse", "HEAD"], { cwd });',
        'execFileSync("gh", ["issue", "view"], { cwd, env: gitTestEnv() });',
        'await execSync("git" + " status --porcelain", { cwd });',
      ].join("\n"),
    );
    const shapes = findUnscrubbedGitCalls(readFileSync(path.join(fix, "shapes.ts"), "utf8"));
    assert(
      shapes.length === 1 && shapes[0]?.lineNo === 3,
      `canary: gh/true/concatenated-command calls are spared, and a later call's env does not cover an earlier git call (reported at ${shapes.map((s) => s.lineNo).join(",")})`,
    );

    // A file that deletes the location vars itself is clean even without the
    // shared helper's name in it.
    writeFileSync(
      path.join(fix, "own-scrub.ts"),
      [
        "for (const k of Object.keys(env)) if (k.startsWith(\"GIT_\")) delete env[k];",
        'const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });',
      ].join("\n"),
    );
    const own = findUnscrubbedGitCalls(readFileSync(path.join(fix, "own-scrub.ts"), "utf8"));
    assert(
      own.length === 1 && own[0].siteScrubbed,
      "canary: a fixture that scrubs at its own site is exempted, and only through that flag",
    );

    // Comments and docstrings never spawn.
    writeFileSync(
      path.join(fix, "prose.ts"),
      ['// execFileSync("git", ["commit"]) is the leak this gate hunts.', "/** … */"].join("\n"),
    );
    assert(
      findUnscrubbedGitCalls(readFileSync(path.join(fix, "prose.ts"), "utf8")).length === 0,
      "canary: a comment naming the pattern is not a violation",
    );

    // The allowlist is not a way to silence a real offender: it is consulted by
    // file, and it is empty.
    assert(ALLOWED.length === 0, "the exemption list is empty — a new offender fixes its call");
    // The backlog is a backlog only while it shrinks. Growth means a fixture
    // was taught to leak rather than fixed, so the gate reads its own length
    // and refuses it. Each entry is a bare suite file name: a path would name a
    // shared `lib/` seam, and those may never be exempted.
    assert(
      SCAN_EXEMPT.length <= SCAN_EXEMPT_CEILING &&
        new Set(SCAN_EXEMPT).size === SCAN_EXEMPT.length,
      `the pre-#1981 backlog has not grown (${SCAN_EXEMPT.length} files, ceiling ${SCAN_EXEMPT_CEILING}, each listed once)`,
    );
    assert(
      SCAN_EXEMPT.every((f) => !f.includes("/")),
      "the backlog names bare suite file names only — no shared lib/ seam may be exempted",
    );
  } finally {
    rmSync(fix, { recursive: true, force: true });
  }
}

// ── And the tree is clean.
const offenders = scanSmokeTests(REPO_ROOT);
if (offenders.length === 0) {
  assert(true, "every smoke-test git spawn threads a scrubbed env (no inherited GIT_DIR/GIT_WORK_TREE)");
} else {
  for (const o of offenders) assert(false, `${o.file}:${o.lineNo}: ${o.line}`);
}

// The scan must actually reach the suite, or this is a narrower gate with a
// longer docstring — the fail-open class test-file-size-limit.ts documents.
{
  const scanned = listTsFiles(SMOKE_DIR);
  assert(
    scanned.length > 100,
    `canary: the scan reaches the suite (${scanned.length} .ts files under extension/smoke-tests/, recursive, live tier excluded)`,
  );
  const sharedSeams = ["lib/git-worktree-fixture.ts", "lib/clean-repo-fixture.ts", "lib/headless-s5-git.ts"];
  const seen = sharedSeams.filter((f) => scanned.includes(path.join(SMOKE_DIR, f)));
  assert(
    seen.length === sharedSeams.length,
    `canary: the shared fixture seams in lib/ are in scope (${seen.length}/${sharedSeams.length})`,
  );
}

console.log(exit === 0 ? "\nAll fixture-git-env checks passed." : "\nFAILED");
process.exit(exit);
