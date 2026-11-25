#!/usr/bin/env bun
/**
 * The verify gate's heartbeat switch: `PI_ENSEMBLE_VERIFY_HEARTBEAT_MS`.
 *
 * The behaviour of the beat itself is `test-verify-heartbeat.ts`'s; this file
 * owns the three things a knob must hold so it stays usable and discoverable:
 * the reader's own truth table, its registration in the headless input
 * inventory (which is also what scrubs it from a project's verify command), and
 * the documentation rows an operator actually reads — `docs/configuration.md`
 * for the switch, the stable-subset table in `docs/headless.md` for the line
 * the knob writes, and the troubleshooting entry for the failure it exists to
 * answer. A documented default that drifts from the resolver, or a row that no
 * longer describes the switch, fails here rather than in a host that stopped
 * trusting the progress stream.
 *
 * Run: bun smoke-tests/test-verify-heartbeat-switch.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { buildCapabilities } from "../src/headless/capabilities.ts";
import { HEADLESS_INPUTS } from "../src/headless/inputs.ts";
import { isStableKind, NDJSON_STABLE_FIELDS } from "../src/headless/ndjson.ts";
import { verifyChildEnv } from "../src/work-driver-verify-cmd.ts";
import { verifyHeartbeatMs } from "../src/work-driver-verify-events.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const KNOB = "PI_ENSEMBLE_VERIFY_HEARTBEAT_MS";
const DEFAULT_MS = 300_000;

// ── the reader's truth table ─────────────────────────────────────────────────
{
  const saved = process.env[KNOB];
  try {
    delete process.env[KNOB];
    assert(
      verifyHeartbeatMs() === DEFAULT_MS,
      `reader: unset reads the shipped 5-minute interval (got ${verifyHeartbeatMs()})`,
    );
    process.env[KNOB] = "";
    assert(verifyHeartbeatMs() === DEFAULT_MS, "reader: an empty value is the default, not off");
    process.env[KNOB] = "0";
    assert(verifyHeartbeatMs() === 0, "reader: an explicit 0 is the off switch");
    process.env[KNOB] = "45000";
    assert(verifyHeartbeatMs() === 45_000, "reader: an explicit interval is honoured");
    process.env[KNOB] = "45_000";
    assert(verifyHeartbeatMs() === 45_000, "reader: a digit-grouped value reads as its number");
    process.env[KNOB] = "1500.7";
    assert(
      verifyHeartbeatMs() === 1500,
      `reader: a fractional value is floored, never left as a float (got ${verifyHeartbeatMs()})`,
    );
    process.env[KNOB] = "abc";
    assert(
      verifyHeartbeatMs() === DEFAULT_MS,
      "reader: a value that is not a number is the shipped default, never an accidental off",
    );
    process.env[KNOB] = "-1";
    assert(
      verifyHeartbeatMs() === DEFAULT_MS,
      "reader: a negative value is the default — only 0 means off",
    );
  } finally {
    if (saved === undefined) delete process.env[KNOB];
    else process.env[KNOB] = saved;
  }
}

// ── registered, listed, and scrubbed from project commands ───────────────────
{
  const entry = HEADLESS_INPUTS.find((e) => e.name === KNOB);
  assert(
    entry?.type === "duration-ms" && entry.default === DEFAULT_MS,
    `headless inputs list ${KNOB} as a duration defaulting to ${DEFAULT_MS} (got ${JSON.stringify(entry)})`,
  );
  const names = HEADLESS_INPUTS.map((e) => e.name);
  assert(names.indexOf(KNOB) > names.indexOf("PI_ENSEMBLE_VERIFY_GATE_REUSE"), "the row sits at its sorted position in the verify block");
  assert(
    buildCapabilities().inputs.some((i) => i.name === KNOB),
    "the knob is in the --capabilities answer, so an operator can discover it",
  );
  // The verify env scrub builds its drop-list from this inventory, so a knob
  // missing here would reach the project's own command with the driver's value.
  const scrubbed = verifyChildEnv({ [KNOB]: "1", PATH: "/usr/bin" });
  assert(
    scrubbed[KNOB] === undefined && scrubbed.PATH === "/usr/bin",
    "the knob is in the scrub list: the project's verify never sees the driver's interval, and its PATH survives",
  );
  assert(
    Object.prototype.hasOwnProperty.call(NDJSON_STABLE_FIELDS, "verify-heartbeat") === true &&
      isStableKind("verify-heartbeat"),
    "verify-heartbeat is a declared stable NDJSON kind, so its fields are a host contract",
  );
  assert(
    JSON.stringify(NDJSON_STABLE_FIELDS["verify-heartbeat"]) ===
      JSON.stringify(["step", "command", "elapsedSeconds", "at"]),
    `and the contract names exactly step, command, elapsedSeconds and at (got ${JSON.stringify(NDJSON_STABLE_FIELDS["verify-heartbeat"])})`,
  );
}

// ── the rows an operator reads ───────────────────────────────────────────────
{
  const read = (file: string) =>
    readFileSync(path.resolve(import.meta.dirname, "..", "..", "docs", file), "utf8");

  const row = read("configuration.md")
    .split("\n")
    .find((l) => l.startsWith(`| \`${KNOB}\` |`));
  assert(row !== undefined, "docs/configuration.md carries a row for the switch");
  for (const [needle, why] of [
    ["`300000`", "names the shipped interval, so an operator knows the default silence"],
    ["`0`", "names the one off value, so an operator can spell the disable"],
    ["verify-heartbeat", "names the line the knob puts on the stream"],
    ["elapsedSeconds", "names the field a host reads"],
    ["verify-completed", "points at the end event the beats sit inside"],
    ["verifyChildEnv", "says the knob is scrubbed from a project command, not read there"],
    ["unref", "says a beat cannot keep the process alive"],
  ] as const) {
    assert(row?.includes(needle) === true, `the configuration row ${why} (looks for ${needle})`);
  }

  const headless = read("headless.md");
  const beatRow = headless.split("\n").find((l) => l.startsWith("| `verify-heartbeat` |"));
  assert(
    beatRow !== undefined &&
      beatRow.includes("`step`") &&
      beatRow.includes("`command`") &&
      beatRow.includes("`elapsedSeconds`") &&
      beatRow.includes("`at`"),
    "docs/headless.md's stable subset names verify-heartbeat and its four fields",
  );
  assert(
    beatRow?.includes("not a verdict") === true,
    "the row says a beat is progress and never a verdict, so no host infers an end from one",
  );
  const endRow = headless.split("\n").find((l) => l.startsWith("| `verify-completed` |"));
  assert(
    endRow?.includes("at most one") === true && endRow?.includes("no end") === true,
    "the row names the single end event and keeps a missing end as the killed-gate discriminator",
  );

  const troubleshooting = read("troubleshooting.md");
  const heading = troubleshooting
    .split("\n")
    .find((l) => l.startsWith("### ") && l.includes("stopped as stalled"));
  assert(heading !== undefined, "docs/troubleshooting.md has an entry for a cycle stopped as stalled");
  const section = troubleshooting.split(heading ?? "\u0000")[1] ?? "";
  assert(
    section.includes("verify-heartbeat") &&
      section.includes("heartbeat lines") &&
      section.includes("no end line") &&
      section.includes(KNOB),
    "that entry says to look for heartbeat lines and the end event, and names the switch that turns them off",
  );
}

process.exit(exit);
