#!/usr/bin/env bun
/**
 * Skill-name surface gate — issue #871 (epic #867 sub-issue 2).
 *
 * One bidirectional offline gate for the whole skill-name surface:
 *
 *   1. Every skill name referenced in the prompt sources resolves to
 *      skill/<name>/SKILL.md.
 *   2. Each SKILL.md frontmatter `name:` (first `---` block only) equals
 *      its directory name.
 *   3. Every LENSES[].skill (extension/src/lens-review-format.ts) resolves
 *      to the repo's skill/<name>/SKILL.md.
 *   4. Anti-vacuity: the real-repo extraction yields ≥ 10 DISTINCT names.
 *
 * **Extraction rule** (#867 decisions comment). A skill-name reference is
 * a backticked token matching `^[a-z0-9]+(-[a-z0-9]+)*$` on a line that also
 * matches /skill/i, in agents-base/, modules/ and pi-prompts/ ONLY. Path
 * references `skill/<name>` (e.g. skill/vipune/SKILL.md) and
 * `<skills-dir>/<name>` also yield `<name>`. Both forms feed the same
 * "name → skill/<name>/SKILL.md must exist" check; the anti-vacuity count
 * aggregates over the union.
 *
 * **Exclusions.** The tool name `skill`; role keys read from agents.json
 * (developer, ops, …); tokens containing `*`; `<…>` placeholders (e.g.
 * `<skills-dir>` — the placeholder itself is not a skill name, though
 * `<skills-dir>/<name>` still yields `<name>`). A backticked token that is a
 * placeholder (starts with `<`) is dropped entirely.
 *
 * **Scan roots.** agents-base/, modules/, pi-prompts/ at the repo root only —
 * .worktrees/, dist/, node_modules/, tmp/ and outputs/ are never scanned
 * (same explicit-exclusion doctrine as test-file-size-limit.ts).
 *
 * **Frontmatter rule.** Only the first `---`-delimited block is read:
 * skill/devops-infrastructure/SKILL.md has an in-body `name: CI/CD` at line
 * 37 inside a code block, so a whole-file `/^name:/` scan is wrong by
 * construction.
 *
 * **Proven in both directions** (test-file-size-limit.ts precedent): the
 * checker functions are exported and run against a tmpdir fixture built in
 * the test (mkdtempSync, rmSync in finally — nothing committed) that must
 * report failures, and against the real repo that must be clean.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LENSES } from "../src/lens-review-format.ts";

const REPO_ROOT = path.join(import.meta.dirname, "..", "..");
const SCAN_ROOTS = ["agents-base", "modules", "pi-prompts"];
const ANTI_VACUITY_FLOOR = 10;

const SKILL_TOKEN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PATH_REF = /(?:^|[\s`'(])skill\/([a-z0-9-]+)/g;
const SKILLS_DIR_REF = /<skills-dir>\/([a-z0-9-]+)/g;

/** Roles from agents.json — their names appear on skill lines and must not read as skills. */
function roleKeys(agentsJsonPath: string): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(agentsJsonPath, "utf8")) as {
      agent?: Record<string, unknown>;
    };
    return new Set(Object.keys(parsed.agent ?? {}));
  } catch {
    return new Set();
  }
}

function listMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...listMarkdownFiles(full));
    else if (entry.endsWith(".md")) out.push(full);
  }
  return out;
}

/**
 * Extract skill-name references from the prompt sources under `root`.
 * A backticked bare token only counts on a line matching /skill/i; the two
 * path-ref forms count on any line they appear on.
 */
export function extractSkillNames(root: string): Map<string, string> {
  const excluded = roleKeys(path.join(root, "agents.json"));
  const names = new Map<string, string>(); // name → relative file of first reference
  for (const scanRoot of SCAN_ROOTS) {
    for (const file of listMarkdownFiles(path.join(root, scanRoot))) {
      const rel = path.relative(root, file);
      const text = readFileSync(file, "utf8");
      for (const line of text.split("\n")) {
        for (const token of line.matchAll(/`([^`]+)`/g)) {
          const t = token[1];
          if (t.startsWith("<") || t.includes("*")) continue; // placeholders, globs
          if (!SKILL_TOKEN.test(t)) continue;
          if (t === "skill" || excluded.has(t)) continue; // tool name, role key
          if (!/skill/i.test(line)) continue;
          if (!names.has(t)) names.set(t, rel);
        }
        for (const re of [PATH_REF, SKILLS_DIR_REF]) {
          re.lastIndex = 0;
          for (const m of line.matchAll(re)) {
            const t = m[1];
            if (t === "skill" || excluded.has(t)) continue;
            if (!names.has(t)) names.set(t, rel);
          }
        }
      }
    }
  }
  return names;
}

/** The first `---`-delimited frontmatter block, or null when absent. */
export function firstFrontmatterBlock(text: string): string | null {
  if (!text.startsWith("---")) return null;
  const rest = text.slice(3);
  const end = rest.search(/^---[ \t]*$/m);
  if (end === -1) return null;
  return rest.slice(0, end);
}

/** `name:` value from the first frontmatter block only. */
export function frontmatterName(text: string): string | null {
  const block = firstFrontmatterBlock(text);
  if (block === null) return null;
  const m = block.match(/^name:\s*(.+?)\s*$/m);
  if (!m) return null;
  return m[1].replace(/^["']|["']$/g, "");
}

export interface SkillSurfaceFailure {
  kind: "phantom" | "frontmatter" | "lens";
  detail: string;
}

/**
 * The full gate over one tree: extracted names must resolve, frontmatter
 * names must match their directories. LENSES and the anti-vacuity floor are
 * repo-only checks (the fixture carries its own lens file? no — LENSES is a
 * static import of the real roster), so they run inside `checkRepoSurface`.
 */
export function checkTreeSurface(root: string): { names: Map<string, string>; failures: SkillSurfaceFailure[] } {
  const names = extractSkillNames(root);
  const failures: SkillSurfaceFailure[] = [];
  for (const [name, file] of [...names].sort()) {
    if (!existsSync(path.join(root, "skill", name, "SKILL.md"))) {
      failures.push({ kind: "phantom", detail: `${file} references \`${name}\` — no skill/${name}/SKILL.md` });
    }
  }
  const skillDir = path.join(root, "skill");
  let dirs: string[] = [];
  try {
    dirs = readdirSync(skillDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    dirs = [];
  }
  for (const dir of dirs) {
    const skillMd = path.join(skillDir, dir, "SKILL.md");
    if (!existsSync(skillMd)) continue;
    const name = frontmatterName(readFileSync(skillMd, "utf8"));
    if (name === null) {
      failures.push({ kind: "frontmatter", detail: `skill/${dir}/SKILL.md has no \`name:\` in its first frontmatter block` });
    } else if (name !== dir) {
      failures.push({ kind: "frontmatter", detail: `skill/${dir}/SKILL.md frontmatter name \`${name}\` ≠ directory \`${dir}\`` });
    }
  }
  return { names, failures };
}

/** Repo-only additions: LENSES resolution + anti-vacuity on the union. */
export function checkRepoSurface(repoRoot: string): SkillSurfaceFailure[] {
  const failures = [...checkTreeSurface(repoRoot).failures];
  for (const lens of LENSES) {
    if (!existsSync(path.join(repoRoot, "skill", lens.skill, "SKILL.md"))) {
      failures.push({ kind: "lens", detail: `LENSES ${lens.name} → \`${lens.skill}\` does not resolve to skill/${lens.skill}/SKILL.md` });
    }
  }
  const distinct = extractSkillNames(repoRoot).size;
  if (distinct < ANTI_VACUITY_FLOOR) {
    failures.push({ kind: "phantom", detail: `anti-vacuity: only ${distinct} distinct names extracted (floor ${ANTI_VACUITY_FLOOR})` });
  }
  return failures;
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
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "pi-ens-skillgate-"));
  try {
    mkdirSync(path.join(fixtureRoot, "agents-base"));
    mkdirSync(path.join(fixtureRoot, "modules"));
    mkdirSync(path.join(fixtureRoot, "pi-prompts"));
    mkdirSync(path.join(fixtureRoot, "skill", "good-skill"), { recursive: true });
    mkdirSync(path.join(fixtureRoot, "skill", "bad-skill"), { recursive: true });
    writeFileSync(
      path.join(fixtureRoot, "agents-base", "role.md"),
      "Load the `skill` tool and use the `real-skill` or `phantom-skill` skill here.\n" +
        "Also a `skill/good-skill/SKILL.md` path reference, and `--skill <skills-dir>/good-skill`.\n",
    );
    writeFileSync(path.join(fixtureRoot, "skill", "good-skill", "SKILL.md"), "---\nname: good-skill\ndescription: fine\n---\n\nbody\n");
    writeFileSync(path.join(fixtureRoot, "skill", "bad-skill", "SKILL.md"), "---\nname: something-else\ndescription: >\n  folded\n---\n\nbody\n");
    const { names, failures } = checkTreeSurface(fixtureRoot);
    const got = failures.map((f) => `${f.kind}:${f.detail}`);
    assert(
      names.has("phantom-skill") && names.has("good-skill"),
      `canary: fixture extraction sees the phantom backtick and the path refs (got ${JSON.stringify([...names.keys()].sort())})`,
    );
    assert(
      !names.has("skill") && names.has("real-skill"),
      "canary: the tool name `skill` is excluded while a bare backticked skill name on a skill line is picked up",
    );
    assert(
      failures.some((f) => f.kind === "phantom" && f.detail.includes("phantom-skill")),
      `canary: phantom reference IS reported (${JSON.stringify(got)}) — a gate never observed to fail is worthless`,
    );
    assert(
      failures.some((f) => f.kind === "frontmatter" && f.detail.includes("something-else")),
      `canary: frontmatter name ≠ directory IS reported (good-skill passes silently; bad-skill does not)`,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

// ---------------------------------------------- and the repo is clean

const repoFailures = checkRepoSurface(REPO_ROOT);
const extracted = [...extractSkillNames(REPO_ROOT).keys()].sort();
console.log(`  distinct names from the real-repo scan (${extracted.length}):`);
for (const n of extracted) console.log(`    - ${n}`);
if (repoFailures.length === 0) {
  assert(true, `every extracted skill name, every SKILL.md frontmatter name and every LENSES entry resolves (${extracted.length} distinct names)`);
} else {
  for (const f of repoFailures) {
    assert(false, f.detail);
  }
}

console.log(exit === 0 ? "\nAll skill-surface checks passed." : "\nFAILED");
process.exit(exit);
