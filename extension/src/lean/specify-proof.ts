/**
 * lean/specify-proof — runs one test file against the base and hashes it.
 *
 * The step's whole claim is "these tests are red on the code as it stands",
 * and that claim is only worth anything if something executed the file. This
 * module runs the project's `verify.test` template with `{file}` replaced and
 * classifies the result into four kinds, three of which mean different things
 * to the caller:
 *
 *   - `infra`  — a missing dependency tree, a timeout or a kill. The base
 *                itself is not trustworthy, so the step THROWS (the engine
 *                turns a throw into handed-back exit 10) rather than reporting
 *                a red that was really an environment fault.
 *   - `red`    — non-zero exit AND the file's own basename in the output. The
 *                only kind that counts as proof.
 *   - `green`  — exit 0 on base. Not a test of the feature; the file is
 *                dropped and the criterion goes uncovered.
 *   - `unclear`— non-zero without the basename: something else failed and the
 *                output never named this file. Dropped, reason recorded.
 *
 * `hashFile` is the freeze: sha256 of the bytes as they sat in the worktree,
 * which is what later steps compare against to notice an edit.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { looksLikeMissingDeps } from "../worktree-provision.ts";
import type { ExecFn } from "../worktree.ts";

/** How long one test file gets before the step calls it an environment fault. */
export const TEST_TIMEOUT_MS = 120_000;

export type ProofKind = "red" | "green" | "infra" | "unclear";

export interface Proof {
  kind: ProofKind;
  /** The runner command as run, for the outcome reason. */
  cmd: string;
  /** Exit status; undefined for a timeout/kill where there is none. */
  code?: number;
  /** The classification's evidence, verbatim. */
  detail: string;
}

/** Was this rejection a timeout or a signal rather than a non-zero exit? */
function wasKilled(err: unknown): boolean {
  const e = err as { killed?: boolean; signal?: string | null; timedOutKill?: boolean };
  return e?.killed === true || e?.timedOutKill === true || (e?.signal ?? null) !== null;
}

/** Exit status from a rejected exec, or undefined when there was none. */
function exitCodeOf(err: unknown): number | undefined {
  const code = (err as { code?: unknown })?.code;
  return typeof code === "number" ? code : undefined;
}

function outputOf(out: string | undefined, err: unknown): string {
  const e = err as { stdout?: unknown; stderr?: unknown };
  const parts = [
    out ?? "",
    typeof e?.stdout === "string" ? e.stdout : "",
    typeof e?.stderr === "string" ? e.stderr : "",
  ];
  return parts.join("\n");
}

/** Replace every `{file}` in the template with the test path. */
export function renderTestCommand(template: string, file: string): string {
  return template.split("{file}").join(file);
}

/**
 * Run one test file in the worktree and classify the outcome.
 *
 * Never throws: a kill, a timeout and a missing binary all come back as
 * `kind: "infra"`, and it is the caller that decides throwing is the right
 * response to an untrustworthy base.
 */
export async function runTestFile(
  exec: ExecFn,
  opts: { wt: string; template: string; file: string },
): Promise<Proof> {
  const cmd = renderTestCommand(opts.template, opts.file);
  // argv form: the template is read as the executable plus its arguments, so
  // the project's runner never reaches a shell that would re-parse the
  // worktree's path. A template needing shell composition does not fit here.
  const [bin, ...args] = cmd.split(/\s+/).filter((w) => w !== "");
  if (bin === undefined || args.length === 0) {
    // A template with no arguments cannot name a file to run: the placeholder
    // check in config.ts rejects the shape, and this refuses it at the run.
    return { kind: "infra", cmd, detail: `runner template has nothing to run: ${cmd}` };
  }
  const base = path.basename(opts.file);
  const ran = await exec(bin, {
    argv: args,
    cwd: opts.wt,
    timeout: TEST_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  }).catch((err: unknown) => ({ __err: err }) as never);
  const err = (ran as { __err?: unknown })?.__err;
  const out = outputOf((ran as { stdout?: string })?.stdout, err);
  if (err !== undefined) {
    if (looksLikeMissingDeps(out))
      return {
        kind: "infra",
        cmd,
        code: exitCodeOf(err),
        detail: `missing dependencies: ${trim(out)}`,
      };
    if (wasKilled(err))
      return {
        kind: "infra",
        cmd,
        detail: `the runner was killed or timed out at ${TEST_TIMEOUT_MS}ms`,
      };
    const code = exitCodeOf(err);
    if (code === undefined)
      return { kind: "infra", cmd, detail: `the runner could not be started: ${trim(out)}` };
    if (!out.includes(base))
      return {
        kind: "unclear",
        cmd,
        code,
        detail: `exited ${code} without naming ${base}`,
      };
    return { kind: "red", cmd, code, detail: `exited ${code}` };
  }
  return { kind: "green", cmd, code: 0, detail: "exited 0 on the base commit" };
}

/** A short, single-line excerpt of runner output for a reason string. */
export function trim(out: string): string {
  return out.replace(/\s+/g, " ").trim().slice(0, 300);
}

/** sha256 of a file's current bytes, or undefined when it cannot be read. */
export function hashFile(file: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return undefined;
  }
}
