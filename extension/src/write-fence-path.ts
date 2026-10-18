/**
 * write-fence-path — the path rule for the /work write fence (#1655).
 *
 * A developer child works in its own detached worktree, but nothing stopped a
 * write aimed at the repo root (or a sibling worktree). It landed silently and
 * surfaced only at consolidation, as a dirty repo root, after the whole develop
 * spend. This module decides, for one target path, whether the write stays
 * inside the child's write root.
 *
 * The target is resolved THE WAY THE OS DOES: each symlink is followed as it is
 * met, and `..` is applied to the real parent. Lexical normalisation
 * (`path.resolve`) is deliberately not used: `<worktree>/node_modules/../bin/x`
 * stays inside the worktree lexically, but the OS writes `<repo>/bin/x`.
 *
 * Allowed, by resolved realpath: the write root, the cycle scratch dir, the OS
 * temp dirs, and — through the worktree's own provisioned dependency links only
 * — the tree that link points at. Everything else is refused. A root that is set
 * but unusable fails closed: only scratch and temp stay writable.
 */

import { lstatSync, readlinkSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SHAREABLE_DEPS } from "./worktree-provision.ts";

/** Symlink hops allowed before a resolution is treated as a loop. */
const MAX_SYMLINK_DEPTH = 32;

/** The fence's view of the environment the companion was loaded into. */
export interface FenceConfig {
  /** Usable write root: lexical (for the dependency-link prefix) and real (for containment). */
  root?: { lexical: string; real: string };
  /** The root exactly as the driver set it, named in every refusal. */
  rootLabel: string;
  /** Realpaths of the trees a write may always land in: scratch and the OS temp dirs. */
  allowed: string[];
  /** When the fence loaded: a dependency link newer than this was made by the child, not provisioned. */
  loadedAt: number;
}

/** Options for judgeWrite. */
export interface JudgeOpts {
  /** The bash command creates a link too (see BashTarget.linkedCommand). */
  linkedCommand?: boolean;
}

export type WriteJudgement = { ok: true } | { ok: false; message: string };

function lstatOf(p: string) {
  try {
    return lstatSync(p);
  } catch {
    return undefined;
  }
}

/**
 * Resolve an absolute path the way the OS does. A symlink is followed where it
 * sits, so a `..` after it climbs from its target. A segment that does not exist
 * is taken lexically: the nearest existing ancestor is already resolved by then.
 * Throws on a symlink loop, which the caller turns into a refusal.
 */
export function resolveLikeOs(abs: string, depth = 0, probe?: { missing: boolean }): string {
  if (depth > MAX_SYMLINK_DEPTH) throw new Error(`too many symbolic links resolving ${abs}`);
  let cur: string = path.sep;
  for (const seg of abs.split(path.sep)) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      cur = path.dirname(cur);
      continue;
    }
    const next = path.join(cur, seg);
    const st = lstatOf(next);
    if (st?.isSymbolicLink()) {
      // Joined raw, not path.resolve'd: a link's own `..` must still be resolved by the OS rule.
      const target = readlinkSync(next);
      cur = resolveLikeOs(
        path.isAbsolute(target) ? target : `${cur}${path.sep}${target}`,
        depth + 1,
        probe,
      );
    } else {
      // A segment that does not exist yet is taken lexically; `probe` records that it was.
      if (!st && probe) probe.missing = true;
      cur = next;
    }
  }
  return cur;
}

/** resolveLikeOs, or undefined when the path cannot be resolved. */
function safeResolve(p: string): string | undefined {
  try {
    return resolveLikeOs(path.resolve(p));
  } catch {
    return undefined;
  }
}

/** `child` is `parent` or lies beneath it. */
export function isInside(child: string, parent: string): boolean {
  const prefix = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child === parent || child.startsWith(prefix);
}

/** A segment that names an entry, not `.`, `..` or nothing. */
function isPlainName(seg: string): boolean {
  return seg !== "" && seg !== "." && seg !== "..";
}

function usableRoot(raw: string): FenceConfig["root"] {
  if (!path.isAbsolute(raw)) return undefined;
  try {
    if (!statSync(raw).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  const lexical = path.resolve(raw);
  const real = safeResolve(lexical);
  return real === undefined ? undefined : { lexical, real };
}

/**
 * The fence's config from the child's environment, or undefined when the fence
 * is off: no PI_ENSEMBLE_WRITE_ROOT (the child is not a fenced dispatch), or
 * PI_ENSEMBLE_WRITE_FENCE=0 (the operator's escape hatch).
 */
export function loadFenceConfig(env: NodeJS.ProcessEnv): FenceConfig | undefined {
  const rawRoot = env.PI_ENSEMBLE_WRITE_ROOT;
  if (rawRoot === undefined || env.PI_ENSEMBLE_WRITE_FENCE === "0") return undefined;
  const allowed: string[] = [];
  const scratch = env.PI_ENSEMBLE_WRITE_SCRATCH;
  const dirs = [
    scratch && path.isAbsolute(scratch) ? scratch : undefined,
    os.tmpdir(),
    "/tmp",
    "/private/tmp",
  ];
  for (const dir of dirs) {
    const real = dir === undefined ? undefined : safeResolve(dir);
    if (real !== undefined) allowed.push(real);
  }
  return {
    root: usableRoot(rawRoot),
    rootLabel: rawRoot,
    allowed,
    loadedAt: Date.now(),
  };
}

/**
 * A write to `abs` is inside the worktree's own provisioned dependency tree when
 * its LEXICAL path runs through a dependency link the worktree owns, and the
 * resolved target lies inside what that link points at. The link must be one
 * `worktree-provision.ts` creates (a shareable dep at the root, or `node_modules`
 * one package directory down) and must point at a tree of the same name, so a
 * symlink a child made itself to `/etc` is not a dependency tree.
 */
function dependencyLinkAllows(
  abs: string,
  rootLexical: string,
  resolved: string,
  loadedAt: number,
): boolean {
  const prefix = rootLexical + path.sep;
  if (!abs.startsWith(prefix)) return false;
  const [first, second] = abs.slice(prefix.length).split(path.sep);
  if (first === undefined || !isPlainName(first)) return false;
  const links: string[] = [];
  if ((SHAREABLE_DEPS as readonly string[]).includes(first)) {
    links.push(path.join(rootLexical, first));
  }
  if (second === "node_modules") links.push(path.join(rootLexical, first, second));
  return links.some((link) => {
    const st = lstatOf(link);
    // A link the child made after it started is not provisioned, whatever it points at.
    if (!st?.isSymbolicLink() || st.ctimeMs >= loadedAt) return false;
    const real = safeResolve(link);
    if (real === undefined) return false;
    return path.basename(real) === path.basename(link) && isInside(resolved, real);
  });
}

/**
 * Judge one write. `target` is what the tool was given (relative paths resolve
 * against `cwd`, the child's own working directory). The refusal message names
 * the path and the write root, and says nothing about the scratch or temp
 * allowances, so the child can correct itself without learning the rule's gaps.
 */
export function judgeWrite(
  target: string,
  cwd: string,
  cfg: FenceConfig,
  opts: JudgeOpts = {},
): WriteJudgement {
  const abs = path.isAbsolute(target) ? target : `${cwd}${path.sep}${target}`;
  const probe = { missing: false };
  let resolved: string;
  try {
    resolved = resolveLikeOs(abs, 0, probe);
  } catch (err) {
    return refuse(target, `it could not be resolved (${(err as Error).message})`);
  }
  if (opts.linkedCommand && probe.missing) {
    return refuse(
      target,
      "it is under a path this command creates, so it cannot be checked before the command runs. Write it in a separate command",
    );
  }
  if (cfg.allowed.some((dir) => isInside(resolved, dir))) return { ok: true };
  if (!cfg.root) {
    return refuse(
      target,
      `the write root is unusable (${JSON.stringify(cfg.rootLabel)}), so only the scratch and temp directories are writable until the driver sets a valid worktree`,
    );
  }
  if (isInside(resolved, cfg.root.real)) return { ok: true };
  if (dependencyLinkAllows(abs, cfg.root.lexical, resolved, cfg.loadedAt)) return { ok: true };
  return refuse(
    target,
    `it is outside your write root (${cfg.rootLabel}). Write only inside that worktree`,
  );
}

function refuse(target: string, why: string): WriteJudgement {
  return { ok: false, message: `Refused: ${target} — ${why}.` };
}
