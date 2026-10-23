/**
 * #1454 — shared scaffolding for the path-claims tests.
 *
 * Split out of test-work-driver-cross-group-conflicts.ts for the 500-line
 * gate (AGENTS.md §12). These are the four helpers both the registry suite and
 * the stale-claim suite need; keeping them in `lib/` (which
 * test-seams-wired.ts reads) means a helper no test calls is still visible.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../../src/work-driver-context.ts";
import { type PathClaimEntry, readClaims, registerClaim } from "../../src/work-driver-path-claims.ts";
import { setSiblingClaimWait } from "../../src/work-driver-path-claims-siblings.ts";
import { initialState } from "../../src/workflow-state-update.ts";
import type { WorkState } from "../../src/workflow-state.ts";

export function tmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "pi-claims-test-"));
}

/** Minimal workstate in the shape the claim gate reads at the plan step. */
export function makeState(issue: number, repoRoot: string): WorkState {
  return {
    ...initialState(issue, repoRoot),
    pipelineState: {
      ...initialState(issue, repoRoot).pipelineState,
      workstreams: {},
    },
  };
}

export function makeCtx(dir: string, issue: number): DriverContext {
  return { repoRoot: dir, issue } as unknown as DriverContext;
}

/** Write the claims registry verbatim, bypassing registerClaim's liveness filter. */
export function seedClaims(dir: string, claims: unknown[]): void {
  const wd = path.join(dir, ".pi", "work-state");
  mkdirSync(wd, { recursive: true });
  writeFileSync(path.join(wd, "path-claims.json"), JSON.stringify(claims));
}

/** Read the claims file verbatim from disk — what the next writer would see. */
export function rawClaims(dir: string): PathClaimEntry[] {
  const f = path.join(dir, ".pi", "work-state", "path-claims.json");
  if (!existsSync(f)) return [];
  return JSON.parse(readFileSync(f, "utf8")) as PathClaimEntry[];
}

/**
 * Register a claim through the PRODUCTION writer under a foreign issue number,
 * so a suite can plant a live sibling's reservation without duplicating the
 * writer's normalisation. `registerClaim` stamps this process's pid, which is
 * what makes the entry live for `readClaims`.
 */
export function registerClaimForTest(
  dir: string,
  issue: number,
  paths: string[],
): Promise<PathClaimEntry[]> {
  return registerClaim(dir, issue, paths);
}

/** The claim registry's own key: `registerClaim` stamps the WRITER's pid. */
const SELF_PID = process.pid;

/**
 * Drop a claim from the plan-time gate's view the way production does: #1101's
 * sibling filter, which `readClaims` applies BEFORE the gate sees anything. A
 * same-pid entry whose issue the queue declared a sibling is removed from both
 * the fresh and the stale list, so `checkCrossGroupClaimsSync` can end up with a
 * list whose triggering entry is gone — the only route to the degenerate
 * conflict list that does not forge the registry file.
 *
 * Returns whether the filter actually dropped the row. A case that silently
 * measured nothing (a foreign pid, which the pid gate makes inert) fails here
 * instead of asserting the wrong park.
 */
export async function hideSiblingClaimFromGate(dir: string, issue: number): Promise<boolean> {
  const rows = rawClaims(dir);
  const target = rows.find((r) => r.issue === issue);
  setSiblingClaimWait([issue]);
  const seen = await readClaims(dir);
  if (target === undefined) return false;
  return !seen.some((c) => c.issue === target.issue && c.pid === target.pid);
}

/**
 * A pid that is definitely alive and definitely not ours — a real child the
 * caller spawns and stops. Using the test's own pid would pass the live case
 * trivially; a foreign live pid is the shape that actually exercises the
 * non-self owner path.
 */
export async function spawnLivePid(): Promise<{ pid: number; stop: () => Promise<void> }> {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  const stop = async () => {
    child.kill("SIGKILL");
    await new Promise<void>((res) => child.once("exit", () => res()));
  };
  if (!child.pid) throw new Error("could not spawn a live pid for the liveness cases");
  return { pid: child.pid, stop };
}

export { rmSync } from "node:fs";
