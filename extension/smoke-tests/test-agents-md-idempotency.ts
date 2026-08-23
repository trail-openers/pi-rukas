#!/usr/bin/env bun
/**
 * idempotency — the load-bearing guarantee of the /agents-md feature.
 *
 * A regenerator is only safe to run on a live repo if running it a second time
 * is a no-op. This test builds a checked-in fixture repo in a temp dir, and
 * asserts the full lifecycle:
 *
 *   create  → bytes A
 *   update  → the WRITE CODEPATH IS NOT ENTERED (writeFile stubbed to throw),
 *             and the bytes are still A
 *   mutate env (delete ci.yml) → check exits 1 with exact findings
 *   update  → bytes B (a real change)
 *   update  → no-op, bytes B
 *
 * Plus a pure-render `Buffer.equals`: the renderer is a pure function, so two
 * renders of the same (facts, ledger, preamble, version) are byte-identical.
 *
 * The "write codepath not entered" assertion is the key one: `update` computes
 * the new bytes and compares them to the current file. When they match, it must
 * not call `writeFile` at all. Stubbing `writeFile` to throw and expecting no
 * throw is what makes "no-op" a real, observable property rather than a claim.
 */

import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderAgent } from "../src/agents-md/renderer.ts";
import { detectFacts } from "../src/agents-md/detect.ts";
import { createAgent, updateAgent, checkAgent, type AgentsMdFs } from "../src/agents-md/agents-md.ts";
import { EXIT_FINDINGS, EXIT_CLEAN } from "../src/agents-md/check.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const tmp = mkdtempSync(path.join(tmpdir(), "pi-ens-agentsmd-"));
const AGENTS = path.join(tmp, "AGENTS.md");
const FIXED_DATE = "2026-01-01";

// ---------------------------------------------------------------- the fixture

function buildFixture(): void {
  mkdirSync(path.join(tmp, ".github", "workflows"), { recursive: true });
  mkdirSync(path.join(tmp, "src"), { recursive: true });
  writeFileSync(
    path.join(tmp, "package.json"),
    JSON.stringify(
      {
        name: "fixture",
        scripts: { test: "vitest", lint: "biome lint", build: "bun run build" },
        devDependencies: { typescript: "^5.4.0" },
      },
      null,
      2,
    ),
  );
  // bun.lock marks the package manager as bun (a real, not guessed, fact).
  writeFileSync(path.join(tmp, "bun.lock"), "{ lockfileVersion: 1 }");
  writeFileSync(path.join(tmp, ".github", "workflows", "ci.yml"), "name: CI\njobs:\n  test:\n    steps: []\n");
  writeFileSync(path.join(tmp, "src", "index.ts"), "export const x = 1;\n");
}
buildFixture();

// An in-memory FS over the temp dir, with a fixed clock, so dates don't churn.
function mkFs(overrides?: Partial<AgentsMdFs>): AgentsMdFs {
  return {
    readFile: (p) => readFileSync(p, "utf8"),
    writeFile: (p, b) => writeFileSync(p, b),
    stat: (p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    },
    today: () => FIXED_DATE,
    ...overrides,
  };
}

// -------------------------------------------- create → bytes A, and it's valid

let A: string;
{
  const fs = mkFs();
  const res = createAgent(tmp, AGENTS, fs);
  A = fs.readFile(AGENTS);
  assert(res.exitCode === 0 && res.plan?.wouldWrite === true, "create writes a fresh file (wouldWrite)");
  assert(res.plan?.managedIds.includes("quality-gates"), "create emits the quality-gates section");
  assert(res.plan?.managedIds.includes("commands"), "create emits the commands section");
  assert(res.plan?.managedIds.includes("environment"), "create emits the environment section");
  assert(res.plan?.managedIds.includes("decision-ledger"), "create emits the decision-ledger section");
  assert(A.includes("bun run test") && A.includes("bun run lint"), "create emits the detected commands");
}

// ------------------------------------ pure render is byte-identical on re-run

{
  const facts = detectFacts(tmp);
  const input = { facts, ledger: [], preamble: "# T\n", version: 1 };
  const b1 = Buffer.from(renderAgent(input), "utf8");
  const b2 = Buffer.from(renderAgent({ ...input, facts: detectFacts(tmp) }), "utf8");
  assert(Buffer.compare(b1, b2) === 0, "pure render: two renders of the same input are Buffer.equals");
}

// --------------------------- update #1 → WRITE CODEPATH NOT ENTERED, still A

{
  let writes = 0;
  let threw = false;
  const fs = mkFs({
    writeFile: () => {
      writes++;
      threw = true;
      throw new Error("write codepath was entered on a no-op update");
    },
  });
  let updateErr = "";
  try {
    const res = updateAgent(tmp, AGENTS, fs);
    updateErr = res.error ?? "";
    assert(res.exitCode === 0, "update #1 does not error");
    assert(res.plan?.wouldWrite === false, "update #1: wouldWrite is false (already current)");
  } catch (e) {
    updateErr = (e as Error).message;
  }
  assert(!threw && writes === 0, "update #1: the writeFile codepath was NOT entered (stub never called)");
  assert(fs.readFile(AGENTS) === A, "update #1: bytes are still A (unchanged)");
  assert(updateErr === "", "update #1: no error surfaced");
}

// ----------------------------------- delete ci.yml → check exits 1 (stale)

{
  rmSync(path.join(tmp, ".github", "workflows", "ci.yml"));
  const fs = mkFs();
  const res = checkAgent(tmp, AGENTS, {}, fs);
  assert(res.check?.code === EXIT_FINDINGS, `after deleting ci.yml, check exits ${EXIT_FINDINGS} (got ${res.check?.code})`);
  assert(
    res.check?.findings.some((f) => f.kind === "stale-path" && f.message.includes("ci.yml")),
    "check reports the exact stale finding (the deleted CI workflow)",
  );
  // Restore so the rest of the lifecycle is on a known state.
  writeFileSync(path.join(tmp, ".github", "workflows", "ci.yml"), "name: CI\njobs:\n  test:\n    steps: []\n");
  const resClean = checkAgent(tmp, AGENTS, {}, fs);
  assert(resClean.check?.code === EXIT_CLEAN, "with ci.yml restored, check is clean (0)");
}

// ----------------------------------------- mutate env → update → bytes B

let B: string;
{
  // A real environment change: add a script to package.json.
  const pkg = JSON.parse(readFileSync(path.join(tmp, "package.json"), "utf8")) as Record<string, unknown>;
  (pkg.scripts as Record<string, string>).typecheck = "bunx tsc --noEmit";
  writeFileSync(path.join(tmp, "package.json"), JSON.stringify(pkg, null, 2));

  const fs = mkFs();
  const res = updateAgent(tmp, AGENTS, fs);
  B = fs.readFile(AGENTS);
  assert(res.plan?.wouldWrite === true, "update #2 (after env change): wouldWrite is true");
  assert(B !== A, "update #2: bytes changed to B (a real update)");
  assert(B.includes("bun run typecheck"), "update #2: B contains the newly-detected command (bun run typecheck)");
}

// -------------------------------------------- update #3 → no-op, bytes B

{
  let writes = 0;
  const fs = mkFs({
    writeFile: () => {
      writes++;
    },
  });
  const res = updateAgent(tmp, AGENTS, fs);
  assert(res.plan?.wouldWrite === false, "update #3: wouldWrite is false (B is current)");
  assert(writes === 0, "update #3: writeFile codepath NOT entered");
  assert(fs.readFile(AGENTS) === B, "update #3: bytes are still B");
}

rmSync(tmp, { recursive: true, force: true });

console.log(exit === 0 ? "\nAll idempotency checks passed." : "\nFAILED");
process.exit(exit);
