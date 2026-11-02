/**
 * lens-harness-fidelity-ratchet — the ratchet that proves the lens mutation
 * harness's OWN checks can fail.
 *
 * WHY THIS FILE EXISTS. Eight six-lens rounds on this branch each found a NEW
 * instance of one class: a verification step in the mutation harness runs, and
 * nothing shows it is able to fail. The instances differed (a precondition gated
 * on `false`; a fidelity call that could be deleted; a table that never calls the
 * generator; a whole-class control that delegates to the shipped matcher; a batch
 * acquire that decides nothing) and fixing them one at a time did not converge,
 * because the class is not "this check is wrong" — it is "this check is unproven".
 * Asserting each check again is the same one-at-a-time move. What closes the class
 * is a check that checks the checkers: for every named entry point, apply a
 * deletion/hollowing mutant to a scratch copy of the harness and REQUIRE a red.
 *
 * WHY A SCRATCH COPY AND NOT THIS TREE. The mutations edit files on disk, so they
 * must not happen where a developer, a gate, or `git add -A` can see them. Each
 * mutant is applied under a `mkdtemp` copy of `extension/` and the tree is removed
 * afterwards; the working tree this test runs in is never written. See
 * `runMutantSuite` for the copy's shape and why a copy that omits the sibling
 * `skill/` dir or the real `.git` silently invalidates every measurement.
 *
 * WHY A RED IS NOT ENOUGH — THE DOUBLE-RED CONTRACT. A mutant that reddens for a
 * reason unrelated to the check it targets proves nothing, and the cheapest way to
 * write a ratchet that always "passes" is to mutate something that breaks the
 * import graph: every mutant would then exit non-zero and every check would read
 * as proven. So every entry point is asserted in TWO directions:
 *
 *   MUTATE  -> the named suite reddens (the check can fail)
 *   UNMUTATED -> the same suite, in the same kind of scratch copy, is green
 *                (the red came from the mutation, not from the rig)
 *
 * and each mutant additionally names the specific assertion text its red must
 * contain, so a mutant that reddens an unrelated assertion does not count.
 *
 * THE RATCHET'S OWN WITNESS (`test-lens-harness-fidelity-ratchet.ts`). A ratchet
 * whose mutant list is empty reports "0 entry points proven" and exits 0, which is
 * the green-on-nothing defect it exists to close, wearing the ratchet's own shape.
 * `HARNESS_MUTANTS` is exported so that file can prove the list is non-empty AND
 * prove the runner reddens when given a mutant that cannot fail.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** One entry point the harness claims to verify, and the mutation that must redden
 * a suite if the claim is true. */
export interface HarnessMutant {
  /** Stable id, printed in the report so a reader can point at one row. */
  readonly id: string;
  /** The claim the suite makes about this entry point, in one line. */
  readonly claim: string;
  /** File under `extension/` the mutation edits. */
  readonly file: string;
  /** Exact text to find. A mutation whose `from` is absent is a NO-OP and is
   * refused rather than counted as a red — the same rule `lens-coverage-liveness-
   * probe.ts` applies to its liveness replacement. */
  readonly from: string;
  readonly to: string;
  /** The suite that must redden. */
  readonly suite: string;
  /** Substring at least one `✗` line must contain. Without it a mutant that
   * reddens an unrelated assertion — or crashes the import graph — would count as
   * proof that THIS check can fail. */
  readonly redMustContain: string;
}

/**
 * The five entry points, one mutant each, at `7d1b71eb`. Every `from` is a verbatim
 * excerpt of the file it names, and every `to` is the hollowing a reviewer would
 * write to bypass the check. Two mutants must never produce the same red set: the
 * ratchet asserts distinctness in `assertMutantsAreDistinguishable`.
 */
export const HARNESS_MUTANTS: readonly HarnessMutant[] = [
  {
    id: "P1-noop-precondition",
    claim: "lens-class-mutants.ts P1 refuses a mutant byte-identical to shipped",
    file: "smoke-tests/lib/lens-class-mutants.ts",
    from: "    if (mutated === literal)\n      throw new ClassRefused(",
    to: "    if (false && mutated === literal)\n      throw new ClassRefused(",
    suite: "smoke-tests/test-lens-class-mutants.ts",
    redMustContain: "is a NO-OP",
  },
  {
    id: "runMutant-fidelity-call",
    claim: "runMutant calls assertHarnessFidelity before measuring",
    file: "smoke-tests/lib/lens-mutant-harness.ts",
    // The honest mutant, and the reason for it is a measurement rather than a
    // preference. Deleting the bare call
    //     assertHarnessFidelity();
    // is NOT observable through `test-lens-class-mutants.ts`: `runMutant` builds
    // its classes from `{ ...SHIPPED, [flank]: mutated }`, so a drift in `SHIPPED`
    // is measured against the drifted constant and the baseline still agrees — the
    // pair stays green either way. That is itself the finding (the guard is
    // self-confirming for a `SHIPPED` drift), and a ratchet that pretends otherwise
    // would be pasting a red. So this mutant removes the call in the form that IS
    // observable: without the gate, a harness whose mirror no longer matches the
    // product keeps printing a clean table instead of refusing. `to` deletes the
    // call from `runMutant` only, leaving `runShipped`'s in place.
    from: "  assertHarnessFidelity();\n  const classes = { ...SHIPPED, [flank]: mutated };",
    to: "  void 0; // fidelity gate removed\n  const classes = { ...SHIPPED, [flank]: mutated };",
    suite: "smoke-tests/test-lens-class-mutants.ts",
    // The arm that moves, named by its own text: with the gate deleted, the
    // reconciliation rows are printed by a harness that never checked its mirror.
    redMustContain: "table reconciliation",
  },
  {
    id: "measuredTable-mutantsFor-bypass",
    claim: "measuredTable's rows come from mutantsFor, never hand-typed",
    file: "smoke-tests/lib/lens-mutant-harness.ts",
    // A hand-typed table is the defect the generator exists to close. The rows are
    // spelled so the harness's own guards still accept them as rows — the shipped
    // class in `shipped` (so the declaring-row assertion passes) and a mutated
    // value carrying the members the reconciliation expects — which is exactly the
    // shape that keeps the suite green today and is the whole point of the mutant:
    // a table that never asked the generator for anything.
    from: "  return mutantsFor(SHIPPED[flank]).map((mutant) => ({",
    to: "  const handRolled: ClassMutant[] = (flank === \"TERMINATOR\"\n    ? [\"!\", \"?\", \",\", \".\", \";\", \":\", \"-\"]\n    : [\"_\", \".\", \"/\", \"+\", \"-\"]).map((m) => ({\n    member: m,\n    shipped: SHIPPED[flank],\n    mutated: SHIPPED[flank].replace(m, \"\"),\n    representative: m,\n    survivors: \"\",\n  }));\n  return handRolled.map((mutant) => ({",
    suite: "smoke-tests/test-lens-class-mutants.ts",
    redMustContain: "measured row declares the shipped class",
  },
  {
    id: "wholeClassRemoval-hollowed",
    claim: "wholeClassRemoval actually deletes the anchored TERMINATOR arm",
    file: "smoke-tests/lib/lens-mutant-harness.ts",
    from:
      "function mentionsPathWithoutTerminatorArm(summary: string, file: string): boolean {\n  const escaped = file.replace(",
    to:
      "function mentionsPathWithoutTerminatorArm(summary: string, file: string): boolean {\n  return mentionsPathWith(summary, file, SHIPPED);\n}\nfunction mentionsPathWithoutTerminatorArmUnused(summary: string, file: string): boolean {\n  const escaped = file.replace(",
    suite: "smoke-tests/test-lens-class-mutants.ts",
    redMustContain: "whole-class control",
  },
  {
    id: "runSilentRound-openBatch-acquire",
    claim: "runSilentRound acquires the deck batch the round is measured on",
    file: "smoke-tests/lib/lens-coverage-liveness-probe.ts",
    from: "  openBatch(key, 2);\n  const silent = LENS_ROSTER[0]?.name;\n  const out = await fanout(",
    to: "  openBatch(key, 2);\n  dispatchDeck.reset();\n  const silent = LENS_ROSTER[0]?.name;\n  const out = await fanout(",
    suite: "smoke-tests/test-lens-fanout-batch-release.ts",
    redMustContain: "acquires the deck batch its round is measured on",
  },
];

/** The two things a run reports per mutant: did the unmutated rig read green, and
 * did the mutated one redden where it must. */
export interface RatchetResult {
  readonly id: string;
  readonly baselineGreen: boolean;
  readonly reddened: boolean;
  readonly matchedRed: string | null;
  readonly detail: string;
}

/** The `extension/` root, resolved from this file so a caller's cwd cannot point
 * the rig at another tree. */
/** The `extension/` root, resolved from this file so a caller's cwd cannot point
 * the rig at another tree. Exported so the witness file can hash the same paths
 * the rig mutates (its source-integrity canary). */
export const EXTENSION_ROOT = path.resolve(import.meta.dirname, "..", "..");

/** A file the harness reads from the source tree, NOT the scratch copy. */
const SCRATCH_SENTINEL = "__RATCHET_SCRATCH__";

/**
 * Build a scratch tree whose leaf files are symlinked INDIVIDUALLY.
 *
 * WHY NOT SYMLINK A DIRECTORY, AND WHY THIS MATTERS MORE THAN IT LOOKS. An earlier
 * revision of this rig symlinked `smoke-tests/lib` as a directory and then wrote the
 * mutant through that link. Writing through a directory link writes the REAL file —
 * so `measureMutant` rewrote the harness in the developer's worktree and, worse,
 * `rmSync(target)` before the write DELETED the source file. `git status` caught it
 * as ` D lens-mutant-harness.ts` and the tree was restored from `HEAD` by blob hash.
 * A mutation harness that mutates the tree it is measuring is the exact defect this
 * branch exists to close, so the rule is structural: **the scratch tree contains
 * only regular files and symlinks to individual files; nothing under a linked
 * directory is ever opened for writing, and no path the rig writes can resolve
 * outside the scratch root.** Every leaf is linked, so Bun resolves the same
 * on-disk files it would in a copy (the import graph stays intact — a copied `src/`
 * dies on `Cannot find module './dispatch-deck.ts'`, which would fake a red) while
 * the single file a mutant changes is a real file inside the scratch tree.
 *
 * The sentinel file is the rig's own witness: if it is absent the tree is not a
 * scratch tree, and every red the rig then reports is meaningless.
 */
function buildScratch(linkFiles: readonly string[]): { root: string; extensionDir: string } {
  const root = mkdtempSync(path.join(tmpdir(), "lens-fidelity-ratchet-"));
  const extensionDir = path.join(root, "extension");
  mkdirSync(extensionDir, { recursive: true });
  for (const rel of linkFiles) {
    const source = path.join(EXTENSION_ROOT, rel);
    const linkPath = path.join(extensionDir, rel);
    mkdirSync(path.dirname(linkPath), { recursive: true });
    symlinkSync(source, linkPath, "file");
  }
  writeFileSync(path.join(extensionDir, SCRATCH_SENTINEL), "");
  return { root, extensionDir };
}

/** Every `.ts` under `dir`, relative to `EXTENSION_ROOT`. */
function listTs(dir: string): string[] {
  const abs = path.join(EXTENSION_ROOT, dir);
  const out: string[] = [];
  for (const name of readdirSync(abs)) {
    if (!name.endsWith(".ts")) continue;
    out.push(`${dir}/${name}`);
  }
  return out;
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
function makeScratch(): { root: string; extensionDir: string } {
  const repoRoot = path.resolve(EXTENSION_ROOT, "..");
  const skillDir = path.join(repoRoot, "skill");
  try {
    readdirSync(skillDir);
  } catch {
    throw new Error(
      `the fidelity rig needs the sibling skill/ dir at ${skillDir} — without it LENS_ROSTER is empty and every mutant reddens for the wrong reason`,
    );
  }
  const leafFiles = [
    ...new Set([
      ...listTs("src"),
      ...listTs("smoke-tests"),
      ...listTs("smoke-tests/lib"),
      ...suitesUnderTest(),
    ]),
  ];
  const { root, extensionDir } = buildScratch(leafFiles);
  symlinkSync(skillDir, path.join(root, "skill"), "dir");
  // The suites live directly under `smoke-tests/`, which is NOT linked as a
  // directory (only individual files are), so the directory must exist before the
  // suite files are copied into it.
  mkdirSync(path.join(extensionDir, "smoke-tests"), { recursive: true });
  // The file a mutant rewrites is a REAL file in the scratch tree, copied from the
  // source. `measureMutant` copies it again immediately before writing, so this is
  // the "the tree is complete before any mutation" guarantee rather than the
  // mutation itself.
  for (const m of HARNESS_MUTANTS) {
    const source = path.join(EXTENSION_ROOT, m.file);
    try {
      readFileSync(source, "utf8");
    } catch {
      throw new Error(`ratchet mutant ${m.id} names a file that does not exist: ${m.file}`);
    }
    const dest = path.join(extensionDir, m.file);
    rmSync(dest, { force: true });
    cpSync(source, dest);
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
function suitesUnderTest(): string[] {
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
export function assertNoSymlinkInScratchTree(extensionDir: string): void {
  const realSource = realpathSync(EXTENSION_ROOT);
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let dest: string;
        try {
          dest = realpathSync(full);
        } catch {
          continue; // a dangling link cannot be written through
        }
        if (dest === realSource || dest.startsWith(realSource + path.sep)) offenders.push(full);
      } else if (entry.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(extensionDir);
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

/** Point the scratch tree at a private object store so `git hash-object -w` from
 * the mutated suite cannot write into the real clone. */
function gitEnv(extensionDir: string): { gitDir: string; env: NodeJS.ProcessEnv } {
  const seed = seedGitDir();
  const gitDir = path.join(path.dirname(extensionDir), "gitdir");
  cpSync(seed, gitDir, { recursive: true });
  return { gitDir, env: { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: extensionDir } };
}

/** Run one suite inside a scratch tree and return its red lines and pass count. */
function runSuite(
  extensionDir: string,
  suite: string,
  env: NodeJS.ProcessEnv,
): { reds: string[]; passes: number; failed: boolean; stderr: string } {
  try {
    const out = asText(
      execFileSync("bun", ["run", suite], {
        cwd: extensionDir,
        env,
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 32 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    const reds = out.split("\n").filter((l) => l.startsWith("\u2717"));
    const passes = out.split("\n").filter((l) => l.startsWith("\u2713")).length;
    return { reds, passes, failed: reds.length > 0 || out.includes("FAILED"), stderr: "" };
  } catch (e) {
    const err = e as { stdout?: unknown; stderr?: unknown; message?: string };
    const out = asText(err.stdout);
    const reds = out.split("\n").filter((l) => l.startsWith("\u2717"));
    const passes = out.split("\n").filter((l) => l.startsWith("\u2713")).length;
    return {
      reds,
      passes,
      failed: reds.length > 0 || out.includes("FAILED"),
      // `stderr` is REPORTED, never counted as a red. A suite that exits non-zero
      // while printing no `✗` did not fail an assertion — it crashed, or wrote to
      // stderr for a reason the suite itself does not consider a failure (the
      // fan-out witness's `git cat-file` notices its object is absent and git says
      // so on stderr). Treating stderr as failure turned every environmental note
      // into a "mutation proved", which is the green-on-nothing defect inverted.
      stderr: asText(err.stderr || err.message).slice(0, 400),
    };
  }
}

/**
 * One mutant, measured: copy, mutate, run, classify, discard.
 *
 * The unmutated run happens in the SAME kind of scratch tree so the pair is
 * comparable — a red that the rig itself produces (missing `skill/`, no `.git`)
 * would otherwise be indistinguishable from a red the mutation produced.
 */
export function measureMutant(m: HarnessMutant): RatchetResult {
  const { root, extensionDir } = makeScratch();
  const { gitDir, env } = gitEnv(extensionDir);
  try {
    // The mutated file is a REAL file inside the scratch tree (every leaf there is
    // either a per-file symlink or a copy, and nothing under a linked directory is
    // ever written — see `buildScratch`). It is copied fresh from the source here so
    // a prior mutant's bytes can never leak into this measurement, then rewritten.
    const target = path.join(extensionDir, m.file);
    const source = path.join(EXTENSION_ROOT, m.file);
    const original = readFileSync(source, "utf8");
    // THE LEAK THIS LINE CLOSES, and why it is a line rather than a comment.
    // `buildScratch` links every leaf with `symlink(…, "file")`, and `writeFileSync`
    // FOLLOWS a leaf symlink and writes the target. An earlier revision checked
    // `isSymbolicLink()` only in the refusal branch, so the check that ran first was
    // the earlier `rmSync`/`cpSync`, and a mutant of `lens-class-mutants.ts` wrote
    // `if (false && mutated === literal)` into the DEVELOPER'S file. A mutation rig
    // that mutates the tree it measures is the defect class this branch exists to
    // close, wearing the rig's own shape — twice now. So the guard is the FIRST
    // operation on the target, it is unconditional, and it is enforced on every
    // scratch leaf rather than only on the one about to be written.
    assertNoSymlinkInScratchTree(extensionDir);
    if (lstatSync(target).isSymbolicLink())
      throw new Error(
        `the scratch tree put a symlink at the mutant target ${m.file} — writing through it would mutate the SOURCE file`,
      );
    rmSync(target, { force: true });
    cpSync(source, target);
    const baseline = runSuite(extensionDir, m.suite, env);

    // The mutation must actually apply. A `from` that is not in the file means the
    // mutant is a no-op and its "red" would be the baseline's — refused loudly.
    if (!original.includes(m.from)) {
      return {
        id: m.id,
        baselineGreen: !baseline.failed,
        reddened: false,
        matchedRed: null,
        detail: `MUTATION DID NOT APPLY: ${m.file} does not contain the expected text — the mutant is a no-op and its green is meaningless`,
      };
    }
    writeFileSync(target, original.replace(m.from, m.to));
    chmodSync(target, 0o644);
    const after = runSuite(extensionDir, m.suite, env);
    const matched = after.reds.find((r) => r.includes(m.redMustContain)) ?? null;
    return {
      id: m.id,
      baselineGreen: !baseline.failed,
      reddened: after.failed,
      matchedRed: matched,
      detail: `baseline pass=${baseline.passes} red=${baseline.reds.length}; mutated pass=${after.passes} red=${after.reds.length}${after.stderr ? ` stderr=${after.stderr}` : ""}`,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(gitDir, { recursive: true, force: true });
  }
}

/** The ratchet's own refusal when asked to prove nothing. */
export class NothingToProve extends Error {}

/**
 * Run every mutant and refuse, rather than pass, when the list is empty or when a
 * mutant cannot be trusted. Returns the per-mutant results for the caller to print.
 */
export function runRatchet(mutants: readonly HarnessMutant[] = HARNESS_MUTANTS): RatchetResult[] {
  if (mutants.length === 0)
    throw new NothingToProve(
      "the harness-fidelity ratchet was given no mutants — an empty list proves every entry point and reddens nothing, which is the defect class this file exists to close",
    );
  const ids = new Set(mutants.map((m) => m.id));
  if (ids.size !== mutants.length)
    throw new NothingToProve("two ratchet mutants share an id — one of them is not being measured");
  return mutants.map(measureMutant);
}

/**
 * Two mutants that reddened exactly the same lines means one of them reddened for
 * the other's reason, and the pair proves one thing, not two. Returns the pairs
 * whose red sets are identical.
 */
export function indistinguishablePairs(
  results: readonly { id: string; matchedRed: string | null; reddened: boolean }[],
): [string, string][] {
  const done = results.filter((r) => r.reddened);
  const pairs: [string, string][] = [];
  for (let i = 0; i < done.length; i++) {
    for (let j = i + 1; j < done.length; j++) {
      const a = done[i]!;
      const b = done[j]!;
      if (a.matchedRed !== null && a.matchedRed === b.matchedRed) pairs.push([a.id, b.id]);
    }
  }
  return pairs;
}
