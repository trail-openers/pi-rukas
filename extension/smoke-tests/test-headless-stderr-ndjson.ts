#!/usr/bin/env bun
/**
 * #1370 — a headless run's stderr is NDJSON only. The driver's own plain-text
 * diagnostics (`trace`, `traceWarn`, `console.*`, the pi-binary-resolve PATH
 * warning) are rerouted as `log` lines, and stdout stays free of them.
 *
 * A child process installs the capture the way cli.ts does, then writes
 * through every channel. A canary run without the capture proves the probe
 * would see the plain-text lines. Offline.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateNdjsonLine } from "../src/headless/ndjson.ts";
import { levelOf, strayLine } from "../src/headless/stderr.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const src = path.resolve(import.meta.dirname, "..", "src");
const PATH_WARNING =
  "[pi-rukas] pi-binary-resolve: WARNING — pi resolved from PATH, no integrity check performed";

// ── Unit: levels and the line shape.
assert(
  levelOf("[pi-rukas] WARN review round unrecorded") === "warn",
  "a traceWarn line is a warning",
);
assert(levelOf(PATH_WARNING) === "warn", "the pi-binary-resolve WARNING line is a warning");
assert(levelOf("[pi-rukas] /work fired") === "info", "a trace line is info");
{
  const warn = JSON.parse(strayLine("x", "warn")) as Record<string, unknown>;
  const info = JSON.parse(strayLine("y", "info")) as Record<string, unknown>;
  assert(
    validateNdjsonLine(warn).length === 0 && warn.level === "warn",
    "a warning line validates and carries level",
  );
  assert(
    validateNdjsonLine(info).length === 0 && !("level" in info),
    "an info line validates and has no level",
  );
  assert(
    validateNdjsonLine({ ...info, level: "debug" }).length > 0,
    "an unknown level is rejected",
  );
}

// ── Child process: every channel the driver writes plain text through.
const dir = mkdtempSync(path.join(tmpdir(), "headless-stderr-"));
const probe = path.join(dir, "probe.ts");
writeFileSync(
  probe,
  `import { captureStrayOutput } from ${JSON.stringify(path.join(src, "headless", "stderr.ts"))};
import { reportResolutionWarning } from ${JSON.stringify(path.join(src, "pi-binary-resolve.ts"))};
import { trace, traceWarn } from ${JSON.stringify(path.join(src, "trace.ts"))};
const cap = process.env.PROBE_CAPTURE === "1" ? captureStrayOutput() : undefined;
const write = cap?.write ?? ((l: string) => process.stderr.write(l + "\\n"));
write(JSON.stringify({ v: 1, kind: "log", at: new Date().toISOString(), message: "runner" }));
reportResolutionWarning({ warning: ${JSON.stringify(PATH_WARNING)} });
traceWarn("review round unrecorded");
trace("debug line");
console.log("a stray console.log");
console.error("an error", { code: 7 });
process.stderr.write("multi\\nline ");
process.stderr.write(Buffer.from("tail\\n"));
process.stderr.write("unterminated");
cap?.flush();
`,
);

function runProbe(capture: boolean) {
  const r = spawnSync("bun", [probe], {
    encoding: "utf8",
    env: { ...process.env, PROBE_CAPTURE: capture ? "1" : "0", PI_ENSEMBLE_DEBUG: "1" },
  });
  const lines = r.stderr.split("\n").filter((l) => l !== "");
  const parsed = lines.map((l) => {
    try {
      return JSON.parse(l) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  });
  return { r, lines, parsed };
}

{
  const canary = runProbe(false);
  assert(
    canary.parsed.some((p) => p === undefined),
    "canary: without the capture, stderr carries non-JSON lines",
  );
}
{
  const { r, lines, parsed } = runProbe(true);
  assert(r.status === 0, `the probe exits 0 (got ${r.status})`);
  assert(r.stdout === "", `stdout stays empty (got ${JSON.stringify(r.stdout)})`);
  assert(
    parsed.every((p) => p !== undefined && validateNdjsonLine(p).length === 0),
    `every stderr line is a valid NDJSON v1 line (${lines.filter((_, i) => parsed[i] === undefined).join(" | ")})`,
  );
  const messages = parsed.map((p) => p?.message);
  const byMessage = (m: string) => parsed.find((p) => p?.message === m);
  assert(
    byMessage("runner")?.level === undefined,
    "the runner's own line passes through unchanged",
  );
  assert(
    byMessage(PATH_WARNING)?.level === "warn",
    "the pi-binary-resolve warning is a log line with level warn",
  );
  assert(
    byMessage("[pi-rukas] WARN review round unrecorded")?.level === "warn",
    "traceWarn becomes a warning log line",
  );
  assert(byMessage("[pi-rukas] debug line")?.level === undefined, "trace becomes an info log line");
  assert(byMessage("a stray console.log") !== undefined, "console.log is rerouted off stdout");
  assert(
    byMessage("an error { code: 7 }")?.level === "warn",
    "console.error is formatted as one warning",
  );
  assert(
    messages.includes("multi") &&
      messages.includes("line tail") &&
      messages.includes("unterminated"),
    "raw writes are split on newlines, joined across chunks, and flushed at the end",
  );
  assert(
    parsed.every((p) => p?.kind === "log"),
    "every rerouted line is a log line",
  );
}

rmSync(dir, { recursive: true, force: true });
console.log(`\nexit ${exit}`);
process.exit(exit);
