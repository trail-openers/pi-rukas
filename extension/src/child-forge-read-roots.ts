/**
 * child-forge-read-roots.ts — the protected forge config set, computed ONCE in
 * the parent and handed to the child as harness-owned data (#2638).
 *
 * The field report: a developer child whose `glab` answered "not authenticated"
 * (its config roots had been redirected at an empty dir, correctly) unset the
 * variable and read the operator's glab config file, which put a plaintext token
 * — for hosts unrelated to the run — into the agent context and the transcript.
 * The env strip removes the AMBIENT login; the read half needs the operator's
 * real paths, and a child that can edit its own env cannot be trusted to report
 * them. So the child never resolves them: the parent resolves the set from its
 * OWN environment at dispatch time, and the child judges what it was handed.
 *
 * Resolution order, stated once here and enforced by the tests:
 *
 *   gh    `GH_CONFIG_DIR`, else `<XDG config home>/gh`, else `<home>/.config/gh`
 *   glab  `GLAB_CONFIG_DIR`, else `<XDG config home>/glab-cli`, else `<home>/.config/glab-cli`
 *
 * Absolute values only: a relative override would name a path under the cwd, so
 * it is ignored and the next arm answers — the same rule `spawn-operator-config.ts`
 * applies to its own snapshot, and the sandbox's `GLAB_CONFIG_DIR` mount rule
 * applies to its bind source.
 *
 * The HOME the resolvers read is the environment's when it is absolute, and the
 * passwd entry otherwise — and BOTH homes are always protected: a tool that
 * resolves its config through `getpwuid(3)` rather than `$HOME` (glab is one, per
 * the #2352 measurement) reads the passwd path whatever the env says, so the
 * canary row in the suite proves the second half is judged.
 *
 * Serialisation is a `:`-joined list of absolute, already-resolved directory
 * paths in `PI_ENSEMBLE_FORGE_PROTECTED_PATHS`. The guard refuses a protected
 * set it cannot read — an absent or malformed value means the child was not given
 * one — so the fail-closed arm is a refusal, not a pass.
 */

import os from "node:os";
import path from "node:path";
import type { ProtectedDir } from "./child-forge-read-judge.ts";
import { safeResolve } from "./write-fence-path.ts";

/**
 * The harness-owned channel that carries the parent's protected set to the child.
 *
 * This is the ONLY #2638 value a child receives: the parent resolves BOTH homes
 * itself — its `HOME` and its passwd entry, which a child could not report honestly
 * (Bun's `os.homedir()` follows the `HOME` the offline suite pins, and a child's own
 * `HOME` is its own to change) — and the child is handed the finished set. No second
 * hint travels, because a hint the child could write is a hint it could lie about.
 */
export const FORGE_PROTECTED_PATHS_ENV = "PI_ENSEMBLE_FORGE_PROTECTED_PATHS";

/**
 * The channel that carries the parent's OWN homes to the child, so a leading `~`
 * in a judged path can be expanded against every home it could mean.
 *
 * The child's `HOME` is not that answer: for a reviewer or explore child the
 * harness itself redirects it to a scratch tree (`reviewer-scratch-home.ts`), so
 * `~/.config/gh/hosts.yml` resolved against the child's env names a path that
 * holds nothing, while the operator's credential file sits at the home the parent
 * named. The parent publishes both of its homes — its `HOME` and its passwd entry
 * — and the child expands `~` against each, because the protected trees are
 * derived from exactly those two.
 */
export const FORGE_PROTECTED_HOMES_ENV = "PI_ENSEMBLE_FORGE_PROTECTED_HOMES";

/** The separator of the serialised home list. An absolute POSIX path never contains it. */
const SEP = ":";

/** The parent's two homes, as the one string its child's env carries. */
export function protectedForgeHomesEnvValue(homes: ForgeHomes): string {
  return forgeHomeSpellings(homes).join(SEP);
}

/**
 * The homes the child was handed. Absent or malformed is `[]`, which leaves the
 * child's own `HOME` as the only thing `~` can mean: the read rule still judges
 * every absolute spelling, and no home the child invented can shrink the set the
 * parent published.
 */
export function protectedForgeHomesFromChild(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const raw = env[FORGE_PROTECTED_HOMES_ENV];
  if (raw === undefined || raw === "") return [];
  return raw.split(SEP).filter((p) => path.isAbsolute(p));
}

/** A serialised entry's forge, from the sentinel its directory name carries. */
function forgeFor(dir: string): string {
  // The two sentinels are checked SEPARATELY and the second one wins: a tree that
  // carries both names (`…/glab-cli/gh`) is judged as both, so the narrower name
  // cannot be used to smuggle a gh tree past a glab rule, or the other way round.
  const glab = dir.includes("glab") || dir.includes("gitlab");
  const gh = dir.includes("gh") || dir.includes("github");
  return glab && gh ? "gh/glab" : glab ? "glab" : gh ? "gh" : "forge";
}

/** `<XDG_CONFIG_HOME>` when absolute, else `<home>/.config` — the XDG base git, gh and glab honour. */
function configHome(env: Record<string, string | undefined>, home: string): string {
  const xdg = env.XDG_CONFIG_HOME;
  return xdg !== undefined && xdg !== "" && path.isAbsolute(xdg) ? xdg : path.join(home, ".config");
}

/** The env's home when it is absolute, else the passwd entry (Bun snapshots HOME inside os.homedir()). */
function envHome(env: Record<string, string | undefined>): string {
  const home = env.HOME;
  return home !== undefined && home !== "" && path.isAbsolute(home) ? home : os.homedir();
}

/**
 * The config root one CLI uses FOR ONE HOME, as the set of spellings that home can
 * produce — not the one winner the CLI itself would pick.
 *
 * This is the difference between protecting a CLI's config and protecting the
 * operator's credentials. The CLI resolves a single root, so the *effective* root
 * for the passwd home is the env's `XDG_CONFIG_HOME` — the same tree the env home
 * already contributes, and deduplicating it away would leave the passwd home's
 * `~/.config/gh` unprotected: the one tree the rule exists for, because a token
 * written by a tool that never read `HOME` lands there. The set is the superset:
 * the override (if any), the XDG spelling and the home's own `~/.config` spelling,
 * all four arms deduplicated by directory. Over-protecting an extra tree costs a
 * refusal the helper can route through `forge_read`; under-protecting leaks a token.
 */
function cliDirsFor(
  env: Record<string, string | undefined>,
  home: string,
  override: string | undefined,
  name: string,
): string[] {
  return [override ?? "", path.join(configHome(env, home), name), path.join(home, ".config", name)];
}

/**
 * One directory as the parent's set needs it: the spelling the parent named, and the
 * spelling the OS opens.
 *
 * Both are kept because they are different questions. The lexical form is what
 * crosses the serialised env var to the child — the parent resolves nothing on the
 * child's behalf, since the child's filesystem view is not the parent's promise. The
 * realpath is what makes a credential file reachable through a link: the parent
 * resolves the root IT named, so a helper that types a path outside the protected
 * tree and lands inside it by following a symlink is judged against the resolved
 * root. A root that cannot be resolved is judged by its lexical form alone, which is
 * the normal case for a directory the operator has not created yet.
 */
function protectedDir(dir: string, forge: string): ProtectedDir | undefined {
  if (dir === "" || !path.isAbsolute(dir)) return undefined;
  const lexical = path.resolve(dir);
  // Trailing separators are stripped on the way IN: the set crosses a serialised
  // env var to the child, and a slash that decides whether a rule fires is a
  // rule that fires by accident. `matches` in the judge strips again on the way
  // out, so the two ends cannot disagree whatever spelling arrived.
  const normalised = lexical.length > 1 ? lexical.replace(/[/]+$/, "") : lexical;
  const resolved = safeResolve(normalised);
  return {
    lexical: normalised,
    real: resolved === undefined ? normalised : resolved,
    forge: forgeFor(normalised),
  };
}

/**
 * The parent's view: the env's home and the passwd home, which may be one home.
 *
 * `passwdHome` is injectable because the suite needs a passwd entry it can point
 * at — `os.homedir()` cannot be faked from inside the process that reads it.
 * Production passes nothing and gets the real entry.
 */
export interface ForgeHomes {
  /** What the parent's `HOME` says (or the passwd entry when `HOME` is unusable). */
  envHome: string;
  /** The parent's passwd entry (`getpwuid`), which may equal `envHome`. */
  passwdHome: string;
}

/**
 * The homes a leading `~` in a judged path can stand for: `envHome` and
 * `passwdHome`, de-duplicated and absolute.
 *
 * This is the answer the CHILD cannot give. Its own `HOME` is the harness's to
 * redirect (a reviewer or explore child runs with a scratch home), so `~` in a
 * path that child typed means whichever home the PARENT's config lives in — the
 * same two homes the protected set was derived from.
 */
export function forgeHomeSpellings(homes: ForgeHomes): string[] {
  return [...new Set([homes.envHome, homes.passwdHome])].filter(
    (h) => h !== "" && path.isAbsolute(h),
  );
}

/** The two homes the parent judges, from its own env and its own passwd entry. */
export function forgeHomesFrom(
  source: Record<string, string | undefined> = process.env,
  passwdHome: string = os.homedir(),
): ForgeHomes {
  return { envHome: envHome(source), passwdHome };
}

/**
 * The protected forge config directories the parent resolved: both CLI roots for
 * the env's home AND for the passwd home, de-duplicated.
 *
 * Each of the four roots is resolved with ITS OWN home as the last fallback, and
 * that ordering is the rule: `GH_CONFIG_DIR` and the XDG home are the parent's
 * statements and win for both homes, while the third arm — the home itself — is
 * what makes the passwd home a SECOND protected tree. An implementation that
 * resolved once and paired the result with each home protected nothing extra, and
 * the canary row would stay green with the passwd half deleted.
 *
 * `source` is the env the CALLER holds — in production, the parent's. A child
 * that asks this function about its own env gets its own stripped values back,
 * which is exactly the answer the rule must not trust; only the parent calls it.
 */
export function protectedForgePathsFrom(
  source: Record<string, string | undefined> = process.env,
  homes: ForgeHomes = forgeHomesFrom(source),
): ProtectedDir[] {
  const out: ProtectedDir[] = [];
  const seen = new Set<string>();
  // Four arms: gh's and glab's roots for the env's home AND for the passwd home,
  // each on its own home, each contributed as every spelling that home can produce
  // (`cliDirsFor`). Deduplication is by directory, so the usual case — `HOME` is the
  // passwd entry and `XDG_CONFIG_HOME` is `<home>/.config` — collapses to two entries
  // while a second home still adds its own two.
  for (const home of [homes.envHome, homes.passwdHome]) {
    for (const dir of [
      ...cliDirsFor(source, home, source.GH_CONFIG_DIR, "gh"),
      ...cliDirsFor(source, home, source.GLAB_CONFIG_DIR, "glab-cli"),
    ]) {
      const d = protectedDir(dir, "");
      if (d === undefined || seen.has(d.lexical)) continue;
      seen.add(d.lexical);
      out.push(d);
    }
  }
  return out;
}

/** The parent's set, as the one string the child's env carries. */
export function protectedForgePathsEnvValue(
  source: Record<string, string | undefined> = process.env,
  homes: ForgeHomes = forgeHomesFrom(source),
): string {
  return protectedForgePathsFrom(source, homes)
    .map((d) => d.lexical)
    .join(SEP);
}

/**
 * The set as the child was handed it. An absent, empty or malformed value is
 * `undefined`: the guard reads that as "this child was given no protected set"
 * and refuses rather than judging nothing, because the child cannot supply the
 * answer itself (decision 4).
 *
 * The child resolves NOTHING: not the config-dir variables, not the home, not the
 * passwd entry. Its `HOME` is its own to change (the reviewer's scratch home is a
 * `HOME` the harness itself redirects), so a child-side resolver would protect the
 * wrong tree on the child's say-so.
 */
export function protectedForgePathsFromChild(
  env: Record<string, string | undefined> = process.env,
): ProtectedDir[] | undefined {
  const raw = env[FORGE_PROTECTED_PATHS_ENV];
  if (raw === undefined || raw === "") return undefined;
  const parts = raw.split(SEP).filter((p) => p !== "");
  if (parts.length === 0) return undefined;
  const out: ProtectedDir[] = [];
  for (const part of parts) {
    // A malformed entry fails the whole read: a partial set is a set that
    // silently protects less than the parent resolved.
    if (!path.isAbsolute(part)) return undefined;
    const d = protectedDir(part, "");
    if (d === undefined) return undefined;
    out.push(d);
  }
  return out;
}
