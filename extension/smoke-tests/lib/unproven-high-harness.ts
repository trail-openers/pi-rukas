/**
 * unproven-high-harness — the shared scaffolding for the three halves of the
 * #2040 unproven-HIGH cap suite (AGENTS.md §12's 500-line gate split the cases
 * into `test-lens-unproven-high.ts` for the pure pass,
 * `test-lens-unproven-high-fanin.ts` for the merge exit, and
 * `test-lens-unproven-high-child.ts` for the child plumbing, the store round and
 * the renderers).
 *
 * What lives here is the part a split must not duplicate: the row and tool-call
 * builders the files compare against must be the SAME definitions, or each half
 * would be pinning its own idea of a reproduction and a `bash` call. Same for
 * `createAssert`: three files counting passes and failures must count them the
 * same way, or one can report green while red.
 *
 * `makeChildHarness` installs the `spawn.ts` mock and builds the skills dir, so
 * a child-level file gets `runLensChild` offline in the `test-lens-kill-child.ts`
 * shape. It is a function rather than a module-level side effect because the
 * mock must be installed BEFORE the lens modules load, and only the file that
 * calls it loads them.
 */

import { mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Finding } from "../../src/lens-review-types.ts";
import { LENS_ROSTER } from "../../src/lens-roster.ts";

/** The command the fixtures prove a HIGH ran, shared so the claim and the
 * recorded call are one string rather than two that happen to agree. */
export const PROOF_COMMAND = "bun test src/a";

/** A HIGH row with `title`, overridable field by field. */
export const HIGH = (title: string, over: Partial<Finding> = {}): Finding => ({
  lens: "SIMPLICITY",
  severity: "HIGH",
  path: "src/a.ts",
  line: 2,
  title,
  ...over,
});

/** The evidence claim a HIGH makes. */
export const repro = (command: string, observed: string) => ({ command, observed });

/** One recorded `bash` call, in the shape the child's session records it.
 * `id` names the call so a `toolResult` can be joined to it (#2040 review): a
 * call is a request, and only its result says whether it ran. */
export const bash = (command: string, id = `call-${command}`) => ({
  type: "toolCall",
  name: "bash",
  id,
  arguments: { command },
});

/** One recorded tool result, in the shape `spawnSpecialist` returns them: the
 * child asked for `toolCallId` and Pi accepted (`isError: false`) or refused it. */
export const toolResult = (
  toolCallId: string,
  isError: boolean,
  text = isError ? "command failed" : "ok",
) => ({ toolCallId, toolName: "bash", isError, text });

/** One `report_finding` tool call, `arguments` given verbatim. */
export const findingCall = (arguments_: Record<string, unknown>) => ({
  type: "toolCall",
  name: "report_finding",
  arguments: arguments_,
});

/** A HIGH's `report_finding` call claiming `command`/`observed` as its evidence. */
export const provenCall = (
  title: string,
  command: string,
  observed: string,
  over: Record<string, unknown> = {},
) =>
  findingCall({
    severity: "HIGH",
    path: "src/a.ts",
    line: 2,
    title,
    reproduction: { command, observed },
    ...over,
  });

/** The recorded tool calls of a `LensRunResult`, as the merge exit reads them. */
export function recordedCalls(r: unknown): unknown[] {
  return (r as { toolUses?: unknown[] }).toolUses ?? [];
}

/** The recorded tool RESULTS of a `LensRunResult`, same seam. */
export function recordedResults(r: unknown): unknown[] {
  return (r as { toolResults?: unknown[] }).toolResults ?? [];
}

/**
 * The pass/fail printer a suite file reports with, plus the tally it exits on.
 *
 * Shared for the same reason the builders are: three files now assert against
 * these helpers, and a counter that differs between them (one that swallowed a
 * failure, or one that printed its own `exit` line differently) is a suite that
 * reports green while red.
 */
export function createAssert(): {
  /** Failures so far — what the file's last line exits with. */
  failures: () => number;
  assert: (cond: boolean, msg: string) => void;
} {
  let failed = 0;
  return {
    failures: () => failed,
    assert: (cond, msg) => {
      if (cond) console.log(`✓ ${msg}`);
      else {
        console.error(`✗ ${msg}`);
        failed++;
      }
    },
  };
}

/**
 * Install the `spawn.ts` mock and build the skills dir + lens entry a
 * `runLensChild` call needs. Returns the child runner, a setter for what the
 * stubbed spawn answers, and a `cleanup` for the temp skills dir.
 *
 * The mock is keyed on the resolved `../../src/spawn.ts` URL (the pattern
 * `test-lens-kill-child.ts` uses) and the responder is read per call, so each
 * case sets its own child shape before running. `runLensChild` is imported
 * INSIDE `runChild`, after the mock is installed — that file's shape, and the
 * reason the runner is a function rather than a top-level import.
 */
export function makeChildHarness() {
  let spawnResponder: () => unknown = () => ({
    role: "code-review-specialist",
    ok: true,
    text: "reviewed",
    toolUses: [],
    ms: 10,
    exitCode: 0,
  });
  mock.module(new URL("../../src/spawn.ts", import.meta.url).href, () => ({
    makeRunId: () => "run-2040",
    spawnSpecialist: async () => spawnResponder(),
  }));

  const skillsRoot = mkdtempSync(path.join(os.tmpdir(), "lens2040-"));
  const skillsDir = path.join(skillsRoot, "skills");
  mkdirSync(skillsDir, { recursive: true });
  let prec = 10;
  for (const s of LENS_ROSTER.map((l) => l.skill)) {
    const d = path.join(skillsDir, s);
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, "SKILL.md"), `---\nname: ${s}\nprecedence: ${prec}\n---\n`);
    prec += 10;
  }

  const lens = { name: "SECURITY", skill: "code-review-security", precedence: 10 };
  // The skills dir is pinned through the env var the production path reads, as
  // `test-lens-kill-child.ts` does: a host without the lens skills installed used
  // to see an EMPTY roster in a fixture like this and pass it for the wrong reason.
  const priorSkillsDir = process.env.PI_ENSEMBLE_SKILLS_DIR;
  process.env.PI_ENSEMBLE_SKILLS_DIR = skillsDir;

  return {
    /** Set what the stubbed `spawnSpecialist` answers for the next call. */
    setSpawn: (responder: () => unknown) => {
      spawnResponder = responder;
    },
    /** The lens roster entry the child runs as. */
    lens,
    /** The skills dir the child is told to load from. */
    skillsDir,
    /** Run one child against the current stubbed spawn result. */
    runChild: async () => {
      const { runLensChild } = await import("../../src/lens-review-child.ts");
      return runLensChild({
        lens,
        runId: "run-2040",
        skillsDir,
        context: "review this",
        roster: [],
        opts: { diff: "diff --git a/src/a.ts b/src/a.ts\n+export const a = 1;\n", cwd: "/repo" },
        bumpBatch: () => {},
      });
    },
    /** Remove the temp skills dir and restore the env. Call from the file's last line. */
    cleanup: () => {
      if (priorSkillsDir === undefined) delete process.env.PI_ENSEMBLE_SKILLS_DIR;
      else process.env.PI_ENSEMBLE_SKILLS_DIR = priorSkillsDir;
      rmSync(skillsRoot, { recursive: true, force: true });
    },
  };
}
