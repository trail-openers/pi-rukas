#!/usr/bin/env bun
/**
 * #2181 — the merge-author gate's OPT-OUT is decided by git's stderr, never by the
 * message that embeds the command line.
 *
 * The one thing this gate does to allow a merge is answer "this repository never
 * committed `.pi/merge-authors`". When that answer came from a local regex over
 * `errText(err)` plus git's words, and `errText` reads `message` — where the
 * executor writes `Command failed: git cat-file -t <base>:.pi/merge-authors` — the
 * base sha itself entered the matched text. A base git cannot resolve prints
 * `fatal: not a valid object name <base>`, which that regex also accepted, so a
 * PRESENT gate file was read as no gate at all and a stranger's PR merged. Same
 * shape for a broken clone.
 *
 * The classifier is now the shared `gitCatFileSaysAbsent` (`git-range.ts`), which
 * reads `stderr` and the exit code only. These arms pin both halves of that rule:
 * an unresolvable ref refuses rather than opting out, and a genuine
 * "path … does not exist in <commit>" still answers the opt-out — because deleting
 * the phrase set to fix the fail-open would have broken every seeded trial
 * repository that never opted in.
 */

import { readMergeAuthorAllowlist } from "../src/merge-author-allowlist.ts";
import { gitFailure } from "./lib/author-opt-in-arms.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.log(`✗ ${msg}`);
    exit = 1;
  }
}

const BASE = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const GATE_FILE = [".pi", "merge-authors"].join("/");

/** An executor whose type probe fails like git, with the command line in `message`. */
function probeRejects(stderr: string) {
  return async (_cmd: string, opts?: { argv?: string[] }) => {
    const argv = opts?.argv ?? [];
    // The execp shape: `message` names the command, so it carries the base sha.
    throw gitFailure(`Command failed: git ${argv.join(" ")}`, 128, stderr);
  };
}

function reason(read: Awaited<ReturnType<typeof readMergeAuthorAllowlist>>): string {
  return read.ok === false
    ? `${read.reason}: ${read.detail ?? ""}`
    : "ok — merged with no gate at all";
}

{
  // git never read a commit: the REV part of the tree-ish is unresolvable. That
  // says nothing about the path, so it must never become the opt-out.
  const read = await readMergeAuthorAllowlist(
    probeRejects(`fatal: Not a valid object name ${BASE}\n`),
    "/r",
    BASE,
  );
  assert(
    read.ok === false && read.reason !== "absent",
    `an unresolvable base refuses as unreadable, never as absence (${reason(read)})`,
  );
  assert(
    read.ok === false &&
      (read.detail ?? "").toLowerCase().includes("not a valid object name"),
    `…and the refusal carries git's own words (${reason(read)})`,
  );
}
{
  // A broken clone: exit 128 with a complaint about the repository, not the path.
  const read = await readMergeAuthorAllowlist(
    probeRejects("fatal: not a git repository (or any of the parent directories): .git\n"),
    "/r",
    BASE,
  );
  assert(
    read.ok === false && read.reason !== "absent",
    `a repository git cannot read is not an opt-out (${reason(read)})`,
  );
  assert(
    read.ok === false &&
      (read.detail ?? "").toLowerCase().includes("not a git repository"),
    `…and the refusal names what the probe actually answered (${reason(read)})`,
  );
}
{
  // The control: git DID read the commit and answered about the path. That is the
  // one answer that means "no rule here", and the classifier keeps it.
  const exec = async (_cmd: string, opts?: { argv?: string[] }) => {
    const argv = opts?.argv ?? [];
    if (argv.includes("cat-file"))
      throw gitFailure(
        `Command failed: git ${argv.join(" ")}`,
        128,
        `fatal: path '${GATE_FILE}' does not exist in '${BASE}'\n`,
      );    throw new Error("no bytes are read for a path that is not there");
  };
  const read = await readMergeAuthorAllowlist(exec, "/r", BASE);
  assert(
    read.ok === false && read.reason === "absent",
    `git's own "path … does not exist in <commit>" still answers the opt-out (${reason(read)})`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
