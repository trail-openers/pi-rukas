import * as cmds from "./forge-commands.ts";
/**
 * forge-label-ops — the label operations of the forge adapter (#1377).
 *
 * Split out of forge.ts along the 500-line seam (AGENTS.md §12), in the same
 * shape `forge-comments.ts` and `forge-ci.ts` already take: a module that
 * receives the adapter's `run` seam and returns the methods the Forge object
 * spreads in. Keeps the per-forge argv/field quirks of the label family (the
 * `--json name` list read, `gh`'s "true" stdout from `label create --force`,
 * the `mr`→`pr` subcommand mapping) in one file instead of four sites.
 */
import type { ForgeType } from "./forge-detect.ts";
import { parseLabelNames } from "./forge-labels.ts";
import { asRecord, mapGhIssueLabel, mapGlIssueLabel } from "./forge-mapping.ts";
import type { NormalizedLabel } from "./forge-types.ts";

/** The adapter seam a label operation needs — the `run` the Forge object closes over. */
export interface LabelOpsDeps {
  forge: ForgeType;
  run: <T>(cmd: string, map: (stdout: string) => T) => Promise<T>;
}

/** The four label methods, built once and spread into the Forge object. */
export function labelOps(deps: LabelOpsDeps) {
  const { forge, run } = deps;
  return {
    /**
     * The repo's label NAMES (#1377's pre-filing existence check). Deliberately
     * NOT `NormalizedLabel[]`: the caller only ever asks "does this name exist",
     * and a name list is the whole contract, so no color/description field is
     * carried that nothing reads. A CLI that fails throws — the plan driver
     * treats an unreadable label list as a halt, never as "no labels exist".
     */
    labelList: (): Promise<string[]> =>
      run(cmds.labelListCmd(forge), (stdout) => parseLabelNames(stdout, forge)),

    /**
     * `gh label create --force` on an existing label prints `true` rather than
     * a JSON row, and an empty stdout is what a no-op answers — neither is a
     * label, so both map to undefined instead of a half-filled row.
     */
    labelCreate: (name: string, color: string): Promise<NormalizedLabel | undefined> =>
      run(cmds.labelCreateCmd(forge, name, color), (stdout) => {
        if (!stdout || stdout === "" || stdout === "true") return undefined;
        try {
          const o = asRecord(stdout);
          if (forge === "github") return mapGhIssueLabel(o);
          return mapGlIssueLabel(o);
        } catch {
          return undefined;
        }
      }),

    labelAdd: (target: "issue" | "mr", number: number, name: string): Promise<void> =>
      run(cmds.labelAddCmd(forge, target, number, name), () => undefined),

    labelRemove: (target: "issue" | "mr", number: number, name: string): Promise<void> =>
      run(cmds.labelRemoveCmd(forge, target, number, name), () => undefined),
  };
}
