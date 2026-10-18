/**
 * work-driver-verify-select-develop — #1647: the develop-round plan for the
 * selected verify.
 *
 * One call per develop verify pass decides between two commands. The selected
 * command runs the smoke tests the cycle's changed files can affect (plus
 * ALWAYS_RUN) through verify-loop, with its failures attributed by
 * `withSelectedAttribution`. The full `.pi/verify-cmd` runs when selection is
 * switched off (`PI_ENSEMBLE_VERIFY_SELECT=0`) or the selector cannot be sure;
 * every fallback reason is written to the gate's notes. Selection only replaces
 * the develop round's command: the full suite still runs at the ci step.
 *
 * The fast tier (`.pi/verify-cmd-fast`) wraps OUTSIDE the attribution: it runs
 * once per gate call, ahead of whichever command was chosen, and its failure
 * never reaches the attribution (a typecheck is not a test to attribute).
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { CycleContext } from "./work-driver-context.ts";
import { type VerifyChannel, createVerifyChannel } from "./work-driver-integrate-verify-flake.ts";
import { ALWAYS_RUN } from "./work-driver-verify-always-run.ts";
import { developTierTimeouts } from "./work-driver-verify-budget.ts";
import { verifyCmdFor } from "./work-driver-verify-cmd.ts";
import { fastVerifyCmdFor, withFastTier } from "./work-driver-verify-fast.ts";
import { removeVerifyReportDir } from "./work-driver-verify-report-path.ts";
import {
  type SelectedVerifyRecord,
  withSelectedAttribution,
} from "./work-driver-verify-select-exec.ts";
import { selectVerifyTests, selectedVerifyCommand } from "./work-driver-verify-select.ts";
import type { ExecFn } from "./worktree.ts";

export interface SelectedVerifyPlan {
  /** The develop command: the selected one, or the full one when selection fell back. Undefined when the project has none. */
  cmd: string | undefined;
  /** Wraps the executor the gate runs `cmd` through: fast tier, then the command with attribution. */
  wrap: (execFn: ExecFn) => ExecFn;
  /** Hands the gate's record to the caller and removes the report directory, once the gate has read its verdicts. */
  finish: (onRecord?: (record: SelectedVerifyRecord) => void) => void;
}

/** `PI_ENSEMBLE_VERIFY_SELECT=0` restores the full develop command exactly. */
export function verifySelectEnabled(): boolean {
  return process.env.PI_ENSEMBLE_VERIFY_SELECT !== "0";
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** Repo-relative → extension-relative. A path outside `extension/` stays as is: the selector treats it as outside the graph. */
function extensionRelativeOf(repoRelative: string): string {
  return repoRelative.startsWith("extension/")
    ? repoRelative.slice("extension/".length)
    : repoRelative;
}

/**
 * Plan the develop verify for one pass. `touchedPaths` are repo-relative and
 * cover every worktree; `worktrees` names the trees a selected run may execute
 * in; `rawExec` is the executor without the fast tier, for the base probe. The
 * selection or the fallback reason is pushed onto `notes`.
 */
export async function planDevelopVerify(
  ctx: CycleContext,
  touchedPaths: readonly string[],
  worktrees: Record<string, string>,
  baseSha: string | undefined,
  rawExec: ExecFn,
  notes: string[],
): Promise<SelectedVerifyPlan> {
  const { repoRoot } = ctx;
  const fullCmd = await verifyCmdFor(repoRoot);
  const fastCmd = await fastVerifyCmdFor(repoRoot);
  const fastTimeoutMs = (await developTierTimeouts(repoRoot)).fast;
  const fullPlan = (note: string): SelectedVerifyPlan => {
    notes.push(note);
    return {
      cmd: fullCmd,
      wrap: (execFn) => withFastTier(execFn, fullCmd ?? "", fastCmd, { fast: fastTimeoutMs }),
      finish: () => {},
    };
  };
  if (fullCmd === undefined) {
    return { cmd: undefined, wrap: (execFn) => execFn, finish: () => {} };
  }
  if (!verifySelectEnabled()) {
    return fullPlan(
      "verify selection disabled (PI_ENSEMBLE_VERIFY_SELECT=0) — the full verify command ran",
    );
  }
  // Selection replaces `.pi/verify-cmd` only. A command derived from package.json
  // or Cargo.toml is not one the selected command could stand in for.
  if (!(await fileExists(path.join(repoRoot, ".pi", "verify-cmd")))) {
    return fullPlan("verify selection fell back to the full suite (no-pi-verify-cmd)");
  }
  if (!fastCmd) return fullPlan("verify selection fell back to the full suite (no-fast-tier)");
  let selection: ReturnType<typeof selectVerifyTests>;
  try {
    selection = selectVerifyTests(
      path.join(repoRoot, "extension"),
      touchedPaths.map(extensionRelativeOf),
    );
  } catch (err) {
    return fullPlan(
      `verify selection fell back to the full suite (uncomputable-graph: ${(err as Error).message?.slice(0, 120)})`,
    );
  }
  if (selection.mode === "full") {
    return fullPlan(
      `verify selection fell back to the full suite (${selection.fallbackReason ?? "unknown"})`,
    );
  }
  const cmd = selectedVerifyCommand(selection.tests);
  const record: SelectedVerifyRecord = { flaky: [], baselineRed: [] };
  const changedTests = touchedPaths
    .map(extensionRelativeOf)
    .filter((p) => /^smoke-tests\/test-[^/]+\.ts$/.test(p));
  const timeoutMs = (await developTierTimeouts(repoRoot)).suite;
  notes.push(
    `verify selection ran ${selection.tests.length} test(s) plus ${ALWAYS_RUN.length} always-run, not the full suite (PI_ENSEMBLE_VERIFY_SELECT=0 restores it)`,
  );
  // The report channel is made when the gate is about to run the command, not
  // here: a cycle whose gate is skipped must not leave a directory behind.
  let channel: VerifyChannel | undefined;
  let channelMade = false;
  // One channel per plan, however many times the gate asks to wrap: a second
  // channel would orphan the first one's report directory.
  const channelOnce = (): VerifyChannel | undefined => {
    if (!channelMade) {
      channelMade = true;
      channel = createVerifyChannel();
    }
    return channel;
  };
  return {
    cmd,
    wrap: (execFn) => {
      const ch = channelOnce();
      const attributed =
        ch === undefined
          ? execFn
          : withSelectedAttribution(execFn, rawExec, {
              cmd,
              channel: ch,
              repoRoot,
              baseSha,
              changeRoots: [...Object.values(worktrees), repoRoot],
              changedTests,
              probeLabel: `develop-${ctx.issue}`,
              timeoutMs,
              record,
            });
      return withFastTier(attributed, cmd, fastCmd, { fast: fastTimeoutMs });
    },
    finish: (onRecord) => {
      onRecord?.(record);
      if (channel !== undefined) removeVerifyReportDir(channel.reportDir);
    },
  };
}
