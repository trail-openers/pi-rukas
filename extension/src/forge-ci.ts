/**
 * forge-ci — CI watch + run operations for the forge adapter.
 *
 * Split from `forge.ts` at a natural seam (the `// ── CI ──` section).
 * Keeps `forge.ts` under the 500-line hard limit while leaving the CI
 * poll loop and the one-shot run fetch in a single cohesive module.
 */

import { terminalCiFor } from "./forge-ci-terminal.ts";
import * as cmds from "./forge-commands.ts";
import type { ForgeType } from "./forge-detect.ts";
import { mapGhRun, mapGlPipeline } from "./forge-mapping.ts";
import type { CiWatchOpts, CiWatchResult, ForgeExecFn, NormalizedCIRun } from "./forge.ts";

const DEFAULT_POLL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/** Poll until the CI run/pipeline reaches a terminal status, or the cap fires. */
export async function ciWatch(
  execFn: ForgeExecFn,
  forge: ForgeType,
  cwd: string,
  owner: string,
  repo: string,
  runId: number,
  watchOpts?: CiWatchOpts,
): Promise<CiWatchResult> {
  const pollMs = watchOpts?.pollMs ?? DEFAULT_POLL_MS;
  const timeoutMs = watchOpts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = watchOpts?.now ?? Date.now;
  const sleep = watchOpts?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const start = now();
  const terminal = terminalCiFor(forge);

  let run: NormalizedCIRun | undefined;
  for (;;) {
    const stdout = await cmds.ciRunOnce(execFn, forge, cwd, owner, repo, runId);
    const o = JSON.parse(stdout) as Record<string, unknown>;
    run = forge === "github" ? mapGhRun(o) : mapGlPipeline(o);
    if (terminal.has(run.status)) {
      return { ok: true, run, terminal: true, timedOut: false };
    }
    if (now() - start >= timeoutMs) {
      return { ok: true, run, terminal: false, timedOut: true };
    }
    await sleep(pollMs);
  }
}

/** One-shot CI run fetch (no polling). */
export function ciRun(
  execFn: ForgeExecFn,
  forge: ForgeType,
  cwd: string,
  owner: string,
  repo: string,
  id: number,
): Promise<NormalizedCIRun> {
  return cmds.ciRunOnce(execFn, forge, cwd, owner, repo, id).then((stdout) => {
    const o = JSON.parse(stdout) as Record<string, unknown>;
    return forge === "github" ? mapGhRun(o) : mapGlPipeline(o);
  });
}
