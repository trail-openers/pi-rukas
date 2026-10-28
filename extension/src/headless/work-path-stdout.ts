/**
 * headless/work-path-stdout — the ONE stdout writer on the `work` path (#1863
 * round 1, security).
 *
 * stdout is the host's contract: exactly one document, parsed as plain JSON, and
 * one writer may produce it. A second document — a late wedge racing a healthy
 * `work()`, or the supervisor's crash projection landing after a forwarded child
 * document — would leave the host reading one line and discarding the other, and
 * which one wins depends on the reader. So every `work`-path write goes through
 * this latch: the first document is the document, and every later call is
 * refused, never written, and traced to stderr (NDJSON `log` territory, not the
 * host's stream). `captureStrayOutput` keeps wrapping `console.*` and the `trace`
 * channels for the duration of a run, so this is the only way a line gets there.
 *
 * Its own leaf module, rather than a couple of lines in `cli.ts`, for two
 * reasons: the supervisor and the runner both need it and neither may import the
 * other (their cycle would make the CLI's entry-point guard run inside a library
 * import), and a one-line latch is exactly the kind of statement that drifts into
 * a bare `process.stdout.write` — a gate (`test-headless-runner-result-document.ts`)
 * now fails if either call site bypasses it.
 *
 * The latch is process-scoped, which is what makes the tiers compose: in a
 * supervised run the SUPERVISOR's process is the one that talks to the host (the
 * child's stdout is a pipe), so the child's writes land in that pipe and the
 * supervisor's single forwarded line is what is guarded here. In a single-tier
 * run (`PI_ENSEMBLE_HEADLESS_SUPERVISED=1`) this fd IS the host's, and the
 * guarantee's single-writer structure is the second line of defence.
 *
 * The S6 verbs and `--capabilities` print one document each and never reach the
 * `work` path: outside the latch by shape, not by exception.
 */

import { trace } from "../trace.ts";

/**
 * Where a refused document is reported. Its own indirection, not a call to
 * `trace` at the site, so a test can observe the refusal without a host
 * attached: `captureStrayOutput` turns a `trace` line into an NDJSON `log`
 * object, which is exactly why matching on the word "refused" in a child's
 * stderr was unreadable. Production behaviour is `trace`'s.
 */
let onRefusal: (msg: string) => void = (m) => trace(m);

let written = false;

/** Write the run's result document, or refuse it if one already went out. */
export function workPathStdout(s: string): void {
  if (written) {
    onRefusal(`headless: refused a second stdout result document (${s.length} bytes)`);
    return;
  }
  written = true;
  process.stdout.write(s);
}

/** @internal Test-only: has a document already gone out from this process? */
export function isWorkPathStdoutArmed(): boolean {
  return written;
}

/**
 * @internal Test-only. Redirects the refusal notice, so a test can observe the
 * refusal instead of matching on a `trace` line that `captureStrayOutput`
 * reshapes into an NDJSON object. Returns the previous handler to restore.
 *
 * It deliberately does NOT re-arm the latch. An earlier version did, and the
 * test that used it then attempted the "second" write on a freshly disarmed
 * latch — which legitimately went through, and the case passed by asserting on
 * nothing while the host really had read two documents. A latch a test can
 * quietly disarm is not the property under test, so the knob is not offered.
 */
export function setWorkPathStdoutRefusal(refusal: (msg: string) => void): (msg: string) => void {
  const prev = onRefusal;
  onRefusal = refusal;
  return prev;
}
