/**
 * temp-bytes-stub-2051 — the fixture #2051's AC3 test writes its leak through,
 * kept out of the test file so that file stays an acceptance test.
 *
 * `installStubChild`'s `stub.body` hook runs at the moment the child's process
 * is created, i.e. INSIDE the operator-config guard's measurement window, so a
 * write made there is a write the child made during its own run — the exact
 * shape of the field incident (a lens that generated synthetic transcripts
 * under the temp dir and never removed them).
 */

import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { trackedTempDir } from "./git-test-env.ts";

/**
 * A scratch dir under the temp root this process's TMPDIR names, removed by
 * `git-test-env.ts`'s process-end / SIGTERM cleanup: the test that measures a
 * temp leak must not itself be a temp leak.
 */
export function childFreeTemp(tag: string): string {
  return trackedTempDir(`pi-2051-${tag}-`);
}

/**
 * Write `bytes` of REAL (allocated) content to `file`.
 *
 * Real, never `truncate`d: the measure is `st_blocks * 512`, and a sparse file
 * reports a huge apparent size for almost no blocks — a fixture that cheated
 * here would clear the threshold arm while allocating nothing at all.
 */
export function writeRealBytes(file: string, bytes: number): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.alloc(bytes, 0x78));
}

/**
 * A directory built the way the HARNESS builds its own temp trees: `mkdtemp`
 * then an explicit `chmod 0700`. The explicit chmod is the load-bearing half —
 * a bare `mkdir` inherits `0777 & ~umask`, which on this host is `0775` and on
 * the common umask `022` is `0755`, and neither is what the harness skip
 * matches. So a fixture that wants a directory the walk must skip (or wants to
 * prove it must not) states the mode here rather than inheriting the host's
 * umask, and the two shapes stay reproducible on any host.
 */
export function harnessModeDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

/**
 * A directory built the way a CHILD's own `mkdir` builds one: `mkdir` with no
 * mode at all, which is `0777 & ~umask` — never `0700` on any umask at or below
 * `007`. Paired with {@link harnessModeDir} so the walk's two opposite
 * expectations (skip this, measure that) are both stated by name instead of by
 * whatever the host's umask happens to produce.
 */
export function childModeDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Allocated bytes of a tree, measured OUTSIDE this module: `du` counts 1024-byte
 * blocks, so its figure is scaled to the 512-byte blocks the walk sums. A walk
 * assertion that compared only against a byte number the test itself chose could be
 * satisfied by a walk that measured something else; agreeing with an external
 * enumeration of the same tree is what makes "what is counted" the assertion.
 *
 * `exclude` matches NAMES, not paths, so a name listed here is skipped wherever it
 * appears — which is why a caller must not name a fixture after another fixture's
 * entry. `du` does not follow a symlink (measured: a root holding only a link to a
 * 140 MB tree reports 1 KiB), so a link is not a witness on its own; compare such a
 * tree against its target's own `duBytes`, not the link's.
 */
export function duBytes(target: string, ...exclude: string[]): number {
  const args = ["-As", ...exclude.map((p) => `--exclude=${p}`), target];
  const out = execFileSync("du", args).toString().trim().split(/\s+/)[0];
  return Number(out) * 1024;
}

/**
 * A directory carrying a harness prefix, mode `0700` and a `bytes` leak, owned by a
 * uid this process is NOT — the one conjunct of the harness skip a fixture cannot
 * `chmod` into place, since `chown` needs privilege this test does not have. Built
 * through `unshare`'s user namespace, which makes the parent see a foreign uid;
 * `undefined` when this host cannot provide one (no `unshare`, no `newuidmap`, a
 * locked-down kernel), in which case the caller states the conjunct rather than
 * pretending to measure it.
 */
export async function makeForeignOwnedDir(
  dir: string,
  bytes: number,
): Promise<string | undefined> {
  mkdirSync(dir, { recursive: true });
  writeRealBytes(path.join(dir, "leak.bin"), bytes);
  const quoted = JSON.stringify(dir);
  for (const map of ["100000:0:1", "1:0:1"]) {
    try {
      execFileSync("unshare", [
        "-r",
        `--map-users=${map}`,
        `--map-groups=${map}`,
        "sh",
        "-c",
        `chmod 700 ${quoted} && chown 0:0 ${quoted}`,
      ]);
    } catch {
      continue;
    }
    const st = lstatSync(dir);
    if (st.uid !== (process.getuid?.() ?? -1) && (st.mode & 0o777) === 0o700) return dir;
  }
  rmSync(dir, { recursive: true, force: true });
  return undefined;
}

/**
 * A child's own directory, built the way `mkdir` builds one and then widened to
 * `0755` — the shape the harness skip must refuse. Stated as a helper because the
 * walk's own header rests on "a child's `mkdir` is never `0700`", and a fixture
 * that inherited the mode from the host umask would be asserting whatever umask
 * the runner happened to export.
 */
export function childWideDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o755);
  return dir;
}

/** `chmod` a tree to a mode the harness skip reads as ours (0700) or not (any other). */
export function setMode(dir: string, mode: number): void {
  chmodSync(dir, mode);
}
