/**
 * test-public-hygiene-driver-text — the hygiene seam for text the DRIVER
 * composes itself, rather than text a tool call carried.
 *
 * Extracted from `test-public-hygiene-guard.ts` under AGENTS.md §12's file-size
 * cap, following the precedent of `test-public-hygiene-roots.ts` (blocks 4b/4c)
 * and `test-forge-pr-merge-seam.ts` (block 7c): a fixture module exports one
 * async function taking the terms and paths its caller already owns, and the
 * guard file calls it inside its own `withEnv`. Nothing here runs on import; the
 * caller supplies `TERM` and the scratch dir so one denylist governs the whole
 * file.
 *
 * Why this seam needs its own assertions at all: the driver's forge writes are
 * in-process execs, so the `tool_call` hook never sees them. `forge.ts`'s
 * `checkPublicText` is what stops a commit-message string the driver composes
 * itself — a squash subject, a release note — from reaching the forge with a
 * private term in it.
 */

import type { createForge } from "../src/forge.ts";
import { assert } from "./merge-guard-helpers.ts";

/**
 * The driver-authored commit message, checked at the forge seam, plus the squash
 * subject (block 7c) which is the one forge write a cycle cannot undo.
 */
export async function driverAuthoredText(
  term: string,
  dir: string,
  buildForge: typeof createForge,
): Promise<void> {
  const execed: string[] = [];
  // The commands that PUBLISH. Since the driver's checks grew the public-only
  // gate (#1788 round 2), a refused post also asks `git remote get-url` and
  // `gh api … --jq .private` on its way to deciding — those are reads, and an
  // assertion that counted them would fail for a check that correctly refused
  // BEFORE publishing. What this case must prove is that no `gh issue`/`gh pr`
  // write ran, so the predicate names writes.
  const published = (): string[] =>
    execed.filter((c) => c.startsWith("gh issue") || c.startsWith("gh pr") || c.startsWith("glab"));
  const det = {
    forge: "github",
    host: "github.com",
    url: "https://github.com/example-owner/example-repo.git",
    source: "remote",
  } as const;
  const forge = buildForge(det as never, {
    execFn: (async (cmd: string) => {
      execed.push(cmd);
      return { stdout: "{}", exitCode: 0 };
    }) as never,
    cwd: dir,
  });
  const dirty = `feat(x): wire ${term} into the build`;
  let thrown: unknown;
  try {
    await forge.issueCreate("release notes", `commit ${dirty} to the release`);
  } catch (err) {
    thrown = err;
  }
  assert(thrown !== undefined, "a driver-authored commit message is refused at the forge seam");
  assert(
    (thrown as Error)?.name === "PublicHygieneError",
    "as the hygiene error the driver's error paths already recognise",
  );
  const message = String((thrown as Error)?.message ?? "");
  assert(message.length > 0 && !message.includes(term), "and its refusal carries no term");
  assert(
    published().length === 0,
    "nothing was execed: the check runs before the forge command, not after the post",
  );
  // And the clean counterpart, so the block is not satisfied by a seam that
  // refuses everything. The assertion is on what reached the exec, not on the
  // call resolving: a fake forge whose stdout is not a created-issue URL
  // rejects for that reason AFTER the check passed, and conflating the two
  // would report a passing seam as a refusing one.
  execed.length = 0;
  await forge.issueCreate("release notes", "commit feat(x): wire the build").catch(() => undefined);
  assert(
    published().length === 1,
    "a clean driver-authored message reaches the exec — the seam did not refuse it",
  );

  // The squash subject (#1788 round 2): a squash publishes the subject as the
  // commit message on main, so it is a public text surface like a title or a
  // body, and the check must run before anything is execed.
  execed.length = 0;
  let mergeThrown: unknown;
  try {
    await forge.prMerge(7, "squash", `feat(x): wire ${term} into the build`);
  } catch (err) {
    mergeThrown = err;
  }
  assert(mergeThrown !== undefined, "a dirty squash subject is refused at the forge seam");
  assert(
    (mergeThrown as Error)?.name === "PublicHygieneError",
    "as the hygiene error the driver's error paths already recognise",
  );
  const mergeMessage = String((mergeThrown as Error)?.message ?? "");
  assert(
    mergeMessage.length > 0 && !mergeMessage.includes(term),
    "and its refusal carries no term",
  );
  assert(published().length === 0, "nothing was execed: the merge did not happen");
  execed.length = 0;
  await forge.prMerge(7, "squash", "feat(x): wire the build").catch(() => undefined);
  assert(
    published().some((c) => c.includes("--subject")),
    "a clean subject reaches the merge command",
  );
  execed.length = 0;
  await forge.prMerge(7, "squash", undefined).catch(() => undefined);
  assert(
    published().every((c) => !c.includes("--subject")),
    "no subject at all is not refused — gh composes one",
  );
}
