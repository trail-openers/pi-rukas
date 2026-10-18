#!/usr/bin/env bun
/**
 * #1647 — ALWAYS_RUN completeness. A smoke test that reads repository source or
 * configuration as text depends on files no import graph shows, so it must be
 * listed in ALWAYS_RUN or a develop round will skip it for a change to the file
 * it reads. This test runs the detector over the real tree (every reader must
 * be listed, and every listed test must exist) and over a fixture reader that is
 * deliberately not listed (the gate must catch it).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ALWAYS_RUN, textReadingTests } from "../src/work-driver-verify-always-run.ts";

let exit = 0;
const assert = (c: boolean, m: string) => {
  if (c) console.log(`✓ ${m}`);
  else {
    console.error(`✗ ${m}`);
    exit = 1;
  }
};

const extensionDir = path.resolve(import.meta.dirname, "..");

// The real tree: every detected reader is listed.
const readers = textReadingTests(extensionDir);
const unlisted = readers.filter((t) => !ALWAYS_RUN.includes(t));
assert(readers.length > 0, "the detector finds the repository's source readers");
assert(
  unlisted.length === 0,
  `every smoke test that reads repository text is in ALWAYS_RUN (missing: ${unlisted.join(", ") || "none"})`,
);
const stale = ALWAYS_RUN.filter((t) => !existsSync(path.join(extensionDir, t)));
assert(stale.length === 0, `every ALWAYS_RUN entry exists (stale: ${stale.join(", ") || "none"})`);
assert(
  new Set(ALWAYS_RUN).size === ALWAYS_RUN.length,
  "ALWAYS_RUN lists each test once",
);

// A fixture reader that is not listed: the completeness check must name it.
const fixture = mkdtempSync(path.join(tmpdir(), "pi-always-run-"));
mkdirSync(path.join(fixture, "smoke-tests"), { recursive: true });
writeFileSync(
  path.join(fixture, "smoke-tests", "test-fixture-reader.ts"),
  'import { readFileSync } from "node:fs";\nimport path from "node:path";\nconst file = path.join(__dirname, "..", "src", "x.ts");\nreadFileSync(file, "utf8");\n',
);
writeFileSync(
  path.join(fixture, "smoke-tests", "test-fixture-quiet.ts"),
  'import { a } from "../src/a.ts";\nvoid a;\n',
);
const fixtureReaders = textReadingTests(fixture);
assert(
  fixtureReaders.includes("smoke-tests/test-fixture-reader.ts"),
  "a fixture test that reads a src/ file is detected as a reader",
);
assert(
  !fixtureReaders.includes("smoke-tests/test-fixture-quiet.ts"),
  "a fixture test that only imports a src/ module is not a reader",
);
const fixtureMissing = fixtureReaders.filter((t) => !ALWAYS_RUN.includes(t));
assert(
  fixtureMissing.includes("smoke-tests/test-fixture-reader.ts"),
  "the completeness check fails on a fixture reader missing from ALWAYS_RUN",
);
rmSync(fixture, { recursive: true, force: true });

process.exit(exit);
