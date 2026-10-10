#!/usr/bin/env bun
/**
 * Structural assembly gate for the role prompts.
 *
 * This checks presence only: it cannot determine whether a doctrine sentence
 * accurately describes runtime behaviour. That remains a human review
 * judgement, so this test must not be read as semantic prompt verification.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const MANIFESTS = path.join(ROOT, "manifests");
const PROMPTS = path.join(ROOT, "dist", "prompts", "standard");
const BUILD = path.join(ROOT, "build.sh");
const CODEMODE_MODULE = "modules/core/codemode.md";

// Epic #1026 sub-issue 3: the codemode module is capped at 60 lines so the
// built prompts stay lean (the module ships to all six roles).

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// Build the same output this gate inspects. No Pi child or network is used.
execFileSync("bash", [BUILD], {
  cwd: ROOT,
  env: {
    ...process.env,
    PI_ENSEMBLE_BASE: ROOT,
    PROMPTS_DIR: path.join(ROOT, "dist", "prompts"),
  },
  stdio: "ignore",
});

// #1031 — codemode module heading, asserted per-manifest below.
const codemodeHeading = readFileSync(path.join(ROOT, CODEMODE_MODULE), "utf8").match(/^#{1,6} .+$/m)?.[0];

// Epic #1026 sub-issue 3 — the doc sweep: no source doc file still prescribes
// the `oo` prefix as a command wrapper. The allowlist entries in agents.json
// (and the allowlist block build.sh renders from them) still carry `oo`-prefixed
// patterns until sub-issue 5 retires the guard, so this gate targets the
// prescriptive prose in the role/agent/workflow docs, not the allowlist.
const OO_SWEEP_FILES = [
  "agents-base/project-manager.md",
  "agents-base/developer.md",
  "agents-base/ops.md",
  "agents-base/explore.md",
  "agents-base/adversarial-developer.md",
  "agents-base/code-review-specialist.md",
  "pi-prompts/start.md",
  "modules/workflows/parallel-worktrees.md",
  "modules/workflows/issue-workflow.md",
  "modules/core/async-tasks.md",
  "modules/core/bash-final-reminders.md",
];
// Matches `oo` used as a command-prefix wrapper: "oo git", "oo gh", "oo cargo",
// "oo npm", "oo bun", "oo pnpm", "oo yarn", "oo pytest", "oo glab", etc.
// A fresh non-global regex is created per use because a shared `g`-flagged
// regex is stateful (`lastIndex`), so reusing one across the sweep and the
// canary below would make every second `test()` miss.
function ooPrefixRe() {
  return /(?<!\w)oo\s+(?:git|gh|glab|npm|cargo|bun|pnpm|yarn|pytest|go|uv|npx|ruff|recall|help|patterns|learn|forget)\b/;
}
function assertOoSweep(lines: string[], rel: string) {
  const re = ooPrefixRe(); // fresh per file, so lastIndex can't leak forward
  const violations: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (re.test(line)) {
      violations.push(`  line ${i + 1}: ${line.trim().slice(0, 120)}`);
    }
  }
  assert(
    violations.length === 0,
    violations.length === 0
      ? `${rel}: no oo command-prefix prescriptions remain`
      : `${rel}: ${violations.length} line(s) still prescribe oo command prefix:\n${violations.join("\n")}`,
  );
}
// Prove the gate can fail: an in-test fixture with a prescriptive `oo`-prefixed
// runner line must be reported (and an exempted one must not be).
{
  const fixture = [
    "Run the suite with `oo cargo test` to keep the report short.",
    "Run the suite with `oo bun test` to keep the report short.",
  ];
  const canaryRe = ooPrefixRe(); // fresh regex, independent of the sweep above
  const badViolations = fixture.filter((l) => canaryRe.test(l));
  assert(
    badViolations.length === 2,
    `oo sweep canary: fixture line(s) reporting a prescriptive oo-prefix (${badViolations.length}/2)`,
  );
}
for (const rel of OO_SWEEP_FILES) {
  const p = path.join(ROOT, rel);
  let src = "";
  try {
    src = readFileSync(p, "utf8");
  } catch {
    assert(false, `${rel}: file exists (required for doc sweep)`);
    continue;
  }
  assertOoSweep(src.split("\n"), rel);
}

for (const manifestName of readdirSync(MANIFESTS).filter((name) => name.endsWith(".manifest"))) {
  const role = manifestName.replace(/\.manifest$/, "");
  const manifestPath = path.join(MANIFESTS, manifestName);
  const manifestLines = readFileSync(manifestPath, "utf8").split("\n");
  assert(
    manifestLines.includes(CODEMODE_MODULE),
    `${role}: manifest references modules/core/codemode.md`,
  );
  assert(
    !manifestLines.includes("modules/core/oo-command-runner.md"),
    `${role}: manifest no longer references modules/core/oo-command-runner.md`,
  );
  const promptPath = path.join(PROMPTS, `${role}.md`);
  const prompt = readFileSync(promptPath, "utf8");
  const promptLines = new Set(prompt.split("\n"));
  if (codemodeHeading !== undefined) {
    assert(
      promptLines.has(codemodeHeading),
      `${role}: assembled prompt contains the codemode heading (${codemodeHeading})`,
    );
  }

  // #911 — content check (not just heading presence): the PM prompt must
  // carry the hand-managed-work gate sentence in the Development Workflow
  // section, so a future edit can't drop it silently.
  if (role === "project-manager") {
    assert(
      prompt.includes("Hand-managed work gets the same gates as /work"),
      "project-manager: built prompt contains the hand-managed-work gate sentence",
    );
    assert(
      prompt.slice(prompt.indexOf("## Development Workflow")).includes(
        "Hand-managed work gets the same gates as /work",
      ),
      "project-manager: the gate sentence is in the Development Workflow section",
    );
    // #1007 — the worktree-bound-dispatch fence must name all four dispatch
    // types with their cwd/workCwd parameters, so a future regression that
    // drops the fence fails the gate rather than surfacing as feature work
    // landing at root.
    const worktreeSection = prompt.match(
      /Worktree-bound dispatches[\s\S]*?(?=\n###?\s)/,
    );
    assert(
      worktreeSection !== null,
      "project-manager: built prompt contains the worktree-bound-dispatch section",
    );
    if (worktreeSection) {
      const section = worktreeSection[0];
      const fourDispatches = [
        "dispatch_specialist",
        "dispatch_parallel",
        "adversarial_loop",
        "dispatch_lens_review",
      ];
      for (const tool of fourDispatches) {
        assert(
          section.includes(tool),
          `project-manager: worktree-bound-dispatch section names ${tool}`,
        );
      }
      assert(
        section.includes("workCwd"),
        "project-manager: worktree-bound-dispatch section names workCwd",
      );
    }
  }

  for (const line of manifestLines) {
    const modulePath = line.trim();
    if (!modulePath || modulePath.startsWith("#")) continue;

    const module = readFileSync(path.join(ROOT, modulePath), "utf8");
    // bash-final-reminders intentionally starts at H2, so the first ATX
    // heading is used rather than requiring every module to invent an H1.
    const heading = module.match(/^#{1,6} .+$/m)?.[0];
    assert(heading !== undefined, `${role}: ${modulePath} has a markdown heading`);
    if (heading !== undefined) {
      assert(
        promptLines.has(heading),
        `${role}: assembled prompt contains ${modulePath}'s first heading (${heading})`,
      );
    }
  }

  // #1031 — the codemode module replaces the retired oo-command-runner module:
  // it must appear in every role's manifest (asserted above via
  // manifestLines.includes), and no manifest or assembled prompt may still
  // reference the old module.
  const manifest = manifestLines.join("\n");
  assert(
    !manifest.includes("oo-command-runner"),
    `${role}: manifest no longer references oo-command-runner`,
  );
  assert(
    !prompt.includes("oo-command-runner"),
    `${role}: assembled prompt contains no oo-command-runner reference`,
  );
}

// #1031 — the codemode module's token budget: the ≤60-line cap is asserted on
// the SOURCE file (build.sh concatenates agents-base + module bodies, so the
// assembled prompt is far larger than 60 lines regardless).
{
  const source = readFileSync(path.join(ROOT, CODEMODE_MODULE), "utf8");
  const lineCount = source.split("\n").length;
  assert(
    lineCount <= 60,
    `modules/core/codemode.md is within the 60-line cap (currently ${lineCount} lines)`,
  );
  const heading = source.match(/^#{1,6} .+$/m)?.[0];
  assert(heading !== undefined, "modules/core/codemode.md has a markdown heading");
  assert(
    heading === "# Codemode",
    "modules/core/codemode.md first heading is exactly '# Codemode'",
  );
}

// #1031 — the two script paths the codemode module names must exist, and
// verify-loop.sh must actually support the `--digest` mode the module
// describes, so the module can't reference tools that drift away.
for (const rel of [
  "extension/smoke-tests/lib/verify-loop.sh",
  "extension/smoke-tests/lib/ci-log-digest.sh",
]) {
  let content = "";
  try {
    content = readFileSync(path.join(ROOT, rel), "utf8");
  } catch {
    assert(false, `${rel}: file exists (named by modules/core/codemode.md)`);
    continue;
  }
  if (rel.endsWith("verify-loop.sh")) {
    assert(
      content.includes("--digest"),
      "extension/smoke-tests/lib/verify-loop.sh supports the `--digest` mode named by the codemode module",
    );
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
