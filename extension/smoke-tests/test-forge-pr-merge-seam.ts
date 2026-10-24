/**
 * test-forge-pr-merge-seam.ts — the `prMerge` arm of the forge text seam
 * (#1788, round 2).
 *
 * A squash merge publishes the subject it is handed as the commit message on
 * main, so it is a public text surface exactly like a PR title or body — and
 * the merge is the one forge write a cycle cannot undo. The assertions are the
 * three ways that seam can be wrong: it refuses everything (so the merge never
 * happens), it refuses nothing (so the subject ships with the private term), or
 * it checks AFTER the command (so the merge lands and the refusal arrives too
 * late). The `execed` counter is what separates them: the dirty case must exec
 * nothing and the clean cases must exec the merge.
 *
 * It is a `test-*.ts` file on purpose: the offline loop runs `test-*.ts` and
 * nothing else, so a fixture named otherwise is code no gate ever executes.
 * `test-public-hygiene-guard.ts` also calls this function, which is how the
 * seam is exercised under that file's denylist env as well as here.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createForge } from "../src/forge.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

const DETECTION = {
  forge: "github",
  host: "github.com",
  url: "https://github.com/example-owner/example-repo.git",
  source: "remote",
} as const;

/**
 * Run `body` with `PI_ENSEMBLE_PUBLIC_DENYLIST` pointed at a temp file holding
 * `term` — never the operator's real `~/.config/pi-rukas/public-denylist`,
 * which this repository is public and must not read from a test.
 */
export async function withTempDenylist(
  term: string,
  body: (cwd: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "hygiene-seam-"));
  const list = path.join(dir, "public-denylist");
  writeFileSync(list, `# synthetic terms\n${term}\n`, "utf8");
  const prev = process.env.PI_ENSEMBLE_PUBLIC_DENYLIST;
  process.env.PI_ENSEMBLE_PUBLIC_DENYLIST = list;
  try {
    await body(dir);
  } finally {
    if (prev === undefined) delete process.env.PI_ENSEMBLE_PUBLIC_DENYLIST;
    else process.env.PI_ENSEMBLE_PUBLIC_DENYLIST = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Drive the forge adapter's `prMerge` with a recording fake executor. */
export async function forgePrMergeSeam(
  term: string,
  cwd: string,
  build: typeof createForge,
): Promise<void> {
  const execed: string[] = [];
  const forge = build(DETECTION as never, {
    execFn: (async (cmd: string, _opts?: unknown) => {
      execed.push(cmd);
      return { stdout: "Merged", exitCode: 0 };
    }) as never,
    cwd,
  });
  let thrown: unknown;
  try {
    await forge.prMerge(7, "squash", `feat(x): wire ${term} into the build`);
  } catch (err) {
    thrown = err;
  }
  assert(thrown !== undefined, "a dirty squash subject is refused at the forge seam");
  assert(
    (thrown as Error)?.name === "PublicHygieneError",
    "as the hygiene error the driver's error paths already recognise",
  );
  assert(
    !String((thrown as Error)?.message ?? "").includes(term),
    "and its refusal carries no term",
  );
  assert(execed.length === 0, "nothing was execed: the merge did not happen");
  // A clean subject reaches the exec, and no subject at all (gh composes one
  // from the PR) is nobody's business to refuse.
  execed.length = 0;
  await forge.prMerge(7, "squash", "feat(x): wire the build");
  assert(
    execed.length === 1 && execed[0]?.includes("gh pr merge 7"),
    "a clean subject reaches the merge command",
  );
  execed.length = 0;
  await forge.prMerge(7);
  assert(execed.length === 1, "no subject at all is not refused — gh composes one");
}

// Run as its own file as well as being called by test-public-hygiene-guard.ts:
// the assertions must be reachable from the offline loop, and a test whose
// only caller is another test is one the loop never discovers.
if (import.meta.main) {
  const term = ["example", "private", "host"].join("-");
  await withTempDenylist(term, async (cwd) => {
    await forgePrMergeSeam(term, cwd, createForge);
  });
  process.exit(exit);
}
