#!/usr/bin/env bun
/**
 * check — exit-code fixtures for the deterministic staleness gate.
 *
 * The exit code is the contract: 0 clean, 1 findings/drift, 2 refuse/corrupt.
 * This test builds three fixture files in a temp dir and asserts each resolves
 * to the right code through the SAME `checkAgent` the CLI calls:
 *
 *   a clean file            → 0
 *   a file with a stale ref → 1  (referenced path no longer exists)
 *   a file with corrupt     → 2  (markers cannot be parsed)
 *
 * No LLM. Each check is a filesystem / shell boolean.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type AgentsMdFs, checkAgent } from "../src/agents-md/agents-md.ts";
import { EXIT_CLEAN, EXIT_FINDINGS, EXIT_REFUSE } from "../src/agents-md/check.ts";
import { renderSection } from "../src/agents-md/markers.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const tmp = mkdtempSync(path.join(tmpdir(), "pi-ens-agentsmd-check-"));

function mkFs(): AgentsMdFs {
  return {
    readFile: (p) => readFileSync(p, "utf8"),
    writeFile: () => {
      throw new Error("check must not write");
    },
    stat: (p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    },
    today: () => "2026-01-01",
  };
}

// A valid, clean file: references only paths that exist in the fixture root.
{
  writeFileSync(path.join(tmp, "src"), "x");
  const clean = `# T\n${renderSection("quality-gates", "- **g** — `bun run test`")}${renderSection(
    "decision-ledger",
    "| key | value | provenance |\n| --- | --- | --- |\n| k | v | [auto:2026-01-01] |",
  )}`;
  writeFileSync(path.join(tmp, "clean.md"), clean);
  const r = checkAgent(tmp, path.join(tmp, "clean.md"), {}, mkFs());
  assert(r.check?.code === EXIT_CLEAN, `clean file → exit ${EXIT_CLEAN} (got ${r.check?.code})`);
}

// A file that references a path that no longer exists → findings → 1.
{
  const stale = `# T\n${renderSection("quality-gates", "- see `gone-file.ts` for details")}${renderSection(
    "decision-ledger",
    "| key | value | provenance |\n| --- | --- | --- |\n| k | v | [auto:2026-01-01] |",
  )}`;
  writeFileSync(path.join(tmp, "stale.md"), stale);
  const r = checkAgent(tmp, path.join(tmp, "stale.md"), {}, mkFs());
  assert(
    r.check?.code === EXIT_FINDINGS,
    `stale path → exit ${EXIT_FINDINGS} (got ${r.check?.code})`,
  );
  assert(
    r.check?.findings.some((f) => f.kind === "stale-path" && f.message.includes("gone-file.ts")),
    "...with the exact stale-path finding",
  );
}

// A gate command hand-added to the commands section (not quality-gates) is
// still visible to check: its first token must be on PATH. This is the
// coverage fix — a commands-section-only gate must not be silently skipped.
{
  const cmds = `# T\n${renderSection("quality-gates", "- **g** — `bun run test`")}${renderSection(
    "commands",
    "| kind | command |\n| --- | --- |\n| gate | `definitely-not-a-real-cmd-xyz` |",
  )}${renderSection(
    "decision-ledger",
    "| key | value | provenance |\n| --- | --- | --- |\n| k | v | [auto:2026-01-01] |",
  )}`;
  writeFileSync(path.join(tmp, "cmds.md"), cmds);
  const r = checkAgent(tmp, path.join(tmp, "cmds.md"), {}, mkFs());
  assert(
    r.check?.code === EXIT_FINDINGS,
    `commands-section gate → exit ${EXIT_FINDINGS} (got ${r.check?.code})`,
  );
  assert(
    r.check?.findings.some(
      (f) => f.kind === "missing-command" && f.message.includes("definitely-not-a-real-cmd-xyz"),
    ),
    "...with the missing-command finding for the commands-section line",
  );
}

// A gate line with shell metacharacters is reported (invalid-shell), never
// parsed or executed → findings → 1.
{
  const unsafe = `# T\n${renderSection("quality-gates", "- **evil** — `echo a; echo b` | `true`\n- **safe** — `true`")}${renderSection(
    "decision-ledger",
    "| key | value | provenance |\n| --- | --- | --- |\n| k | v | [auto:2026-01-01] |",
  )}`;
  writeFileSync(path.join(tmp, "unsafe.md"), unsafe);
  const r = checkAgent(tmp, path.join(tmp, "unsafe.md"), {}, mkFs());
  assert(
    r.check?.code === EXIT_FINDINGS,
    `metacharacter gate → exit ${EXIT_FINDINGS} (got ${r.check?.code})`,
  );
  assert(
    r.check?.findings.some(
      (f) => f.kind === "invalid-shell" && f.message.includes("echo a; echo b"),
    ),
    "...with the invalid-shell finding naming the metacharacter line",
  );
}

// A file whose markers cannot be parsed → refuse → 2.
{
  const corrupt =
    "# T\n<!-- pi-ensemble:agents-md:begin a v1 -->\nbody\n<!-- pi-ensemble:agents-md:end b -->\n";
  writeFileSync(path.join(tmp, "corrupt.md"), corrupt);
  const r = checkAgent(tmp, path.join(tmp, "corrupt.md"), {}, mkFs());
  assert(
    r.check?.code === EXIT_REFUSE,
    `corrupt markers → exit ${EXIT_REFUSE} (got ${r.check?.code})`,
  );
  assert(r.check?.corrupt === true, "...flagged as corrupt");
}

rmSync(tmp, { recursive: true, force: true });

console.log(exit === 0 ? "\nAll check exit-code checks passed." : "\nFAILED");
process.exit(exit);
