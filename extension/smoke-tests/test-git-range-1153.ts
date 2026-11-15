#!/usr/bin/env bun
/**
 * #1153 — the driver's git plumbing has one typed entry point, and the "commits ahead of
 * base, and can we tell?" question has one answer.
 *
 * 1. CANARY — no driver git call in the listed modules passes a command string. Every call
 *    goes through `execGit` (argv + timeout). The control proves the scanner can fail.
 * 2. REAL GIT — `aheadOfBase` returns each of its five kinds against a real repository, and
 *    `refResolves` separates "absent" from "unknown".
 * 3. FIXTURES — a killed/timed-out probe is `unknown`, never `absent` (#1153 review): a
 *    `code: 1` produced by the harness says nothing about the ref. (Its round-3 companion — a
 *    probe that EXITS 0 WITHOUT AN OBJECT ID — lives in test-git-range-object-id-1153.ts,
 *    which split off for the file-size cap. The rest of the fixture arms — every killed /
 *    signalled / exit-1 / wording shape — live in
 *    test-git-range-probe-failures-1153.ts, which split off for the same cap.)
 * 4. COVERAGE — every module that imports `./git-range.ts` is in the canary's LISTED set, so a
 *    new caller cannot join the "argv only" rule by silence.
 * 5. The #2283 modules' argv shape, asserted on `argv` and not just on "no command string".
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { aheadOfBase, execGit, refResolves } from "../src/git-range.ts";
import { assert, exit } from "./lib/assert-rig.ts";
import {
  LISTED,
  commandStringLines,
  gitRangeImporters,
} from "./lib/git-range-canary-inventory.ts";
import { realExec } from "./lib/git-range-fixture-exec.ts";

// ── 1. canary ────────────────────────────────────────────────────────────────

const srcDir = path.join(import.meta.dir, "..", "src");
for (const f of LISTED) {
  const hits = commandStringLines(readFileSync(path.join(srcDir, f), "utf8"));
  assert(hits.length === 0, `${f}: no git command string (${hits.length} found)`);
}
assert(
  commandStringLines('await exec("git diff HEAD", {})').length === 1,
  "control: the scanner flags a git command string",
);

// Every module that imports git-range must be one the canary actually scans.
// A caller that joins later and is not added to LISTED gets argv discipline
// by imitation only — nothing fails when it passes a command string.
{
  const unlisted = gitRangeImporters(srcDir).filter((f) => !LISTED.includes(f));
  assert(
    unlisted.length === 0,
    `canary covers every git-range importer (unlisted: ${unlisted.join(", ") || "none"})`,
  );
  // The control: a scanner blind to a real importer would pass silently.
  assert(
    LISTED.includes("work-driver-diff.ts"),
    "control: LISTED covers a known git-range importer",
  );
}

// ── 2. real git ──────────────────────────────────────────────────────────────

const dir = mkdtempSync(path.join(tmpdir(), "git-range-1153-"));
const git = (args: string[]) =>
  execGit(realExec, dir, ["-c", "user.name=t", "-c", "user.email=t@t", ...args]);

try {
  await git(["init", "-q", "-b", "main"]);
  writeFileSync(path.join(dir, "a.txt"), "a\n");
  await git(["add", "a.txt"]);
  await git(["commit", "-q", "-m", "base"]);
  // The base is what origin/main would point at.
  const base = (await git(["rev-parse", "HEAD"])).trim();
  await git(["update-ref", "refs/remotes/origin/main", base]);
  // Two commits on the feature branch, pushed as origin/feat.
  await git(["checkout", "-q", "-b", "feat"]);
  for (const n of [1, 2]) {
    writeFileSync(path.join(dir, `f${n}.txt`), `${n}\n`);
    await git(["add", `f${n}.txt`]);
    await git(["commit", "-q", "-m", `c${n}`]);
  }
  await git(["update-ref", "refs/remotes/origin/feat", "HEAD"]);

  const ahead = await aheadOfBase(realExec, dir, "origin/main", "origin/feat");
  assert(
    ahead.kind === "ahead" && ahead.n === 2,
    `ahead: two commits ahead (got ${JSON.stringify(ahead)})`,
  );

  const empty = await aheadOfBase(realExec, dir, "origin/feat", "origin/feat");
  assert(empty.kind === "empty", `empty: head equals base (got ${JSON.stringify(empty)})`);

  const unpushed = await aheadOfBase(realExec, dir, "origin/main", "origin/nope");
  assert(
    unpushed.kind === "unpushed",
    `unpushed: head ref absent (got ${JSON.stringify(unpushed)})`,
  );

  const unresolved = await aheadOfBase(realExec, dir, "origin/nomain", "origin/feat");
  assert(
    unresolved.kind === "unresolved",
    `unresolved: base ref absent (got ${JSON.stringify(unresolved)})`,
  );

  const notARepo = mkdtempSync(path.join(tmpdir(), "git-range-1153-norepo-"));
  try {
    const unknown = await aheadOfBase(realExec, notARepo, "origin/main", "origin/feat");
    assert(
      unknown.kind === "unknown",
      `unknown: git cannot run in a non-repo (got ${JSON.stringify(unknown)})`,
    );
    const probe = await refResolves(realExec, notARepo, "origin/feat");
    assert(probe.state === "unknown", "refResolves: a non-repo is unknown, not absent");
  } finally {
    rmSync(notARepo, { recursive: true, force: true });
  }

  const absent = await refResolves(realExec, dir, "origin/nope");
  assert(
    absent.state === "absent",
    `refResolves: a missing ref is absent — git's wording, not the code (got ${JSON.stringify(absent)})`,
  );
  const resolves = await refResolves(realExec, dir, "origin/feat");
  assert(resolves.state === "resolves", "refResolves: a present ref resolves");

  // #1153 fix round — `absent` requires git's OWN WORDS, not just exit 1.
  // The real-git half of that: a missing ref in a real repo must reach absent
  // through the wording clause (git printed "not a valid object name"), not
  // through the exit code alone. The non-repo case is asserted once above
  // against a real directory, for both `aheadOfBase` and `refResolves`; the
  // synthetic half (the exact stderr shapes) is in section 3, in
  // test-git-range-probe-failures-1153.ts.
  assert(
    await refSaysAbsentForMissingRefInFreshRepo(),
    "refResolves: real git — a missing ref in a real repo is absent",
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * The real-git half of the wording rule, against a repository created here
 * rather than the shared fixture above: a ref that genuinely does not exist
 * must reach `absent` (which now needs git's wording, not just exit 1), and
 * one that does must `resolve`.
 */
async function refSaysAbsentForMissingRefInFreshRepo(): Promise<boolean> {
  const fresh = mkdtempSync(path.join(tmpdir(), "git-range-1153-fresh-"));
  try {
    const g = (args: string[]) =>
      execGit(realExec, fresh, ["-c", "user.name=t", "-c", "user.email=t@t", ...args]);
    await g(["init", "-q", "-b", "main"]);
    writeFileSync(path.join(fresh, "a.txt"), "a\n");
    await g(["add", "a.txt"]);
    await g(["commit", "-q", "-m", "base"]);
    const missing = await refResolves(realExec, fresh, "refs/remotes/origin/never-pushed");
    const present = await refResolves(realExec, fresh, "HEAD");
    return missing.state === "absent" && present.state === "resolves";
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
}

// ── 5. the #2283 modules' argv shape, asserted on `argv` and not just on "no command string" ─
//
// The canary in part 1 proves a LISTED module passes no command string; it cannot prove the
// argv it passes is the right one. For the provenance gate's committed-blob read that gap
// mattered: `--end-of-options` is inert as written (the ref is always a full 40-hex sha, and
// the path is glued to it as `<oid>:<file>`), so it is defence-in-depth against a future
// caller that separates rev from path — and defence-in-depth nothing asserts is
// defence-in-depth that goes away with the next refactor.
{
  const { checkWorktreeProvenance } = await import(
    "../src/work-driver-verify-develop-provenance.ts"
  );
  const calls: { cmd: string; argv?: string[] }[] = [];
  const recording = async (cmd: string, o?: { argv?: string[] }): Promise<{ stdout: string }> => {
    calls.push({ cmd, argv: o?.argv });
    const argv = o?.argv ?? [];
    if (argv.includes("rev-parse")) return { stdout: `${"a".repeat(40)}\n` };
    // The committed change-set read the gate shares with the protected-path check: a
    // name-status stream whose single `A` record names the data file it will then read.
    if (argv.includes("diff")) return { stdout: "A\u0000runs/gone.json\u0000" };
    if (argv.includes("ls-tree")) return { stdout: "" }; // absent → one failure, no throw
    return { stdout: '{"source":"runs/gone.json"}\n' };
  };
  await checkWorktreeProvenance({
    execFn: recording as never,
    cwd: "/repo",
    base: "b".repeat(40),
    id: "a",
  });
  const show = calls.find((c) => c.cmd === "git" && c.argv?.includes("show") === true);
  assert(show !== undefined, "the provenance gate reads the added file through `git show`");
  assert(
    show?.argv?.includes("--end-of-options") === true,
    `the committed-blob read pins the option boundary (argv: ${JSON.stringify(show?.argv)})`,
  );
  const shown = (show?.argv ?? []).some((a) => a.startsWith(`${"a".repeat(40)}:`));
  assert(
    shown === true,
    `and reads at the OID it pinned, not a ref it would resolve later (argv: ${JSON.stringify(show?.argv)})`,
  );
  const probe = calls.find((c) => c.argv?.includes("ls-tree") === true);
  assert(
    probe?.argv?.includes("--end-of-options") === true &&
      probe?.argv?.includes("--literal-pathspecs") === true,
    `the token probe keeps its own pathspec boundary (argv: ${JSON.stringify(probe?.argv)})`,
  );
  const rendered = JSON.stringify(calls.map((c) => [c.cmd, c.argv?.join(" ")]));
  assert(
    calls.every((c) => c.cmd === "git") && calls.every((c) => c.argv !== undefined),
    `every git read this module issues is argv form (got: ${rendered})`,
  );
}

process.exit(exit);
