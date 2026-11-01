/**
 * Shared fixture for the two lens-coverage smoke tests.
 *
 * `test-lens-coverage-denominator.ts` pins the pure accounting (the denominator
 * and what counts as evidence for a file); `test-lens-coverage-routing.ts` pins
 * what an unaccounted file DOES to a round's verdict. Both need the same clone:
 * a real git repo whose PR changes TWO files, driven through the injected
 * `lensChildFn` seam so nothing ever spawns a child.
 *
 * The clone lives here rather than in either test so neither file can drift its
 * own copy of "what the PR changed" — the denominator both tests measure against
 * is git's answer over this one fixture.
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type FileAccountability, selectedFiles } from "../../src/lens-review-coverage.ts";
import type { Finding, LensRunResult } from "../../src/lens-review-types.ts";
import { runLensReview } from "../../src/lens-review.ts";
import { LENS_ROSTER } from "../../src/lens-roster.ts";
import { gitTestEnv } from "./git-test-env.ts";

/** A diff over three files, so "named two of three" is a real subtraction. */
export const THREE_FILE_DIFF = ["src/a.ts", "src/b.ts", "src/c.ts"]
  .flatMap((f) => [
    `diff --git a/${f} b/${f}`,
    `--- a/${f}`,
    `+++ b/${f}`,
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ])
  .join("\n");

/** An empty accountability map, for the pure-accounting arms. */
export const EMPTY_ACCOUNTABILITY = new Map<string, FileAccountability>();

/** A lens row as the fan-out hands it. */
export function row(over: Partial<LensRunResult> = {}): LensRunResult {
  return {
    lens: "SECURITY",
    ok: true,
    ms: 1,
    startMs: 0,
    attempts: 1,
    blocked: false,
    findings: [],
    ...over,
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture; only the read fields matter
  } as any as LensRunResult;
}

export function finding(p: string, severity: Finding["severity"] = "LOW", line?: number): Finding {
  // biome-ignore lint/suspicious/noExplicitAny: partial fixture
  return { lens: "SECURITY", severity, path: p, line, title: "x" } as any as Finding;
}

/** A healthy lens row: it answered, with whatever findings and prose the case says. */
export function lens(name: string, findings: Finding[], summary: string): LensRunResult {
  return {
    lens: name,
    ok: true,
    ms: 1,
    startMs: Date.now(),
    attempts: 1,
    blocked: false,
    findings,
    summary,
  };
}

export const reportFrom = (name: string, rows: Omit<Finding, "lens">[]): Finding[] =>
  rows.map((r) => ({ ...r, lens: name }));

/** The two files the scenario clone's PR changes. */
export const CHANGED_A = "src/a.ts";
export const CHANGED_B = "src/b.ts";

export interface Clone {
  root: string;
  repo: string;
  base: string;
  head: string;
  restore: () => void;
}

/**
 * A clone whose PR changes TWO files, with a `main` the ledger writer and the
 * advisory split can resolve. Two, not one: a one-file denominator makes the
 * covered/uncovered distinction nearly tautological, and the field case this
 * closes was a lens that read one file of a two-file delta.
 */
export function mkClone(opts: { skills?: "full" | "unusable" } = {}): Clone {
  const root = mkdtempSync(path.join(os.tmpdir(), "lens-coverage-"));
  const repo = path.join(root, "repo");
  const skills = path.join(root, "skills");
  const ledgerFile = path.join(root, "ledger", "review-ledger.json");
  mkdirSync(path.join(repo, "src"), { recursive: true });
  mkdirSync(path.join(root, "ledger"), { recursive: true });
  // The installed skills dir always exists; `skills: "empty"` simply declares
  // no `code-review-*` skill in it, so the roster has ZERO healthy entries and
  // the fan-out runs with `results === []` — the vacuous-`every` shape the
  // blocked-only arm of `test-lens-coverage-denominator.ts` pins. The EXPECTED
  // (bundled) set still blocks each lens by name, so this is a real blocked-only
  // review and not the empty-roster shortcut.
  let prec = 10;
  for (const l of LENS_ROSTER) {
    mkdirSync(path.join(skills, l.skill), { recursive: true });
    // `skills: "unusable"` writes the six skill dirs but NO frontmatter, so
    // every entry blocks on its own parse error. The roster is then six NAMED
    // blocked lanes with ZERO healthy ones — `runLensFanOut` runs with
    // `results === []`, the vacuous-`every` shape the blocked-only arm of
    // `test-lens-coverage-denominator.ts` pins. This is the shape that reaches
    // the fan-out at all: a skills dir with no `code-review-*` dir at all is
    // diverted to the empty-roster install exit before the fan-out, and that
    // path never computes a denominator, so it cannot pose the question.
    if (opts.skills === "unusable") continue;
    writeFileSync(
      path.join(skills, l.skill, "SKILL.md"),
      `---\nname: ${l.skill}\nprecedence: ${prec}\n---\n`,
    );
    prec += 10;
  }
  const savedLedger = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  const savedSkills = process.env.PI_ENSEMBLE_SKILLS_DIR;
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = ledgerFile;
  process.env.PI_ENSEMBLE_SKILLS_DIR = skills;
  const gitEnv = gitTestEnv();
  const sh = (cmd: string) =>
    execSync(cmd, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: gitEnv,
    }).trim();
  sh("git init -q -b main");
  sh("git config user.email dev@example.com");
  sh("git config user.name dev");
  writeFileSync(path.join(repo, "src", "a.ts"), "one\ntwo\nthree\n");
  writeFileSync(path.join(repo, "src", "b.ts"), "alpha\nbeta\n");
  writeFileSync(path.join(repo, "src", "untouched.ts"), "stable\n");
  sh("git add -A");
  sh("git commit -qm base");
  const base = sh("git rev-parse HEAD");
  // A bare remote with `origin/HEAD` set, for the same reason the advisory
  // fixture sets it: without it the ledger writer's `resolveMainline` falls
  // through to `gh repo view` and, offline, that is a WARN on every round.
  execSync(`git init -q --bare -b main ${path.join(root, "remote.git")}`, {
    encoding: "utf8",
    env: gitEnv,
  });
  sh(`git remote add origin ${path.join(root, "remote.git")}`);
  sh("git push -q origin main");
  sh("git fetch -q origin");
  sh("git remote set-head origin main");
  sh("git checkout -qb feat/x");
  writeFileSync(path.join(repo, "src", "a.ts"), "one\ntwo\nthree\nfour\n");
  writeFileSync(path.join(repo, "src", "b.ts"), "alpha\nbeta\ngamma\n");
  sh("git add -A");
  sh("git commit -qm pr");
  const head = sh("git rev-parse HEAD");
  return {
    root,
    repo,
    base,
    head,
    // `delete` is the only correct "reset to unset": assigning undefined stores
    // the string "undefined", which piSkillsDir() then treats as a real dir.
    restore: () => {
      // biome-ignore lint/performance/noDelete: delete is the correct "reset to unset"
      if (savedLedger === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
      else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = savedLedger;
      // biome-ignore lint/performance/noDelete: delete is the correct "reset to unset"
      if (savedSkills === undefined) delete process.env.PI_ENSEMBLE_SKILLS_DIR;
      else process.env.PI_ENSEMBLE_SKILLS_DIR = savedSkills;
    },
  };
}

/**
 * One round of the REAL review, over the refs the review resolves itself.
 * `full: true` keeps the automatic delta (#973) from narrowing a later round
 * to a range these scenarios never make; `base`+`head` (and no pasted `diff`)
 * is what makes the diff `computed`, and therefore what earns a denominator.
 */
export async function round(
  c: Clone,
  evidence: (name: string) => LensRunResult,
  extra?: { extraFindings?: Finding[] },
) {
  let write: Promise<unknown> = Promise.resolve();
  const summary = await runLensReview({
    cwd: c.repo,
    branch: "feat/x",
    head: c.head,
    base: c.base,
    full: true,
    lensChildFn: (async (args: { lens: { name: string } }) => evidence(args.lens.name)) as never,
    ...(extra?.extraFindings ? { extraFindings: extra.extraFindings } : {}),
    onLedgerWrite: (w: Promise<unknown>) => {
      write = w;
    },
  });
  // #984 seam — the ledger write is fire-and-forget and shells out to git in
  // this clone; awaiting it is what lets the scenario tear the clone down.
  await write;
  return summary;
}

/**
 * The clone's PR diff, byte-exact to what `git diff base...head` produces for
 * it. Used for the caller-pasted arm, where the POINT is that the text is the
 * same and only its provenance differs — so it must be a diff the parser
 * actually reads (a `+++ ` line only counts when the line before it is `--- `,
 * and a headerless string would compare a parsed change set against nothing).
 */
export const PASTED_DIFF = [
  `diff --git a/${CHANGED_A} b/${CHANGED_A}`,
  `--- a/${CHANGED_A}`,
  `+++ b/${CHANGED_A}`,
  "@@ -1,3 +1,4 @@",
  " one",
  " two",
  " three",
  "+four",
  `diff --git a/${CHANGED_B} b/${CHANGED_B}`,
  `--- a/${CHANGED_B}`,
  `+++ b/${CHANGED_B}`,
  "@@ -1,2 +1,3 @@",
  " alpha",
  " beta",
  "+gamma",
].join("\n");

/** The clone's PR, as git itself computes it — the expected denominator, read
 * from the tool rather than asserted from what this file chose to write. */
export function gitDiff(c: Clone): string {
  return execSync(`git diff ${c.base}...${c.head}`, {
    cwd: c.repo,
    encoding: "utf8",
    env: gitTestEnv(),
  });
}

/** The clone's changed files as git itself reports them, sorted — the expected
 * set read from the tool rather than from what this file chose to write. */
export function gitChanged(c: Clone): string[] {
  return Array.from(selectedFiles(gitDiff(c))).sort();
}

/** Tear a clone down: restore the env it stamped, then remove the tree. */
export function teardown(c: Clone): void {
  c.restore();
  rmSync(c.root, { recursive: true, force: true });
}
