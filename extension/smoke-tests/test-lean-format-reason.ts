#!/usr/bin/env bun
/**
 * A `verify.format` failure carries the formatter's own output, and one that exits non-zero without
 * naming the file (a toolchain proxy that cannot pick a version) hands the step back instead of
 * dropping the child's test. Real exec, real git, real scripts.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { formatSubmitted } from "../src/lean/specify-format.ts";
import type { ExecFn } from "../src/worktree.ts";
import { SpecifyInfraError } from "../src/lean/specify-reset.ts";

const SELF = "test-lean-format-reason.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

const wt = mkdtempSync(path.join(tmpdir(), "format-reason-"));
const exec = ((cmd: string, opts?: object) => execp(cmd, opts ?? {})) as unknown as ExecFn;
await execp("git init -q", { cwd: wt });
writeFileSync(path.join(wt, "AC1.rs"), "fn x() {}\n");
writeFileSync(path.join(wt, "parse.sh"), 'echo "error: expected item, found $1:3:1" >&2; exit 1\n');
writeFileSync(
  path.join(wt, "proxy.sh"),
  'echo "error: rustup could not choose a version" >&2; exit 1\n',
);

const refused = await formatSubmitted(exec, wt, `sh ${path.join(wt, "parse.sh")} {file}`, [
  "AC1.rs",
]);
assert(
  refused.length === 1 && /expected item, found AC1\.rs/.test(refused[0]?.reason ?? ""),
  `a formatter that names the file refuses it with its own words (${JSON.stringify(refused)})`,
);

const thrown = await formatSubmitted(exec, wt, `sh ${path.join(wt, "proxy.sh")} {file}`, [
  "AC1.rs",
]).then(
  (r) => `returned ${JSON.stringify(r)}`,
  (err: Error) => `${err.name}: ${err.message}`,
);
assert(
  /SpecifyInfraError/.test(thrown) && /rustup could not choose a version/.test(thrown),
  `a formatter that fails without naming the file hands back, showing its output (${thrown})`,
);

process.exit(exit);
