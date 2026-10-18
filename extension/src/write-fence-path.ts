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
}

export type WriteJudgement = { ok: true } | { ok: false; message: string };

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Resolve an absolute path the way the OS does. A symlink is followed where it
 * sits, so a `..` after it climbs from its target. A segment that does not exist
 * is taken lexically: the nearest existing ancestor is already resolved by then.
 * Throws on a symlink loop, which the caller turns into a refusal.
 */
export function resolveLikeOs(abs: string, depth = 0): string {
  if (depth > MAX_SYMLINK_DEPTH) throw new Error(`too many symbolic links resolving ${abs}`);
  let cur: string = path.sep;
  for (const seg of abs.split(path.sep)) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      cur = path.dirname(cur);
      continue;
    }
    const next = path.join(cur, seg);
    if (isSymlink(next)) {
      // Joined raw, not path.resolve'd: a link's own `..` must still be resolved by the OS rule.
      const target = readlinkSync(next);
      cur = resolveLikeOs(
        path.isAbsolute(target) ? target : `${cur}${path.sep}${target}`,
        depth + 1,
      );
    } else {
      cur = next;
    }
  }
  return cur;
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
  return { lexical, real: resolveLikeOs(lexical) };
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
  if (scratch && path.isAbsolute(scratch)) allowed.push(resolveLikeOs(path.resolve(scratch)));
  for (const tmp of [os.tmpdir(), "/tmp", "/private/tmp"]) {
    allowed.push(resolveLikeOs(path.resolve(tmp)));
  }
  return { root: usableRoot(rawRoot), rootLabel: rawRoot, allowed };
}

/**
 * A write to `abs` is inside the worktree's own provisioned dependency tree when
 * its LEXICAL path runs through a dependency link the worktree owns, and the
 * resolved target lies inside what that link points at. The link must be one
 * `worktree-provision.ts` creates (a shareable dep at the root, or `node_modules`
 * one package directory down) and must point at a tree of the same name, so a
 * symlink a child made itself to `/etc` is not a dependency tree.
 */
function dependencyLinkAllows(abs: string, rootLexical: string, resolved: string): boolean {
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
    if (!isSymlink(link)) return false;
    let real: string;
    try {
      real = resolveLikeOs(link);
    } catch {
      return false;
    }
    return path.basename(real) === path.basename(link) && isInside(resolved, real);
  });
}

/**
 * Judge one write. `target` is what the tool was given (relative paths resolve
 * against `cwd`, the child's own working directory). The refusal message names
 * the path and the write root, and says nothing about the scratch or temp
 * allowances, so the child can correct itself without learning the rule's gaps.
 */
export function judgeWrite(target: string, cwd: string, cfg: FenceConfig): WriteJudgement {
  const abs = path.isAbsolute(target) ? target : `${cwd}${path.sep}${target}`;
  let resolved: string;
  try {
    resolved = resolveLikeOs(abs);
  } catch (err) {
    return refuse(target, `it could not be resolved (${(err as Error).message})`);
  }
  if (cfg.allowed.some((dir) => isInside(resolved, dir))) return { ok: true };
  if (!cfg.root) {
    return refuse(
      target,
      `the write root is unusable (${JSON.stringify(cfg.rootLabel)}), so only the scratch and temp directories are writable until the driver sets a valid worktree`,
    );
  }
  if (isInside(resolved, cfg.root.real)) return { ok: true };
  if (dependencyLinkAllows(abs, cfg.root.lexical, resolved)) return { ok: true };
  return refuse(
    target,
    `it is outside your write root (${cfg.rootLabel}). Write only inside that worktree`,
  );
}

function refuse(target: string, why: string): WriteJudgement {
  return { ok: false, message: `Refused: ${target} — ${why}.` };
}
