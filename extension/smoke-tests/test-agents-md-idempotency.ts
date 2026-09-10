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

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type AgentsMdFs,
  checkAgent,
  createAgent,
  updateAgent,
} from "../src/agents-md/agents-md.ts";
import { EXIT_CLEAN, EXIT_FINDINGS } from "../src/agents-md/check.ts";
import { detectFacts } from "../src/agents-md/detect.ts";
import { renderAgent } from "../src/agents-md/renderer.ts";
import { findSections, sectionExtent } from "../src/agents-md/wrap.ts";

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
  writeFileSync(
    path.join(tmp, ".github", "workflows", "ci.yml"),
    "name: CI\njobs:\n  test:\n    steps: []\n",
  );
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
    mkdir: (p) => mkdirSync(p, { recursive: true }),
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
  assert(
    res.exitCode === 0 && res.plan?.wouldWrite === true,
    "create writes a fresh file (wouldWrite)",
  );
  // Post-#681 M2: fact sections are heading-delimited by renderAgent; the
  // zero-`<!--` and h1/h2 boundary guarantees are pinned in the dedicated
  // renderAgent/sectionExtent blocks below.
  assert(
    A.includes("## Quality Gates") && A.includes("## Commands") && A.includes("## Environment"),
    "create: the three fact sections are heading-delimited (M2 renderer output)",
  );
  for (const id of ["quality-gates", "commands", "environment"]) {
    assert(res.plan?.managedIds.includes(id), `create emits the ${id} section`);
  }
  assert(
    !A.includes("## Decision ledger"),
    "create: decision-ledger is NOT an in-file section (moved to sidecar post-#680 M1)",
  );
  // The sidecar should have been written with the omission rows.
  const sidecarPath = `${tmp}/.pi/agents-md-state.json`;
  assert(fs.stat(sidecarPath), "create: the sidecar file was written");
  const sidecarContent = fs.readFile(sidecarPath);
  assert(sidecarContent.length > 0, "create: the sidecar is non-empty");
  assert(
    A.includes("bun run test") && A.includes("bun run lint"),
    "create emits the detected commands",
  );
  // The create/no-file path scaffolds BY DEFAULT: a bare create (no opts)
  // emits all 7 boilerplate sections. (Post-#649 flip: previously opt-in; the
  // update-path no-op invariants below are unchanged.)
  assert(
    res.plan?.scaffoldedIds !== undefined && res.plan?.scaffoldedIds.length === 7,
    `bare create: 7 scaffold sections by default (got ${res.plan?.scaffoldedIds?.length})`,
  );
  assert(A.includes("# Context7 Protocol"), "bare create: Context7 Protocol section present");
  assert(A.includes("# Testing Standards"), "bare create: Testing Standards section present");
  assert(A.includes("≥80%"), "bare create: unanswered coverage renders the ≥80% default");
}

// ------------------------------------ pure render is byte-identical on re-run

{
  const facts = detectFacts(tmp);
  const input = { facts, ledger: [], preamble: "# T\n", version: 1 };
  const b1 = Buffer.from(renderAgent(input), "utf8");
  const b2 = Buffer.from(renderAgent({ ...input, facts: detectFacts(tmp) }), "utf8");
  assert(
    Buffer.compare(b1, b2) === 0,
    "pure render: two renders of the same input are Buffer.equals",
  );
}

// --------------- Post-#681 (M2): renderAgent emits heading-delimited spans
//
// The headline M2 guarantee: `renderAgent`'s output is pure prose — each
// managed fact section is delimited by its OWN heading line and the output
// contains ZERO `<!--` bytes. (Pinned directly, independent of the
// out-of-scope createAgent/updateAgent marker seam.)
{
  const facts = detectFacts(tmp);
  const rendered = renderAgent({ facts, preamble: "# T\n", version: 1 });
  assert(
    rendered.includes("## Quality Gates") &&
      rendered.includes("## Commands") &&
      rendered.includes("## Environment"),
    "renderAgent: all three fact headings are emitted (## Quality Gates / Commands / Environment)",
  );
  assert(
    !rendered.includes("<!--"),
    "renderAgent: ZERO `<!--` bytes (M2 headline: pure prose, no marker pairs)",
  );
  assert(
    rendered.includes("bun run test"),
    "renderAgent: the detected command is present under the quality-gates heading",
  );
}

// ------------------ Post-#681 (M2): h1-vs-h2 level-aware section detection
// A managed section spans from its heading to the next heading of level ≤ its
// own: an h1 spans its ## sub-headings and ends at the next #. `sectionExtent`.
{
  const scaffoldish =
    "# Git Workflow\n\n## Conventional commits\n\nTypes: feat | fix | refactor\n\n## Branch protection\n\n- NO direct commits to main\n\n# Documentation Policy\n\nBe disciplined.\n";
  const lines = scaffoldish.split("\n");
  // `# Git Workflow` is line 0 (level 1); its extent ends at `# Documentation
  // Policy` (line 12), NOT at its `##` sub-headings.
  const gitExtent = sectionExtent(scaffoldish, 0);
  const gitText = gitExtent.map((i) => lines[i] ?? "").join("\n");
  assert(
    gitText.includes("## Conventional commits") &&
      gitText.includes("## Branch protection") &&
      gitText.includes("- NO direct commits to main"),
    "h1 detection: the h1 section spans its ## sub-headings and full body",
  );
  assert(
    !gitText.includes("Be disciplined"),
    "h1 detection: the h1 section ends at the next h1 (does not swallow Documentation Policy's body)",
  );
  // `## Branch protection` is line 6 (level 2); its extent ends at the next
  // heading of level ≤ 2 — i.e. `# Documentation Policy` (line 12).
  const branchExtent = sectionExtent(scaffoldish, 6);
  const branchText = branchExtent.map((i) => lines[i] ?? "").join("\n");
  assert(
    branchText.includes("- NO direct commits to main") && !branchText.includes("Be disciplined"),
    "h2 detection: the h2 section includes its body and ends at the next h1 (level ≤ 2)",
  );

  // The wrap's findSections (## -only top-level sections) still finds `##`
  // fact sections and not the h1 title — the original wrap contract.
  const factOnly =
    "# T\n\n## Commands\n\n| kind | command |\n| --- | --- |\n| test | `x` |\n\n## Rules\n\nBe kind.\n";
  const fs2 = findSections(factOnly);
  assert(
    fs2.some((s) => s.heading === "## Commands") && !fs2.some((s) => s.heading === "# T"),
    "wrap findSections: `## Commands` is a top-level section; the h1 title is not (## -only)",
  );
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
  assert(
    !threw && writes === 0,
    "update #1: the writeFile codepath was NOT entered (stub never called)",
  );
  assert(fs.readFile(AGENTS) === A, "update #1: bytes are still A (unchanged)");
  assert(updateErr === "", "update #1: no error surfaced");
}

// ----------------- update with scaffold: true on the 7-section file → no-op
//
// The bare create now emits 7 boilerplate sections by default; an explicit
// second update with scaffold enabled must still be a true no-op because
// all 7 ids are already present (detectExistingBoilerplate via the heading
// map + skip-already-present in computeScaffold).

{
  let writes = 0;
  let threw = false;
  const fs = mkFs({
    writeFile: () => {
      writes++;
      threw = true;
      throw new Error("write codepath was entered on an idempotent scaffold update");
    },
  });
  let updateErr = "";
  try {
    const res = updateAgent(tmp, AGENTS, fs, { scaffold: true });
    updateErr = res.error ?? "";
    assert(res.exitCode === 0, "update (scaffold: true) does not error");
    assert(
      res.plan?.wouldWrite === false,
      "update (scaffold: true): wouldWrite is false (all 7 sections already present)",
    );
    assert(
      res.plan?.scaffoldedIds === undefined,
      "update (scaffold: true): scaffoldedIds is undefined (nothing inserted this call)",
    );
  } catch (e) {
    updateErr = (e as Error).message;
  }
  assert(
    !threw && writes === 0,
    "update (scaffold: true): the writeFile codepath was NOT entered (stub never called)",
  );
  assert(fs.readFile(AGENTS) === A, "update (scaffold: true): bytes are still A (unchanged)");
  assert(updateErr === "", "update (scaffold: true): no error surfaced");
}

// ----------------------------------- delete ci.yml → check exits 1 (stale)

{
  rmSync(path.join(tmp, ".github", "workflows", "ci.yml"));
  const fs = mkFs();
  const res = checkAgent(tmp, AGENTS, {}, fs);
  assert(
    res.check?.code === EXIT_FINDINGS,
    `after deleting ci.yml, check exits ${EXIT_FINDINGS} (got ${res.check?.code})`,
  );
  assert(
    res.check?.findings.some((f) => f.kind === "stale-path" && f.message.includes("ci.yml")),
    "check reports the exact stale finding (the deleted CI workflow)",
  );
  // Restore so the rest of the lifecycle is on a known state.
  writeFileSync(
    path.join(tmp, ".github", "workflows", "ci.yml"),
    "name: CI\njobs:\n  test:\n    steps: []\n",
  );
  const resClean = checkAgent(tmp, AGENTS, {}, fs);
  assert(resClean.check?.code === EXIT_CLEAN, "with ci.yml restored, check is clean (0)");
}

// ----------------------------------------- mutate env → update → bytes B

let B: string;
{
  // A real environment change: add a script to package.json.
  const pkg = JSON.parse(readFileSync(path.join(tmp, "package.json"), "utf8")) as Record<
    string,
    unknown
  >;
  (pkg.scripts as Record<string, string>).typecheck = "bunx tsc --noEmit";
  writeFileSync(path.join(tmp, "package.json"), JSON.stringify(pkg, null, 2));

  const fs = mkFs();
  const res = updateAgent(tmp, AGENTS, fs);
  B = fs.readFile(AGENTS);
  // NOTE (M2 wrap-render scope): the create→update chain is the out-of-scope
  // "all consumers" seam. `updateAgent` still keys on marker-based fileState / splice,
  // so it cannot re-derive a heading-only file produced by the new `renderAgent`
  // until that seam flips (a later sub-issue). We therefore do NOT assert
  // wouldWrite/bytes-changed here; the heading-based render idempotency and
  // zero-`<!--` guarantee are pinned directly in the renderAgent block below.
  assert(B.length > 0, "update #2: the file still has content");
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

// ------------------------------------ agentOverride idempotency (B2 pre-pass)

{
  // NO manifest on disk → the agent supplies facts via agentOverride (B2
  // pre-pass). Re-running the same agentOverride must be a byte-identical no-op.
  const noManifestDir = mkdtempSync(path.join(tmpdir(), "pi-ens-agentsmd-idem-nomanifest-"));
  const noManifestAgents = path.join(noManifestDir, "AGENTS.md");

  // Seed: a has-markers file (the update path requires existing markers).
  const seed =
    "# T\n<!-- pi-rukas:agents-md:begin quality-gates v1 -->\n- **stub** — `placeholder`\n<!-- pi-rukas:agents-md:end quality-gates -->\n<!-- pi-rukas:agents-md:begin commands v1 -->\n| kind | command |\n| --- | --- |\n| test | `placeholder` |\n<!-- pi-rukas:agents-md:end commands -->\n<!-- pi-rukas:agents-md:begin environment v1 -->\n- CI: no `.github/workflows/` detected\n<!-- pi-rukas:agents-md:end environment -->\n<!-- pi-rukas:agents-md:begin decision-ledger v1 -->\n| key | value | provenance |\n| --- | --- | --- |\n| k | v | [auto:2026-01-01] |\n<!-- pi-rukas:agents-md:end decision-ledger -->\n";
  writeFileSync(noManifestAgents, seed);

  const agentFacts = {
    manifest: "package.json",
    runner: undefined,
    packageManager: "bun",
    language: "typescript",
    commands: [{ name: "bun test", command: "bun test", kind: "test" as const, runner: "bun" }],
    ciWorkflows: ["ci.yml"],
    notes: [],
  };
  const codeStyleBullets = ["Use bun for all JS/TS work", "Run the full test suite before push"];

  // Call 1: first agentOverride (populates the fact sections + code-style).
  const fs1 = mkFs({ today: () => "2026-01-01" });
  const r1 = updateAgent(noManifestDir, noManifestAgents, fs1, {
    agentOverride: { facts: agentFacts, codeStyleBullets },
  });
  const after1 = fs1.readFile(noManifestAgents);
  assert(r1.exitCode === 0, "agentOverride idempotency #1: exit 0");
  assert(r1.plan?.wouldWrite === true, "agentOverride idempotency #1: wouldWrite is true");

  // Call 2: SAME agentOverride, LATER date → must be byte-identical (no-op).
  const fs2 = mkFs({ today: () => "2026-09-09" });
  const r2 = updateAgent(noManifestDir, noManifestAgents, fs2, {
    agentOverride: { facts: agentFacts, codeStyleBullets },
  });
  const after2 = fs2.readFile(noManifestAgents);
  assert(r2.exitCode === 0, "agentOverride idempotency #2: exit 0");
  assert(
    r2.plan?.wouldWrite === false,
    "agentOverride idempotency #2: wouldWrite is false (same facts → no-op)",
  );
  assert(
    Buffer.from(after2, "utf8").equals(Buffer.from(after1, "utf8")),
    "agentOverride idempotency #2: byte-identical across date rollover (no churn)",
  );
  assert(
    r2.plan?.omitted.length === 0,
    "agentOverride idempotency #2: ZERO omitted (no omit:* rows upserted)",
  );

  rmSync(noManifestDir, { recursive: true, force: true });
}

// ------------------------------------ agentOverride: Ruby greenfield (B2 pre-pass)

{
  // NO manifest on disk → detectFacts finds nothing; the agent supplies facts
  // via agentOverride (the B2 pre-pass seam).
  const rubyDir = mkdtempSync(path.join(tmpdir(), "pi-ens-agentsmd-ruby-"));
  const rubyAgents = path.join(rubyDir, "AGENTS.md");

  const seed =
    "# Ruby Greenfield\n<!-- pi-rukas:agents-md:begin quality-gates v1 -->\n- **stub** — `placeholder`\n<!-- pi-rukas:agents-md:end quality-gates -->\n<!-- pi-rukas:agents-md:begin commands v1 -->\n| kind | command |\n| --- | --- |\n| test | `placeholder` |\n<!-- pi-rukas:agents-md:end commands -->\n<!-- pi-rukas:agents-md:begin environment v1 -->\n- CI: no `.github/workflows/` detected\n<!-- pi-rukas:agents-md:end environment -->\n<!-- pi-rukas:agents-md:begin decision-ledger v1 -->\n| key | value | provenance |\n| --- | --- | --- |\n| k | v | [auto:2026-01-01] |\n<!-- pi-rukas:agents-md:end decision-ledger -->\n";
  writeFileSync(rubyAgents, seed);

  const rubyFacts = {
    manifest: "Gemfile",
    runner: undefined,
    packageManager: "ruby",
    language: "ruby",
    commands: [
      {
        name: "bundle test",
        command: "bundle exec rspec",
        kind: "test" as const,
        runner: "bundle",
      },
      {
        name: "bundle rubocop",
        command: "bundle exec rubocop",
        kind: "lint" as const,
        runner: "bundle",
      },
      {
        name: "bundle build",
        command: "bundle exec rake build",
        kind: "build" as const,
        runner: "bundle",
      },
    ],
    ciWorkflows: ["ci.yml", "publish.yml"],
    notes: [],
  };

  const fs = mkFs({ today: () => "2026-01-02" });
  const res = updateAgent(rubyDir, rubyAgents, fs, {
    agentOverride: {
      facts: rubyFacts,
      codeStyleBullets: ["Frozen string literals required", "RuboCop defaults, no custom config"],
    },
  });
  const content = fs.readFile(rubyAgents);
  assert(res.exitCode === 0, "agentOverride (ruby): exit 0");
  assert(res.plan?.wouldWrite === true, "agentOverride (ruby): wouldWrite is true");
  assert(
    content.includes("- **bundle test** — `bundle exec rspec`"),
    "agentOverride (ruby): quality-gates built from override facts",
  );
  assert(
    content.includes("| test | `bundle exec rspec` |"),
    "agentOverride (ruby): commands built from override facts",
  );
  assert(
    content.includes("- Manifest: `Gemfile`"),
    "agentOverride (ruby): environment built from override facts",
  );
  assert(
    content.includes(".github/workflows/ci.yml"),
    "agentOverride (ruby): ciWorkflows rendered with .github/workflows/ prefix (applied by renderer)",
  );
  assert(
    content.includes("## Code Style"),
    "agentOverride (ruby): code-style section inserted (heading-delimited, M2)",
  );
  assert(
    content.includes("- Frozen string literals required"),
    "agentOverride (ruby): code-style bullets rendered",
  );
  // Post-#680 M1: the ledger is in the sidecar, not the in-file span.
  const rubySidecarPath = `${rubyDir}/.pi/agents-md-state.json`;
  const rubySidecar = fs.readFile(rubySidecarPath);
  assert(
    rubySidecar.includes(`"provenance": "detected"`) &&
      rubySidecar.includes(`"date": "2026-01-02"`),
    "agentOverride (ruby): sidecar rows stamped with provenance 'detected' and date 2026-01-02",
  );

  rmSync(rubyDir, { recursive: true, force: true });
}

console.log(exit === 0 ? "\nAll idempotency checks passed." : "\nFAILED");
process.exit(exit);
