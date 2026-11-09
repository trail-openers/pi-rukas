#!/usr/bin/env bun
/**
 * The merge-time protected-path read, unit-pinned against a scripted executor.
 *
 * This is the predicate BOTH merge gates ask (the driver's `merged` step and the
 * mode-independent merge guard), so it is pinned on its own: a drift here is a
 * hole in two gates at once, and neither gate's own test can tell which side
 * broke. Five behaviours, each the shape a real merge decision turns on:
 *
 *   1. A protected path in the PR's own commits is reported, in both directions
 *      of a rename (`git mv` out of `.github/` and into it).
 *   2. The range is the MERGE BASE, not a tip-to-tip diff — a protected file
 *      changed on main after the branch was cut is not the branch's doing.
 *   3. The OIDs are PINNED: the read takes them from its caller and issues one
 *      `rev-parse` per ref, so a ref that moves after the caller pinned it
 *      cannot make the gate diff something other than what it reports.
 *   4. Every unreadable read is `{ ok: false }` naming the cause, never `{ ok:
 *      true, paths: [] }`. An empty list is a pass, and "git did not answer" is
 *      not one.
 *   5. `PI_ENSEMBLE_PROTECTED_PATHS` is not consulted: the develop-time halt's
 *      switch is not a licence to auto-merge a protected diff.
 *
 * No git binary: each case scripts the exact argv the read must issue and answers
 * it, so a change to the command shape fails here rather than in a fixture that
 * silently answers nothing.
 */
import { mergeProtectedPathsForBranch } from "../src/merge-protected-paths.ts";
import { PROTECTED_DIFF_ARGV } from "../src/work-driver-protected-paths-read.ts";
import type { ScriptedExec } from "./lib/merge-protected-paths-fixture.ts";
import {
  BASE_SHA,
  CI,
  HEAD_SHA,
  LATE_SHA,
  MAIN_SHA,
  nameStatus,
  readRoutes,
  scripted,
  type Call,
} from "./lib/merge-protected-paths-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The branch form for one scripted read; `headOid` is the caller's pinned head. */
function read(
  exec: ScriptedExec,
  headOid?: string,
  headBranch = "feature/x",
) {
  return mergeProtectedPathsForBranch(exec, "/repo", headBranch, headOid);
}

/**
 * The TOCTOU fixture lives in ./lib/merge-protected-paths-fixture.ts, shared with
 * the pinned-OID file, so both files see the same moving ref.
 */

// ---------------------------------------------------------------- a protected diff

{
  const { exec, calls } = scripted(readRoutes(nameStatus(`M ${CI}`)));
  const r = await read(exec);
  assert(
    r.ok === true && r.paths.join(",") === CI,
    "a modified .github/ path in the PR's own diff is reported",
  );
  const diffCall = calls.find((c) => c.argv[0] === "-c");
  assert(
    diffCall !== undefined &&
      diffCall.argv.slice(0, PROTECTED_DIFF_ARGV.length).join(" ") ===
        PROTECTED_DIFF_ARGV.join(" "),
    "the committed read issues the SAME argv the develop gate issues (one command shape for both gates)",
  );
  const range = diffCall?.argv[diffCall.argv.length - 1] ?? "";
  assert(
    range === `${BASE_SHA}..${HEAD_SHA}`,
    `the range is <merge-base>..<head>, spelled as ONE commit range after --end-of-options (got ${JSON.stringify(range)})`,
  );
}

{
  const { exec } = scripted(readRoutes(nameStatus(`A ${CI}`, "A docs/notes.md")));
  const r = await read(exec);
  assert(
    r.ok === true && r.paths.length === 1 && r.paths[0] === CI,
    "an added protected path is reported and the non-protected path does not confuse the count",
  );
}

{
  const { exec } = scripted(readRoutes(nameStatus(`D ${CI}`)));
  const r = await read(exec);
  assert(
    r.ok === true && r.paths.join(",") === CI,
    "a DELETED protected path is reported — a cycle cannot remove the CI workflow and merge",
  );
}

{
  // `R100\0from\0to` — git prints the source first, so both must be checked or a
  // `git mv` out of the protected set reads as an innocuous addition.
  const { exec } = scripted(readRoutes(nameStatus(`R100 ${CI} src/ci.yml`)));
  const r = await read(exec);
  assert(
    r.ok === true && r.paths.includes(CI),
    "a rename OUT of a protected path is reported (the source is checked, not just the destination)",
  );
}

{
  const { exec } = scripted(readRoutes(nameStatus(`R100 src/ci.yml ${CI}`)));
  const r = await read(exec);
  assert(
    r.ok === true && r.paths.includes(CI),
    "a rename INTO a protected path is reported (the destination is checked too)",
  );
}

{
  const { exec } = scripted(readRoutes(nameStatus(`C100 ${CI} docs/leak.yml`)));
  const r = await read(exec);
  assert(
    r.ok === true && r.paths.includes(CI),
    "a COPY out of a protected path is reported — `cp .github/... docs/` is the act `git mv` does not cover",
  );
}

{
  const { exec } = scripted(readRoutes(nameStatus("M src/app.ts", "A docs/readme.md")));
  const r = await read(exec);
  assert(
    r.ok === true && r.paths.length === 0,
    "an ordinary diff reports nothing and is a pass, not a refusal",
  );
}

// ------------------------------------------------------- the merge-base, not the tip

{
  // The scripted `git diff` answers whatever range it is asked for, so the
  // assertion that matters is WHICH range the read asked for: the merge base,
  // never the tip of main. A tip-to-tip `origin/main..origin/feature/x` would
  // show main's own protected edits as the branch's and hold every cycle cut
  // before them.
  const { exec, calls } = scripted(readRoutes(nameStatus("M src/app.ts")));
  await read(exec);
  const mb = calls.find((c) => c.argv[0] === "merge-base");
  assert(
    mb?.argv.join(" ").includes("--end-of-options") === true,
    "the merge-base read uses --end-of-options so a ref that looks like a flag stays a ref",
  );
  const range = calls.find((c) => c.argv[0] === "-c")?.argv.slice(-1)[0] as string;
  assert(
    range.startsWith(`${BASE_SHA}..`) && !range.startsWith("origin/main"),
    `the diff is taken from the MERGE BASE, so a protected file changed on main after the branch was cut does not hold the cycle (got ${JSON.stringify(range)})`,
  );
}

// -------------------------------------------------------------- unreadable ≠ clean

{
  const { exec } = scripted([
    [/^git remote/, () => ({ stdout: "origin\n" })],
    [/^git config --get remote/, () => ({ stdout: "https://x.invalid/r.git\n" })],
    [/^git symbolic-ref/, () => ({ stdout: "origin/main\n" })],
    [/^git fetch/, () => ({ stdout: "" })],
    [/^git rev-parse --end-of-options origin\/feature/, () => ({ stdout: `${HEAD_SHA}\n` })],
    [/^git rev-parse --end-of-options origin\/main/, () => ({ stdout: `${MAIN_SHA}\n` })],
    [/^git merge-base/, () => ({ stdout: "\n" })],
  ]);
  const r = await read(exec);
  assert(
    r.ok === false && r.unreadable.includes("no merge-base"),
    "an empty merge-base answer (unrelated histories, a shallow clone) is unreadable, not a clean diff",
  );
}

{
  const { exec } = scripted([
    [/^git remote/, () => ({ stdout: "origin\n" })],
    [/^git config --get remote/, () => ({ stdout: "https://x.invalid/r.git\n" })],
    [/^git symbolic-ref/, () => ({ stdout: "origin/main\n" })],
    [/^git fetch/, () => ({ stdout: "" })],
    [/^git rev-parse --end-of-options origin\/feature/, () => ({ stdout: `${HEAD_SHA}\n` })],
    [/^git rev-parse --end-of-options origin\/main/, () => ({ stdout: `${MAIN_SHA}\n` })],
    [/^git merge-base/, () => Promise.reject(new Error("no merge base"))],
  ]);
  const r = await read(exec);
  assert(
    r.ok === false && r.unreadable.includes("merge-base failed"),
    "a merge-base that throws is unreadable and names the cause",
  );
}

{
  // A ref that resolves to something other than an object id: the read refuses
  // rather than diffing garbage, and it never reaches the diff.
  const { exec, calls } = scripted([
    [/^git remote/, () => ({ stdout: "origin\n" })],
    [/^git config --get remote/, () => ({ stdout: "https://x.invalid/r.git\n" })],
    [/^git symbolic-ref/, () => ({ stdout: "origin/main\n" })],
    [/^git fetch/, () => ({ stdout: "" })],
    [/^git rev-parse/, () => ({ stdout: "not-an-oid\n" })],
  ]);
  const r = await read(exec);
  assert(
    r.ok === false &&
      r.unreadable.includes("not an object id") &&
      calls.every((c) => c.argv[0] !== "-c"),
    "a rev-parse that answers something other than an OID is unreadable and no diff is attempted",
  );
}

{
  // A caller that hands over something which is not an OID at all: refused
  // before any merge-base or diff is issued.
  const { exec, calls } = scripted(readRoutes(nameStatus(`M ${CI}`)));
  const r = await read(exec, "feature-not-an-oid");
  assert(
    r.ok === false &&
      r.unreadable.includes("not an object id") &&
      calls.every((c) => c.argv[0] !== "-c" && c.argv[0] !== "merge-base"),
    "a non-OID head from the caller is refused before git is asked for a base or a diff",
  );
}

{
  const { exec } = scripted([
    [/^git remote/, () => ({ stdout: "origin\n" })],
    [/^git config --get remote/, () => ({ stdout: "https://x.invalid/r.git\n" })],
    [/^git symbolic-ref/, () => ({ stdout: "origin/main\n" })],
    [/^git fetch/, () => ({ stdout: "" })],
    [/^git rev-parse --end-of-options origin\/feature/, () => ({ stdout: `${HEAD_SHA}\n` })],
    [/^git rev-parse --end-of-options origin\/main/, () => ({ stdout: `${BASE_SHA}\n` })],
    [/^git merge-base/, () => ({ stdout: `${BASE_SHA}\n` })],
    [/^git -c .*diff -z/, () => Promise.reject(new Error("fatal: bad revision"))],
  ]);
  const r = await read(exec);
  assert(
    r.ok === false && r.unreadable.includes("bad revision"),
    'a diff that fails is unreadable — an empty change set would look like "nothing protected changed"',
  );
}

{
  // A rename record whose second side never arrived: the tokens after it would
  // be read as further records, so the whole read is untrusted.
  const { exec } = scripted(readRoutes(nameStatus(`R100 ${CI}`).replace(/\0$/, "")));
  const r = await read(exec);
  assert(
    r.ok === false,
    "a rename record without its second side is unreadable, not a shorter list",
  );
}

for (const [what, branch] of [
  ["an empty branch name", ""],
  ["a branch name that starts with a dash", "--help"],
] as const) {
  const { exec, calls } = scripted(readRoutes(""));
  const r = await read(exec, undefined, branch);
  assert(
    r.ok === false && calls.every((c) => c.argv[0] !== "fetch" && c.argv[0] !== "-c"),
    `${what} is refused before a fetch or a diff is issued (no diff, no pass)`,
  );
}

// ------------------------------------------- the branch form resolves refs, then fails closed

{
  const { exec, calls } = scripted(readRoutes(nameStatus(`M ${CI}`)));
  const r = await read(exec);
  assert(
    r.ok === true && r.paths.includes(CI),
    "the branch form resolves remote + mainline, fetches the pair, and reports the protected path",
  );
  assert(
    calls.some((c) => c.argv[0] === "fetch" && c.argv.includes("feature/x")),
    "the branch form brings the PR's own ref into the tree before diffing it",
  );
  const diffCall = calls.find((c) => c.argv[0] === "-c");
  assert(
    diffCall !== undefined && !diffCall.argv.includes("HEAD"),
    "the read is over the fetched <remote>/<branch>, never this checkout's HEAD",
  );
}

{
  const { exec } = scripted([
    [/^git config --get remote/, () => Promise.reject(new Error("no remote"))],
    [/^git remote$/, () => ({ stdout: "\n" })],
    [/^git symbolic-ref/, () => Promise.reject(new Error("no origin/HEAD"))],
    [/^gh repo view/, () => Promise.reject(new Error("no gh"))],
  ]);
  const r = await read(exec);
  assert(
    r.ok === false && r.unreadable.includes("no git remote"),
    "with no remote the branch read is unreadable — it does not fall back to a local diff",
  );
}

{
  const { exec } = scripted([
    [/^git config --get remote/, () => ({ stdout: "https://x.invalid/r.git\n" })],
    [/^git symbolic-ref/, () => Promise.reject(new Error("no origin/HEAD"))],
    [/^gh repo view/, () => Promise.reject(new Error("gh unavailable"))],
  ]);
  const r = await read(exec);
  assert(
    r.ok === false && r.unreadable.includes("mainline"),
    "an unresolvable mainline is unreadable: no base means no verdict, not a merge",
  );
}

{
  const { exec, calls } = scripted([
    [/^git remote/, () => ({ stdout: "origin\n" })],
    [/^git config --get remote/, () => ({ stdout: "https://x.invalid/r.git\n" })],
    [/^git symbolic-ref/, () => ({ stdout: "origin/main\n" })],
    [/^git fetch/, () => Promise.reject(new Error("Connection timed out"))],
  ]);
  const r = await read(exec);
  assert(
    r.ok === false &&
      r.unreadable.includes("git fetch") &&
      calls.every((c) => c.argv[0] !== "-c" && c.argv[0] !== "rev-parse"),
    "a fetch that fails is a refusal at the fetch, and no diff or resolve is attempted over stale refs",
  );
}

// -------------------------------------- the develop-time switch does not reach here

// Not a bare block: the arm mutates `process.env`, so it needs a name to restore
// against, and the save/restore is the assertion that the switch is not read.
async function switchDoesNotReachHere() {
  const saved = process.env.PI_ENSEMBLE_PROTECTED_PATHS;
  process.env.PI_ENSEMBLE_PROTECTED_PATHS = "0";
  try {
    const { exec } = scripted(readRoutes(nameStatus(`M ${CI}`)));
    const r = await read(exec);
    assert(
      r.ok === true && r.paths.includes(CI),
      "PI_ENSEMBLE_PROTECTED_PATHS=0 does not blind the merge-time read — that switch disables the develop-time halt, and is not a licence to auto-merge a protected diff",
    );
  } finally {
    if (saved === undefined) delete process.env.PI_ENSEMBLE_PROTECTED_PATHS;
    else process.env.PI_ENSEMBLE_PROTECTED_PATHS = saved;
  }
}

await switchDoesNotReachHere();

process.exit(exit);
