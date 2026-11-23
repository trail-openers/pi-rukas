#!/usr/bin/env bun
/**
 * The base roster run reads the report its own command wrote, when the head tree's path is a prefix
 * of the base tree's — the shape lean's trees always have (`lean-<issue>` and
 * `lean-<issue>-roster-base`). Real exec, real script: the command is rendered for the head tree,
 * retargeted to the base tree, run there, and its report read back. A run that writes no report
 * hands back with its exit code and output, so the hand-back says what the command printed.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execp } from "../src/exec.ts";
import {
  renderRosterCommand,
  retargetRosterCommand,
  runProjectSuite,
} from "../src/lean/verify-roster-command.ts";
import type { VerifyExec, VerifyRosterConfig } from "../src/lean/verify-types.ts";

const SELF = "test-lean-roster-retarget-prefix.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(tmpdir(), "roster-prefix-"));
const head = path.join(root, ".worktrees", "lean-7");
const base = `${head}-roster-base`;
mkdirSync(head, { recursive: true });
mkdirSync(base, { recursive: true });
const runner = path.join(root, "roster.sh");
writeFileSync(
  runner,
  `#!/bin/sh\nprintf '<testsuite><testcase name="t"/></testsuite>\\n' > "$2"\nexit 0\n`,
);
const real = ((cmd: string, opts?: object) => execp(cmd, opts ?? {})) as unknown as VerifyExec;

const rendered = renderRosterCommand(
  { roster: `sh ${runner} {dir} {report}` } as VerifyRosterConfig,
  head,
);
if ("reason" in rendered) throw new Error(rendered.reason);
const moved = retargetRosterCommand(rendered, head, base);
assert(
  moved.args[1] === base &&
    moved.args[2] === moved.report &&
    moved.report === path.join(base, ".lean-roster-report.xml"),
  `the retargeted command names the base tree and the report it reads (${JSON.stringify(moved.args)})`,
);
const r = await runProjectSuite(real, { cwd: base, ...moved, timeoutMs: 10_000, reportCwd: base });
assert(r.ran === true, `the base run reads the report its command wrote (${JSON.stringify(r)})`);

writeFileSync(path.join(root, "quiet.sh"), "#!/bin/sh\necho 'no such fixture dir' >&2\nexit 3\n");
const none = await runProjectSuite(real, {
  cwd: base,
  bin: "sh",
  args: [path.join(root, "quiet.sh")],
  report: moved.report,
  timeoutMs: 10_000,
  reportCwd: base,
});
assert(
  !none.ran && /exit 3/.test(none.reason) && /no such fixture dir/.test(none.reason),
  `a run with no report hands back naming its exit and stderr (${JSON.stringify(none)})`,
);

process.exit(exit);
