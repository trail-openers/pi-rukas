#!/usr/bin/env bun
/**
 * Issue #2449 — the local gate arms the per-file wall-clock ceiling.
 *
 * Split out of `test-verify-cmd-no-bare-bunx.ts` (AGENTS.md §12 file-size cap),
 * which already reads `.pi/verify-cmd` and owns its shape. This is the second
 * property of that one line: the timing prefix on the loop invocation.
 *
 * The knob is read by `smoke-tests/lib/verify-timing.sh` from the ENVIRONMENT, so
 * the tier must name it on the loop call — and name it in the one spelling that
 * keeps the operator in charge: `${NAME:-30}`. A bare `NAME=30` overwrites an
 * exported `PI_ENSEMBLE_VERIFY_TIMING_CEILING_S=0`, which is the documented way to
 * take the ratchet off on a loaded host. That override is the whole property, so
 * it is pinned rather than left to a reader's goodwill.
 *
 * Nothing here trusts the shape to mean what it looks like: the prefix is taken
 * from the tier's own bytes and EXPANDED by a real bash with the ambient value
 * unset, `0`, and a custom number, so the gate judges what the shell would run.
 *
 * Run: bun smoke-tests/test-verify-cmd-timing-ceiling.ts
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const VERIFY_CMD = path.join(REPO_ROOT, ".pi", "verify-cmd");
const CEILING_KNOB = "PI_ENSEMBLE_VERIFY_TIMING_CEILING_S";
const CEILING_DEFAULT = "30";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The prefix this gate requires, in the tier's own spelling: the knob's
 *  `:-`-defaulted assignment glued to the `--jobs-from-host` loop invocation. */
const CEILING_PREFIX_RE = new RegExp(
  `^${CEILING_KNOB}="\\$\\{${CEILING_KNOB}:-([0-9]{1,4})\\}"\\s+bash\\s+smoke-tests/lib/verify-loop\\.sh\\s+--jobs-from-host\\b`,
);

const text = readFileSync(VERIFY_CMD, "utf8");
// The `&&` chain split into stages: the loop call is the stage that names the
// knob and the script, and exactly one such stage is what "armed, once" means.
const loopStages = text
  .split("&&")
  .map((l) => l.trim())
  .filter((l) => l.startsWith(CEILING_KNOB) && l.includes("smoke-tests/lib/verify-loop.sh"));
// `?? ""` so the canaries still run when the prefix is absent — the count
// assertion has already failed the run, and a crash would hide which one.
const loopStage = loopStages[0] ?? "";

assert(
  loopStages.length === 1,
  `exactly one verify-loop.sh invocation carries the ceiling prefix — found ${loopStages.length} (the knob comes from the environment, so no prefix means the local gate runs with the ceiling off)`,
);

const matched = CEILING_PREFIX_RE.exec(loopStage);
assert(
  matched !== null,
  `the loop call is prefixed with \`${CEILING_KNOB}="\${${CEILING_KNOB}:-${CEILING_DEFAULT}}" bash smoke-tests/lib/verify-loop.sh --jobs-from-host …\` — \`:-\` is the operator override, the number is the default: ${loopStage.slice(0, 140)}`,
);

/**
 * What bash answers for the knob when the tier's own prefix runs, with `ambient`
 * exported (unset when `undefined`). The assignment runs in the position the tier
 * has it — immediately before `bash` — so this is the tier's expansion, not a
 * re-implementation of it here.
 */
function expand(ambient: string | undefined): string | undefined {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (ambient === undefined) delete env[CEILING_KNOB];
  else env[CEILING_KNOB] = ambient;
  const probe = `${loopStage.split(" bash ")[0]} bash -c 'echo "$${CEILING_KNOB}"'`;
  const r = spawnSync("bash", ["-c", probe], {
    cwd: path.join(REPO_ROOT, "extension"),
    encoding: "utf8",
    env,
  });
  return r.status === 0 ? (r.stdout ?? "").trim() : undefined;
}

assert(
  matched?.[1] === CEILING_DEFAULT,
  `the tier's ceiling default is ${CEILING_DEFAULT} s (the docs' knob row states that number); the tier carries ${matched?.[1]}`,
);
assert(
  expand(undefined) === CEILING_DEFAULT,
  `with the ambient value unset the tier's ${CEILING_DEFAULT} binds (bash answered ${JSON.stringify(expand(undefined))})`,
);
assert(
  expand("0") === "0",
  `an ambient ${CEILING_KNOB}=0 survives the prefix — that is how the ratchet comes off on a loaded host (bash answered ${JSON.stringify(expand("0"))})`,
);
assert(
  expand("17") === "17",
  `an ambient ${CEILING_KNOB}=17 overrides the tier's default (bash answered ${JSON.stringify(expand("17"))})`,
);

// The allow-list is the only exemption the ceiling honours; a tier that arms the
// knob without naming it leaves a reader hunting for where a file is silenced.
assert(
  text.includes("timing-allowlist.json"),
  "the tier names extension/timing-allowlist.json — the exemption list is the ratchet's other half",
);

// ---- canaries: the two shapes this gate exists to refuse, observed refused

const bareAssignment = loopStage.replace(
  `${CEILING_KNOB}="\${${CEILING_KNOB}:-${CEILING_DEFAULT}}"`,
  `${CEILING_KNOB}=${CEILING_DEFAULT}`,
);
assert(
  bareAssignment !== loopStage && !CEILING_PREFIX_RE.test(bareAssignment),
  "canary: a bare assignment that overwrites the operator's export is caught (no `:-`)",
);
assert(
  !CEILING_PREFIX_RE.test(loopStage.replace(`${CEILING_KNOB}=`, "")),
  "canary: a loop call with no ceiling prefix is caught (the ceiling would sit silently off)",
);

console.log(
  exit === 0 ? "\nverify-cmd timing-ceiling prefix: all checks passed" : "\nverify-cmd timing-ceiling prefix: FAILED",
);
process.exit(exit);
