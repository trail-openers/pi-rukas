/**
 * lens-fidelity-rig — the scratch tree the harness-fidelity ratchet mutates.
 *
 * Split out of `lens-harness-fidelity-ratchet.ts` along the seam AGENTS §12 forces
 * and the design already implies: the ratchet is the POLICY (which entry points
 * count, what a red must name, when to refuse), this file is the MACHINERY (build a
 * scratch tree that can really run a suite, run one suite in it, and prove the tree
 * cannot reach back into the tree being measured). Nothing here knows what a lens
 * mutant is, and the ratchet imports this file and never the reverse.
 *
 * WHY THE MACHINERY IS THE INTERESTING HALF. This rig has twice shipped the exact
 * defect the ratchet exists to close — a verification step that cannot fail. It
 * symlinked `smoke-tests/lib` as a directory and wrote the mutant through the link,
 * and `rmSync` of the target then DELETED the real `lens-mutant-harness.ts`; a
 * second revision linked leaves individually and a mutant of `lens-class-mutants.ts`
 * still landed in the developer's worktree, because `writeFileSync` FOLLOWS a leaf
 * symlink. Both source files were restored from `HEAD` by blob hash. The lesson is
 * in `assertNoSymlinkInScratchTree`: a rig must ASSERT the containment property it
 * depends on before it writes, not assume the caller set it up correctly.
 */

import { execFileSync } from "node:child_process";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HARNESS_MUTANTS } from "./lens-fidelity-ratchet-mutants.ts";

/** The `extension/` root, resolved from this file so a caller's cwd cannot point
 * the rig at another tree. Exported so the witness file can hash the same paths
 * the rig mutates (its source-integrity canary). */
export const EXTENSION_ROOT = path.resolve(import.meta.dirname, "..", "..");

/** A file the harness reads from the source tree, NOT the scratch copy. */
const SCRATCH_SENTINEL = "__RATCHET_SCRATCH__";

/**
 * Build a scratch tree of REAL FILES under `extension/`, plus the two links the
 * suites need but never write through.
 *
 * WHY COPIES, AND NOT SYMLINKS — the measured reason. A previous revision linked
 * every leaf with `symlink(…, "file")`, on the theory that a link keeps Bun resolving
 * the same on-disk files and so keeps the import graph intact. It did neither, for a
 * reason specific to Bun: **the loader realpaths a module before it resolves its
 * imports**, so a symlinked `lens-mutant-harness.ts` is read from the SOURCE tree and
 * the mutant written into the scratch copy is simply never loaded — the suite runs
 * unmutated and prints its green baseline, which the ratchet would have reported as
 * "the check cannot fail". Measured directly: with a leaf-symlinked `lib/`,
 * `if (mutated === literal)` was rewritten in the scratch copy and
 * `test-lens-class-mutants.ts` still printed 36 passes and 0 reds. Real copies make
 * the mutated bytes the only bytes the loader can reach.
 *
 * The two links that remain are READ-ONLY as far as the rig is concerned and are not
 * in the set `assertNoSymlinkInScratchTree` judges: `node_modules/` (~80 MB, copied
 * it would make the ratchet minutes rather than seconds) and the repo-root sibling
 * `skill/`, which `LENS_ROSTER` resolves through `BUNDLED_SKILL_DIR`. Writing through
 * either is impossible by construction here because the rig never names a path under
 * them as a mutation target.
 *
 * Source `.ts` entries that do not resolve are SKIPPED rather than linked: this
 * checkout has dangling names in `src/` (e.g. `adversarial-classify.ts`), and a
 * dangling entry that is never imported is not a reason for the rig to fail.
 */
function buildScratch(copyDirs: readonly string[]): { root: string; extensionDir: string } {
  const root = mkdtempSync(path.join(tmpdir(), "lens-fidelity-ratchet-"));
  const extensionDir = path.join(root, "extension");
  mkdirSync(extensionDir, { recursive: true });
  for (const rel of copyDirs) {
    const src = path.join(EXTENSION_ROOT, rel);
    const dest = path.join(extensionDir, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    if (isDirectory(src)) copyTree(src, dest);
    else cpSync(src, dest);
  }
  writeFileSync(path.join(extensionDir, SCRATCH_SENTINEL), "");
  return { root, extensionDir };
}

function isDirectory(p: string): boolean {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Copy a directory, following directory entries but skipping entries that do not
 * resolve (the dangling names above) and anything under a nested `node_modules`. */
function copyTree(srcDir: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir)) {
    if (entry === "node_modules") continue;
    const full = path.join(srcDir, entry);
    try {
      lstatSync(full);
    } catch {
      continue; // dangling entry in the source tree — never imported, never copied
    }
    if (isDirectory(full)) copyTree(full, path.join(destDir, entry));
    else cpSync(full, path.join(destDir, entry));
  }
}

/**
 * A scratch copy of `extension/` that can actually run the suites, plus the two
 * things it needs from the repository that a copy of `extension/` alone does not
 * give it.
 *
 * WHY THE WHOLE REPO ROOT, NOT JUST `extension/`. `LENS_ROSTER` is built from
 * `BUNDLED_SKILL_DIR`, which resolves to the SIBLING `skill/` directory — so a tree
 * that contains only `extension/` yields an EMPTY roster, and every assertion that
 * reads the roster goes red-vacuous while every mutation "proves" itself. That is
 * the exact green-on-nothing shape this ratchet refuses, so the sibling `skill/` is
 * linked in and its absence is a hard error rather than a silent empty roster.
 *
 * WHY `.git` MUST BE REAL. `assertLivenessMutantReds` runs `git hash-object -w` and
 * `git cat-file -t`; a tree without a readable object store throws and reddens five
 * checks for an environmental reason, which would be counted as a mutation proof.
 * A private `GIT_DIR` created per scratch tree keeps every write out of the real
 * clone's object store.
 */
export function makeScratch(mutantFiles: readonly string[] = HARNESS_MUTANTS.map((m) => m.file)):
  { root: string; extensionDir: string } {
  const repoRoot = path.resolve(EXTENSION_ROOT, "..");
  const skillDir = path.join(repoRoot, "skill");
  try {
    readdirSync(skillDir);
  } catch {
    throw new Error(
      `the fidelity rig needs the sibling skill/ dir at ${skillDir} — without it LENS_ROSTER is empty and every mutant reddens for the wrong reason`,
    );
  }
  // Copy the two source directories whole (skipping dangling entries and nested
  // node_modules) rather than enumerating `.ts` files: the suites import fixtures
  // from `lib/` that are not mutants, and a hand-kept extension list is one more
  // thing that can silently omit the file a red depends on.
  const { root, extensionDir } = buildScratch(["src", "smoke-tests"]);
  symlinkSync(skillDir, path.join(root, "skill"), "dir");
  // `node_modules` is linked, not copied: copying ~80 MB per mutant would make the
  // ratchet minutes instead of seconds, and the tree is READ-ONLY as far as the rig
  // is concerned — no mutant writes into it, which is exactly the set
  // `assertNoSymlinkInScratchTree` judges. Without it the suites cannot import
  // `@earendil-works/*` and every mutant reddens on a missing module, which is the
  // environmental-red-that-looks-like-a-proof this rig keeps having to learn.
  symlinkSync(path.join(EXTENSION_ROOT, "node_modules"), path.join(extensionDir, "node_modules"), "dir");
  // The suites live directly under `smoke-tests/`, which is NOT linked as a
  // directory (only individual files are), so the directory must exist before the
  // suite files are copied into it.
  mkdirSync(path.join(extensionDir, "smoke-tests"), { recursive: true });
  // The file a mutant rewrites is a REAL file in the scratch tree, copied from the
  // source. `measureMutant` copies it again immediately before writing, so this is
  // the "the tree is complete before any mutation" guarantee rather than the
  // mutation itself.
  for (const rel of mutantFiles) {
    const source = path.join(EXTENSION_ROOT, rel);
    try {
      readFileSync(source, "utf8");
    } catch {
      throw new Error(`the rig was asked to mutate a file that does not exist: ${rel}`);
    }
    const dest = path.join(extensionDir, rel);
    if (lstatSync(dest).isSymbolicLink())
      throw new Error(`buildScratch left a symlink at the mutation target ${rel}`);
  }
  for (const f of ["package.json", "bunfig.toml"]) {
    try {
      cpSync(path.join(EXTENSION_ROOT, f), path.join(extensionDir, f));
    } catch {
      /* optional */
    }
  }
  return { root, extensionDir };
}

/** The two suite paths the ratchet actually runs, deduplicated. */
export function suitesUnderTest(): string[] {
  return [...new Set(HARNESS_MUTANTS.map((m) => m.suite))];
}

/**
 * A scratch tree needs a `.git` whose OBJECT STORE answers the fan-out witness's
 * `git hash-object` / `git cat-file`, and it must not be the repository's own.
 *
 * An empty `git init --bare` is NOT enough and the symptom is instructive: with no
 * commit and no HEAD, `git cat-file -t <blob>` fails and
 * `assertLivenessMutantReds` reports five environmental reds that would be counted
 * as mutation proofs. So the scratch repo is seeded with one empty commit, which is
 * what makes `cat-file` resolve against a real (if tiny) object store.
 *
 * The store is seeded ONCE per process and copied per scratch tree, because the
 * commit is the same every time and `git init` + commit per mutant would dominate
 * the ratchet's runtime.
 */
let seededGitDir: string | null = null;
function seedGitDir(): string {
  if (seededGitDir) return seededGitDir;
  const root = mkdtempSync(path.join(tmpdir(), "lens-fidelity-gitseed-"));
  // `--separate-git-dir` yields a FLAT git dir (objects/, refs/, HEAD at the top)
  // rather than a working tree with a nested `.git`, which is the shape `GIT_DIR`
  // expects and the only shape that survives being copied per scratch tree. Plain
  // `git init` produced `<root>/.git`, and pointing `GIT_DIR` at `<root>` then failed
  // with `not a git repository` — five environmental reds that would have been
  // counted as mutation proofs.
  const gitDir = path.join(root, "gitdir");
  execFileSync("git", ["init", "--quiet", `--separate-git-dir=${gitDir}`, root], { stdio: "ignore" });
  // One empty commit gives HEAD and a commit object, which is what makes
  // `cat-file -t` answer instead of "could not get object info". The identity is
  // passed explicitly so the seed does not depend on the host's git config.
  execFileSync("git", ["commit", "--quiet", "--allow-empty", "-m", "ratchet seed"], {
    cwd: root,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_DIR: gitDir,
      GIT_AUTHOR_NAME: "ratchet",
      GIT_AUTHOR_EMAIL: "ratchet@invalid",
      GIT_COMMITTER_NAME: "ratchet",
      GIT_COMMITTER_EMAIL: "ratchet@invalid",
    },
  });
  seededGitDir = gitDir;
  return gitDir;
}

/**
 * Refuse if any leaf under the scratch `extension/` resolves back INTO the source
 * tree.
 *
 * This is the rig's own containment proof, and it exists because the leak is real
 * and happened twice while this file was being written: `buildScratch` links leaves
 * with `symlink(…, "file")`, and `writeFileSync` FOLLOWS a leaf symlink, so one
 * linked leaf among the mutated files is enough for a mutant to land in the
 * developer's worktree. Rather than trusting each caller to have copied the right
 * file first, the rig asserts the property it depends on before it writes, over the
 * WHOLE tree, so an unrelated link cannot become the next leak.
 */
export function assertNoSymlinkInScratchTree(
  extensionDir: string,
  /** Paths (relative to `extensionDir`) the rig is about to WRITE. A symlink under
   * any of them, or at any point along one, is a leak: `writeFileSync` follows it
   * into the source tree. Read-only links elsewhere in the tree — `node_modules/`,
   * which must point at the real one or nothing imports — are not in this set and
   * are deliberately not judged, because they are never written through. Naming the
   * guarded set is the honest form of the check: a guard that refuses every scratch
   * tree is as useless as one that refuses none, and the first revision of this one
   * walked the whole tree and refused the rig's own `node_modules` link. */
  written: readonly string[],
): void {
  const realSource = realpathSync(EXTENSION_ROOT);
  const offenders: string[] = [];
  for (const rel of written) {
    // Check the leaf AND every ancestor: `smoke-tests/lib` linked as a directory is
    // how the first leak happened, and a leaf-only check would have passed it.
    for (let p = rel; p && p !== "." && p !== path.sep; p = path.dirname(p)) {
      const full = path.join(extensionDir, p);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (!st.isSymbolicLink()) continue;
      let dest: string;
      try {
        dest = realpathSync(full);
      } catch {
        continue; // a dangling link cannot be written through
      }
      if (dest === realSource || dest.startsWith(realSource + path.sep)) offenders.push(p);
    }
  }
  if (offenders.length > 0)
    throw new Error(
      "the scratch tree links " +
        offenders.length +
        " file(s) back into the source tree (" +
        offenders.map((o) => path.relative(extensionDir, o)).join(", ") +
        ") — writing through such a link mutates the file under measurement",
    );
}

/** Coerce whatever a Bun `execFileSync` handed back into text.
 *
 * `encoding: "utf8"` is not honoured on every Bun path — the seed's
 * `git rev-parse HEAD` came back as a `Buffer` and `.trim()` threw a `TypeError`
 * that read as a broken rig. Decoding here makes the runner independent of that
 * variance instead of depending on a runtime flag behaving. */
function asText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Uint8Array) return new TextDecoder().decode(v);
  if (v == null) return "";
  return String(v);
}

/**
 * Give the scratch tree a git object store that is PRIVATE to the rig but contains
 * the real repository's objects.
 *
 * WHY A CLONE AND NOT A FRESHLY INITIALISED STORE. An earlier revision `git init`ed an
 * empty store and pointed `GIT_DIR` at it. That is safe — `git hash-object -w` from a
 * mutated suite cannot reach the real clone — but it is USELESS for any suite that
 * grounds a claim in a real object: the liveness probe's whole point is that a blob it
 * cites can be fetched (`git cat-file -t <sha>` answers `blob`), and in an empty store
 * that throws `could not get object info` and kills the run before it prints anything.
 * The ratchet then reported `baseline pass=36 red=0` for a 45-assertion suite: an
 * environmentally truncated run that looked like a clean baseline, which is precisely
 * the green-on-nothing defect this branch exists to close, relocated into the rig.
 *
 * So the store is the real clone's objects, reachable but not writable: `objects/
 * alternates` points at the source object store and `objects/info/alternates` is the
 * only mechanism that reads another store's objects without copying them, while
 * `hash-object -w` writes into the scratch-local store. The real clone is never
 * written — a scratch-local object directory receives every write. `--bare` +
 * `GIT_WORK_TREE` avoids a second working tree and any worktree registration in the
 * source repo.
 */
export function gitEnv(extensionDir: string): { gitDir: string; env: NodeJS.ProcessEnv } {
  const repoRoot = path.resolve(EXTENSION_ROOT, "..");
  const gitDir = path.join(path.dirname(extensionDir), "gitdir");
  execFileSync("git", ["init", "--quiet", "--bare", gitDir], { stdio: "ignore" });
  // Read the source objects without copying them, and never write to them.
  //
  // `--absolute-git-dir` is WRONG here and that is the bug this line fixes: inside a
  // linked worktree it answers `.git/worktrees/<name>`, which has no `objects/` of its
  // own — a worktree shares the main checkout's store — so alternates pointed at a
  // directory that does not exist and git refused every read with
  // `object directory … does not exist; check .git/objects/info/alternates`. The common
  // directory is the one that owns `objects/`.
  const commonDir = execFileSync(
    "git",
    ["-C", repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf8" },
  ).trim();
  mkdirSync(path.join(gitDir, "objects", "info"), { recursive: true });
  writeFileSync(path.join(gitDir, "objects", "info", "alternates"), `${commonDir}/objects\n`);
  // A commit is needed for `git rev-parse HEAD:<path>` (the probe reads the shipped
  // fan-out from git), and it must be the real HEAD, not a synthetic empty commit —
  // otherwise the shipped blob the probe compares against would be a different tree.
  const head = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  writeFileSync(path.join(gitDir, "HEAD"), `${head}\n`);
  writeFileSync(path.join(gitDir, "commondir"), "\n");
  return {
    gitDir,
    env: {
      ...process.env,
      GIT_DIR: gitDir,
      GIT_WORK_TREE: extensionDir,
      // `GIT_ALTERNATE_OBJECT_DIRECTORIES` is the env form; the file above is the
      // store form. Both, because git reads them at different layers and a scratch
      // run that silently lost its alternates would fail as a red, not as a rig bug.
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(commonDir, "objects"),
    },
  };
}

/**
 * Run one suite inside a scratch tree and classify its output.
 *
 * WHY THE CLASSIFIER IS THE INTERESTING PART, AND WHY IT COUNTS BOTH STREAMS.
 * These suites print their `✗` lines through `console.error`, which is fd 2, and
 * `execFileSync` hands fd 2 back on `err.stderr` for a non-zero exit — so a
 * classifier that reads only `stdout` counts **0 reds for a run that printed reds**.
 * Every "this bypass keeps the suite green" this rig produced inherited that bug,
 * including the ones that looked like confirmations, until it was caught by comparing
 * a mutated run's `pass=36 red=0` against the same suite run by hand. So a red is a
 * `✗` line in EITHER stream, de-duplicated because a line can be mirrored into both.
 *
 * The verdict comes from those lines rather than the exit code: a suite that throws
 * before printing anything has no `✗` and is therefore NOT a proven mutation, it is a
 * broken measurement — which is why `stderr` is reported alongside and a crash and a
 * red are never the same answer.
 */
export function runSuite(
  extensionDir: string,
  suite: string,
  env: NodeJS.ProcessEnv,
): { reds: string[]; passes: number; failed: boolean; stderr: string } {
  let out = "";
  let errText = "";
  try {
    out = asText(
      execFileSync("bun", ["run", suite], {
        cwd: extensionDir,
        env,
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch (e) {
    const err = e as { stdout?: unknown; stderr?: unknown; message?: string };
    out = asText(err.stdout);
    errText = asText(err.stderr || err.message);
  }
  const lines = [...new Set([...out.split("\n"), ...errText.split("\n")])];
  const reds = lines.filter((l) => l.startsWith("✗"));
  const passes = lines.filter((l) => l.startsWith("✓")).length;
  return {
    reds,
    passes,
    failed: reds.length > 0,
    stderr: errText.slice(0, 400),
  };
}
