#!/usr/bin/env bun
/**
 * Issue #2449 — the local gates arm the per-file wall-clock ceiling.
 *
 * Split out of `test-verify-cmd-no-bare-bunx.ts` (AGENTS.md §12 file-size cap),
 * which already reads `.pi/verify-cmd` and owns its shape. This is the second
 * property of that one line: the timing prefix on the loop invocation, checked for
 * BOTH tiers — `.pi/verify-cmd` (the develop gate) and `.pi/verify-cmd-full` (the
 * suite the ci step runs locally). An armed develop tier and a silent full tier is
 * half a ratchet: the slower half of the gate would absorb exactly the file the
 * ceiling exists to name.
 *
 * The knob is read by `smoke-tests/lib/verify-timing.sh` from the ENVIRONMENT, so
 * each tier must name it on its loop call — and name it in the one spelling that
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
import { readFirstConfigLine } from "../src/work-driver-verify-cmd.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const CEILING_KNOB = "PI_ENSEMBLE_VERIFY_TIMING_CEILING_S";
const CEILING_DEFAULT = "30";
/** Tiers that run the loop: the develop gate and the full suite the ci step runs. */
const TIERS = [".pi/verify-cmd", ".pi/verify-cmd-full"];

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The prefix this gate requires, in the tier's own spelling: the knob's
 *  `:-`-defaulted assignment glued to the `--jobs-from-host` loop invocation. The
 *  default is one to four non-zero-leading digits, so the capture cannot pick up a
 *  padded or empty spelling and still report a number. */
const CEILING_PREFIX_RE = new RegExp(
  `^${CEILING_KNOB}="\\$\\{${CEILING_KNOB}:-([1-9][0-9]{0,3})\\}"\\s+bash\\s+smoke-tests/lib/verify-loop\\.sh\\s+--jobs-from-host\\b`,
);

/** The loop stages of a tier: the `&&`-separated words that name both the knob and
 *  the script. The executable line only — the tier's comments NAME the knob and the
 *  allow-list to explain them, and a comment is not an invocation. */
function executableLoopStages(text: string): string[] {
  const line = readFirstConfigLine(text) ?? "";
  return line
    .split("&&")
    .map((l) => l.trim())
    .filter((l) => l.startsWith(CEILING_KNOB) && l.includes("smoke-tests/lib/verify-loop.sh"));
}

for (const rel of TIERS) {
  const text = readFileSync(path.join(REPO_ROOT, rel), "utf8");
  const stages = executableLoopStages(text);
  // `?? ""` so the canaries still run when the prefix is absent — the count
  // assertion has already failed the run, and a crash would hide which one.
  const stage = stages[0] ?? "";

  assert(
    stages.length === 1,
    `${rel}: exactly one verify-loop.sh invocation carries the ceiling prefix — found ${stages.length} (the knob comes from the environment, so no prefix means this tier runs with the ceiling off)`,
  );

  const matched = CEILING_PREFIX_RE.exec(stage);
  assert(
    matched !== null,
    `${rel}: the loop call is prefixed with \`${CEILING_KNOB}="\${${CEILING_KNOB}:-${CEILING_DEFAULT}}" bash smoke-tests/lib/verify-loop.sh --jobs-from-host …\` — \`:-\` is the operator override, the number is the default: ${stage.slice(0, 140)}`,
  );

  /**
   * What bash answers for the knob when this tier's own prefix runs, with `ambient`
   * exported (unset when `undefined`). The assignment runs in the position the tier
   * has it — immediately before `bash` — so this is the tier's expansion, not a
   * re-implementation of it here. Bound once per ambient value: the assertion's
   * message must quote the SAME answer it judged, not a second probe.
   */
  const expand = (ambient: string | undefined): string | undefined => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (ambient === undefined) delete env[CEILING_KNOB];
    else env[CEILING_KNOB] = ambient;
    const probe = `${stage.split(" bash ")[0]} bash -c 'echo "$${CEILING_KNOB}"'`;
    const r = spawnSync("bash", ["-c", probe], {
      cwd: path.join(REPO_ROOT, "extension"),
      encoding: "utf8",
      env,
    });
    return r.status === 0 ? (r.stdout ?? "").trim() : undefined;
  };

  assert(
    matched?.[1] === CEILING_DEFAULT,
    `${rel}: the tier's ceiling default is ${CEILING_DEFAULT} s (the docs' knob row states that number); the tier carries ${matched?.[1]}`,
  );
  for (const ambient of [undefined, "0", "17"]) {
    const expected = ambient ?? CEILING_DEFAULT;
    const answered = expand(ambient);
    assert(
      answered === expected,
      `${rel}: ${
        ambient === undefined
          ? `with the ambient value unset the tier's ${CEILING_DEFAULT} binds`
          : `an ambient ${CEILING_KNOB}=${ambient} survives the prefix — that is how the ratchet comes off on a loaded host`
      } (bash answered ${JSON.stringify(answered)})`,
    );
  }

  // The allow-list is the only exemption the ceiling honours; a tier that arms the
  // knob without naming it leaves a reader hunting for where a file is silenced.
  assert(
    text.includes("timing-allowlist.json"),
    `${rel}: the tier names extension/timing-allowlist.json — the exemption list is the ratchet's other half`,
  );

  // ---- canaries: the two shapes this gate exists to refuse, observed refused.
  // Each mutant is BUILT BY CONSTRUCTION from the tier's own stage — the needle is
  // derived from the bytes, never a literal that could be absent from them, which
  // is what makes a `replace()`-built canary vacuous when the needle does not occur.
  const needle = `${CEILING_KNOB}="\${${CEILING_KNOB}:-${matched?.[1] ?? CEILING_DEFAULT}}"`;

  const bareAssignment = stage.replace(needle, `${CEILING_KNOB}=${matched?.[1] ?? CEILING_DEFAULT}`);
  assert(
    stage.includes(needle) && bareAssignment !== stage,
    `canary ${rel}: the bare-assignment mutant is a real edit of this tier's own call (the needle occurred and the bytes changed)`,
  );
  assert(
    !CEILING_PREFIX_RE.test(bareAssignment),
    `canary ${rel}: a bare assignment that overwrites the operator's export is caught (no \`:-\`)`,
  );

  const noPrefix = stage.replace(`${needle} `, "");
  assert(
    noPrefix !== stage && noPrefix.startsWith("bash "),
    `canary ${rel}: the no-prefix mutant is a real edit of this tier's own call (the prefix came off and the loop call is what is left)`,
  );
  assert(
    !CEILING_PREFIX_RE.test(noPrefix),
    `canary ${rel}: a loop call with no ceiling prefix is caught (the ceiling would sit silently off)`,
  );
}

console.log(
  exit === 0 ? "\nverify-cmd timing-ceiling prefix: all checks passed" : "\nverify-cmd timing-ceiling prefix: FAILED",
);
process.exit(exit);
