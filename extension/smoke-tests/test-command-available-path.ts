#!/usr/bin/env bun
/**
 * #723 — commandAvailable() must honour an in-process process.env.PATH
 * mutation made AFTER the process started (the PATH-shim technique
 * test-agents-md-scaffold.ts and other smoke tests use to stub a gate
 * command), and must still report a genuinely-missing command as missing.
 *
 * Confirmed root cause: execFileSync("command", ["-v", name], {shell:
 * "/bin/sh"}) with no explicit `env` does not reliably read a PATH mutation
 * made after process start under Bun 1.3.12 — passing `env: process.env`
 * reads the CURRENT value at call time, closing the gap.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { commandAvailable } from "../src/agents-md/check.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const tmp = mkdtempSync(path.join(tmpdir(), "pi-ens-cmdavail-"));
const shim = path.join(tmp, "bin");
mkdirSync(shim, { recursive: true });
const stubName = "totally-fake-gate-command-723";
writeFileSync(path.join(shim, stubName), "#!/bin/sh\nexit 0\n");
chmodSync(path.join(shim, stubName), 0o755);

const savedPath = process.env.PATH;

// 1. Positive case: an in-process PATH mutation prepending the shim dir must
// be honoured — this is what the scaffold test's PATH-shim technique relies on.
try {
  process.env.PATH = `${shim}${path.delimiter}${savedPath ?? ""}`;
  assert(
    commandAvailable(stubName) === true,
    "commandAvailable: in-process PATH mutation is honoured (shim command found)",
  );
} finally {
  process.env.PATH = savedPath;
}

// 2. Negative case: with the shim removed from PATH, the same command must
// report unavailable — the fix must not silently mask a genuinely-missing
// gate command.
assert(
  commandAvailable(stubName) === false,
  "commandAvailable: genuinely-missing command still reports unavailable",
);

// 3. A command that was never on PATH at all (no shim involved).
assert(
  commandAvailable("definitely-not-a-real-binary-anywhere-723") === false,
  "commandAvailable: unknown command reports unavailable",
);

rmSync(tmp, { recursive: true, force: true });

console.log(exit === 0 ? "\nAll commandAvailable PATH checks passed." : "\nFAILED");
process.exit(exit);
