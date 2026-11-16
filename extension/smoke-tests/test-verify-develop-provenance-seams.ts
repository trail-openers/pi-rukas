#!/usr/bin/env bun
/**
 * #2295 round 1 — the two seams a false PASS would come from, tested apart from the gate.
 *
 * The gate suites drive a real repository and pin verdicts; this file pins the two FUNCTIONS those
 * verdicts are computed by, because both can be wrong in a way a repository fixture cannot show
 * cheaply. `basenameNames` is the whole of the basename arm's weakening: if a substring ever
 * satisfied a claim, a decoy file would pass a record that cited a different one, and the
 * disclosure would name a path that was never a match. `probeHostRoot` is the only host read the
 * gate makes, and its arms are a traversal refusal, a regular-file refusal, a symlink-escape
 * refusal, and the distinction between "not there" (a failure) and "past the depth this seam walks"
 * (a could-not-tell) — answering the second with the first would fail a legitimate run tree on the
 * gate's own cost bound.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PROVENANCE_TREE_MAX_BYTES,
  basenameNames,
  readTreePaths,
} from "../src/work-driver-verify-develop-provenance-commit.ts";
import {
  PROVENANCE_ROOT_MAX_DEPTH,
  probeHostRoot,
} from "../src/work-driver-verify-develop-provenance-root.ts";
import { assert, exit } from "./lib/assert-rig.ts";

// ── 1. the basename matcher is component-wise, never a substring or a suffix ───────────────
{
  const paths = new Set([
    "deep/nested/out.ndjson",
    "docs/notes/deep/inner/run.log",
    "xout.ndjson",
    "out.ndjson.bak",
    "README.md",
  ]);
  assert(
    basenameNames(paths, "out.ndjson") === true,
    "a bare claim is satisfied by a file of that name at any depth",
  );
  assert(
    basenameNames(paths, "xout.ndjson") === true,
    "and by a top-level file of that name",
  );
  // The two substring shapes that would buy an adversary a green: a path that merely ENDS with the
  // name after an extra leading character, and one that ends with it plus a suffix.
  assert(
    basenameNames(new Set(["deep/xout.ndjson"]), "out.ndjson") === false,
    "a file whose name merely ENDS with the claim (`xout.ndjson`) does not satisfy it",
  );
  assert(
    basenameNames(new Set(["deep/out.ndjson.gz"]), "out.ndjson") === false &&
      basenameNames(new Set(["deep/x.log.bak"]), "x.log") === false,
    "a file with an extra extension does not satisfy the bare name it contains",
  );
  assert(
    basenameNames(paths, "out") === false && basenameNames(paths, "d") === false,
    "a prefix of a basename is not a basename — the matcher never degrades to startsWith",
  );
  assert(
    basenameNames(new Set<string>(), "out.ndjson") === false,
    "an empty listing names nothing (the ceiling path reads this as unreadable, never as this)",
  );
  assert(
    basenameNames(new Set([""]), "out.ndjson") === false,
    "and a blank entry is not a path that matches anything",
  );
}

// ── 2. the tree listing fails CLOSED: a read that could not answer never yields a path set ──
{
  const oid = "a".repeat(40);
  const oversize = await readTreePaths(
    (async () => ({ stdout: "x".repeat(PROVENANCE_TREE_MAX_BYTES + 1) })) as never,
    "/repo",
    oid,
  );
  assert(
    oversize.ok === false && String(oversize.why).includes("ceiling") === true,
    `a listing past the byte ceiling is a named ceiling failure, never a truncated set (got ${JSON.stringify(oversize)})`,
  );
  const threw = await readTreePaths(
    (async () => {
      throw new Error("git died");
    }) as never,
    "/repo",
    oid,
  );
  assert(
    threw.ok === false && String(threw.why).includes("could not be read") === true,
    `a git fault is a named unread, never an empty listing that then reports absence (got ${JSON.stringify(threw)})`,
  );
  const shortSha = await readTreePaths(
    (async () => ({ stdout: "" })) as never,
    "/repo",
    "abc123",
  );
  assert(
    shortSha.ok === false && String(shortSha.why).includes("full commit sha") === true,
    `a ref that is not a full sha is refused before any read (got ${JSON.stringify(shortSha)})`,
  );
  // The vacuity guard for the two arms above: the same helper DOES return a set when git answers.
  const good = await readTreePaths(
    (async () => ({ stdout: "results/a.ndjson\0deep/b.ndjson\0" })) as never,
    "/repo",
    oid,
  );
  assert(
    good.ok === true && good.paths.size === 2 && basenameNames(good.paths, "b.ndjson") === true,
    `control: an executed listing yields its entries, so the two refusals above are the bound and not a helper that always fails (got ${JSON.stringify(good)})`,
  );
}

// ── 3. the host root: traversal, non-regular files and symlink escapes all answer `absent` ──
{
  const root = mkdtempSync(path.join(tmpdir(), "pi-2295-root-seam-"));
  const outside = mkdtempSync(path.join(tmpdir(), "pi-2295-outside-"));
  try {
    writeFileSync(path.join(outside, "looted.ndjson"), '{"x":1}\n');
    writeFileSync(path.join(outside, "looted.sh"), "#!/bin/sh\n");
    mkdirSync(path.join(root, "runs", "c5"), { recursive: true });
    writeFileSync(path.join(root, "runs", "c5", "widened.ndjson"), '{"t":1}\n');
    writeFileSync(path.join(root, "top.json"), "{}\n");
    mkdirSync(path.join(root, "widened-dir.json"), { recursive: true }); // a DIRECTORY named like a file
    symlinkSync(path.join(outside, "looted.ndjson"), path.join(root, "looted.ndjson"));
    // A linked PARENT component: `linked/x.ndjson` resolves outside the root.
    mkdirSync(path.join(root, "real"), { recursive: true });
    symlinkSync(outside, path.join(root, "linked"));

    // (a) A regular file under the root satisfies a path claim at exactly that path.
    assert(
      probeHostRoot(root, "runs/c5/widened.ndjson").kind === "present",
      "a regular file at the claimed path under the root satisfies the claim",
    );
    // (b) A bare name is found anywhere below the root within the depth the seam walks.
    assert(
      probeHostRoot(root, "widened.ndjson").kind === "present",
      "a bare name is satisfied by a regular file of that name at depth",
    );
    // (c) Traversal and an absolute re-spelling never satisfy, and never become a verdict of
    // "present" — the fragment is the child's bytes, not the operator's path.
    for (const bad of ["../etc/passwd", "runs/../../etc/passwd", "/etc/passwd", "..", "runs/"]) {
      assert(
        probeHostRoot(root, bad).kind === "absent",
        `a traversal or absolute fragment (\`${bad}\`) is answered absent, never present`,
      );
    }
    // (d) A directory that shares the claimed name is not a regular file.
    assert(
      probeHostRoot(root, "widened-dir.json").kind === "absent",
      "a DIRECTORY named like the claimed file does not satisfy the claim",
    );
    // (e) A symlink to a file outside the root does not satisfy it, whether claimed by path or by
    // bare name — the realpath must stay inside the declared root.
    assert(
      probeHostRoot(root, "looted.ndjson").kind === "absent" &&
        probeHostRoot(root, "runs/../looted.ndjson").kind === "absent",
      "a symlink that resolves OUTSIDE the root does not satisfy a claim by name or by path",
    );
    assert(
      probeHostRoot(root, "linked/looted.ndjson").kind === "absent",
      "a linked PARENT directory cannot walk a claim out of the root",
    );
    // (f) A slashed claim whose path holds no file is `absent` — the depth bound never applies to a
    // claim that named where it lives, so a decoy of the same name elsewhere cannot mute it.
    mkdirSync(path.join(root, "decoy"), { recursive: true });
    writeFileSync(path.join(root, "decoy", "gone.ndjson"), "{}\n");
    const slashed = probeHostRoot(root, "runs/gone.ndjson");
    assert(
      slashed.kind === "absent",
      `a slashed claim answered by a decoy of that name ELSEWHERE still reads absent (got ${JSON.stringify(slashed)})`,
    );
    // (g) A bare name whose file sits PAST the depth ceiling is a could-not-tell, not a failure —
    // the ceiling is this seam's cost decision and a record must not fail on it.
    const deepDir = ["a", "b", "c", "d", "e", "f", "g", "h"].slice(0, PROVENANCE_ROOT_MAX_DEPTH + 2);
    const deepRel = path.join(...deepDir, "buried.ndjson");
    mkdirSync(path.join(root, ...deepDir), { recursive: true });
    writeFileSync(path.join(root, deepRel), "{}\n");
    const deep = probeHostRoot(root, "buried.ndjson");
    assert(
      deep.kind === "unusable" && deep.refusal === "beyond-depth",
      `a bare name whose file is past the ${PROVENANCE_ROOT_MAX_DEPTH}-level walk is a named beyond-depth could-not-tell, never a failure (got ${JSON.stringify(deep)})`,
    );
    // (h) A name that occurs nowhere is `absent` — the beyond-depth arm must not swallow it.
    assert(
      probeHostRoot(root, "never-committed.ndjson").kind === "absent",
      "a name that does not occur below the root at all reads absent",
    );
    // (i) A root that cannot be read is `unusable`, never `absent` and never `present`.
    const broken = probeHostRoot(path.join(root, "no-such-dir"), "top.json");
    assert(
      broken.kind === "unusable" && broken.refusal === "unreadable",
      `a missing root is a named unreadable refusal (got ${JSON.stringify(broken)})`,
    );
    const fileRoot = probeHostRoot(path.join(root, "top.json"), "top.json");
    assert(
      fileRoot.kind === "unusable" && String(fileRoot.why).includes("not a directory") === true,
      `a root that is a FILE is refused by name (got ${JSON.stringify(fileRoot)})`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
}

console.log(`\nexit ${String(exit)}`);
process.exit(exit);
