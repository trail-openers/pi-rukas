#!/usr/bin/env bun
/**
 * lean/specify — `verify.format` brings each submitted test to the project's format before it is
 * proven red and frozen, so a frozen test never fails the project's own format check. Unset, the
 * submitted bytes are frozen as written. A formatter that refuses a file drops it; one that writes
 * any other path is a hand-back. Real git, through the specify fixture.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { loadWorkConfig } from "../src/lean/config.ts";
import {
  ROOTS,
  RUNNER,
  configWith,
  makeRepo,
  redScript,
  runSpecify,
  submit,
} from "./lib/lean-specify-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const TEST = "tests/AC1-retry.test.sh";
const UNFORMATTED = `${redScript()}# UNFORMATTED\n`;
const FORMATTED = `${redScript()}# formatted\n`;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
// The project's "formatter": rewrites the marker in the file it is handed, or touches a stray file.
const FMT = '#!/bin/sh\nsed \'s/UNFORMATTED/formatted/\' "$1" > "$1.tmp" && mv "$1.tmp" "$1"\n';
const STRAY = "#!/bin/sh\necho x > src/stray.txt\n";

async function run(format: string | undefined, files: Record<string, string> = {}) {
  const { repoRoot, baseSha } = makeRepo({ "src/a.ts": "1\n", "fmt.sh": FMT, ...files });
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 21,
    config: configWith({ test: RUNNER, ...(format === undefined ? {} : { format }) }),
    writes: (wt) => {
      mkdirSync(path.join(wt, "tests"), { recursive: true });
      writeFileSync(path.join(wt, TEST), UNFORMATTED, { mode: 0o755 });
    },
    toolUses: [submit("AC1", [TEST])],
  });
  return r;
}

{
  const r = await run("sh fmt.sh {file}");
  assert(
    r.outcome?.frozen?.[TEST] === sha(FORMATTED),
    `verify.format set: the formatted bytes are frozen (${r.outcome?.reason ?? r.threw?.message})`,
  );
  assert(
    readFileSync(path.join(r.worktree, TEST), "utf8") === FORMATTED,
    "…and they are what the tree holds",
  );
}

{
  const r = await run(undefined);
  assert(
    r.outcome?.frozen?.[TEST] === sha(UNFORMATTED),
    `verify.format unset: the submitted bytes are frozen as written (${r.outcome?.reason ?? r.threw?.message})`,
  );
}

{
  // `false` exits 1 naming nothing: it said nothing about the file, so the step hands back.
  const r = await run("false {file}");
  assert(
    r.outcome?.frozen === undefined || r.outcome.frozen[TEST] === undefined,
    `a formatter that fails without naming the file freezes nothing (${(r.outcome?.reason ?? r.threw?.message ?? "").slice(0, 160)})`,
  );
  assert(
    /verify\.format `false .*`: exited 1 without naming/.test(r.threw?.message ?? ""),
    "…and hands back, naming the formatter",
  );
}

{
  const r = await run("sh stray.sh {file}", { "stray.sh": STRAY });
  assert(
    /verify\.format wrote outside the submitted test files: src\/stray\.txt/.test(
      r.threw?.message ?? "",
    ),
    `a formatter that writes another path hands back (${(r.threw?.message ?? r.outcome?.reason ?? "").slice(0, 160)})`,
  );
}

{
  // The loader holds verify.format to verify.test's template rules, naming the field it refused.
  const { repoRoot, baseSha } = makeRepo({
    ".pi/work.json": JSON.stringify({ version: 1, verify: { test: RUNNER, format: "rustfmt" } }),
  });
  const err = await loadWorkConfig(execp, repoRoot, baseSha).then(
    () => undefined,
    (e: Error) => e.message,
  );
  assert(
    /verify\.format must contain the literal \{file\}/.test(err ?? ""),
    `a format command without {file} is refused at load (${err})`,
  );
}

for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
process.exit(exit);
