/**
 * lib/lean-spec-intake-config-fixture — the rig for `contractOf`'s config arms
 * (`test-lean-spec-intake-config.ts`), kept out of the case file so neither
 * crosses AGENTS.md §12's line cap.
 *
 * Nothing here asserts. The rig calls the REAL `contractOf` over a real git repo
 * and stubs only the deriving child, so the judgement under test — what a config
 * that could not be read becomes — is `contractOf`'s and not a copy of it.
 *
 * `intake` pins `PI_ENSEMBLE_LEAN_SPEC_INTAKE` for the call: the mode is what
 * makes the config read load-bearing, and a case that left it unset would be
 * judging `require`'s byte-identical decline instead of the arm under test.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execp } from "../../src/exec.ts";
import { type WorkConfig, loadWorkConfig } from "../../src/lean/config.ts";
import { contractOf } from "../../src/lean/spec-intake.ts";
import type { DerivedSpec } from "../../src/lean/state-derived-spec.ts";
import type { DispatchResult } from "../../src/types.ts";
import { withEnv } from "./env-scope.ts";
import { gitTestEnv } from "./git-test-env.ts";
import { worktreeCommit } from "./lean-spec-intake-fixtures.ts";

/** A prose ticket: no `pi-spec v1` block anywhere, and not blank. */
export const PROSE = "The engine should refuse a run whose frozen tests miss AC1.";

/** A well-formed config a stubbed loader can hand back. */
export const EMPTY_CONFIG: WorkConfig = {
  version: 1,
  autoMerge: false,
  verify: {},
  budgets: {},
};

/** The loader a case that is NOT about the config read uses: the real one, at the base. */
export function realLoadConfig(repoRoot: string, sha: string): Promise<WorkConfig> {
  return loadWorkConfig(execp, repoRoot, sha);
}

/** The contract the stubbed child drafts. */
export const CHILD_SPEC = {
  problem: "frozen tests miss AC1",
  criteria: [{ id: "AC1", text: "the run refuses an uncovered AC1", verify: "test" as const }],
  size: "S" as const,
};

/** A child result carrying that contract in the block the brief demands. */
export function childReply(): DispatchResult {
  return {
    role: "explore",
    ok: true,
    text: "```pi-spec v1\n" + JSON.stringify(CHILD_SPEC, null, 2) + "\n```",
    toolUses: [],
    ms: 1,
    exitCode: 0,
  };
}

/** A temp git repo with git identity configured; the caller commits and removes it. */
export function tempGitRepo(tag: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), `lean-intake-config-${tag}-`));
  const git = (args: string[]): void => {
    const r = spawnSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      env: { ...gitTestEnv(), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t" },
    });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr ?? ""}`);
  };
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  git(["commit", "-q", "--allow-empty", "-m", "fixture"]);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Drive `contractOf` once. `configFile` is committed at the base the run reads. */
export async function driveContractOf(opts: {
  tag: string;
  configFile?: string;
  /** Pin the env knob verbatim — an INVALID value is what makes the switch itself
   * refuse, which is the arm that must come back as a rule naming the knob. */
  intake?: string;
  /** The run's config read. REQUIRED: the case is usually about what the read did,
   * and a defaulted-away loader is how a config arm ends up judging the real git. */
  loadConfig: (repoRoot: string, baseSha: string) => Promise<WorkConfig>;
  dispatch?: () => Promise<DispatchResult>;
}): Promise<{
  contract?: { spec?: unknown; derived?: DerivedSpec; rule?: string; infra?: boolean };
  thrown?: unknown;
  base: string;
  derives: number;
  /** How many times `contractOf` reached for the run's config THROUGH ITS OWN SEAM:
   * zero when the mode was refused before the read, one when it read and the loader
   * is the one that failed. */
  loadAttempts: number;
  cleanup: () => void;
}> {
  const { dir, cleanup } = tempGitRepo(opts.tag);
  const base = worktreeCommit(dir, {
    ".pi/work.json": opts.configFile ?? JSON.stringify({ version: 1 }),
  });
  let derives = 0;
  let contract: Record<string, unknown> | undefined;
  let thrown: unknown;
  try {
    // The recording wrapper goes on the SEAM, not into the returned counter: a
    // config read `contractOf` never attempted must read as zero attempts, which is
    // what makes "the mode is refused before the config is read" assertable.
    let loadAttempts = 0;
    const countedLoadConfig = async (repoRoot: string, sha: string): Promise<WorkConfig> => {
      loadAttempts++;
      return opts.loadConfig(repoRoot, sha);
    };
    await withEnv(
      opts.intake === undefined ? {} : { PI_ENSEMBLE_LEAN_SPEC_INTAKE: opts.intake },
      async () => {
        try {
          contract = await contractOf(
            dir,
            730,
            PROSE,
            { baseSha: base },
            {
              issueTitle: async () => "prose ticket",
              loadConfig: countedLoadConfig,
              dispatch: async () => {
                derives++;
                return (opts.dispatch ?? childReply)();
              },
            },
            countedLoadConfig,
          );
        } catch (err) {
          thrown = err;
        }
      },
    );
    return { contract, thrown, base, derives, loadAttempts, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}
