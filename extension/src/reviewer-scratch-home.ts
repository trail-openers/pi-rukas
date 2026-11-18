/**
 * reviewer-scratch-home — the scratch `HOME` a read-only child's bash runs with
 * (#2352), and the switch that decides whether it exists.
 *
 * The incident: reviewer and explore children — roles whose write/edit tools are
 * structurally excluded and whose bash is not — probed a target project by
 * moving that project's live state directory under its scratch and copying it
 * back, planting thousands of files in it, and leaving a name with a leading
 * space plus a symlink behind. Those writes land in the operator's real `$HOME`
 * because a child inherits it, and no command-text guard sees a write made by
 * the target project's own CLI through `XDG_STATE_HOME`.
 *
 * So the child's bash gets a `HOME` of its own: a `home/` directory under the
 * per-spawn temp dir the spawn layer already makes (#2241), plus the four XDG
 * roots pointed inside it. It is set on the CHILD PROCESS env, not on the pi
 * process of anyone else, and the scratch lives under `PI_ENSEMBLE_CHILD_TMP`,
 * which that spawn's existing `finally` removes — so this adds no allocation,
 * no new root variable, and no cleanup site.
 *
 * Why the env and not a rewritten command: `tool_call` may mutate `event.input`
 * (Pi's extensions doc, "In-place mutation"), so a hook could prefix `HOME=… `
 * onto the command text. That arm was rejected because Pi's bash tool also
 * expands `~` and hands `$HOME` to whatever it execs, and a prefix is one
 * string rewrite away from being re-quoted away by the model; the env is the
 * value the tool itself reads, and it is set once, at the one construction site.
 *
 * Three home-derived roots the child still needs are RE-EXPORTED here by name,
 * at the values the parent resolves for them today (R12): `PI_AGENT_DIR` (Pi's
 * own agent dir — model auth and settings live there), `PI_ENSEMBLE_SKILLS_DIR`
 * (the reviewer's skill file, which the review skill-read cap counts reads of),
 * and `VIPUNE_DATABASE_PATH` — vipune's real variable, not `VIPUNE_DB_PATH`,
 * which vipune ignores (#2357). The last one is the point of the whole
 * re-export list: vipune resolves its default store from the passwd entry, so a
 * redirected `HOME` does not move it and a probe would still have reached the
 * operator's memory store (R10, measured). Pinning the variable explicitly keeps
 * vipune on the store the harness intends whether or not it follows `HOME`, and
 * makes the answer the same for every other tool that reads its store through
 * `getpwuid`: those are the residual the guard (write-fence-reviewer.ts) has to
 * cover, which is why the guard, not this redirect, is the load-bearing half.
 *
 * The two #2352 switches are independent of each other and of
 * `PI_ENSEMBLE_WRITE_FENCE`, and each is off only on the literal `"0"`. This
 * module owns the redirect's switch and the role predicate the companion's guard
 * hook keys on, so the pair cannot disagree about which child is confined.
 *
 * One residual, stated here because this module creates it: `VIPUNE_DATABASE_PATH`
 * is re-exported deliberately, so a reviewer keeps the memory it is meant to consult
 * — and a `vipune` write is therefore not judged by the write guard (the guard reads
 * command text, and vipune names no path). A confined child can
 * still write its own memory row; that is the accepted cost of the re-export.
 */

import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isReadOnlyRole } from "./write-fence-deps.ts";

/** The env name that switches the scratch-HOME redirect off. */
export const SCRATCH_HOME_SWITCH = "PI_ENSEMBLE_REVIEWER_SCRATCH_HOME";

/** The env name that switches the reviewer bash guard off. */
export const WRITE_GUARD_SWITCH = "PI_ENSEMBLE_REVIEWER_WRITE_GUARD";

/** The scratch home's directory name under the child's per-spawn temp dir. */
export const SCRATCH_HOME_DIR = "home";

/** The five variables a redirected child's bash carries instead of the operator's. */
export const SCRATCH_HOME_VARS = [
  "HOME",
  "XDG_STATE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
] as const;

/**
 * The home-derived roots that must survive the redirect, each re-exported at the
 * value the parent resolves today. `VIPUNE_DATABASE_PATH` is vipune's real
 * variable (#2357); `VIPUNE_DB_PATH` is read by pi-rukas's own stats reader and
 * is NOT what the CLI follows, so setting that one would have been a no-op.
 */
export const REEXPORTED_HOME_ROOTS = [
  "PI_AGENT_DIR",
  "PI_ENSEMBLE_SKILLS_DIR",
  "VIPUNE_DATABASE_PATH",
] as const;

/** Whether the scratch-HOME redirect applies. Default ON; only `"0"` disables. */
export function reviewerScratchHomeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SCRATCH_HOME_SWITCH] !== "0";
}

/** Whether the reviewer bash guard applies. Default ON; only `"0"` disables. */
export function reviewerWriteGuardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[WRITE_GUARD_SWITCH] !== "0";
}

/**
 * Which children the #2352 pair applies to: the whole `READ_ONLY_ROLES` set
 * (R5) — the two reviewer roles and `explore` — because all three have no
 * write/edit tool and an unfenced bash, which is the whole shape of the
 * incident. Developer, ops and lens-fix children are out of scope: the driver
 * fences them, and the fence's own roots are what confine them.
 */
export function isConfinedRole(role: string | undefined): boolean {
  return isReadOnlyRole(role);
}

/** The scratch home for one spawn: a `home/` dir under the child's own temp root. */
export function reviewerScratchHome(childTmp: string): string {
  return path.join(childTmp, SCRATCH_HOME_DIR);
}

/**
 * The env a confined child's bash runs with: the five home roots pointed at the
 * scratch, and every root in `REEXPORTED_HOME_ROOTS` pinned to what the parent
 * resolves today so the redirect costs the child nothing it needs.
 *
 * Returns `{}` for a role the pair does not cover, so the caller's spread is a
 * no-op rather than a branch. `env` and `homedir` are seams for the offline
 * suite: the re-export values are read from the CALLER's env (the parent, whose
 * values the child is meant to keep), and `os.homedir()` — not `$HOME` — is what
 * the defaults resolve against, which is the same rule the modules that own
 * these roots use.
 *
 * The scratch dir is created here: the child's `HOME` must be a real directory,
 * because a tool that finds none writes nothing and reports success, which is
 * indistinguishable from the isolation having worked.
 */
export function reviewerScratchHomeEnv(
  role: string,
  childTmp: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = () => os.homedir(),
): Record<string, string> {
  if (!isConfinedRole(role)) return {};
  const home = reviewerScratchHome(childTmp);
  const out: Record<string, string> = {
    HOME: home,
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
  };
  for (const dir of Object.values(out)) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      // The dir is under a dir the spawn made 0700 and removes itself; a
      // failure to pre-create it is the child's own mkdir to make, and this
      // function must not fail a dispatch over it.
    }
  }
  // The re-exports come FIRST so the child's own values are what the child sees
  // for the roots it must keep; each is read from the parent env, falling back
  // to the same default the owning module uses.
  out.PI_AGENT_DIR = env.PI_AGENT_DIR ?? path.join(homedir(), ".pi", "agent");
  out.PI_ENSEMBLE_SKILLS_DIR =
    env.PI_ENSEMBLE_SKILLS_DIR ?? path.join(homedir(), ".pi", "agent", "skills");
  out.VIPUNE_DATABASE_PATH =
    env.VIPUNE_DATABASE_PATH ?? path.join(homedir(), ".vipune", "memories.db");
  return out;
}
