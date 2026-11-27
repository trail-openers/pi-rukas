/**
 * lib/lean-specify-reask-golden — the partial-submission fixture of the specify re-ask, in one place.
 *
 * Eight `verify: "test"` criteria, one in-cap red file each, submitted for AC1-AC4 only, so the boundary
 * refuses nothing and the only gap is the four ids the child never declared. `test-lean-specify-reask.ts`
 * drives it.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  CONFIG,
  type RunOpts,
  type RunResult,
  makeRepo,
  redScript,
  runSpecify,
  submit,
} from "./lean-specify-fixture.ts";

export const IDS = ["AC1", "AC2", "AC3", "AC4", "AC5", "AC6", "AC7", "AC8"];
export const SUBMITTED = IDS.slice(0, 4);
export const MISSING = IDS.slice(4);
export const BODY = `\`\`\`pi-spec v1\n${JSON.stringify({
  problem: "The retry helper gives up on the first transient failure.",
  size: "S",
  criteria: IDS.map((id) => ({ id, text: `retry behaviour ${id}`, verify: "test" })),
})}\n\`\`\``;
export const rel = (id: string): string => `tests/${id}-retry.test.sh`;

/** The child's work on its first dispatch: a red test for every criterion. */
export function writeAll(wt: string, dispatch: number): void {
  if (dispatch !== 1) return;
  mkdirSync(path.join(wt, "tests"), { recursive: true });
  for (const f of IDS.map(rel)) writeFileSync(path.join(wt, f), redScript(), { mode: 0o755 });
}

export const submitted = (ids: string[]): unknown[] => ids.map((id) => submit(id, [rel(id)]));

/** One specify run over a fresh repo with this fixture's spec. */
export function runPartial(
  issue: number,
  opts: Partial<Omit<RunOpts, "repoRoot" | "baseSha" | "issue">> = {},
): Promise<RunResult> {
  const { repoRoot, baseSha } = makeRepo({ "src/retry.ts": "export const retry = () => {};\n" });
  return runSpecify({
    repoRoot,
    baseSha,
    issue,
    config: CONFIG,
    specBody: BODY,
    writes: writeAll,
    toolUses: (d: number) => (d === 1 ? submitted(SUBMITTED) : []),
    ...opts,
  });
}
