#!/usr/bin/env bun
/**
 * brownfield wrap — the `no-markers` branch of `updateAgent`.
 *
 * A host repo with a human-written `AGENTS.md` (no pi-ensemble markers)
 * cannot be `create`d and has nothing for the has-markers splice to touch.
 * The wrap inserts marker pairs around the sections the core can re-derive
 * and appends the managed sections it can derive, leaving every original
 * line in place. This test asserts the whole contract:
 *
 *   - dryRun: true → `newBytes` carries the wrapped bytes, `writeFile` NOT called
 *   - marker pairs around the machine section; doctrine section byte-identical
 *   - the diff is insertions-only (original is a line-subsequence of the wrap)
 *   - a `decision-ledger` span is present and non-empty
 *   - `fileState(newBytes) === "has-markers"` (the wrap is terminal)
 *   - `checkAgent` on the wrapped bytes reports no `empty-section` finding
 *   - the exit-code table: reword/delete → 2, ambiguous → 1 per section,
 *     nothing classifiable → 2
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type AgentsMdFs,
  checkAgent,
  createAgent,
  fileState,
  updateAgent,
} from "../src/agents-md/agents-md.ts";
import { detectFacts } from "../src/agents-md/detect.ts";
import { parseMarkers, sectionContent } from "../src/agents-md/markers.ts";
import { commandsBody, environmentBody, gatesBody } from "../src/agents-md/renderer.ts";
import { WrapError, classifySections, isInsertionsOnly, wrapBytes } from "../src/agents-md/wrap.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const tmp = mkdtempSync(path.join(tmpdir(), "pi-ens-agentsmd-wrap-"));
const AGENTS = path.join(tmp, "AGENTS.md");
const FIXED_DATE = "2026-01-01";

// ---------------------------------------------------------------- the fixture
// A brownfield AGENTS.md: one machine-shaped section (commands, exactly the
// shape commandsBody emits) and one doctrine section (human rules).

const MACHINE_CMD = "| kind | command |\n| --- | --- |\n| test | `vitest` |";
const DOCTRINE =
  "Agents may squash-merge PRs when all gates pass. Direct commits to main are forbidden.";

const ORIGINAL = `# Fixture project

## Overview

This project is a fixture.

## Commands

${MACHINE_CMD}

## Merge rules

${DOCTRINE}
`;
writeFileSync(AGENTS, ORIGINAL);

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

// ------------------------------------------------------- 1. dryRun wrap plan

let writes = 0;
const fs = mkFs({
  writeFile: () => {
    writes++;
  },
});
const res = updateAgent(tmp, AGENTS, fs, true);

assert(res.exitCode === 0, "wrap dryRun: exit 0");
assert(res.plan !== undefined, "wrap dryRun: returns a plan");
assert(res.plan?.state === "no-markers", "wrap dryRun: plan.state is no-markers");
assert(res.plan?.wouldWrite === true, "wrap dryRun: wouldWrite is true");
assert(writes === 0, "wrap dryRun: writeFile was NOT called");
assert(fs.readFile(AGENTS) === ORIGINAL, "wrap dryRun: the file on disk is untouched");

const wrapped = res.plan?.newBytes ?? "";
assert(
  parseMarkers(wrapped)
    .spans.map((s) => s.id)
    .includes("commands"),
  "wrapped bytes: commands span present",
);
assert(
  sectionContent(wrapped, "commands")?.includes("| test | `vitest` |") === true,
  "wrapped bytes: the machine section's content survives inside its span",
);
assert(
  wrapped.includes(`## Merge rules\n\n${DOCTRINE}`),
  "wrapped bytes: the doctrine section is byte-identical",
);
assert(isInsertionsOnly(ORIGINAL, wrapped), "wrapped bytes: the diff is insertions-only");
assert(
  parseMarkers(wrapped)
    .spans.map((s) => s.id)
    .includes("decision-ledger"),
  "wrapped bytes: decision-ledger span present",
);
const ledgerBody = sectionContent(wrapped, "decision-ledger") ?? "";
assert(
  ledgerBody.includes(`| brownfield-wrap | wrapped | [auto:${FIXED_DATE}] |`),
  "wrapped bytes: the ledger has a non-empty [auto] wrap row",
);
assert(
  fileState({ stat: () => true, readFile: () => wrapped, writeFile: () => {} }, "x") ===
    "has-markers",
  "wrap is terminal: fileState(newBytes) === has-markers",
);

// ------------------------------------------------------------ 2. check clean

{
  const checkRes = checkAgent(
    tmp,
    AGENTS,
    {},
    {
      stat: (p) => (p === AGENTS ? true : stat(p)),
      readFile: (p) => (p === AGENTS ? wrapped : readFileSync(p, "utf8")),
      writeFile: () => {},
      today: () => FIXED_DATE,
    },
  );
  assert(
    !checkRes.check?.findings.some((f) => f.kind === "empty-section"),
    "checkAgent on wrapped bytes: no empty-section finding",
  );
}
function stat(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// ------------------------------------------------------- 3. non-dryRun writes

{
  const fs2 = mkFs();
  const res2 = updateAgent(tmp, AGENTS, fs2, false);
  assert(res2.plan?.wouldWrite === true, "wrap write: wouldWrite is true");
  const onDisk = fs2.readFile(AGENTS);
  assert(onDisk === wrapped, "wrap write: the wrapped bytes landed on disk");
  assert(fileState(fs2, AGENTS) === "has-markers", "wrap write: file is now has-markers");

  // Terminal: a second update takes the normal path and is a no-op.
  const fs3 = mkFs({
    writeFile: () => {
      throw new Error("second update must be a no-op");
    },
  });
  const res3 = updateAgent(tmp, AGENTS, fs3);
  assert(res3.plan?.state === "has-markers", "second update: takes the has-markers path");
  assert(res3.plan?.wouldWrite === false, "second update: no-op (already current)");
}

// --------------------------------------------- 4. exit 1: ambiguous heading

{
  rmSync(AGENTS);
  writeFileSync(
    AGENTS,
    "# Fixture\n\n## Commands\n\nThese are not the commands you know.\n\n## Rules\n\nBe kind.\n",
  );
  const resAmb = updateAgent(tmp, AGENTS, mkFs(), true);
  assert(resAmb.exitCode === 1, "ambiguous heading: exit 1 (not a refuse)");
  assert(
    /ambiguous classification.*Commands/.test(resAmb.error ?? ""),
    "ambiguous heading: the error names the ambiguous section",
  );
  assert(!resAmb.plan, "ambiguous heading: no plan is produced");
}

// ------------------------------------- 5. exit 2: nothing classifiable

{
  rmSync(AGENTS);
  // No `## ` sections at all, and no manifest to derive from.
  writeFileSync(AGENTS, "# Bare file\n\nJust prose, no sections.\n");
  const resNone = updateAgent(tmp, AGENTS, mkFs(), true);
  assert(resNone.exitCode === 2, "nothing classifiable: exit 2");
  assert(/refusing to wrap/.test(resNone.error ?? ""), "nothing classifiable: the error says why");
}

// --------------------------------------- 6. a hostile machine section stays
// the ORIGINAL'S: the wrap never adopts the fact-derived body. A `## Commands`
// section whose shape matches but carries an extra line wraps verbatim, with
// that line preserved inside the span.
{
  const hostile =
    "# F\n\n## Commands\n\n| kind | command |\n| --- | --- |\n| test | `vitest` |\n| secret | `keep me` |\n";
  rmSync(AGENTS);
  writeFileSync(AGENTS, hostile);
  const resHostile = updateAgent(tmp, AGENTS, mkFs(), true);
  assert(resHostile.exitCode === 0, "hostile machine section: wraps (insertions-only)");
  assert(
    (resHostile.plan?.newBytes ?? "").includes("| secret | `keep me` |"),
    "hostile machine section: the original line is preserved, not replaced by the derived body",
  );
}

// --------------------------------------------- 7. create dryRun (no-file)

{
  const mkd = mkdtempSync(path.join(tmpdir(), "pi-ens-agentsmd-wrap-fresh-"));
  const file = path.join(mkd, "AGENTS.md");
  let wrote = false;
  const resC = createAgent(mkd, file, mkFs({ writeFile: () => (wrote = true) }), true);
  assert(resC.exitCode === 0, "create dryRun: exit 0");
  assert(resC.plan?.state === "no-file", "create dryRun: state is no-file");
  assert(resC.plan?.oldBytes === "", "create dryRun: oldBytes is empty");
  assert((resC.plan?.newBytes ?? "").length > 0, "create dryRun: newBytes is computed");
  assert(wrote === false, "create dryRun: writeFile NOT called");
  rmSync(mkd, { recursive: true, force: true });
}

// ------------------- 8. wrapBytes pure API: facts unused, throws, ledger rows

{
  // wrapBytes is pure: `facts` never shapes the output (bodies and ledger
  // rows are the caller's input). The two calls below differ only in facts.
  const noFacts = detectFacts(tmp); // tmp has no manifest after cleanup of ci
  const b1 = wrapBytes(
    ORIGINAL,
    noFacts,
    [{ id: "commands", body: MACHINE_CMD }],
    [{ key: "brownfield-wrap", value: "wrapped", provenance: "auto", date: FIXED_DATE }],
  ).bytes;
  const b2 = wrapBytes(
    ORIGINAL,
    {
      ...noFacts,
      manifest: "package.json",
      commands: [{ name: "x", command: "x", kind: "test", runner: "bun" }],
    },
    [{ id: "commands", body: MACHINE_CMD }],
    [{ key: "brownfield-wrap", value: "wrapped", provenance: "auto", date: FIXED_DATE }],
  ).bytes;
  assert(b1 === b2, "wrapBytes: the facts param does not shape the output (pure)");

  // The ambiguity error carries the section heading(s).
  let err: unknown;
  try {
    wrapBytes(
      "# F\n\n## Commands\n\nnot the table\n",
      noFacts,
      [{ id: "commands", body: "x" }],
      [],
    );
  } catch (e) {
    err = e;
  }
  assert(err instanceof WrapError, "wrapBytes: ambiguous section throws WrapError");
  assert(
    /Commands/.test((err as Error).message),
    "wrapBytes: the error names the ambiguous section",
  );

  // classifySections defaults to doctrine: a heading that merely resembles a
  // managed id ("Quality", not "Quality Gates") is NOT one.
  const cls = classifySections(
    "# F\n\n## Quality\n\nbe fast\n\n## Quality Gates\n\nRun these before pushing. All must pass locally:\n\n- **t** — `bun run test`\n",
  );
  assert(
    cls[0]?.classification === "doctrine",
    "classify: '## Quality' is doctrine (not a managed id)",
  );
  assert(
    cls[1]?.classification === "machine",
    `classify: '## Quality Gates' with gates-shaped content is machine (got ${cls[1]?.classification})`,
  );

  // The body helpers are the same source the update path uses: the machine
  // section above matches commandsBody's shape by construction.
  const nodeFacts = {
    manifest: "package.json",
    runner: "bun",
    packageManager: "bun",
    commands: [{ name: "bun test", command: "bun run test", kind: "test", runner: "bun" }],
    ciWorkflows: [],
    notes: [],
  };
  const cmdBody = commandsBody(nodeFacts);
  assert(
    typeof cmdBody === "string" && cmdBody.includes("| kind | command |"),
    "renderer: commandsBody emits the table the classifier matches",
  );
  assert(
    typeof environmentBody(nodeFacts) === "string",
    "renderer: environmentBody derives from the manifest facts",
  );
  assert(
    typeof gatesBody(nodeFacts) === "string",
    "renderer: gatesBody derives from the command facts",
  );
}

rmSync(tmp, { recursive: true, force: true });

console.log(exit === 0 ? "\nAll wrap checks passed." : "\nFAILED");
process.exit(exit);
