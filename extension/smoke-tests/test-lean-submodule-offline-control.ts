#!/usr/bin/env bun
/**
 * Red control for #2319's no-network claim, written against the operator's field report:
 * the recorded URL is UNREACHABLE, the parent (superproject) checkout already holds the
 * submodule's files, and worktree preparation must succeed without a network call.
 *
 * "Prep succeeds" is not accepted on the step's word. After it returns:
 *   - the submodule's committed file stands in the run's tree;
 *   - the run's origin is a path inside the superproject, never the recorded URL;
 *   - no fetch, clone, ls-remote or pull ran anywhere during prep;
 *   - the run's tree holds the bytes the PARENT holds, byte for byte.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { ensureSpecifyWorktreeWithProvision } from "../src/lean/specify-tree.ts";
import type { ExecFn } from "../src/worktree.ts";
import { INSIDE, SUB, gitIn, repoWithSubmodule } from "./lib/lean-submodule-local-fixture.ts";
import { UNREACHABLE_URL } from "./lib/lean-submodule-local-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`\u2713 ${msg}`);
  else {
    console.error(`\u2717 ${msg}`);
    exit = 1;
  }
}

/** Any argv that would leave the machine. `clone` is git's own word for a submodule populate. */
const NETWORK = ["fetch", "clone", "ls-remote", "pull", "push"];
const NETWORK_SHAPED = (argv: readonly string[]): boolean =>
  argv.some((a) => NETWORK.includes(a)) ||
  argv.some((a) => /^https?:\/\//.test(a) || /^git@/.test(a));

const { repoRoot, baseSha } = repoWithSubmodule("offline-control");

// The operator's situation, three facts at once.
assert(
  readFileSync(path.join(repoRoot, ".gitmodules"), "utf8").includes(UNREACHABLE_URL),
  "control: the recorded URL is the unreachable one, not a local mount",
);
assert(
  existsSync(path.join(repoRoot, INSIDE)),
  "control: the PARENT checkout holds the submodule's file — this is the field report's shape",
);

const argvs: string[][] = [];
const network: string[][] = [];
const exec: ExecFn = async (cmd, o) => {
  const argv = (o?.argv ?? []) as string[];
  argvs.push(argv);
  if (cmd === "git" && NETWORK_SHAPED(argv)) network.push(argv);
  // A synchronously refused URL, never a blackholed one: the sabotage has to be observable
  // rather than slow, so a step that reached for the recorded URL fails in milliseconds.
  if (cmd === "git" && argv.join(" ").includes("example.invalid"))
    return { stdout: "", stderr: `fatal: unable to access ${UNREACHABLE_URL}: Could not resolve host`, exitCode: 128 } as never;
  const { execp } = await import("../src/exec.ts");
  return execp(cmd, o);
};

const issue = 1;
let problem: string | undefined;
let threw: Error | undefined;
let wt = "";
try {
  const r = await ensureSpecifyWorktreeWithProvision(exec, {
    repoRoot,
    issue,
    fromRef: baseSha,
    branch: `lean/issue-${issue}`,
  });
  wt = r.wt;
  problem = r.problem;
} catch (err) {
  threw = err as Error;
}

assert(threw === undefined, `prep SUCCEEDS over an unreachable URL (${threw?.message?.slice(0, 200) ?? "no throw"})`);
assert(problem === undefined, `and says nothing about a submodule it did supply (got ${String(problem)})`);
assert(
  existsSync(path.join(wt, INSIDE)),
  `the run's tree holds the submodule's committed file (wt=${wt})`,
);
assert(
  readFileSync(path.join(wt, INSIDE), "utf8") === readFileSync(path.join(repoRoot, INSIDE), "utf8"),
  "and byte for byte what the PARENT checkout holds",
);
assert(network.length === 0, `no network-shaped argv ran during prep (got ${JSON.stringify(network)})`);

const origin = gitIn(path.join(wt, SUB), "remote", "get-url", "origin");
assert(
  origin.startsWith(repoRoot) || origin.startsWith(path.join(repoRoot, ".git")),
  `the seeded submodule's origin is inside the superproject, not the recorded URL (got ${origin})`,
);
assert(!origin.includes("example.invalid"), "and names no part of the URL the base records");

// The control's own teeth: had the seeding reached for the recorded URL, the sabotage above
// would have been exercised, and a suite that never trips its own trap is not a control.
assert(
  argvs.some((a) => a.includes("submodule") && a.includes("update")),
  "the step did issue its populating call, so the run is not passing by doing nothing",
);

rmSync(repoRoot, { recursive: true, force: true });
process.exit(exit);
