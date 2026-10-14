#!/usr/bin/env bun
/**
 * Provisioning must not report a fault for a project with nothing to link,
 * and `hook-failed` must mean the hook's exit status.
 *
 * The live shape: a repo whose only manifest is `console/Cargo.toml`, with a
 * `.pi/worktree-setup` that exits 0. Rust has no linkable tree (`target/` is
 * never shared), yet the cycle recorded `outcome: "hook-failed"` with "the
 * project expects dependencies here", and the sentence was traced twice —
 * while the gate ran green in that same worktree.
 *
 * Real temp repos, real git, the hook run by a real `sh`. Separate file from
 * test-worktree-provision.ts, which sits at its line budget (AGENTS.md §12).
 */
import { exec } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

// `trace` reads the flag at import time, so it is set before the modules load.
process.env.PI_ENSEMBLE_DEBUG = "1";
const { provisionWorktree } = await import("../src/worktree-provision.ts");
const { makeWorktreeProvisionedEvent } = await import("../src/workflow-state-events-provision.ts");
const { provisionDepsHint } = await import("../src/work-driver-deps-hint.ts");
type WorkState = import("../src/workflow-state.ts").WorkState;

const pexec = promisify(exec);
let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** Everything real, including `sh <hook>` — the exit status is the subject. */
const liveExec = (cmd: string, opts: { cwd?: string; maxBuffer?: number }) =>
  pexec(cmd, { cwd: opts.cwd, maxBuffer: opts.maxBuffer ?? 64 * 1024 }).then((r) => ({
    stdout: r.stdout,
  }));

/** A committed repo with the given files; `hook` writes `.pi/worktree-setup`. */
async function repo(files: Record<string, string>, hook?: string) {
  const root = mkdtempSync(path.join(tmpdir(), "wt-outcome-"));
  const all = { ".gitignore": "node_modules/\ntarget/\n", ...files };
  if (hook !== undefined) Object.assign(all, { ".pi/worktree-setup": hook });
  for (const [rel, content] of Object.entries(all)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
  const git = (args: string) => pexec(`git ${args}`, { cwd: root });
  await git("init -q");
  await git("-c user.email=t@example.com -c user.name=t add -A");
  await git("-c user.email=t@example.com -c user.name=t commit -q -m init");
  const wt = path.join(root, ".worktrees", "w");
  mkdirSync(wt, { recursive: true });
  return { root, wt };
}

/** Provision, returning the result, its event, and what was traced meanwhile. */
async function provision(root: string, wt: string) {
  const traced: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    traced.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await provisionWorktree(liveExec, root, wt);
    const event = makeWorktreeProvisionedEvent(
      "default",
      wt,
      result.via,
      result.problem,
      result.hookFailed,
    );
    return { result, event, traced };
  } finally {
    process.stderr.write = realWrite;
  }
}

const CARGO = { "console/Cargo.toml": '[package]\nname = "c"\n', "console/Cargo.lock": "" };
const NODE = {
  "package.json": '{"name":"x","dependencies":{"left-pad":"1.3.0"}}\n',
  "package-lock.json": '{"lockfileVersion":3,"packages":{"node_modules/left-pad":{}}}\n',
};

// ---------------------------- a Cargo-only repo with a hook: the reported shape
{
  const { root, wt } = await repo(CARGO, "#!/bin/sh\nexit 0\n");
  try {
    const { result, event, traced } = await provision(root, wt);
    assert(result.via === "hook", "Cargo-only + hook: the hook ran");
    assert(
      result.problem === undefined,
      `Cargo-only + hook: no problem — Rust has no linkable tree to be missing (got: ${result.problem})`,
    );
    assert(event.outcome === "hook-ran", `Cargo-only + hook: recorded hook-ran (got ${event.outcome})`);
    assert(
      !traced.some((l) => l.includes("expects dependencies")),
      "Cargo-only + hook: nothing is traced about expected dependencies",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ------------------------------------------------- a Cargo-only repo, no hook
{
  const { root, wt } = await repo(CARGO);
  try {
    const { result, event } = await provision(root, wt);
    assert(
      result.problem === undefined,
      `Cargo-only, no hook: no problem (got: ${result.problem})`,
    );
    assert(
      event.outcome === "none" && event.problem === undefined,
      "Cargo-only, no hook: `none` with no problem — nothing to link is not a failure",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------- #481 survives: a Node repo with a lockfile and no node_modules
{
  const { root, wt } = await repo(NODE);
  try {
    const { result, event } = await provision(root, wt);
    assert(
      result.problem?.includes("no dependency tree") === true,
      "Node + lockfile, no node_modules, no hook: the #481 problem is still raised",
    );
    assert(event.outcome === "none" && event.problem !== undefined, "...and recorded on `none`");
    const hint = provisionDepsHint({ eventLog: [event] } as unknown as WorkState, wt);
    assert(
      hint.includes("no usable dependency directory") && hint.includes("no dependency tree"),
      "...and the missing-deps hint still names it",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ------- a hook that exits 0 over a Node repo with no tree: a problem, not a failure
{
  const { root, wt } = await repo(NODE, "#!/bin/sh\nexit 0\n");
  try {
    const { result, event, traced } = await provision(root, wt);
    assert(
      result.problem?.includes("no non-empty dependency source") === true,
      "Node + hook exiting 0, no tree: the #765 problem is still raised",
    );
    assert(
      event.outcome === "hook-ran",
      `...but a hook that exited 0 is NOT recorded as hook-failed (got ${event.outcome})`,
    );
    assert(event.problem === result.problem, "...and the event still carries the problem");
    assert(
      !traced.some((l) => l.includes("no non-empty dependency source")),
      "...and provisioning does not trace the sentence itself — the caller traces it, once",
    );
    const hint = provisionDepsHint({ eventLog: [event] } as unknown as WorkState, wt);
    assert(
      hint.includes("hook succeeded") && hint.includes("no non-empty dependency source"),
      "...and the missing-deps hint says the hook ran and why the tree is missing",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --------------------------------------- a hook that exits non-zero IS hook-failed
{
  const { root, wt } = await repo(CARGO, "#!/bin/sh\nexit 3\n");
  try {
    const { result, event } = await provision(root, wt);
    assert(result.hookFailed === true, "hook exiting 3: flagged as a failed hook");
    assert(
      event.outcome === "hook-failed" && event.problem?.includes("failed") === true,
      `hook exiting 3: recorded hook-failed with the exit message (got ${event.outcome})`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
