/**
 * lib/lean-verify-bytes — the frozen-test source and runner-helper bytes the
 * `lean/verify` fixture freezes, and the one way to commit them.
 *
 * These are DATA, not harness wiring: each string is the exact body of a file the
 * step's runner executes, and a case's verdict follows from what those bytes print
 * and which exit they take. They live apart from `lean-verify-fixture.ts` for the
 * same reason the tiers live in `lean-verify-tiers.ts` — the fixture module is the
 * git choreography, and a frozen test's text is the thing being choreographed.
 *
 * Two rules the bytes have to keep, both earned the hard way:
 *
 *   - a frozen test's red may not depend on how one machine's `grep` parses a dash.
 *     The predicate is a file EXISTENCE check for that reason (measured: GNU grep
 *     3.12 in this container reports no match for a hyphenated literal the file
 *     plainly holds, while `grep -c --` on the same bytes matches);
 *   - a frozen test that fails must NAME itself, or `runTestFile` reads the run as
 *     `unclear`. A `verify.test` template is argv-form and may carry no shell
 *     metacharacter (config.ts refuses one), so a template cannot echo the path
 *     itself — that is what `NAMING_RUNNER_*` is for.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { git } from "./lean-verify-git.ts";

/** The implementation the frozen test is red against. */
export const SRC = "export const retry = () => { throw new Error('not implemented'); };\n";

/**
 * The fixture's frozen test. It is RED while `src/DONE` is absent and goes green
 * when the case creates it (`implement: true`) — which is what makes the green
 * case and the red case the same repo with one file between them.
 *
 * It names its own path when it fails, which is how `runTestFile` tells a real red
 * from a runner that broke somewhere else.
 */
export const TEST =
  '#!/bin/sh\nif [ ! -f src/DONE ]; then echo "not ok - tests/AC1-retry.test.sh" 1>&2; exit 1; fi\nexit 0\n';

/** A frozen test that passes whatever the source does: a contract nobody wrote. */
export const GREEN_TEST = "#!/bin/sh\nexit 0\n";

/** The frozen contract RED whatever the tree holds — the acceptance-red half of a pair. */
export const RED_ACCEPTANCE_TEST =
  "#!/bin/sh\necho 'not ok - tests/AC1-retry.test.sh' 1>&2\nexit 1\n";

/**
 * An acceptance test the BASE commit carries and cannot pass: the mainline that is
 * already red on this host. Committed at `baseSha` for the baseline-red cases, so the
 * probe's frozen run goes red there for a reason the fixture can point at in git.
 *
 * It fails UNCONDITIONALLY rather than on a missing file: the run's own work is committed
 * on top of the base and cannot make the base's red go away, so a base that is red stays
 * red however much of the change the checkout happens to hold.
 */
export const RED_BASE_TEST = '#!/bin/sh\necho "not ok" 1>&2\nexit 1\n';

/** The committed name of the helper script the silent-runner case writes. */
export const SILENT_RUNNER_FILE = "silent-runner.sh";
/**
 * The helper for the one case that needs a runner of its own: a frozen test
 * whose failure is not attributable to itself.
 *
 * The fixture's own `sh {file}` template cannot produce that shape — its test
 * echoes its own path when it fails — so the case that asks what an
 * unattributable failure becomes needs a runner that stays quiet and exits
 * non-zero. The file was proven red-and-named at freeze time, so that is the
 * same failure continuing: a RED.
 */
export const SILENT_RUNNER_SCRIPT = "exit 1\n";
/** The template that case configures; `validateTestRunner` wants `{file}` whole. */
export const SILENT_RUNNER_TEMPLATE = "sh silent-runner.sh {file}";

/**
 * The helper the cases with an unconditional-red frozen contract configure as the
 * `verify.test` runner. `sh {file}` cannot serve them: the template cannot echo the
 * path (see this module's header), so this committed helper does, exactly as a real
 * project's runner names a file whose assertions failed.
 */
export const NAMING_RUNNER_FILE = "naming-runner.sh";
export const NAMING_RUNNER_SCRIPT = 'echo "not ok - ${1##*/}" 1>&2\nexit 1\n';
export const NAMING_RUNNER_TEMPLATE = `sh ${NAMING_RUNNER_FILE} {file}`;

/**
 * Write `rel` -> `text` as an executable and commit the set — the extra frozen files
 * a case declares besides the fixture's own contract.
 *
 * They are committed, never left on disk: the step refuses an uncommitted tree before
 * it runs a test, and a frozen file whose bytes the record does not name reads as a
 * tampered contract rather than as the hang or exit the case is about.
 */
export function commitFrozenFiles(dir: string, entries: Record<string, string>): void {
  for (const [rel, text] of Object.entries(entries)) {
    const target = path.join(dir, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text, { mode: 0o755 });
    chmodSync(target, 0o755);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "test: extra frozen acceptance tests");
}
