#!/usr/bin/env bun
/**
 * lean/build — the cases where the developer's tree is a link or a kind the
 * step must not follow, and the frozen-record edge that goes with them.
 *
 * Same harness as test-lean-build.ts (a real temp repo, a real worktree, only
 * the model stubbed). Split out to keep each smoke file under the size gate.
 *
 *   (n) child plants a dir symlink OUTSIDE and writes through it -> outside untouched,
 *       link removed, src edit committed
 *   (o) child replaces the frozen dir with a file -> frozen restored, file removed, no residue
 *   (p) a zero-byte frozen test with a matching empty record -> THROW, child never dispatched
 *   (q) child replaces a tracked dir with a link to an outside dir of the same names ->
 *       outside bytes never committed, the names are removed
 */

import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { BuildInfraError } from "../src/lean/build-errors.ts";
import {
  ROOTS,
  SRC,
  TEST,
  commitPaths,
  git,
  outsideDir,
  put,
  putOutside,
  runBuild,
  sha,
  status,
  symlink,
} from "./lib/lean-build-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------ (n) the child plants a symlinked DIRECTORY and writes through it
//
// The link points OUTSIDE the worktree and the child writes a file through it.
// That write is the child's own act, made before the step runs; the snapshot
// taken right after it is what the step must leave exactly as it is.
{
  const outside = outsideDir();
  putOutside(path.join(outside, "keep.txt"), "OUTSIDE KEEP\n");
  const snapshot = (dir: string): string =>
    readdirSync(dir)
      .sort()
      .map((f) => `${f}=${readFileSync(path.join(dir, f), "utf8")}`)
      .join("|");
  const seen = { outsideAfterChild: "" };
  const r = await runBuild({
    issue: 114,
    child: (wt) => {
      put(wt, "src/retry.ts", "export const retry = () => 8;\n");
      symlink(wt, "src/linkdir", outside);
      put(wt, "src/linkdir/planted.ts", "PLANTED THROUGH THE LINK\n");
      seen.outsideAfterChild = snapshot(outside);
    },
  });
  const wt = r.worktree;
  assert(r.threw === undefined, `(n) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.outcome?.kind === "ok", `(n) ok, got ${r.outcome?.kind}`);
  assert(
    seen.outsideAfterChild.includes("planted.ts="),
    "(n) the child really did write through the link (the threat is live)",
  );
  assert(
    snapshot(outside) === seen.outsideAfterChild,
    "(n) the outside directory is exactly as the child left it",
  );
  assert(!existsSync(path.join(wt, "src/linkdir")), "(n) the link is gone from the tree");
  assert(
    (r.outcome?.reason ?? "").includes("removed: src/linkdir ("),
    `(n) the link is listed as removed with its reason (got ${r.outcome?.reason})`,
  );
  assert(
    git(wt, "show", "HEAD:src/retry.ts") === "export const retry = () => 8;",
    "(n) the real src edit is committed",
  );
  assert(
    commitPaths(wt).join() === "src/retry.ts",
    `(n) the commit holds the src edit only (got ${commitPaths(wt).join(", ")})`,
  );
  assert(status(wt) === "", `(n) clean after the commit (got ${status(wt)})`);
}

// ------------------------- (o) the frozen DIRECTORY is replaced by a file
//
// The frozen test lives under `tests/`. The child deletes that directory and
// leaves a regular file where it was. The reset brings the frozen test back, and
// the file cannot be written over a directory: it is removed with its reason,
// not thrown, and the temp file that write would have made is not left behind.
{
  const r = await runBuild({
    issue: 115,
    child: (wt) => {
      put(wt, "src/retry.ts", "export const retry = () => 9;\n");
      rmSync(path.join(wt, "tests"), { recursive: true, force: true });
      put(wt, "tests", "the child put a file where the directory was\n");
    },
  });
  const wt = r.worktree;
  assert(r.threw === undefined, `(o) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.outcome?.kind === "ok", `(o) ok, got ${r.outcome?.kind}`);
  assert(lstatSync(path.join(wt, "tests")).isDirectory(), "(o) tests/ is a directory again");
  assert(
    readFileSync(path.join(wt, "tests/AC1-retry.test.sh"), "utf8") === TEST,
    "(o) the frozen test is back at its recorded bytes",
  );
  assert(
    (r.outcome?.reason ?? "").includes("removed: tests ("),
    `(o) the file is listed as removed with its reason (got ${r.outcome?.reason})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes("restored: tests/AC1-retry.test.sh"),
    `(o) the frozen test is named as restored (got ${r.outcome?.reason})`,
  );
  const residue = [...readdirSync(wt), ...readdirSync(path.join(wt, "tests"))].filter((f) =>
    f.startsWith(".lean-capture"),
  );
  assert(residue.length === 0, `(o) no capture temp file is left behind (got ${residue.join()})`);
  assert(commitPaths(wt).join() === "src/retry.ts", "(o) the commit holds the src edit only");
  assert(status(wt) === "", `(o) clean after the commit (got ${status(wt)})`);
}

// ------------------------------------- (p) an empty frozen test, with an empty record
//
// The committed frozen test is zero bytes and the record is the hash of zero
// bytes, so bytes and record agree. A zero-byte file is not a test: the step
// refuses before the developer is paid.
{
  const r = await runBuild({ issue: 116, frozenText: "", frozenSha: sha("") });
  assert(r.threw !== undefined, "(p) the step refuses a zero-byte frozen test");
  assert(r.threw instanceof BuildInfraError, "(p) the throw is a BuildInfraError");
  assert(
    (r.threw?.message ?? "").includes("frozen tests do not match the record"),
    `(p) the throw names the failure (got ${r.threw?.message})`,
  );
  assert(r.dispatched === 0, `(p) the developer was never dispatched (got ${r.dispatched})`);
}

// ---- (q) a tracked DIRECTORY replaced by a link to an outside directory of the same names
//
// `src/` is tracked. The child deletes it and links `src` to an outside directory
// holding a file of the same name as `src/retry.ts`. Following that link would
// commit the outside bytes; the name is reached through a link, so it is removed
// instead, and the reset restores the real `src/retry.ts`.
{
  const outside = outsideDir();
  putOutside(path.join(outside, "retry.ts"), "OUTSIDE RETRY BYTES\n");
  const r = await runBuild({
    issue: 117,
    child: (wt) => {
      put(wt, "lib/other.ts", "export const other = 2;\n");
      rmSync(path.join(wt, "src"), { recursive: true, force: true });
      symlink(wt, "src", outside);
    },
  });
  const wt = r.worktree;
  assert(r.threw === undefined, `(q) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.outcome?.kind === "ok", `(q) ok, got ${r.outcome?.kind}`);
  assert(
    git(wt, "show", "HEAD:src/retry.ts") === SRC.trimEnd(),
    "(q) the committed src/retry.ts is the base bytes, not the outside ones",
  );
  assert(
    commitPaths(wt).join() === "lib/other.ts",
    `(q) the commit holds the lib edit only (got ${commitPaths(wt).join(", ")})`,
  );
  assert(lstatSync(path.join(wt, "src")).isDirectory(), "(q) src/ is a real directory again");
  assert(
    readFileSync(path.join(wt, "src/retry.ts"), "utf8") === SRC,
    "(q) the worktree's src/retry.ts is the base bytes",
  );
  assert(
    readFileSync(path.join(outside, "retry.ts"), "utf8") === "OUTSIDE RETRY BYTES\n",
    "(q) the outside file is untouched",
  );
  assert(
    (r.outcome?.reason ?? "").includes("src/retry.ts (is reached through a symbolic link)"),
    `(q) the name behind the link is listed as removed (got ${r.outcome?.reason})`,
  );
  assert(status(wt) === "", `(q) clean after the commit (got ${status(wt)})`);
}

for (const dir of ROOTS) {
  try {
    (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
process.exit(exit);
