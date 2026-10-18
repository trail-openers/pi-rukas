/**
 * #1016 — the develop path's git writes are literal and driver-scoped. Real
 * git worktrees: (A) file names that are glob syntax are staged literally,
 * (B) the safety net never commits a `.pi/` or `tmp/` file, even one another
 * process already staged, while a tracked `.pi/` or `tmp/` edit is still
 * SAVED to the retry patch, (C) a second retry for one workstream writes
 * attempt -2, (D) an unreadable commit check counts as evidence, and (E) a
 * commit whose sha cannot be read is still recorded.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetWorktreeToBase, runGit, stagePaths } from "../src/work-develop-git.ts";
import { retryResetFor } from "../src/work-develop-retry.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { hasAnyWorktreeEvidence, safetyNetWorktree } from "../src/work-driver-safety-net.ts";
import { execp } from "../src/work-driver-verify.ts";
import type { WorkState } from "../src/workflow-state.ts";
import { ensureGitIdentity, gitIn, makeBaseWorktrees } from "./lib/git-worktree-fixture.ts";

ensureGitIdentity();

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.log(`✗ ${msg}`);
    exit = 1;
  }
}

/** The subcommand follows the global `--literal-pathspecs` option when present. */
const subOf = (argv: string[]) => argv.find((x) => !x.startsWith("--literal-pathspecs"));

const dir = await mkdtemp(path.join(tmpdir(), "pathspec-1016-"));
try {
  const ids = ["lit", "mix", "save", "re", "ev", "rp"];
  const shas = await makeBaseWorktrees(dir, ids);
  const wt = (id: string) => path.join(dir, ".worktrees", id);
  const git = runGit(execp);

  // (A) Glob syntax is a literal name. `c1.ts` must NOT be swept in by `c[1].ts`,
  // and `*` must NOT stage the untracked `.pi/x` driver file.
  await writeFile(path.join(wt("lit"), "c[1].ts"), "bracket");
  await writeFile(path.join(wt("lit"), "*"), "star");
  await writeFile(path.join(wt("lit"), "c1.ts"), "decoy");
  await mkdir(path.join(wt("lit"), ".pi"), { recursive: true });
  await writeFile(path.join(wt("lit"), ".pi", "x"), "driver");
  await stagePaths(git, wt("lit"), ["c[1].ts", "*"]);
  const staged = gitIn(wt("lit"), ["diff", "--cached", "--name-only", "-z"])
    .split("\0")
    .filter((p) => p !== "")
    .sort();
  assert(
    staged.join("|") === "*|c[1].ts",
    "#1016: literal pathspecs stage exactly the named files, not glob matches",
  );

  // (B) A tracked .pi/ edit and a tracked tmp/ edit, plus a real source edit.
  // The .pi/ edit is pre-staged by someone else; the safety net must not commit it.
  await mkdir(path.join(wt("mix"), ".pi"), { recursive: true });
  await mkdir(path.join(wt("mix"), "tmp"), { recursive: true });
  await writeFile(path.join(wt("mix"), ".pi", "verify-cmd"), "base\n");
  await writeFile(path.join(wt("mix"), "tmp", "notes.txt"), "base\n");
  gitIn(wt("mix"), ["add", "-f", ".pi/verify-cmd", "tmp/notes.txt"]);
  gitIn(wt("mix"), ["commit", "-qm", "track driver files"]);
  const mixBase = gitIn(wt("mix"), ["rev-parse", "HEAD"]);
  await writeFile(path.join(wt("mix"), ".pi", "verify-cmd"), "developer edit\n");
  gitIn(wt("mix"), ["add", "-f", ".pi/verify-cmd"]);
  await writeFile(path.join(wt("mix"), "tmp", "notes.txt"), "scratch edit\n");
  await writeFile(path.join(wt("mix"), "src.txt"), "real work");
  const sn = await safetyNetWorktree("mix", dir, wt("mix"), mixBase, execp, []);
  assert(sn?.kind === "safety-net-commit", "#1016: the source edit is committed");
  const committed = gitIn(wt("mix"), ["show", "--name-only", "--format=", "HEAD"]).split("\n");
  assert(
    committed.join("|") === "src.txt",
    "#1016: the commit holds only the source file, not a pre-staged .pi/ or tmp/ file",
  );
  assert(
    gitIn(wt("mix"), ["show", "HEAD:.pi/verify-cmd"]) === "base",
    "#1016: HEAD keeps the .pi/ file at its base content",
  );

  // (B, save half) Tracked .pi/ and tmp/ edits with zero commits are saved to the
  // retry patch before the reset, and the reset then restores them.
  await mkdir(path.join(wt("save"), ".pi"), { recursive: true });
  await mkdir(path.join(wt("save"), "tmp"), { recursive: true });
  await writeFile(path.join(wt("save"), ".pi", "verify-cmd"), "base\n");
  await writeFile(path.join(wt("save"), "tmp", "notes.txt"), "base\n");
  gitIn(wt("save"), ["add", "-f", ".pi/verify-cmd", "tmp/notes.txt"]);
  gitIn(wt("save"), ["commit", "-qm", "track driver files"]);
  const saveBase = gitIn(wt("save"), ["rev-parse", "HEAD"]);
  await writeFile(path.join(wt("save"), ".pi", "verify-cmd"), "saved pi edit\n");
  await writeFile(path.join(wt("save"), "tmp", "notes.txt"), "saved tmp edit\n");
  const savePatch = path.join(dir, "tmp", "issue-1", "retry-save-1.patch");
  const patch = await resetWorktreeToBase(git, wt("save"), saveBase, {
    repoRoot: dir,
    patchPath: savePatch,
  });
  const body = await readFile(savePatch, "utf8");
  assert(
    patch === savePatch && body.includes("+saved pi edit") && body.includes("+saved tmp edit"),
    "#1016: tracked .pi/ and tmp/ edits are both saved to the retry patch",
  );
  const restored = await readFile(path.join(wt("save"), "tmp", "notes.txt"), "utf8");
  assert(restored === "base\n", "#1016: the reset restores the tracked tmp/ file after the save");

  // (C) A second retry for the same workstream writes attempt -2, never -1 again.
  const scratch = path.join(dir, "tmp", "issue-1");
  const resetRe = retryResetFor({
    execFn: execp,
    repoRoot: dir,
    scratchAbs: scratch,
    cwdFor: (id) => wt(id),
    baseFor: (id) => shas[id],
  });
  await writeFile(path.join(wt("re"), "first.txt"), "first");
  const first = await resetRe("re");
  await writeFile(path.join(wt("re"), "second.txt"), "second");
  const second = await resetRe("re");
  assert(first.attempt === 1 && second.attempt === 2, "#1016: the retry attempt advances 1 → 2");
  assert(
    second.patch === path.join(scratch, "retry-re-2.patch") &&
      (await readFile(path.join(scratch, "retry-re-1.patch"), "utf8")).includes("+first"),
    "#1016: the second retry writes -2 and leaves the first save intact",
  );

  // (D) An unreadable commit check is evidence: the gates run rather than being skipped.
  const evFake = (async (_cmd: string, o: { argv: string[] }) => {
    if (subOf(o.argv) === "status") return { stdout: "" };
    throw new Error("rev-list refused");
  }) as unknown as typeof execp;
  const ctx = { verifyExecFn: evFake } as unknown as DriverContext;
  const state = {
    schemaVersion: 1,
    issue: 1,
    updatedAt: 0,
    eventLog: [],
    pipelineState: { baseSha: shas.ev, worktrees: { ev: wt("ev") } },
  } as unknown as WorkState;
  assert(
    (await hasAnyWorktreeEvidence(ctx, state)) === true,
    "#1016: an unreadable commit check counts as evidence (the gates run)",
  );

  // (E) The commit lands but its sha cannot be read: the event is still recorded.
  await writeFile(path.join(wt("rp"), "rp.txt"), "rp");
  const rpFake = (async (cmd: string, o: { argv: string[]; cwd: string }) => {
    // #1468 — the MERGE_HEAD probe goes to real git; only the sha read is refused.
    if (subOf(o.argv) === "rev-parse" && !o.argv.includes("MERGE_HEAD")) {
      throw new Error("rev-parse refused");
    }
    return execp(cmd, o as Parameters<typeof execp>[1]);
  }) as unknown as typeof execp;
  const rpNotes: string[] = [];
  const rpEv = await safetyNetWorktree("rp", dir, wt("rp"), shas.rp, rpFake, rpNotes);
  assert(
    rpEv?.kind === "safety-net-commit" && rpEv.commitSha === "HEAD",
    "#1016: a landed commit is recorded even when its sha cannot be read",
  );
  assert(
    gitIn(wt("rp"), ["rev-list", "--count", `${shas.rp}..HEAD`]) === "1" &&
      rpNotes.some((n) => n.includes("could not be read")),
    "#1016: the commit is in the branch and a note says the sha was not read",
  );
  assert(existsSync(path.join(wt("rp"), "rp.txt")), "#1016: the committed file survives");
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
