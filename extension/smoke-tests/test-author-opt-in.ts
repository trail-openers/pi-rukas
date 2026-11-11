#!/usr/bin/env bun
/**
 * #2181 A7/A8 — the merge-author gate is OPT-IN per repository.
 *
 * A repository that has never committed the gate file has never said who may land
 * a pull request, and the rule the operator chose for THIS repository is not that
 * repository's rule. `/work` and lean run in other repositories — including
 * benchmark trial repos that seed only the lean config — so an allowlist that
 * opted out by default refused every landing there. So:
 *
 *   - ABSENT gate file at the base commit → the author gate is not applied at all,
 *     and every other gate keeps its meaning.
 *   - PRESENT gate file → fail closed, exactly as before: a file that names nobody,
 *     a symlink, a tree, an unreadable blob and an author the forge never reported
 *     all refuse.
 *   - An unreadable AUTHOR refuses only when the file is present — with no file
 *     there is no allowlist to check the login against, and the gate has no subject.
 *
 * A missing base commit is NOT absence: a cycle that cannot name its base cannot
 * show the file was absent at it, so that still refuses.
 */

import {
  MERGE_AUTHORS_FILE,
  mergeAuthorGate,
  readMergeAuthorAllowlist,
} from "../src/merge-author-allowlist.ts";
import { heldForMergeAuthor } from "../src/merge-guard-author.ts";
import { type OptInArm, optInExec, repoWithOptionalGateFile } from "./lib/author-opt-in-arms.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`\u2713 ${msg}`);
  } else {
    failures++;
    console.log(`\u2717 ${msg}`);
  }
}

const SHA = "0123456789abcdef0123456789abcdef01234567";
const ALLOWED = { ok: true, login: "alice" } as const;

/** The probe's answer for an absent path — git exits non-zero, it does not say "no". */
const ABSENT: OptInArm = { absent: true };

// ---------------------------------------------------------------- A8: absent -> the gate is not applied
{
  const { exec, calls } = optInExec(ABSENT);
  const read = await readMergeAuthorAllowlist(exec, "/r", SHA);
  assert(
    read.ok === false && read.reason === "absent",
    `the reader reports absence as its OWN reason rather than a read failure (${read.ok === false ? read.reason : "ok"})`,
  );
  assert(
    (read.ok === false ? (read.detail ?? "") : "").includes(MERGE_AUTHORS_FILE),
    "…and its detail names the gate file so the operator can see what was not there",
  );
  assert(
    calls.length > 0 && !calls.some((c) => c.includes("show")),
    `absence is decided by the two cheap probes — no bytes are read for a file that is not there (${JSON.stringify(calls)})`,
  );
}
{
  // The control for every refusal below: with the file present, a stranger is
  // refused. Without it, the arm after this could be "the gate refuses everything".
  const { exec } = optInExec({});
  const stranger = await heldForMergeAuthor({
    exec,
    cwd: "/r",
    baseSha: SHA,
    author: { ok: true, login: "mallory" },
  });
  assert(
    stranger.ok === false && stranger.kind === "not-allowlisted",
    "a repository that HAS the file still refuses a stranger",
  );
}
{
  const { exec, calls } = optInExec(ABSENT);
  const stranger = await heldForMergeAuthor({
    exec,
    cwd: "/r",
    baseSha: SHA,
    author: { ok: true, login: "mallory" },
  });
  assert(
    stranger.ok === true,
    `A8: an absent gate file means the repository never opted in, so any author lands (${JSON.stringify(stranger)})`,
  );
  const unreadable = await heldForMergeAuthor({
    exec,
    cwd: "/r",
    baseSha: SHA,
    author: { ok: false, detail: "the forge reported no author" },
  });
  assert(
    unreadable.ok === true,
    "A7: an unreadable author refuses only where the file is present — with no allowlist there is nothing to check it against",
  );
  assert(
    calls.length > 0 && !calls.some((c) => c.includes("show")),
    "…and the absent file still costs only the probes, never a blob read",
  );
}
{
  // Absence is a property of the BASE COMMIT, so a case cannot reach it by
  // deleting the file from its own working tree. The clone has no gate file at all;
  // the read is still asked at a sha, and nothing is ever read from disk.
  const { repoRoot, baseSha, dispose } = repoWithOptionalGateFile({});
  const realGit: string[] = [];
  const spy = async (_cmd: string, opts?: { argv?: string[] }): Promise<{ stdout: string }> => {
    const argv = opts?.argv ?? [];
    realGit.push(argv.join(" "));
    const { spawnSync } = await import("node:child_process");
    const child = spawnSync("git", argv, { cwd: repoRoot });
    if (child.status !== 0) {
      const words = child.stderr.toString();
      // The same shape as `gitFailure`: a real git child reports its verdict on
      // `stderr` with its exit `code`, and the absence classifier reads those
      // two fields rather than the message.
      throw Object.assign(new Error(words.slice(0, 200)), {
        code: child.status,
        stderr: words,
      });
    }
    return { stdout: child.stdout.toString() };
  };
  const decision = await heldForMergeAuthor({
    exec: spy,
    cwd: repoRoot,
    baseSha,
    author: { ok: true, login: "anyone-at-all" },
  });
  dispose();
  assert(
    decision.ok === true,
    `against a REAL repository with no gate file at its base, the merge is allowed (${JSON.stringify(decision)})`,
  );
  assert(
    realGit.length > 0 &&
      realGit.every(
        // Three reads, three commit-naming shapes: `<sha>:<path>` for the type probe and
        // the blob, `<ref>^{commit}` for the base resolve, and `ls-tree <sha> -- <path>`
        // for the mode — whose revision is an argument of its own, not a suffixed last
        // token. What none of them may be is a bare working-tree path.
        (c) =>
          /[0-9a-f]{7,40}:/.test(c) ||
          /\^\{commit\}$/.test(c) ||
          / ls-tree [0-9a-f]{7,40} -- /.test(c),
      ),
    `…and every read named a commit, never a working-tree path (${JSON.stringify(realGit)})`,
  );
}

// --------------------------------------------------------- A8: present but empty -> refuses
{
  const { exec } = optInExec({ body: "# the maintainers\n\n\t\n" });
  const decision = await heldForMergeAuthor({
    exec,
    cwd: "/r",
    baseSha: SHA,
    author: { ok: true, login: "alice" },
  });
  assert(
    decision.ok === false && decision.kind === "allowlist-unreadable",
    `A8: a file that exists but names nobody refuses even the login it might have listed (${JSON.stringify(decision)})`,
  );
  assert(
    (decision.reason ?? "").includes("names no login"),
    `…and says the file names no login (${JSON.stringify((decision.reason ?? "").slice(0, 140))})`,
  );
}

// ------------------------------------- A7: present but unreadable / a tree / a symlink -> refuses
{
  const arms: Array<[string, OptInArm, string]> = [
    ["a directory at the path", { type: "tree", mode: "040000" }, "directory"],
    [
      // The arm that real git makes the old probe useless against: a committed symlink
      // is a `blob` to `cat-file -t`, so only the tree MODE catches it.
      "a symlink at the path",
      { type: "blob", mode: "120000" },
      "symlink",
    ],
    ["a submodule at the path", { type: "blob", mode: "160000" }, "submodule"],
    ["an unreadable blob", { showThrows: true }, ""],
  ];
  for (const [name, arm, expect] of arms) {
    const { exec } = optInExec(arm);
    const read = await readMergeAuthorAllowlist(exec, "/r", SHA);
    assert(
      read.ok === false && read.reason !== "absent",
      `A7: a PRESENT file that cannot be read as ${name} is a refusal, never an opt-out (${read.ok === false ? read.reason : "ok"})`,
    );
    assert(
      expect.length === 0 || (read.ok === false ? (read.detail ?? "") : "").includes(expect),
      `…and the refusal names its cause for "${name}"`,
    );
    const decision = await heldForMergeAuthor({
      exec,
      cwd: "/r",
      baseSha: SHA,
      author: ALLOWED,
    });
    assert(
      decision.ok === false && decision.kind === "allowlist-unreadable",
      `…and on the shared path ${name} parks as an unreadable gate file, not as an opt-out`,
    );
  }
}
{
  // A file whose bytes cannot be read is NOT the same as no file, and the author
  // never reaches the comparison: the gate file's own fault is what is reported.
  const { exec } = optInExec({ showThrows: true });
  const stranger = await heldForMergeAuthor({
    exec,
    cwd: "/r",
    baseSha: SHA,
    author: { ok: true, login: "mallory" },
  });
  assert(
    stranger.ok === false && stranger.kind === "allowlist-unreadable",
    "an unreadable gate file outranks the stranger's login in the refusal it gets",
  );
}

// ------------------------- an unreadable author refuses where the file is present (A7's other half)
{
  const { exec } = optInExec({});
  const unreadable = await heldForMergeAuthor({
    exec,
    cwd: "/r",
    baseSha: SHA,
    author: { ok: false, detail: "the forge reported no author" },
  });
  assert(
    unreadable.ok === false && unreadable.kind === "author-unreadable",
    "A7: with the file present, an author the forge never reported still refuses",
  );
  assert(
    (unreadable.reason ?? "").includes("could not be read"),
    "…and is worded as an unreadable author, not as somebody off the list",
  );
}

// ------------------------------------------------------ absence is not "no base commit"
{
  const { exec } = optInExec(ABSENT);
  const noBase = await heldForMergeAuthor({
    exec,
    cwd: "/r",
    baseSha: undefined,
    author: { ok: true, login: "alice" },
  });
  assert(
    noBase.ok === false && noBase.kind === "allowlist-unreadable",
    "a cycle with no recorded base cannot PROVE the file was absent at it, so it is refused rather than opted out",
  );
}

// --------------------------------------------- the pure gate keeps absence apart from a refusal
{
  const absent = { ok: false, reason: "absent" } as const;
  const stranger = mergeAuthorGate({
    allowlist: absent,
    author: { ok: true, login: "mallory" },
  });
  assert(
    stranger.ok === true,
    "the shared function itself treats an absent gate file as no rule, so no path can re-implement absence as a refusal",
  );
  const unreadableAuthor = mergeAuthorGate({
    allowlist: absent,
    author: { ok: false, detail: "the forge reported no author" },
  });
  assert(
    unreadableAuthor.ok === true,
    "…and an unreadable author with no file is likewise no rule",
  );
  // A read that could not be made is still a refusal, and the two reasons stay apart.
  const broken = { ok: false, reason: "git-failed", detail: "boom" } as const;
  const brokenDecision = mergeAuthorGate({
    allowlist: broken,
    author: { ok: true, login: "alice" },
  });
  assert(brokenDecision.ok === false, "a git read that failed is NOT absence — it still refuses");
}

if (failures > 0) {
  console.log(`\nFAILED ${failures} assertion(s)`);
  process.exit(1);
}
console.log("\nall assertions passed");
