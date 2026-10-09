#!/usr/bin/env bun
/**
 * #1015 — the git-state line wired through startJob / startBatch.
 *
 * Proves the line is computed from the dispatch cwd (never process.cwd()),
 * reaches developer/ops members only, survives a killed developer, and is
 * per-member in a batch.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBatch, startJob } from "../src/async-jobs.ts";
import type { DispatchResult } from "../src/types.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });

function mkRepo(dirty: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "git-state-dispatch-"));
  git(dir, "init", "-q");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "i");
  if (dirty) writeFileSync(join(dir, "zz-dirty-marker.txt"), "x");
  return dir;
}

// biome-ignore lint/suspicious/noExplicitAny: testing seam — minimum pi shape.
function makePi() {
  const inbox: Array<{ content: string; deliverAs?: string }> = [];
  // biome-ignore lint/suspicious/noExplicitAny: testing seam
  const pi: any = {
    sendUserMessage(content: string, options?: { deliverAs?: string }) {
      inbox.push({ content, deliverAs: options?.deliverAs });
    },
  };
  return { pi, inbox };
}

function result(role: string, extra: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role,
    ok: true,
    text: `${role} done.`,
    toolUses: [],
    ms: 10,
    exitCode: 0,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 1,
    },
    transcriptPath: "/tmp/fake.json",
    ...extra,
  } as DispatchResult;
}

async function waitFor(inbox: unknown[], n: number) {
  for (let i = 0; i < 200 && inbox.length < n; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

// 1. startJob: developer with a dirty temp cwd → line reflects the temp repo,
//    not process.cwd() (which is the worktree, not the marker file).
{
  const dir = mkRepo(true);
  const { pi, inbox } = makePi();
  startJob(pi, {
    label: "developer",
    role: "developer",
    cwd: dir,
    work: async () => result("developer"),
  });
  await waitFor(inbox, 1);
  assert(inbox.length === 1, "startJob delivers one report");
  assert(
    inbox[0]?.content.includes("1 uncommitted/untracked (zz-dirty-marker.txt)"),
    `developer line computed from dispatch cwd (got: ${inbox[0]?.content.slice(0, 400)})`,
  );
}

// 2. startJob: explore gets no line even with a dirty cwd.
{
  const dir = mkRepo(true);
  const { pi, inbox } = makePi();
  startJob(pi, {
    label: "explore",
    role: "explore",
    cwd: dir,
    work: async () => result("explore"),
  });
  await waitFor(inbox, 1);
  assert(inbox.length === 1 && !inbox[0]?.content.includes("git state"), "explore gets no line");
}

// 3. startJob: killed developer (inactivity) still annotated.
{
  const dir = mkRepo(true);
  const { pi, inbox } = makePi();
  startJob(pi, {
    label: "developer",
    role: "developer",
    cwd: dir,
    work: async () =>
      result("developer", {
        ok: false,
        exitCode: 1,
        killCause: "inactivity",
      } as Partial<DispatchResult>),
  });
  await waitFor(inbox, 1);
  assert(
    inbox.length === 1 && inbox[0]?.content.includes("zz-dirty-marker.txt"),
    "killed developer still carries the git-state line",
  );
}

// 4. startBatch: two developers (dirty + clean repo), one explore, one killed ops.
{
  const dirty = mkRepo(true);
  const clean = mkRepo(false);
  const { pi, inbox } = makePi();
  startBatch(pi, {
    batchLabel: "git-batch",
    members: [
      {
        label: "developer[dirty]",
        role: "developer",
        cwd: dirty,
        work: async () => result("developer"),
      },
      {
        label: "developer[clean]",
        role: "developer",
        cwd: clean,
        work: async () => result("developer"),
      },
      {
        label: "explore",
        role: "explore",
        cwd: dirty,
        work: async () => result("explore"),
      },
      {
        label: "ops",
        role: "ops",
        cwd: dirty,
        work: async () =>
          result("ops", {
            ok: false,
            exitCode: 1,
            killCause: "inactivity",
          } as Partial<DispatchResult>),
      },
    ],
  });
  await waitFor(inbox, 1);
  const body = inbox[0]?.content ?? "";
  const section = (label: string) => {
    const start = body.indexOf(`=== ${label} `);
    const next = body.indexOf("\n=== ", start + 1);
    return start < 0 ? "" : body.slice(start, next < 0 ? undefined : next);
  };
  assert(inbox.length === 1, "batch delivers one consolidated report");
  assert(
    section("developer[dirty]").includes("1 uncommitted/untracked (zz-dirty-marker.txt)"),
    "dirty developer section carries its own line",
  );
  assert(
    section("developer[clean]").includes("git state (at report time): clean"),
    "clean developer section reads clean (its own cwd)",
  );
  assert(!section("explore").includes("git state"), "explore section has no line");
  assert(
    section("ops").includes("zz-dirty-marker.txt"),
    "killed ops section still carries the line",
  );
}

process.exit(exit);
