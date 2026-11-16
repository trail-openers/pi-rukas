/**
 * lib/lean-spec-intake-post-fixture — the rig for the derived contract's POST
 * counts (`test-lean-spec-intake-post.ts`), kept out of the case file so neither
 * crosses AGENTS.md §12's line cap.
 *
 * Nothing here asserts. The rig drives the REAL `ready` handler over a real git
 * repo and stubs only the outside calls the step makes — the issue read, the
 * config read at the base, and the one deriving child — plus the post seam that
 * counts what left the process.
 *
 * The seams are `ready`'s own `ReadyDeps` argument rather than a replaced
 * handler: `phase1Handlers` builds the handler set, and a case that swapped the
 * `ready` handler wholesale would be judging its own stub.
 *
 * `gh` is stubbed on PATH because the issue read falls through to the raw `gh`
 * call when `PI_ENSEMBLE_FORGE=none` refuses the adapter, and the same script
 * records every `issue comment` argv. Two witnesses, then: the in-process post
 * seam and the forge's own log. A zero that meant "the recorder was bypassed"
 * would show up as a non-empty forge log.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type ReadyDeps, phase1Handlers } from "../../src/lean/command.ts";
import type { WorkConfig } from "../../src/lean/config.ts";
import type { LeanHandlers } from "../../src/lean/engine.ts";
import { runLean } from "../../src/lean/engine.ts";
import { setLeanCommentPoster } from "../../src/lean/io.ts";
import { foldLog } from "../../src/lean/resume.ts";
import type { PiSpec } from "../../src/lean/spec.ts";
import { type LeanRun, createRun, leanStateFile } from "../../src/lean/state.ts";
import type { DispatchResult } from "../../src/types.ts";
import { withEnv } from "./env-scope.ts";
import { gitTestEnv } from "./git-test-env.ts";
import { worktreeCommit } from "./lean-spec-intake-fixtures.ts";

/** The prose ticket every case starts from: no `pi-spec v1` block anywhere. */
export const PROSE = "The engine should refuse a run whose frozen tests do not cover AC1.";

/** The contract the stubbed child drafts. Mutable, because `Step`'s outcome holds a
`PiSpec` and a `readonly` array is not assignable to one. */
export const DERIVED_SPEC: PiSpec = {
  problem: "frozen tests do not decide AC1",
  criteria: [
    { id: "AC1", text: "frozen tests cover AC1", verify: "test" },
    { id: "AC2", text: "an uncovered run is refused", verify: "test" },
  ],
  size: "S",
};

/** The child's reply: that contract, fenced as the brief tells it to answer. */
export const DERIVE_REPLY = [
  "Here is the contract.",
  "```pi-spec v1",
  JSON.stringify(DERIVED_SPEC, null, 2),
  "```",
].join("\n");

const CHILD_ROW: DispatchResult = {
  role: "explore",
  ok: true,
  text: DERIVE_REPLY,
  toolUses: [],
  ms: 1,
  exitCode: 0,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
};

const EMPTY_CONFIG: WorkConfig = { version: 1, autoMerge: false, verify: {}, budgets: {} };

/** Every state after `ready`: refused loudly, so a walk-on is a case bug, not a result. */
const AFTER_READY = [
  "specify",
  "build",
  "challenge",
  "verify",
  "publish",
  "review",
  "ci",
  "land",
] as const;

/** A `gh` stub that answers `issue view` and records every `issue comment` argv. */
function ghRecordingStub(dir: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "answer.json"),
    JSON.stringify({ title: "prose ticket", body, number: 700, state: "OPEN" }),
    "utf8",
  );
  writeFileSync(
    path.join(dir, "gh"),
    [
      "#!/bin/sh",
      'DIR="$(dirname "$0")"',
      'case "$*" in',
      '  *"issue comment"*) printf "%s\\n" "$*" >> "$DIR/comments.txt"; exit 0;;',
      '  *"issue edit"*) printf "%s\\n" "$*" >> "$DIR/edits.txt"; exit 0;;',
      '  *"issue view"*) cat "$DIR/answer.json"; exit 0;;',
      "  *) exit 0;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}

function linesOf(file: string): string[] {
  try {
    return readFileSync(file, "utf8").split("\n").filter((l) => l !== "");
  } catch {
    return [];
  }
}

/** A temp git repo whose base commit carries a `.pi/work.json`. */
function tempRepo(tag: string): { dir: string; base: string } {
  const dir = mkdtempSync(path.join(tmpdir(), `lean-intake-post-${tag}-`));
  const git = (args: string[]): void => {
    const r = spawnSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      env: { ...gitTestEnv(), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t" },
    });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr ?? ""}`);
  };
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  const base = worktreeCommit(dir, { ".pi/work.json": JSON.stringify({ version: 1 }) });
  return { dir, base };
}

/** The run every case drives. One number, so the planted record and the drive agree. */
const ISSUE = 700;

/**
 * Plant the record a crashed first pass left behind: `ready` DECIDED, carrying its
 * `derivedSpec`, with the contract on the run and the run sitting at `specify`.
 *
 * The snapshot is `foldLog`'s own answer for the log, never a hand-carried one: the
 * engine refuses a record whose snapshot disagrees with its log, and a fixture that
 * guessed the counters would fail the case for a reason the case is not about.
 */
function plantResumableRecord(repoRoot: string, baseSha: string): void {
  const derived = { spec: DERIVED_SPEC, model: "fixture-model", at: 1_600_000_000_000 };
  const steps = [
    {
      key: `${ISSUE}:ready:0`,
      state: "ready" as const,
      startedAt: 1,
      endedAt: 2,
      outcome: { kind: "ok", derivedSpec: derived },
    },
  ];
  const base = createRun({
    issue: ISSUE,
    version: "test",
    models: {},
    baseSha,
    branch: `lean/issue-${ISSUE}`,
  });
  const { pos } = foldLog({ ...base, steps }, "planted log");
  mkdirSync(path.dirname(leanStateFile(repoRoot, ISSUE)), { recursive: true });
  const run: LeanRun = { ...base, state: pos.state, counters: pos.counters, steps, derivedSpec: derived };
  writeFileSync(leanStateFile(repoRoot, ISSUE), JSON.stringify(run, null, 2), "utf8");
}

/**
 * Drive `ready` once through the production wiring and report what left the process.
 *
 * `channel` pins `PI_ENSEMBLE_HANDOFF_CHANNEL`; `resumeFrom` plants the record above
 * BEFORE the drive, which is what makes the third case a resume rather than a first
 * pass. `posted` is the recording post seam; `forgePosts` is the `gh` stub's own log.
 */
export async function driveIntakeReady(opts: {
  tag: string;
  channel: "host" | "forge";
  resumeFrom?: boolean;
}): Promise<{
  posted: string[];
  forgePosts: string[];
  derives: number;
  state: string;
  code: number;
  reason: string;
  record?: LeanRun;
  readyOutcome?: string;
}> {
  const { dir, base } = tempRepo(opts.tag);
  const bin = path.join(dir, "ghbin");
  ghRecordingStub(bin, PROSE);
  const posted: string[] = [];
  const undo = setLeanCommentPoster(async (_issue, body) => {
    posted.push(body);
  });
  let derives = 0;
  let driven: Awaited<ReturnType<typeof runLean>> | undefined;
  const deps: Partial<ReadyDeps> = {
    fetchBody: async () => PROSE,
    issueTitle: async () => "prose ticket",
    loadConfig: async () => EMPTY_CONFIG,
    dispatch: async () => {
      derives++;
      return CHILD_ROW;
    },
  };
  try {
    const handlers: LeanHandlers = { ...phase1Handlers(dir, ISSUE, {}, deps) };
    for (const state of AFTER_READY)
      handlers[state] = async () => ({ kind: "blocked", reason: `${state} is not part of this` });
    if (opts.resumeFrom === true) plantResumableRecord(dir, base);
    await withEnv(
      {
        PI_ENSEMBLE_HANDOFF_CHANNEL: opts.channel,
        PI_ENSEMBLE_FORGE: "none",
        PI_ENSEMBLE_LEAN_SPEC_INTAKE: "derive",
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      async () => {
        driven = await runLean({
          repoRoot: dir,
          issue: ISSUE,
          handlers,
          seed: { version: "test", baseSha: base },
          now: () => 1_700_000_000_000,
        });
      },
    );
    return {
      posted,
      forgePosts: linesOf(path.join(bin, "comments.txt")),
      derives,
      state: driven?.state ?? "(no drive)",
      code: driven?.code ?? -1,
      reason: driven?.run.result?.reason ?? "",
      record: driven?.run,
      readyOutcome: driven?.run.steps.find((s) => s.state === "ready")?.outcome?.kind,
    };
  } finally {
    undo();
    rmSync(dir, { recursive: true, force: true });
  }
}
