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
 *   1. the shared executor (exec.ts) and the other argv-aware executors really
 *      run the argv form;
 *   2. no bare `promisify(exec)` outside the shared executor and the one
 *      documented shell-only seam (work-driver-merged-mechanized.ts);
 *   3. the incident itself: the develop gate's consolidated verify, on its
 *      PRODUCTION default executor, preserves the state it discards.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execTree } from "../src/exec-tree.ts";
import { execp as sharedExecp } from "../src/exec.ts";
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

/** Files allowed one bare `promisify(exec)`: the shared executor, and the shell-only seam. */
const BARE_EXEC_OWNERS = new Set(["exec.ts", "work-driver-merged-mechanized.ts"]);

/**
 * A bare `promisify(exec)` (or its `execCb` alias, or a namespaced
 * `promisify(child_process.exec)` / `promisify(cp.exec)`) in code — comments and prose excluded.
 */
const BARE_EXEC = /\bpromisify\(\s*(?:[A-Za-z_$][\w$]*\.)?exec(?:Cb)?\s*\)/;

function bareExecLines(source: string): number {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line) && BARE_EXEC.test(line)).length;
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
    "execp (exec.ts)": sharedExecp,
    "execTree (exec-tree.ts)": execTree,
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

  // ------------------------- 2. one shell-only seam: no other bare promisify(exec)
  const offenders = sourceFiles(SRC)
    .filter((f) => !BARE_EXEC_OWNERS.has(path.basename(f)))
    .filter((f) => bareExecLines(readFileSync(f, "utf8")) > 0)
    .map((f) => path.relative(SRC, f));
  assert(
    offenders.length === 0,
    `no bare promisify(exec) outside exec.ts and the shell-only seam in work-driver-merged-mechanized.ts (offenders: ${offenders.join(", ") || "none"})`,
  );
  assert(
    bareExecLines(
      "const execp = promisify(exec);\n// promisify(exec) in prose\n* promisify(exec)\nconst f = promisify(execFile);",
    ) === 1,
    "the check counts a code use of promisify(exec) and nothing else (comments, prose and execFile are not counted)",
  );
  assert(
    bareExecLines("const e = promisify(child_process.exec);") === 1,
    "the check also counts a namespaced promisify(child_process.exec)",
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
