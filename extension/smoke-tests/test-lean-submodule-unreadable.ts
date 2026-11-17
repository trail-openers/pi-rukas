#!/usr/bin/env bun
/**
 * lean/submodule-reads — a read that cannot be answered is never read as "nothing is wrong".
 *
 * Two fail-open shapes, both from the same family the module header forbids:
 *
 *   (a) `git submodule status` REJECTS, and `submoduleState` returns `undefined`. The reset treats
 *       `undefined` as "no unproven paths", so a step whose backstop read died reports a tree
 *       whose submodule nobody proved as if the submodule were there. The backstop is the one read
 *       that exists to catch a pass that lied, so its own failure must reach the disclosure
 *       rather than delete it;
 *   (b) the per-path `submodule status` the offline control asks REJECTS, and the code reads the
 *       absent line as "nothing fetched, nothing added" and proceeds. Not being able to tell is
 *       not evidence of a clean tree.
 *
 *   (c) `firstTrackedFile`'s `expect` names a file. `git ls-tree -r --name-only` lists TREE
 *       entries too, and `-r` recurses — so a submodule whose first entry is a directory yields a
 *       name no checkout will ever hold, and the reset then flags a perfectly good seeded
 *       submodule as an empty checkout. Blobs only.
 *
 * Every case drives a stub exec that REJECTS the read in question; none of them is a stub that
 * merely answers empty, which is the difference between testing an unreadable read and testing an
 * empty one.
 */

import { submoduleState } from "../src/lean/specify-submodules.ts";
import { firstTrackedFile } from "../src/lean/submodule-expect.ts";
import type { ExecFn } from "../src/worktree.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

const SUB = "vendor/lib";
const SHA = "0123456789abcdef0123456789abcdef01234567";

/** An exec that rejects every git call, the way a child the platform refuses comes back. */
const rejects =
  (label: string): ExecFn =>
  async () => {
    throw new Error(`${label}: exec rejected`);
  };

/** An exec that records calls and answers with a rule the case supplies. */
const answering =
  (rule: (argv: string[]) => string | undefined): { exec: ExecFn; calls: string[][] } => {
    const calls: string[][] = [];
    return {
      calls,
      exec: async (_cmd, o) => {
        const argv = (o?.argv ?? []) as string[];
        calls.push([...argv]);
        return { stdout: rule(argv) ?? "", stderr: "" };
      },
    };
  };

// ── (a) an unreadable `submodule status` is not "no unproven paths"
{
  // A real `.gitmodules` on disk: the step's first gate is a disk read that no stub answers, so
  // without it the case would exercise "no submodules to ask about" rather than the read dying.
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const tree = mkdtempSync("/tmp/lean-sub-state-unreadable-");
  writeFileSync(`${tree}/.gitmodules`, `[submodule "${SUB}"]\n\tpath = ${SUB}\n`);
  const state = await submoduleState(rejects("submodule status"), tree);
  // `registered` is what tells the reader whether git was asked about a tree that has submodules
  // at all. `undefined` collapses three different situations — no `.gitmodules`, a read that
  // died, and a tree git lists nothing for — into one value that the reset reads as "nothing
  // unproven". The unreadable one has to be distinguishable.
  assert(
    state !== undefined && state.unreadable === true,
    `(a) a submoduleState whose \`submodule status\` rejected says so, rather than reporting nothing unproven (got ${JSON.stringify(state)})`,
  );
}

// ── (b) the offline control's per-path read is not silently "nothing arrived"
{
  // The case that matters is what the RESET does with the read, so drive the real path: one
  // registered submodule with nothing local to seed it, and the per-path `submodule status` the
  // control issues rejecting. The step must not come away having proved nothing and disclosed
  // nothing.
  const { initSubmodules } = await import("../src/lean/specify-submodules.ts");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const wt = mkdtempSync("/tmp/lean-sub-unreadable-");
  writeFileSync(`${wt}/.gitmodules`, `[submodule "${SUB}"]\n\tpath = ${SUB}\n`);
  const calls: string[][] = [];
  const exec: ExecFn = async (_cmd, o) => {
    const argv = (o?.argv ?? []) as string[];
    calls.push([...argv]);
    const joined = argv.join(" ");
    if (joined.includes("--get-regexp"))
      return { stdout: `submodule.${SUB}.path ${SUB}\n`, stderr: "" };
    // The superproject's git dirs, answered with a shape `superprojectRoot` accepts.
    if (joined.includes("--git-common-dir"))
      return { stdout: `${wt}/.git\n`, stderr: "" };
    if (joined.includes("--absolute-git-dir")) return { stdout: `${wt}/.git\n`, stderr: "" };
    // The control's read: rejects, as a child the platform refuses would.
    if (joined.includes("submodule") && joined.includes("status"))
      throw new Error("submodule status rejected by the platform");
    return { stdout: "", stderr: "" };
  };
  let notes: readonly { path: string; kind: string }[] | undefined;
  let threw: Error | undefined;
  try {
    notes = await initSubmodules(exec, wt);
  } catch (err) {
    threw = err as Error;
  }
  assert(
    threw === undefined,
    `(b) the round proceeds rather than handing back on a read it merely could not make (${threw?.message ?? "clean"})`,
  );
  assert(
    calls.some((a) => a.includes("submodule") && a.includes("status")),
    `(b) precondition: the control's per-path read really was issued (got ${JSON.stringify(calls.map((a) => a.slice(-3)))})`,
  );
  // The honest outcomes are: the note says the control could not be completed, or the run refuses
  // outright. What is NOT honest is an `absent` note with no mark on it, which is the disclosure
  // that reads exactly like a step that proved nothing was fetched.
  const note = notes?.find((n) => n.path === SUB);
  assert(
    note !== undefined &&
      ((note as { unreadable?: boolean }).unreadable === true ||
        (note as { unproven?: string[] }).unproven?.length !== undefined),
    `(b) and the unreadable control leaves a mark on the note instead of a silent pass (got ${JSON.stringify(note)})`,
  );
}

// ── (c) `expect` names a BLOB, never a tree
{
  // A submodule whose recorded commit holds a directory first and a file second. `ls-tree -r -t`
  // prints BOTH: the tree `dir` and the blob `dir/lib`. A reader that takes the first line gets
  // `dir`, which no checkout holds as a file, so the reset flags a good seed as an empty checkout
  // and the disclosure names a submodule that is fine.
  const listing = answering((argv) => {
    if (argv.includes("ls-tree") && argv.includes("HEAD"))
      return `160000 commit ${SHA}\t${SUB}\n`;
    if (argv.includes("ls-tree"))
      return `040000 tree ${SHA}\tdir\n100644 blob ${SHA}\tdir/lib\n`;
    return "";
  });
  const expect = await firstTrackedFile(listing.exec, "/tmp/whatever", { name: SUB, path: SUB }, "/tmp/source");
  assert(
    expect === "dir/lib",
    `(c) with a directory listed first, expect names the BLOB the checkout holds, not the tree (got ${JSON.stringify(expect)})`,
  );

  // A commit holding ONLY directories yields no expectation at all: checking nothing is the
  // honest answer, whereas a tree name would accuse a healthy seed of being empty.
  const onlyDirs = answering((argv) => {
    if (argv.includes("ls-tree") && argv.includes("HEAD"))
      return `160000 commit ${SHA}\t${SUB}\n`;
    if (argv.includes("ls-tree")) return `040000 tree ${SHA}\tdir\n040000 tree ${SHA}\tother\n`;
    return "";
  });
  const none = await firstTrackedFile(onlyDirs.exec, "/tmp/whatever", { name: SUB, path: SUB }, "/tmp/source");
  assert(
    none === undefined,
    `(c) and a commit whose entries are all trees sets no expectation (got ${JSON.stringify(none)})`,
  );
}

process.exit(failures());
