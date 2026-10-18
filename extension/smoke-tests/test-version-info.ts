#!/usr/bin/env bun
/**
 * #1614 — the version line shown at session start and the
 * `/pi-rukas-version` report: a short commit when one is recorded, an
 * explicit "unknown" when not, and the version read from package.json.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { currentVersionLine, formatVersionLine, formatVersionReport } from "../src/version-info.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const sha = "bf2deb1a9c3e4d5f60718293a4b5c6d7e8f90123";

assert(
  formatVersionLine("0.12.80", sha) === "pi-rukas v0.12.80 · bf2deb1a9c3e",
  "version line carries the version and a 12-char commit",
);
assert(
  formatVersionLine("0.12.80", null) === "pi-rukas v0.12.80 · commit unknown",
  "version line says 'commit unknown' rather than guessing",
);

const report = formatVersionReport({
  version: "0.12.80",
  commit: sha,
  installRoot: "/opt/pi-rukas",
  piVersion: "1.0.0",
});
assert(report.includes(sha), "report carries the full commit");
assert(report.includes("/opt/pi-rukas"), "report carries the install root");
assert(/pi:\s+1\.0\.0/.test(report), "report carries the Pi version");

const unknown = formatVersionReport({
  version: "0.12.80",
  commit: null,
  installRoot: "/opt/pi-rukas",
  piVersion: null,
});
assert(/commit:\s+unknown/.test(unknown), "report says the commit is unknown");
assert(/pi:\s+unknown/.test(unknown), "report says the Pi version is unknown");

const pkg = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8"),
) as { version: string };
assert(
  currentVersionLine().startsWith(`pi-rukas v${pkg.version} · `),
  "the live line reports extension/package.json's version",
);

process.exit(exit);
