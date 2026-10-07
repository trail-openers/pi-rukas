#!/usr/bin/env bun
/**
 * Skill reference-mention gate — issue #994 (epic #869 sub-issue).
 *
 * Sibling of test-skill-name-surface.ts, same bidirectional shape:
 *
 *   1. Every file under skill/<name>/references/ is mentioned in that
 *      skill's SKILL.md BODY (text after the first frontmatter block) as
 *      the path form `references/<exact-filename>` — bullet, backticked
 *      inline, or prose; extension-agnostic, matched per FILE so a skill
 *      with two reference files must name both.
 *   2. Anti-vacuity: the real repo yields ≥ 11 reference files across
 *      skills that HAVE a references/ dir (skills without one are not
 *      checked — 12 of the 21 skill dirs lack one).
 *
 * **Body scanning.** The mention check reads the SKILL.md text AFTER the
 * first frontmatter block (same first-`---`-block rule as
 * extension/src/skill-frontmatter.ts — skill/devops-infrastructure/SKILL.md
 * has an in-body `name: CI/CD` inside a code block, so the whole file is
 * wrong by construction). CRLF-tolerant throughout.
 *
 * **Matching.** A mention is the literal `references/<filename>` token
 * (a word boundary before `references/` guards against `myreferences/…`),
 * regardless of quoting. A bare filename without the `references/` prefix
 * does not count; the bare word "references" in prose does not count.
 *
 * **Proven in both directions** (test-file-size-limit.ts precedent): the
 * checker functions are exported and run against a tmpdir fixture (mkdtemp,
 * rmSync in finally — nothing committed) that must report failures, and
 * against the real repo that must be clean.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.join(import.meta.dirname, "..", "..");
const ANTI_VACUITY_FLOOR = 11;

/**
 * The SKILL.md body — the text after the first `---`-delimited frontmatter
 * block — or the whole text when the file does not begin with one.
 * Same rule as extension/src/skill-frontmatter.ts (first block only,
 * CRLF-tolerant).
 */
export function skillBody(text: string): string {
  const firstLine = text.split(/\r?\n/)[0] ?? "";
  if (!/^---[ \t]*\r?$/.test(firstLine)) return text;
  const rest = text.slice(3);
  const end = rest.search(/^---[ \t]*\r?$/m);
  if (end === -1) return rest;
  return rest.slice(end + 3);
}

/** True when the SKILL.md body mentions `references/<filename>` in any form (backticked, bare bullet, prose). */
export function bodyMentions(body: string, filename: string): boolean {
  const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-zA-Z0-9_-])references/${escaped}`, "g").test(body);
}

export interface ReferenceFailure {
  kind: "unmentioned" | "vacuity";
  detail: string;
}

function listReferenceFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.filter((e) => {
    try {
      return statSync(path.join(dir, e)).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * The gate over one tree: for every skill/<dir>/ with a references/ subdir,
 * each file in it must be mentioned as `references/<filename>` in that
 * skill's SKILL.md body. Skills without a references/ dir are skipped.
 */
export function checkReferenceMentions(root: string): { filesFound: number; failures: ReferenceFailure[] } {
  const failures: ReferenceFailure[] = [];
  let filesFound = 0;
  const skillDir = path.join(root, "skill");
  let dirs: string[] = [];
  try {
    dirs = readdirSync(skillDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    dirs = [];
  }
  for (const dir of dirs) {
    const refsDir = path.join(skillDir, dir, "references");
    const refFiles = listReferenceFiles(refsDir);
    if (refFiles.length === 0) continue; // no references/ dir (or empty) — not checked
    const skillMd = path.join(skillDir, dir, "SKILL.md");
    if (!existsSync(skillMd)) {
      for (const f of refFiles) {
        filesFound += 1;
        failures.push({ kind: "unmentioned", detail: `skill/${dir}/SKILL.md is missing but references/${f} exists` });
      }
      continue;
    }
    const body = skillBody(readFileSync(skillMd, "utf8"));
    for (const f of refFiles) {
      filesFound += 1;
      if (!bodyMentions(body, f)) {
        failures.push({ kind: "unmentioned", detail: `skill/${dir}/references/${f} is not mentioned as references/${f} in skill/${dir}/SKILL.md body` });
      }
    }
  }
  return { filesFound, failures };
}

/** Repo-only addition: the reference-file total must stay ≥ the floor. */
export function checkRepoReferences(repoRoot: string): ReferenceFailure[] {
  const { filesFound, failures } = checkReferenceMentions(repoRoot);
  const out = [...failures];
  if (filesFound < ANTI_VACUITY_FLOOR) {
    out.push({ kind: "vacuity", detail: `anti-vacuity: only ${filesFound} reference files found (floor ${ANTI_VACUITY_FLOOR}) — the checker may be scanning nothing` });
  }
  return out;
}

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ---------------------------------------------- the gate CAN fail

{
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "pi-ens-refgate-"));
  try {
    mkdirSync(path.join(fixtureRoot, "skill", "good-skill", "references"), { recursive: true });
    writeFileSync(path.join(fixtureRoot, "skill", "good-skill", "SKILL.md"), "---\nname: good-skill\ndescription: fine\n---\n\nFor patterns, read `references/alpha.md` before writing code.\n");
    writeFileSync(path.join(fixtureRoot, "skill", "good-skill", "references", "alpha.md"), "# Alpha\n");
    // The postgres-database shape: two reference files, only one mentioned.
    mkdirSync(path.join(fixtureRoot, "skill", "two-files", "references"), { recursive: true });
    writeFileSync(
      path.join(fixtureRoot, "skill", "two-files", "SKILL.md"),
      "---\nname: two-files\ndescription: fine\n---\n\nRead references/one.md for details.\nBare `two.md` without the prefix does not count, and frontmatter references/three.md neither.\n",
    );
    writeFileSync(path.join(fixtureRoot, "skill", "two-files", "references", "one.md"), "# One\n");
    writeFileSync(path.join(fixtureRoot, "skill", "two-files", "references", "two.md"), "# Two\n");
    // A skill without a references/ dir — must not be flagged.
    mkdirSync(path.join(fixtureRoot, "skill", "no-refs"), { recursive: true });
    writeFileSync(path.join(fixtureRoot, "skill", "no-refs", "SKILL.md"), "---\nname: no-refs\ndescription: fine\n---\n\nbody with the word references but no pointer\n");
    const { filesFound, failures } = checkReferenceMentions(fixtureRoot);
    const got = failures.map((f) => `${f.kind}:${f.detail}`);
    assert(filesFound === 3, `canary: fixture discovers the three reference files (got ${filesFound})`);
    assert(failures.length === 1, `canary: exactly the unmentioned file is reported (got ${JSON.stringify(got)})`);
    assert(
      failures.some((f) => f.kind === "unmentioned" && f.detail.includes("two-files/references/two.md")),
      "canary: per-FILE checking — a two-file skill mentioning only one IS reported; a gate never observed to fail is worthless",
    );
    assert(
      !failures.some((f) => f.detail.includes("good-skill")),
      "canary: a backticked inline mention of references/alpha.md passes silently",
    );
    assert(
      !failures.some((f) => f.detail.includes("no-refs")),
      "canary: a skill without a references/ dir is not checked",
    );
    // CRLF + bare-bullet form (python-tdd shape) both count as mentions.
    writeFileSync(
      path.join(fixtureRoot, "skill", "two-files", "SKILL.md"),
      "---\r\nname: two-files\r\ndescription: fine\r\n---\r\n\r\nSee:\r\n- references/one.md\r\n- references/two.md\r\n",
    );
    const fixed = checkReferenceMentions(fixtureRoot);
    assert(fixed.failures.length === 0, `CRLF + bare-bullet: both mention forms pass (got ${JSON.stringify(fixed.failures.map((f) => f.detail))})`);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

// ---------------------------------------------- and the repo is clean

const repoFailures = checkRepoReferences(REPO_ROOT);
const found = checkReferenceMentions(REPO_ROOT).filesFound;
if (repoFailures.length === 0) {
  assert(true, `every reference file is mentioned in its SKILL.md body (${found} reference files, floor ${ANTI_VACUITY_FLOOR})`);
} else {
  for (const f of repoFailures) {
    assert(false, f.detail);
  }
}

console.log(exit === 0 ? "\nAll skill-reference checks passed." : "\nFAILED");
process.exit(exit);
