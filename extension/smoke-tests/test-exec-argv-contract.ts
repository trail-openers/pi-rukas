#!/usr/bin/env bun
/**
 * The argv contract of the driver's executors (#1279).
 *
 * The driver's `ExecFn` declares an argv form — `execFn("git", { cwd, argv:
 * ["status", "--porcelain"] })` — and `promisify(exec)` type-checks as one
 * while silently dropping `argv`. A module whose default executor was
 * shell-only therefore ran a bare `git` for every argv-form call it reached:
 * usage text on stdout, exit 1, empty stderr, reported as `Command failed:
 * git`. The consolidated verify's state capture failed that way on every
 * cycle, and so did the merged step's checkout restore.
 *
 * Three checks:
 *   1. every exported production executor really runs the argv form;
 *   2. no module hands a bare `promisify(exec)` on as a value — it may only
 *      be CALLED, or serve a seam listed below whose type has no argv form.
 *      The scan is also run against a fixture, so it is seen to fail;
 *   3. the incident itself: the develop gate's consolidated verify, on its
 *      PRODUCTION default executor, preserves the state it discards.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execTree } from "../src/exec-tree.ts";
import { execp as lensExecp } from "../src/lens-exec.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { execp as verifyExecp, verifyStepOutcome } from "../src/work-driver-verify.ts";
import { initialState } from "../src/workflow-state.ts";
import { commitIn, fixture } from "./test-work-driver-verify-consolidated.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const SRC = path.join(import.meta.dir, "..", "src");

/**
 * Modules whose bare `promisify(exec)` is handed on as a value, with why that
 * cannot reach an argv-form call: each serves a seam type that declares no
 * `argv`, so a consumer cannot pass one without a type error — bar the last
 * entry, which says why it is listed anyway.
 */
const SHELL_ONLY_SEAMS: Record<string, string> = {
  "forge-detect.ts": "its own seam is `typeof execp`: shell strings only",
  "forge.ts": "ForgeExecFn has no argv form",
  "work-driver-explore.ts": "IssueBodyExec has no argv form",
  "work-driver-adversarial-fix-git.ts":
    "FixExec serves the fix pass's shell-string reads; its develop checks get the argv-aware executor",
  // The one entry typed as the driver's argv-declaring executor. It reaches
  // only forge reads and the merge command, all shell strings, and
  // test-merge-guard.ts pins this module's direct `exec` import as its
  // in-process-merge canary. An argv-form call added on this path needs the
  // argv-aware executor first.
  "work-driver-merged-mechanized.ts": "forge reads and the merge command only: shell strings",
};

/** Every place `source` hands a bare `promisify(exec)` on instead of calling it. */
function shellOnlyEscapes(source: string): string[] {
  const escapes: string[] = [];
  const lines = source.split("\n");
  const defRe = /\b(?:const|let)\s+(\w+)(?::\s*[\w.]+)?\s*=\s*promisify\(\s*exec\w*\s*\)/g;
  for (const def of source.matchAll(defRe)) {
    const use = new RegExp(`(?<!typeof\\s)\\b${def[1]}\\b(?!\\s*\\()`);
    lines.forEach((line, i) => {
      // String contents are prose, not uses ("refusing shell interpolation").
      const code = line.trim().replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
      if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
      // An import binds a name; it hands nothing on.
      if (code.startsWith("import ")) return;
      if (/=\s*promisify\(/.test(code)) return;
      if (use.test(code)) escapes.push(`${i + 1}: ${code}`);
    });
  }
  return escapes;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sourceFiles(path.join(dir, e.name))
      : e.name.endsWith(".ts")
        ? [path.join(dir, e.name)]
        : [],
  );
}

async function main() {
  // ------------------------------------------------- 1. executors honour argv
  const executors = {
    "execTree (exec-tree.ts)": execTree,
    "execp (lens-exec.ts)": lensExecp,
    "execp (work-driver-verify.ts)": verifyExecp,
  };
  for (const [name, run] of Object.entries(executors)) {
    const version = await run("git", { argv: ["--version"] }).catch((e: Error) => ({
      stdout: `REJECTED ${e.message}`,
    }));
    assert(
      version.stdout.startsWith("git version"),
      `${name}: the argv form runs \`git --version\` (got: ${version.stdout.slice(0, 60).trim()})`,
    );
    const literal = await run("echo", { argv: ["$(echo injected)"] });
    assert(
      literal.stdout.trim() === "$(echo injected)",
      `${name}: an argv element is data, never shell syntax (got: ${literal.stdout.trim()})`,
    );
    const shell = await run("echo one && echo two");
    assert(/one\s+two/.test(shell.stdout), `${name}: the shell-string form still runs a shell`);
  }
  const failure = await execTree("git", { argv: ["rev-parse", "--verify", "no-such-ref-32"] }).then(
    () => undefined,
    (e: Error & { stderr?: string; cmd?: string }) => e,
  );
  assert(
    failure?.cmd === "git rev-parse --verify no-such-ref-32" &&
      failure.message.includes("git rev-parse --verify no-such-ref-32") &&
      (failure.stderr ?? "").trim().length > 0,
    `execTree: an argv-form failure names the whole command and carries stderr (got: ${failure?.message.slice(0, 80)})`,
  );

  // ------------------------------------ 2. no shell-only executor is handed on
  const offenders: string[] = [];
  const seen = new Set<string>();
  for (const file of sourceFiles(SRC)) {
    const rel = path.relative(SRC, file);
    const escapes = shellOnlyEscapes(readFileSync(file, "utf8"));
    if (escapes.length === 0) continue;
    seen.add(rel);
    if (!(rel in SHELL_ONLY_SEAMS)) offenders.push(...escapes.map((e) => `${rel}:${e}`));
  }
  assert(
    offenders.length === 0,
    `no module hands a bare promisify(exec) on as a value — use execp from lens-exec.ts (offenders: ${offenders.join(" | ") || "none"})`,
  );
  const dead = Object.keys(SHELL_ONLY_SEAMS).filter((f) => !seen.has(f));
  assert(
    dead.length === 0,
    `every listed shell-only seam still exists (stale: ${dead.join(", ") || "none"})`,
  );
  // The scan in the failing direction: the shapes the tree had before #1279.
  const fixtureSource = [
    "const execp = promisify(exec);",
    "const defaultExecFn: ExecFn = promisify(exec) as unknown as ExecFn;",
    "const a = ctx.verifyExecFn ?? execp;",
    "await helper(execp, repoRoot);",
    "const { execFn = defaultExecFn } = opts;",
    "// execp is fine in a comment",
    "type Seam = typeof execp;",
    'await execp("git status", { cwd });',
  ].join("\n");
  const caught = shellOnlyEscapes(fixtureSource);
  assert(
    caught.length === 3 && caught.every((c) => /^[345]:/.test(c)),
    `the scan catches a fallback, an argument and a default — and nothing else (got: ${caught.join(" | ")})`,
  );

  // ---------------- 3. the incident: consolidated verify on the default executor
  const root = mkdtempSync(path.join(tmpdir(), "pi-ens-32-"));
  try {
    const f = await fixture(root, "conflict", ["a", "b"], { "shared.txt": "line1\nline2\n" });
    writeFileSync(path.join(f.worktrees.a, "shared.txt"), "line1\nA says hi\n");
    await commitIn(f.worktrees.a, "task-a: edit line2");
    writeFileSync(path.join(f.worktrees.b, "shared.txt"), "line1\nB says hi\n");
    await commitIn(f.worktrees.b, "task-b: edit line2");
    writeFileSync(path.join(f.repo, ".pi", "verify-cmd"), "true\n");
    const s0 = initialState(32, 1_000_000);
    const state = {
      ...s0,
      pipelineState: {
        ...s0.pipelineState,
        branchName: "feature/issue-32",
        baseSha: f.baseSha,
        worktrees: f.worktrees,
        workstreams: {
          a: { id: "a", scope: "edit line2 A", paths: [], outOfScope: [] },
          b: { id: "b", scope: "edit line2 B", paths: [], outOfScope: [] },
        },
      },
    };
    // No `verifyExecFn`: the gate falls back to its production default.
    const ctx: DriverContext = {
      host: { sendUserMessage: () => {} } as unknown as ExtensionAPI,
      repoRoot: f.repo,
      issue: 32,
    };
    const gate = await verifyStepOutcome(ctx, state, "develop");
    assert(!gate.ok, "the conflicting workstreams fail the develop gate");
    const scratch = path.join(f.repo, "tmp", "issue-32");
    // A failed capture creates nothing, not even the scratch directory.
    const preserved = existsSync(scratch)
      ? readdirSync(scratch).filter((n) => n.startsWith("restored-state-"))
      : [];
    assert(
      preserved.length === 1,
      `the production default executor preserved the discarded state (files: ${preserved.join(", ") || "none"})`,
    );
    const body = preserved[0] ? readFileSync(path.join(scratch, preserved[0]), "utf8") : "";
    assert(
      body.includes("shared.txt") && body.includes("A says hi") && body.includes("B says hi"),
      "the preserved file holds the conflicted path and both sides of it",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

await main();
console.log(`\nexit ${exit}`);
process.exit(exit);
