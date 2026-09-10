#!/usr/bin/env bun
/**
 * check — exit-code fixtures for the deterministic staleness gate.
 * Post-#680 M1: the decision-ledger lives in the sidecar at
 * `.pi/agents-md-state.json`, not in the in-file span. The check reads the
 * sidecar for drift detection; a missing or corrupt sidecar while AGENTS.md
 * has managed sections is a defined refusal state (exit 2).
 *
 * The exit code is the contract: 0 clean, 1 findings/drift, 2 refuse/corrupt.
 * This test builds fixture files in a temp dir and asserts each resolves
 * to the right code through the SAME `checkAgent` the CLI calls:
 *
 *   a clean file            → 0
 *   a file with a stale ref → 1  (referenced path no longer exists)
 *   a file with corrupt     → 2  (markers cannot be parsed)
 *   missing sidecar + managed sections → 2 (defined refusal state)
 *   corrupt sidecar + managed sections → 2 (defined refusal state)
 *
 * No LLM. Each check is a filesystem / shell boolean.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type AgentsMdFs, checkAgent } from "../src/agents-md/agents-md.ts";
import { EXIT_CLEAN, EXIT_FINDINGS, EXIT_REFUSE } from "../src/agents-md/check.ts";
import { renderSection } from "../src/agents-md/markers.ts";
import { renderLedger, type LedgerRow } from "../src/agents-md/ledger.ts";

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
    mkdir: (p) => mkdirSync(p, { recursive: true }),
    today: () => "2026-01-01",
  };
}

/** Write a minimal valid sidecar file at `<root>/.pi/agents-md-state.json`. */
function writeSidecar(root: string, rows?: LedgerRow[]): void {
  const dir = path.join(root, ".pi");
  mkdirSync(dir, { recursive: true });
  const defaultRows: LedgerRow[] = rows ?? [
    { key: "k", value: "v", provenance: "auto", date: "2026-01-01" },
  ];
  writeFileSync(path.join(dir, "agents-md-state.json"), renderLedger(defaultRows));
}

// A valid, clean file: references only paths that exist in the fixture root.
// Post-#680 M1: no in-file decision-ledger span; the sidecar carries the rows.
{
  mkdirSync(path.join(tmp, "src"), { recursive: true });
  writeFileSync(path.join(tmp, "src.txt"), "x");
  const clean = `# T\n${renderSection("quality-gates", "- **g** — `bun run test`")}`;
  writeFileSync(path.join(tmp, "clean.md"), clean);
  writeSidecar(tmp);
  const r = checkAgent(tmp, path.join(tmp, "clean.md"), {}, mkFs());
  assert(r.check?.code === EXIT_CLEAN, `clean file → exit ${EXIT_CLEAN} (got ${r.check?.code})`);
}

// A file that references a path that no longer exists → findings → 1.
{
  const stale = `# T\n${renderSection("quality-gates", "- see `gone-file.ts` for details")}`;
  writeFileSync(path.join(tmp, "stale.md"), stale);
  writeSidecar(tmp);
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
// still visible to check: its first token must be on PATH.
{
  const cmds = `# T\n${renderSection("quality-gates", "- **g** — `bun run test`")}${renderSection(
    "commands",
    "| kind | command |\n| --- | --- |\n| gate | `definitely-not-a-real-cmd-xyz` |",
  )}`;
  writeFileSync(path.join(tmp, "cmds.md"), cmds);
  writeSidecar(tmp);
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
  const unsafe = `# T\n${renderSection("quality-gates", "- **evil** — `echo a; echo b` | `true`\n- **safe** — `true`")}`;
  writeFileSync(path.join(tmp, "unsafe.md"), unsafe);
  writeSidecar(tmp);
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
    "# T\n<!-- pi-rukas:agents-md:begin a v1 -->\nbody\n<!-- pi-rukas:agents-md:end b -->\n";
  writeFileSync(path.join(tmp, "corrupt.md"), corrupt);
  writeSidecar(tmp);
  const r = checkAgent(tmp, path.join(tmp, "corrupt.md"), {}, mkFs());
  assert(
    r.check?.code === EXIT_REFUSE,
    `corrupt markers → exit ${EXIT_REFUSE} (got ${r.check?.code})`,
  );
  assert(r.check?.corrupt === true, "...flagged as corrupt");
}

// An empty code-style managed section (a hand-edited file with an empty
// marker pair) triggers the GENERIC empty-section guard in runChecks step 2.
{
  const emptyCs =
    "# T\n" +
    renderSection("environment", "- Manifest: package.json") +
    "<!-- pi-rukas:agents-md:begin code-style v1 -->\n<!-- pi-rukas:agents-md:end code-style -->\n";
  writeFileSync(path.join(tmp, "empty-cs.md"), emptyCs);
  writeSidecar(tmp);
  const r = checkAgent(tmp, path.join(tmp, "empty-cs.md"), {}, mkFs());
  assert(
    r.check?.code === EXIT_FINDINGS,
    `empty code-style section → exit ${EXIT_FINDINGS} (got ${r.check?.code})`,
  );
  assert(
    r.check?.findings.some(
      (f) => f.kind === "empty-section" && f.message.includes("code-style"),
    ),
    "...with the generic empty-section finding naming code-style",
  );
}

// A BOILERPLATE span that the operator has emptied by hand triggers the SAME
// generic empty-section guard.
{
  const emptyBoilerplate =
    "# T\n" +
    renderSection("environment", "- Manifest: package.json") +
    "<!-- pi-rukas:agents-md:begin minimalist-engineering v1 -->\n<!-- pi-rukas:agents-md:end minimalist-engineering -->\n";
  writeFileSync(path.join(tmp, "empty-boilerplate.md"), emptyBoilerplate);
  writeSidecar(tmp);
  const r = checkAgent(tmp, path.join(tmp, "empty-boilerplate.md"), {}, mkFs());
  assert(
    r.check?.code === EXIT_FINDINGS,
    `empty boilerplate span → exit ${EXIT_FINDINGS} (got ${r.check?.code})`,
  );
  assert(
    r.check?.findings.some(
      (f) => f.kind === "empty-section" && f.message.includes("minimalist-engineering"),
    ),
    "...with the generic empty-section finding naming the boilerplate id",
  );
}

// Post-#680 M1: missing sidecar while AGENTS.md has managed sections → exit 2.
{
  const missingSidecar = `# T\n${renderSection("quality-gates", "- **g** — `bun run test`")}`;
  writeFileSync(path.join(tmp, "missing-sidecar.md"), missingSidecar);
  // Ensure no sidecar exists for this root.
  const r = checkAgent(tmp, path.join(tmp, "missing-sidecar.md"), {}, mkFs());
  // Note: the sidecar written by writeSidecar(tmp) above exists, so this
  // test would NOT trigger the missing-sidecar path. We need a separate root.
  const tmp2 = mkdtempSync(path.join(tmpdir(), "pi-ens-agentsmd-check-missing-"));
  writeFileSync(path.join(tmp2, "AGENTS.md"), missingSidecar);
  const r2 = checkAgent(tmp2, path.join(tmp2, "AGENTS.md"), {}, mkFs());
  assert(
    r2.check?.code === EXIT_REFUSE,
    `missing sidecar + managed sections → exit ${EXIT_REFUSE} (got ${r2.check?.code})`,
  );
  assert(r2.check?.corrupt === true, "...flagged as corrupt (missing sidecar)");
  rmSync(tmp2, { recursive: true, force: true });
}

// Post-#680 M1: corrupt sidecar while AGENTS.md has managed sections → exit 2.
{
  const tmp3 = mkdtempSync(path.join(tmpdir(), "pi-ens-agentsmd-check-corrupt-"));
  const corruptFile = `# T\n${renderSection("quality-gates", "- **g** — `bun run test`")}`;
  writeFileSync(path.join(tmp3, "AGENTS.md"), corruptFile);
  const dir = path.join(tmp3, ".pi");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "agents-md-state.json"), "{ not valid json !!!");
  const r = checkAgent(tmp3, path.join(tmp3, "AGENTS.md"), {}, mkFs());
  assert(
    r.check?.code === EXIT_REFUSE,
    `corrupt sidecar + managed sections → exit ${EXIT_REFUSE} (got ${r.check?.code})`,
  );
  assert(r.check?.corrupt === true, "...flagged as corrupt (corrupt sidecar)");
  rmSync(tmp3, { recursive: true, force: true });
}

rmSync(tmp, { recursive: true, force: true });

console.log(exit === 0 ? "\nAll check exit-code checks passed." : "\nFAILED");
process.exit(exit);
