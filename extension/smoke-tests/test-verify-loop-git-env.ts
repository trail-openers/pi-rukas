#!/usr/bin/env bun
/**
 * verify-loop.sh must not let a caller's GIT_DIR reach the tests.
 *
 * Smoke tests build throwaway repositories (`git init --bare <tmp>`,
 * `git config user.email …`). With GIT_DIR set — as git does for every hook —
 * those commands rewrite the CALLER's repository: `core.bare = true` and a
 * fake identity in its config, after which no worktree of it works. The
 * runner drops git's repository-locating variables first.
 *
 * This drives the real runner with GIT_DIR pointing at a victim repository
 * and a fixture test that does what the real tests do.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GIT_LOCATION_VARS } from "../src/git-env.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const RUNNER = path.join(import.meta.dirname, "lib", "verify-loop.sh");
const dir = mkdtempSync(path.join(tmpdir(), "verify-loop-git-env-"));
// The child git calls below must not inherit a GIT_DIR of our own.
const clean = { ...process.env };
for (const k of Object.keys(clean)) if (k.startsWith("GIT_")) delete clean[k];
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: clean }).trim();

try {
  const victim = path.join(dir, "victim");
  mkdirSync(victim);
  git(victim, "init", "-q");
  git(victim, "config", "user.email", "owner@example.com");

  // What the real tests do: a bare origin and an identity in a temp clone.
  const fixture = path.join(dir, "fixture-test.ts");
  writeFileSync(
    fixture,
    [
      'import { execFileSync } from "node:child_process";',
      'import { mkdtempSync } from "node:fs";',
      'import { tmpdir } from "node:os";',
      'import path from "node:path";',
      'const d = mkdtempSync(path.join(tmpdir(), "fixture-repo-"));',
      'execFileSync("git", ["init", "-q", "--bare", path.join(d, "origin.git")]);',
      'execFileSync("git", ["init", "-q", path.join(d, "root")]);',
      'execFileSync("git", ["config", "user.email", "t@t"], { cwd: path.join(d, "root") });',
      'console.log("fixture ran");',
      "",
    ].join("\n"),
  );

  const run = spawnSync("bash", [RUNNER, fixture], {
    encoding: "utf8",
    // GIT_DIR alone: with GIT_WORK_TREE as well, `git init --bare` refuses to
    // run and the damage does not happen.
    env: { ...clean, GIT_DIR: path.join(victim, ".git") },
  });
  assert(run.status === 0, `the runner passes the fixture (status ${run.status})`);
  assert(
    git(victim, "config", "--get", "core.bare") === "false",
    "the caller's repository is not turned bare",
  );
  assert(
    git(victim, "config", "--get", "user.email") === "owner@example.com",
    "the caller's identity is not overwritten",
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ── The runner scrubs the WHOLE set, not the eight names it first listed.
//
// Same shape as the victim case above: inject the hostile variable into the
// RUNNER's environment and ask what the test child actually sees. A child of
// this process is no evidence at all — by the time it was spawned the parent
// had already scrubbed (`clean` above), so a runner that scrubbed nothing would
// still report a clean child. The child the runner starts is the one under test.
//
// Five names — `GIT_IMPLICIT_WORK_TREE`, `GIT_SHALLOW_FILE`, `GIT_GRAFT_FILE`,
// `GIT_NO_REPLACE_OBJECTS`, `GIT_REPLACE_REF_BASE` — sat outside the original
// list, each of which redirects a real read (object store, grafts, replace refs).
//
// Asserted against `GIT_LOCATION_VARS` rather than a list typed here, so the
// gate cannot drift from the set production scrubs: a name added on one side
// and not the other fails naming the leak, instead of surviving as stray
// commits in whoever's repository the variable names.
{
  // Its own temp dir: the block above removes `dir` in its `finally`.
  const probeRoot = mkdtempSync(path.join(tmpdir(), "verify-loop-leak-"));
  const leakProbe = path.join(probeRoot, "leak-probe.ts");
  writeFileSync(
    leakProbe,
    [
      `const names = ${JSON.stringify([...GIT_LOCATION_VARS])};`,
      "console.log('LEAK=' + names.filter((n) => process.env[n] !== undefined).join(','));",
      "",
    ].join("\n"),
  );
  const leaked: string[] = [];
  // One name per run: `unset` takes the whole list at once, but a single-name
  // run names WHICH one leaked, and a batched run would only ever report the
  // first — the same off-by-one that kept five names invisible for their whole
  // life inside a list that looked complete.
  for (const name of GIT_LOCATION_VARS) {
    const probe = spawnSync("bash", [RUNNER, leakProbe], {
      encoding: "utf8",
      env: { ...clean, [name]: path.join(probeRoot, "must-not-be-read") },
    });
    const leakLine = (probe.stdout ?? "").split("\n").find((l) => l.startsWith("LEAK="));
    if (leakLine === undefined) {
      leaked.push(`${name}(no output — probe did not run)`);
    } else if (leakLine !== "LEAK=") {
      leaked.push(leakLine.slice(5));
    }
  }
  rmSync(probeRoot, { recursive: true, force: true });
  assert(
    leaked.length === 0,
    `the runner leaves no git location variable in a test child (${GIT_LOCATION_VARS.length} names checked, leaked: ${JSON.stringify(leaked)})`,
  );
}

// ── A `lib/` fixture executor that spawns git carries the scrub itself.
//
// The runner above is a belt for the whole run; it cannot be the only defence,
// because a direct `bun <file>` run — and the `PI_ENSEMBLE_SMOKE_HOST_GIT=1`
// debugging path — start with the operator's environ, where `GIT_DIR` may live.
// `gitTestEnv()` is what closes that, and it only closes it where the env is
// actually threaded into the child options. So the shared fixture seams, which
// run REAL git for many suites at once, are scanned for a git-shaped spawn that
// passes no `env` at all. `src/` is out of scope deliberately: production git
// must keep reading the operator's config, and those calls are scrubbed by
// `git-env.ts` at activation instead.
{
  const libDir = path.join(import.meta.dirname, "lib");
  // Quoted literals blanked to `""` for ANALYSIS only (newlines and length
  // preserved, so offsets still line up with the raw source and with line
  // numbers). Block comments blanked too, so prose ABOUT a call is never
  // scanned as one — a `//` line comment is skipped by the line filter below
  // rather than blanked, because an apostrophe in prose would otherwise swallow
  // the rest of the file.
  // The spawn call whose child IS git, or a shell the fixture uses to run git.
  // A VARIABLE as the program (`exec(cmd, …)`, `spawnSync(cmd, opts.argv, …)`)
  // is deliberately not matched: at these seams `cmd` is verbatim git inside a
  // recording executor that owns its own env, and no source pattern can see
  // through a variable — those are guarded by the behaviour probes, and a
  // variable-shaped pattern would also fire on `execFileSync("bash", …)`.
  // Detect on the RAW source (so the `"git"` / `"/bin/sh"` literal is still
  // there to match) and analyse the STRIPPED copy at the same offset (so a `,`,
  // `(` or `:` inside a command string cannot be read as call syntax). Blanking
  // first and matching after would match nothing, since the program name is
  // itself the literal being blanked.
  const SPAWN =
    /(?:^|[^\w.$])(?:execFileSync|execSync|spawnSync|spawn|execFileP|execp)\s*\(\s*(?:"git"|'git'|`git|"\/bin\/sh"|'\/bin\/sh')\s*[,)]/g;
  // Quoted literals blanked for ANALYSIS only (newlines preserved, so offsets
  // still line up with the raw source and with line numbers). Blanks are
  // LENGTH-PRESERVING — a blank shorter than the literal it replaces shifts
  // every later offset, so the analysis would read the middle of some other
  // call and the gate would report a confident wrong answer. Block comments
  // blanked too, so prose ABOUT a call is never scanned as one — a `//` line
  // comment is skipped by the line filter below rather than blanked, because an
  // apostrophe in prose would otherwise swallow the rest of the file.
  const stripForAnalysis = (src: string): string =>
    src
      .replace(/"(?:[^"\\\n]|\\.)*"/g, (m) => '"' + " ".repeat(m.length - 2) + '"')
      .replace(/'(?:[^'\\\n]|\\.)*'/g, (m) => "'" + " ".repeat(m.length - 2) + "'")
      .replace(/`(?:[^`\\]|\\.)*`/g, (m) => '`' + " ".repeat(m.length - 2) + "`")
      .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));
  const hasEnv = (s: string): boolean =>
    /(^|[{,;\s])env\s*:/.test(s) ||
    // `… , env }` — a shorthand property is the scrub too, when the call names
    // it itself. A call whose options are ONLY a spread (`{ ...opts }`) has no
    // such word and stays an offender.
    /(?:^|[{,;\s])env\s*(?=[}\s])/.test(s);
  const offenderLines = (src: string, code: string): string[] => {
    const bad: string[] = [];
    const lineOf = (pos: number): number => {
      let n = 1;
      for (let k = 0; k < pos; k++) if (src[k] === "\n") n++;
      return n;
    };
    const textOf = (pos: number): string => {
      const s = src.lastIndexOf("\n", pos - 1) + 1;
      const e = src.indexOf("\n", pos);
      return src.slice(s, e < 0 ? src.length : e).trim();
    };
    // Args of the call whose `(` sits at `open`, and top-level commas within it:
    // a comma inside a nested `[…]`/`{…}` is not an argument separator, so a
    // multi-line argv array does not split into pseudo-arguments and an `env:`
    // from the NEXT statement can never excuse this call.
    // Length-preserving so `code[i]` still means `src[i]` and line numbers
    // computed from either agree. An empty blank (`""`) shifts every later
    // offset and the analysis then reads the middle of a different call.
    const argsOf = (open: number): { inner: string; parts: string[] } | undefined => {
      let depth = 0;
      let k = open;
      for (; k < code.length; k++) {
        if (code[k] === "(") depth++;
        else if (code[k] === ")") {
          depth--;
          if (depth === 0) break;
        }
      }
      if (k >= code.length) return undefined; // unbalanced parens
      const inner = code.slice(open + 1, k);
      const parts: string[] = [];
      let d = 0;
      let start = 0;
      for (let j = 0; j < inner.length; j++) {
        const c = inner[j];
        if (c === "(" || c === "[" || c === "{") d++;
        else if (c === ")" || c === "]" || c === "}") d--;
        else if (c === "," && d === 0) {
          parts.push(inner.slice(start, j));
          start = j + 1;
        }
      }
      parts.push(inner.slice(start));
      return { inner, parts: parts.filter((p) => p.trim().length > 0) };
    };
    const definesEnv = (name: string): boolean => {
      const at = new RegExp(`\\b(?:const|let)\\s+${name}\\s*=`).exec(code);
      if (at === null) return false;
      // Scan the initialiser up to the brace that closes it (not a fixed
      // window, which would run into a later `env:` from a neighbouring call).
      const open = code.indexOf("{", at.index);
      if (open < 0) return false;
      let depth = 0;
      let k = open;
      for (; k < code.length; k++) {
        if (code[k] === "{") depth++;
        else if (code[k] === "}") {
          depth--;
          if (depth === 0) break;
        }
      }
      return hasEnv(code.slice(open, Math.min(k + 1, code.length)));
    };
    let m: RegExpExecArray | null;
    while ((m = SPAWN.exec(src)) !== null) {
      const at = m.index + m[0].indexOf("exec");
      const line = textOf(at);
      // Commented-out code is not code: a `//` line or a `*` of a block comment
      // is prose ABOUT a call, not a call.
      if (/^\s*(?:\*|\/\/)/.test(line)) continue;
      const open = code.indexOf("(", at);
      const call = open < 0 ? undefined : argsOf(open);
      // Unparsable is never a pass: an unreadable answer is reported, not
      // folded into "clean".
      if (call === undefined) {
        bad.push(`${lineOf(at)} ${line.slice(0, 72)} (UNPARSABLE)`);
        continue;
      }
      const { inner, parts } = call;
      const last = (parts.at(-1) ?? "").trim();
      if (/^\{/.test(last)) {
        if (hasEnv(last)) continue;
      } else if (/^\w+$/.test(last)) {
        // A shell call (`["-c", cmd]`) is the one that carries whatever git
        // command the driver was handed, so IT must name the scrub in its own
        // text. A variable options bag is credited only for the argv branch:
        // crediting it here too is how a decoy `env:` in a neighbouring `const`
        // would excuse a shell call that inherits the environ. `inner` is
        // blanked but keeps its length, so a quoted `-c` is a 4-character
        // token between the quotes.
        if (/\[\s*"[^"\n]{0,4}"\s*,/.test(inner)) {
          bad.push(`${lineOf(at)} ${line.slice(0, 72)} (SHELL-BRANCH-UNSCRUBBED)`);
          continue;
        }
        // Options held in a variable: excused only if that declaration really
        // carries the scrub.
        if (definesEnv(last)) continue;
        bad.push(`${lineOf(at)} ${line.slice(0, 72)} (OPTIONS-VAR-UNSCRUBBED)`);
        continue;
      } else if (/\.\.\./.test(last)) {
        // Options spread from something the scan cannot resolve (`{ ...opts }`):
        // the scrub has to be spelled out in this call, not hidden in a spread.
        bad.push(`${lineOf(at)} ${line.slice(0, 72)} (UNRESOLVED-OPTIONS)`);
        continue;
      }
      bad.push(`${lineOf(at)} ${line.slice(0, 72)}`);
    }
    return bad;
  };
  const offenders: string[] = [];
  for (const name of readdirSync(libDir).sort()) {
    if (!name.endsWith(".ts")) continue;
    const src = readFileSync(path.join(libDir, name), "utf8");
    for (const o of offenderLines(src, stripForAnalysis(src))) offenders.push(`${name}:${o}`);
  }
  assert(
    offenders.length === 0,
    `every git/shell spawn in smoke-tests/lib threads the scrubbed env (${offenders.length} unscrubbed: ${offenders.join(" | ")})`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
