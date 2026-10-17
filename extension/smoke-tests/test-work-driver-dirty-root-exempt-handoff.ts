#!/usr/bin/env bun
/**
 * #1362 fix round — an unreadable `.pi/dirty-root-exempt` must be visible
 * beyond stderr.
 *
 * The settlement says a broken exemption file yields an empty list plus a
 * **trace**. That is right for a clean cycle and wrong for the one shape that
 * matters: the cycle then blocks on repo-root residue, and the handoff the
 * operator reads says "your repo root is dirty — here are the paths", with no
 * hint that the file which would have exempted them failed to load. Every path
 * in that list was judged against an EMPTY list. `traceWarn` writes to stderr,
 * which is not the artifact anybody reads, so the failure is recorded as a
 * `plumb-report` — the kind the handoff already renders — and the branch step's
 * residue report names it in its own body.
 *
 * Three assertions, all against the production renderers:
 *
 *   1. `runBranch` on a fixture whose exemption file cannot be read: the block
 *      still fires (a broken config never unblocks the gate it should not
 *      exempt), and the plumb report the handoff renders carries "the exemption
 *      file could not be read".
 *   2. The same fixture WITHOUT the read failure: the report is the ordinary
 *      residue report, so the sentence is not decoration pasted onto every
 *      block.
 *   3. The event goes through the real handoff markdown, not just the state
 *      file — a record no renderer reads is invisible in the same way a trace
 *      on stderr is.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DispatchResult } from "../src/types.ts";
import { runBranch } from "../src/work-driver-branch-develop.ts";
import type { CycleContext } from "../src/work-driver-context.ts";
import {
  DIRTY_ROOT_EXEMPT_FILE,
  dirtyRootExemptReadEvent,
  dirtyRootExemptReadNotice,
} from "../src/work-driver-dirty-root-exempt.ts";
import { createEmitSink } from "../src/work-state-emit.ts";
import type { WorkState } from "../src/workflow-state.ts";
import type { ExecFn } from "../src/worktree.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";

const execFileP = promisify(execFile);

// #1145 — fixture repos read no host git config; see lib/git-test-env.ts. The
// bare call is the one entry point: its first call also writes the four levers
// ambiently, which is what the in-process production seam reads.
gitTestEnv();

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_RESUME = "0";
process.env.PI_ENSEMBLE_PR_PREFLIGHT = "0";

const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd, env: gitTestEnv() });

/** Real shell exec with `gh`/fetch stubbed, as the sibling branch tests use. */
function branchExec(): ExecFn {
  return async (cmd, o) => {
    if (cmd.startsWith("gh ")) return { stdout: "" };
    if (cmd.startsWith("git fetch")) return { stdout: "" };
    const [file, args] = o?.argv ? [cmd, o.argv] : ["/bin/sh", ["-c", cmd]];
    const { stdout } = await execFileP(file, args, {
      env: gitTestEnv(),
      cwd: o?.cwd,
      maxBuffer: o?.maxBuffer ?? 8 * 1024 * 1024,
    });
    return { stdout };
  };
}

function branchCtx(repo: string, execFn: ExecFn, readFailed?: string) {
  return {
    host: {} as unknown as never,
    issue: 1362,
    issues: [1362],
    restart: false,
    repoRoot: repo,
    model: undefined,
    labelOverride: undefined,
    verifyExecFn: execFn,
    dispatchFn: async (): Promise<DispatchResult> => ({
      role: "ops",
      ok: true,
      text: "noop",
      toolUses: [],
      ms: 0,
      exitCode: 0,
    }),
    // The list is EMPTY here on purpose: an unreadable file yields the empty
    // list, and that is precisely what makes the residue look like residue.
    dirtyRootExempt: [],
    dirtyRootExemptReadFailed: readFailed,
    emitSink: createEmitSink(() => undefined),
  } as unknown as CycleContext;
}

async function makeRepo(repo: string): Promise<void> {
  mkdirSync(repo, { recursive: true });
  await git(repo, ["init", "-q", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  writeFileSync(path.join(repo, "a.txt"), "base\n");
  await git(repo, ["add", "a.txt"]);
  await git(repo, ["commit", "-q", "-m", "base"]);
}

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1362-handoff-"));

try {
  // ---- 1. unreadable exemption + residue: the block says WHY --------------
  {
    const repoPath = path.join(root, "unreadable");
    await makeRepo(repoPath);
    // A stray the project would have exempted, plus a config that cannot be
    // read (a directory left in the file's place — EISDIR, not ENOENT).
    mkdirSync(path.join(repoPath, ".claude"), { recursive: true });
    writeFileSync(path.join(repoPath, ".claude", "settings.local.json"), "{}\n");
    mkdirSync(path.join(repoPath, ".pi"), { recursive: true });
    mkdirSync(path.join(repoPath, DIRTY_ROOT_EXEMPT_FILE), { recursive: true });

    const out = await runBranch(
      branchCtx(repoPath, branchExec(), "EISDIR: .pi/dirty-root-exempt at some/repo"),
      (await import("../src/workflow-state.ts")).initialState(1362),
      1000,
    ).catch((e) => {
      console.error(`runBranch (#1362 handoff) threw: ${(e as Error).message}`);
      return undefined;
    });

    assert(out !== undefined, "#1362 handoff: the branch step ran and returned a state");
    const reports = (out?.eventLog ?? []).filter((e) => e.kind === "plumb-report");
    const bodies = reports.map((e) => (e as { body: string }).body).join("\n");
    assert(
      out?.eventLog.some((e) => e.kind === "cap-hit" && e.cap === "repo-root-residue") === true,
      "#1362 handoff: an unreadable exemption file does NOT unblock the residue gate (the empty list still judges every path)",
    );
    assert(
      bodies.includes("the exemption file could not be read"),
      `#1362 handoff: the residue plumb report names the unreadable exemption file (bodies: ${JSON.stringify(bodies.slice(0, 400))})`,
    );
    assert(
      bodies.includes("EISDIR"),
      "#1362 handoff: the report carries the read error, so the operator can tell EISDIR from EACCES",
    );
    assert(
      bodies.includes(".claude/settings.local.json"),
      "#1362 handoff: the report still names the path that blocked, beside the reason it was not exempted",
    );

    // ---- 3. the event reaches the real handoff markdown -------------------
    // `plumbReportSection` renders the event's own `body`, which is the string
    // the branch step built, so the markdown can only differ from it by
    // dropping the section. Asserted on a state carrying exactly the events the
    // branch step recorded — the fixture's dispatch noise would otherwise fill
    // the verdict table with rows this check is not about.
    const { renderHandoffMarkdown } = await import("../src/work-driver-handoff-markdown.ts");
    const { withDirtyRootExemptReadFailure } = await import(
      "../src/work-driver-dirty-root-exempt-notice.ts"
    );
    const reason = "EISDIR: .pi/dirty-root-exempt at some/repo";
    const carried = withDirtyRootExemptReadFailure({ ...(out as WorkState), eventLog: [] }, reason);
    const md = renderHandoffMarkdown(carried);
    assert(
      (carried.pipelineState.plumbReports ?? []).some((r) =>
        r.body.startsWith("the exemption file could not be read:"),
      ),
      "#1362 handoff: the record lands on pipelineState.plumbReports, which is the field plumbReportSection reads",
    );
    assert(
      carried.eventLog.some(
        (e) =>
          e.kind === "plumb-report" && e.body.startsWith("the exemption file could not be read:"),
      ),
      "#1362 handoff: the same record is an event, so /work-status and event-log readers see it",
    );
    assert(
      withDirtyRootExemptReadFailure(carried, reason) === carried,
      "#1362 handoff: recording it twice changes nothing (a resumed cycle does not accumulate copies)",
    );
    assert(
      md.includes("the exemption file could not be read"),
      "#1362 handoff: the rendered handoff body carries the sentence, not just the state file",
    );
    assert(md.includes("EISDIR"), "#1362 handoff: the rendered body carries the read error too");
  }

  // ---- 2. the ordinary block is untouched ---------------------------------
  {
    const repoPath = path.join(root, "readable");
    await makeRepo(repoPath);
    mkdirSync(path.join(repoPath, ".claude"), { recursive: true });
    writeFileSync(path.join(repoPath, ".claude", "settings.local.json"), "{}\n");

    const out = await runBranch(
      branchCtx(repoPath, branchExec()),
      (await import("../src/workflow-state.ts")).initialState(1362),
      1000,
    ).catch(() => undefined);

    const bodies = (out?.eventLog ?? [])
      .filter((e) => e.kind === "plumb-report")
      .map((e) => (e as { body: string }).body)
      .join("\n");
    assert(
      out?.eventLog.some((e) => e.kind === "cap-hit" && e.cap === "repo-root-residue") === true,
      "#1362 handoff: the no-config residue block still fires",
    );
    assert(
      !bodies.includes("the exemption file could not be read"),
      "#1362 handoff: with a readable (or absent) config the report says nothing about one",
    );
  }

  // ---- 4. the event is the existing kind, with the settled wording --------
  {
    const ev = dirtyRootExemptReadEvent("EACCES: permission denied");
    assert(
      ev.kind === "plumb-report" && ev.step === "branch" && ev.role === "driver",
      `#1362 handoff: recorded as a plumb-report (no new event kind to disturb nextStep's tail routing): ${JSON.stringify([ev.kind, ev.step, ev.role])}`,
    );
    assert(
      dirtyRootExemptReadNotice("EACCES: permission denied").startsWith(
        "the exemption file could not be read:",
      ),
      "#1362 handoff: the notice leads with the settled wording the brief asks for",
    );
    assert(
      dirtyRootExemptReadNotice("EACCES: permission denied").includes(DIRTY_ROOT_EXEMPT_FILE),
      "#1362 handoff: the notice names the file to fix, so the operator is not left guessing",
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
