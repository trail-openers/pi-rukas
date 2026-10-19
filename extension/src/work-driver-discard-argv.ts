/**
 * work-driver-discard-argv — the hardened, bounded argv for every git call the
 * #1676 discard pass issues (`work-driver-discard-deferred.ts`).
 *
 * Why a module of its own: the 500-line cap (AGENTS.md §12), and because the
 * hardening is the load-bearing part and deserves one place that says why. It
 * reuses `SAFE_CONFIG` — the same `-c` pairs the #406 protected-path reads carry
 * (`work-driver-protected-paths-read.ts`) — rather than restating a list that
 * would drift from the one the gate's canary asserts on.
 *
 * **The discard's `git commit` is a WRITE, which is what makes the prefix
 * non-optional here.** The #406 reads were defensible as read-only; the discard
 * runs `git commit` and `git checkout`/`git rm` in a worktree the developer, a
 * lens-fix or a malicious dependency can write. Measured on git 2.50.1: a
 * child-written executable `.git/hooks/pre-commit` (exit 1) DOES abort an
 * unguarded `git commit -- <path>`, and adding `-c core.hooksPath=/dev/null`
 * makes the same commit succeed — so the pair is load-bearing for the revert
 * commit, not decorative. `core.fsmonitor=false` closes the monitor-script route
 * the same way. `core.quotePath=off` is kept because the discarded path appears
 * verbatim in argv; if a future git version echoes a non-ASCII name in a fatal
 * message, the operator should read the name, not octal escapes.
 *
 * The `filter.<name>.clean=false` entries are inherited defence-in-depth for the
 * conventional names only — see the long block in `work-driver-protected-paths-read.ts`
 * for why a child-chosen filter name cannot be blanket-blocked, and that this is
 * NOT the safety boundary of these calls. `git commit` reaches a `clean` filter
 * the same way `git add`/`git diff` does (it materialises the blob), so the
 * writes carry the same list rather than a shorter one.
 *
 * **Timeouts and buffers are NOT set here.** Every call carries
 * `DEFAULT_GIT_TIMEOUT_MS` explicitly at its call site, and a shared object with
 * a timeout baked in would be a second, silent knob a caller could override
 * without noticing. `maxBuffer` is likewise per call site, sized to what each
 * command can print: `DISCARD_NAME_MAX_BUFFER` for a name-set read,
 * `DISCARD_WRITE_MAX_BUFFER` for a write that prints a summary line.
 */

import { SAFE_CONFIG } from "./work-driver-protected-paths-read.ts";

/** Hardened prefix for every git call the discard pass makes — reads and writes
 *  alike. One list, so the two families cannot drift apart. */
export const DISCARD_GIT_ARGV: readonly string[] = SAFE_CONFIG;

/** Byte ceiling on a name-set read (`status --porcelain -z`, `diff --name-status -M -z`,
 *  `ls-tree --name-only`): paths only, bounded by what a cycle can plausibly touch. */
export const DISCARD_NAME_MAX_BUFFER = 8 * 1024 * 1024;

/** Byte ceiling on a write (`commit`, `checkout`, `rm`): git prints a summary line,
 *  not content, so a small ceiling is a real ceiling rather than a large guess. */
export const DISCARD_WRITE_MAX_BUFFER = 1 * 1024 * 1024;
