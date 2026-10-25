/**
 * A refused squash merge subject must arrive as the function's OWN failure
 * shape, never as an exception past `executeAndVerifyMerge`'s contract: the
 * merge step routes on the discriminated result, so a throw is a cycle that dies
 * where it should park with the reason the guard gave.
 *
 * Both paths are pinned — the forge adapter's `prMerge` (which throws the
 * hygiene error internally) and the direct-exec fallback (which runs the checker
 * itself) — and neither may throw, and both name the reason.
 *
 * Synthetic terms; a scratch denylist; the forge seam injected so neither path
 * touches a remote.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Forge } from "../src/forge.ts";
import { resetDenylistCacheForTests } from "../src/public-denylist.ts";
import { PublicHygieneError } from "../src/public-hygiene-guard.ts";
import type { VerifyExecFn } from "../src/work-driver-git.ts";
import { executeAndVerifyMerge } from "../src/work-driver-merged-mechanized.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

const TERM = ["example", "private", "host"].join("-");
const dir = mkdtempSync(path.join(tmpdir(), "merge-refusal-shape-"));
const list = path.join(dir, "denylist");
writeFileSync(list, `# synthetic\n${TERM}\n`, "utf8");
process.env.PI_ENSEMBLE_PUBLIC_DENYLIST = list;
resetDenylistCacheForTests();

const shellExec: VerifyExecFn = (async () => ({ stdout: "MERGED\n", stderr: "" })) as VerifyExecFn;

/** A forge whose `prMerge` refuses the way the real adapter does: by throwing. */
function throwingForge(): Forge {
  const err = new PublicHygieneError(
    "Refused: this publish would put private text in a public repository.",
  );
  return {
    prView: async () => ({ state: "OPEN" }) as never,
    prMerge: async () => {
      throw err;
    },
  } as unknown as Forge;
}

// 1. The adapter path: a hygiene refusal becomes { ok: false, reason }.
{
  resetDenylistCacheForTests();
  let thrown: unknown;
  let result: unknown;
  try {
    result = await executeAndVerifyMerge(
      7,
      "squash",
      shellExec,
      dir,
      `feat: ship ${TERM}`,
      async () => throwingForge(),
    );
  } catch (err) {
    thrown = err;
  }
  assert(
    thrown === undefined,
    `a refused adapter merge returns rather than throwing (threw ${String((thrown as Error)?.name ?? thrown).slice(0, 40)})`,
  );
  const r = result as { ok?: boolean; reason?: string; merged?: boolean };
  assert(
    r?.ok === false && (r.reason ?? "").includes("private text in a public repository"),
    "and it is { ok: false, reason } carrying the guard's reason, so the merge step parks",
  );
  assert(r?.merged === undefined, "and it is never reported as merged");
}

// 2. A non-hygiene adapter failure keeps its existing shape (no regression).
{
  resetDenylistCacheForTests();
  const boomForge = {
    prView: async () => ({ state: "OPEN" }) as never,
    prMerge: async () => {
      throw new Error("gh: network down");
    },
  } as unknown as Forge;
  const result = (await executeAndVerifyMerge(
    7,
    "squash",
    shellExec,
    dir,
    "feat: a clean subject",
    async () => boomForge,
  )) as { ok?: boolean; reason?: string };
  assert(
    result?.ok === false && (result.reason ?? "").includes("forge pr merge failed"),
    "an ordinary merge failure keeps the reason shape it has always had",
  );
}

// 3. The direct-exec path: refused with a result, and nothing execed.
{
  resetDenylistCacheForTests();
  const calls: string[] = [];
  const exec: VerifyExecFn = (async (cmd: string) => {
    calls.push(cmd);
    return { stdout: "OPEN\n", stderr: "" };
  }) as VerifyExecFn;
  let thrown: unknown;
  let result: unknown;
  try {
    result = await executeAndVerifyMerge(
      7,
      "squash",
      exec,
      dir,
      `feat: ship ${TERM}`,
      async () => undefined,
    );
  } catch (err) {
    thrown = err;
  }
  assert(thrown === undefined, "a refused direct merge returns rather than throwing");
  const r = result as { ok?: boolean; reason?: string };
  assert(
    r?.ok === false && (r.reason ?? "").includes("private-denylist entry matched"),
    "with the hygiene refusal as its reason",
  );
  assert(
    !(r.reason ?? "").includes(TERM),
    "and the reason carries no term, only the location the guard may name",
  );
  assert(
    calls.every((c) => !c.includes("pr me" + "rge")),
    "and the merge command never ran",
  );
}

rmSync(dir, { recursive: true, force: true });
process.exit(exit);
