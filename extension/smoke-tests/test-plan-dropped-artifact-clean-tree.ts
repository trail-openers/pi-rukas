#!/usr/bin/env bun
/**
 * #1383 / PR #1451 follow-up — the durable dropped-items artifact must not
 * dirty the project's working tree.
 *
 * The round-1 shape wrote `<repo>/.pi/plan-dropped/<slug>-<runId>.json`. That
 * path is gitignored only in THIS repo's own `.gitignore`; in any project a
 * `/plan` that omitted anything would have left untracked files under `.pi/`,
 * which (a) dirties the repo root that /work's branch step hard-blocks on and
 * the consolidated-verify tree identity refuses on, and (b) sits in a protected
 * path (`isProtectedPath` flags `.pi/`).
 *
 * The fix puts the artifact under `.pi/work-state/` — the harness's existing
 * per-clone untracked-state directory — and excludes it through
 * `ensureGitExclude`, the same single serialised `.git/info/exclude` writer
 * `decision-log.ts` uses for `.pi/decisions.jsonl`.
 *
 * These pins are the three ways that claim could be false:
 *
 * 1. the artifact lives under `.pi/work-state/` (a bare `.pi/plan-dropped/`
 *    sibling is the regression);
 * 2. after a run that WRITES the artifact, `git status --porcelain -uall` in a
 *    fresh temp repo reports nothing — checked on a repo whose `.gitignore`
 *    does NOT name the path, so the pin proves the exclude mechanism, not a
 *    committed ignore line;
 * 3. the neighbour sweep (`work-driver-artifact-sweep.ts`, which removes
 *    numeric dirs whose sibling `<N>.json` is gone) leaves the named directory
 *    alone, so a /work cycle cannot delete what a /plan run just wrote.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, utimesSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { droppedArtifactFile, writeDroppedArtifact } from "../src/plan-dropped-artifact.ts";
import { DROPPED_ARTIFACT_DIR } from "../src/plan-dropped-budget.ts";
import { runArtifactSweep } from "../src/work-driver-artifact-sweep.ts";
import { droppedFixture } from "./plan-dropped-harness.ts";

let failed = false;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`\u2713 ${msg}`);
  else {
    console.error(`\u2717 ${msg}`);
    failed = true;
  }
}

/** A temp git repo with one commit and a clean tree. */
async function freshRepo(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `plan-dropped-${label}-`));
  const git = (args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  await writeFile(join(root, "README.md"), "# fixture\n");
  git(["add", "README.md"]);
  git(["commit", "-q", "-m", "init"]);
  return root;
}

const porcelain = (root: string) =>
  execFileSync("git", ["-C", root, "status", "--porcelain", "-uall"], {
    encoding: "utf8",
  });

async function main() {
  // ----------------------------------------------------- 1. the location itself
  assert(
    DROPPED_ARTIFACT_DIR === ".pi/work-state/plan-dropped",
    `DROPPED_ARTIFACT_DIR is under the harness's untracked work-state dir (got ${DROPPED_ARTIFACT_DIR})`,
  );

  // ------------------------------------------ 2. writing it leaves the tree clean
  // A repo whose .gitignore names NOTHING — so a clean tree here can only come
  // from the `.git/info/exclude` entry the write performs.
  const root = await freshRepo("write");
  const before = porcelain(root);
  assert(before.trim() === "", "fixture: the temp repo starts clean");

  const dropped = droppedFixture(30);
  const shown = 3;
  const file = await writeDroppedArtifact(
    root,
    "Add rate limiting to /api",
    "feature",
    dropped,
    shown,
  );
  assert(!!file, "writeDroppedArtifact returns the path when items were omitted");
  assert(
    !!file && file.includes(DROPPED_ARTIFACT_DIR) && file.endsWith(".json"),
    `the written path is under DROPPED_ARTIFACT_DIR (${file ?? "undefined"})`,
  );
  assert(
    file === droppedArtifactFile(root, "Add rate limiting to /api", "feature"),
    "the written path is the path droppedArtifactFile names",
  );

  const after = porcelain(root);
  assert(
    after.trim() === "",
    `git status --porcelain -uall shows NOTHING new after the artifact write (got: ${JSON.stringify(after)})`,
  );

  // The exclude entry actually exists, and the clean tree is not an accident of
  // the artifact having failed to land.
  const exclude = await readFile(join(root, ".git", "info", "exclude"), "utf8").catch(() => "");
  assert(
    exclude.split("\n").some((l) => l.trim() === `${DROPPED_ARTIFACT_DIR}/`),
    ".git/info/exclude carries the artifact directory",
  );
  const onDisk = await readFile(file ?? "", "utf8").catch(() => "");
  assert(
    onDisk.includes('"omitted": 27') && onDisk.includes('"shown": 3'),
    "the artifact really was written (the clean tree is the exclude, not a no-op write)",
  );

  // Nothing else in `.pi/` was dragged in: a sibling file the harness does not
  // own must still read as dirt, so the exclude is scoped to the one directory.
  await mkdir(join(root, ".pi", "other"), { recursive: true });
  await writeFile(join(root, ".pi", "other", "stray.txt"), "x\n");
  const withStray = porcelain(root);
  assert(
    withStray.includes(".pi/other/stray.txt"),
    `the exclude is scoped: an unrelated untracked file under .pi/ still shows (${JSON.stringify(withStray)})`,
  );
  await rm(join(root, ".pi", "other"), { recursive: true, force: true });

  // A second run is idempotent — no duplicate exclude line, tree still clean.
  await writeDroppedArtifact(root, "Add rate limiting to /api", "feature", dropped, shown);
  const exclude2 = await readFile(join(root, ".git", "info", "exclude"), "utf8");
  const hits = exclude2.split("\n").filter((l) => l.trim() === `${DROPPED_ARTIFACT_DIR}/`).length;
  assert(hits === 1, `a re-run does not duplicate the exclude line (got ${hits})`);
  assert(porcelain(root).trim() === "", "the tree stays clean across repeated runs");

  // A non-omitting run writes nothing and needs no exclude.
  const clean = await freshRepo("none");
  const nothing = await writeDroppedArtifact(
    clean,
    "nothing omitted",
    "feature",
    droppedFixture(0),
    0,
  );
  assert(nothing === undefined, "a run that omitted nothing writes no artifact");
  assert(
    porcelain(clean).trim() === "",
    "a run that wrote nothing leaves the tree clean and creates no exclude entry",
  );

  // ---------------------------- 3. the neighbour sweep leaves the directory alone
  const swept = await freshRepo("sweep");
  const artifact = await writeDroppedArtifact(swept, "Sweep me", "feature", dropped, shown);
  assert(!!artifact, "artifact written before the sweep");
  // A stale NUMERIC artifact dir with no sibling state file — the sweep's one
  // removal target — so the run does real work and cannot pass by finding
  // nothing. `execFn` is injected because the sweep's default executor runs in
  // the Pi process's directory, not the fixture's.
  await mkdir(join(swept, ".pi", "work-state", "4242"), { recursive: true });
  await writeFile(join(swept, ".pi", "work-state", "4242", "old.txt"), "stale\n");
  // Past the sweep's 14-day orphan floor — a fresh dir is `skipped: recent`,
  // which would make the canary below report a sweep that never ran.
  const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  utimesSync(join(swept, ".pi", "work-state", "4242"), stale, stale);
  await runArtifactSweep({
    repoRoot: swept,
    execFn: async (cmd) => {
      const out = execFileSync("sh", ["-c", cmd], { encoding: "utf8", cwd: swept });
      return { stdout: out, stderr: "" };
    },
  });
  assert(
    !artifact ||
      (await readFile(artifact, "utf8").then(
        () => true,
        () => false,
      )),
    "work-driver-artifact-sweep does NOT remove the plan-dropped directory (#657 sweeps numeric dirs only)",
  );
  const staleGone = await readFile(
    join(swept, ".pi", "work-state", "4242", "old.txt"),
    "utf8",
  ).then(
    () => false,
    () => true,
  );
  assert(staleGone, "canary: the sweep did run and did remove the stale numeric dir");
  assert(porcelain(swept).trim() === "", "the tree is still clean after the sweep");

  console.log(`\nexit ${failed ? 1 : 0}`);
}

await main();
process.exit(failed ? 1 : 0);
