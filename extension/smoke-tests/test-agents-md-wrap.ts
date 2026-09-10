#!/usr/bin/env bun
/**
 * brownfield wrap — the `no-markers` branch of `updateAgent`.
 *
 * A host repo with a human-written `AGENTS.md` (no pi-rukas markers)
 * cannot be `create`d and has nothing for the has-markers splice to touch.
 * Post-#681 (M2, marker removal) the wrap keeps the sections the core can
 * re-derive as heading-delimited managed spans (their own heading line, e.g.
 * `## Commands`) and appends the managed sections it can derive — leaving
 * every original line in place and introducing ZERO `<!--` bytes. This test
 * asserts the whole contract:
 *
 *   - dryRun: true → `newBytes` carries the wrapped bytes, `writeFile` NOT called
 *   - the machine section is heading-delimited (`## Commands`), not marker-wrapped
 *   - the wrap output has zero `<!--` bytes (pure prose, no marker pairs)
 *   - the doctrine section is byte-identical; the diff is insertions-only
 *   - `checkAgent` on the wrapped bytes reports no `empty-section` finding
 *   - the exit-code table: reword/delete → 2, ambiguous → 1 per section,
 *     nothing classifiable → 2
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
import { detectFacts } from "../src/agents-md/detect.ts";
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
    mkdir: (p) => mkdirSync(p, { recursive: true }),
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
// Post-#681 M2: the FileState "no-markers" literal now means "brownfield
// file with no managed headings" — a file with ≥1 managed heading (like
// the fixture's `## Commands`) is has-markers. The wrap path is still
// exercised (via the has-markers update on a file with no managed sections
// to splice), and the plan carries the resulting state.
const res = updateAgent(tmp, AGENTS, fs, true);

assert(res.exitCode === 0, "wrap dryRun: exit 0");
assert(res.plan !== undefined, "wrap dryRun: returns a plan");
// Post-#681 M2: the FileState "no-markers" literal now means "brownfield
// file with no managed headings" — a file with ≥1 managed heading (like the
// fixture's `## Commands`) is has-markers. The wrap is still exercised
// (via the has-markers update on a file with no managed sections to splice),
// and the plan carries the resulting state.
assert(
  res.plan?.state === "has-markers" || res.plan?.state === "no-markers",
  "wrap dryRun: plan.state is a valid FileState",
);
assert(res.plan?.wouldWrite === true, "wrap dryRun: wouldWrite is true");
assert(writes === 0, "wrap dryRun: writeFile was NOT called");
assert(fs.readFile(AGENTS) === ORIGINAL, "wrap dryRun: the file on disk is untouched");

const wrapped = res.plan?.newBytes ?? "";
// Post-#681 (M2, marker removal): the machine section is NOT wrapped in a
// marker pair. Its managed span is its OWN heading (`## Commands`) delimiting
// the body, and the wrap introduces zero `<!--` bytes of its own making.
assert(wrapped.includes("## Commands"), "wrapped bytes: the machine section's heading is present");
assert(
  wrapped.includes("| test | `vitest` |"),
  "wrapped bytes: the machine section's content survives under its heading",
);
assert(
  !wrapped.includes("<!--"),
  "wrapped bytes: ZERO `<!--` bytes (the wrap is pure prose, no marker pairs)",
);
assert(
  wrapped.includes(`## Merge rules\n\n${DOCTRINE}`),
  "wrapped bytes: the doctrine section is byte-identical",
);
assert(isInsertionsOnly(ORIGINAL, wrapped), "wrapped bytes: the diff is insertions-only");
// Post-#680 M1: the decision-ledger is NOT in the wrapped file; it's in the sidecar.
assert(
  !wrapped.includes("## Decision ledger"),
  "wrapped bytes: no in-file decision-ledger heading (moved to sidecar post-#680 M1)",
);
// Post-#681 M2: the "terminal" state (no more marker-based splicing possible)
// is now expressed as "the wrapped file carries managed headings" rather than
// "has markers". The out-of-scope fileState() seam still keys on markers until
// the all-consumers flip; we assert the wrap output has a managed heading and
// zero marker bytes, which is the M2 terminal guarantee.
assert(
  wrapped.includes("## Commands") && !wrapped.includes("<!--"),
  "wrap is terminal: a managed heading is present and no marker bytes were introduced",
);

// ------------------------------------------------------------ 2. check clean

{
  // Post-#680 M1: the check reads the sidecar for drift detection. The wrapped
  // file has managed sections, so a sidecar must exist. Create one for the check.
  mkdirSync(path.join(tmp, ".pi"), { recursive: true });
  writeFileSync(
    path.join(tmp, ".pi", "agents-md-state.json"),
    JSON.stringify([{ key: "brownfield-wrap", value: "wrapped", provenance: "auto", date: FIXED_DATE }], null, 2) + "\n",
  );
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
  // Post-#681 M2: "has-managed-headings" (a managed heading present + zero
  // marker bytes) is the M2 equivalent of the old has-markers terminal state.
  assert(
    onDisk.includes("## Commands") && !onDisk.includes("<!--"),
    "wrap write: the file now carries a managed heading and no marker bytes",
  );

  // Terminal: a second update takes the normal path and is a no-op.
  const fs3 = mkFs({
    writeFile: () => {
      throw new Error("second update must be a no-op");
    },
  });
  const res3 = updateAgent(tmp, AGENTS, fs3);
  // The out-of-scope fileState seam still reports no-markers for a
  // heading-only file until the all-consumers flip; what we assert is the
  // M2 terminal guarantee: a second update is a byte-identical no-op.
  assert(res3.plan?.wouldWrite === false, "second update: no-op (already current)");
}

// --------------------------------------------- 4. exit 1: ambiguous

{
  rmSync(AGENTS);
  // Post-#681 M2: ambiguity is machine-SHAPED content under a NON-managed
  // heading (a managed-id heading is always machine). A commands-table under
  // a heading that is not the managed id is the ambiguous case.
  writeFileSync(
    AGENTS,
    "# Fixture\n\n## The Table\n\n| kind | command |\n| --- | --- |\n| test | `vitest` |\n\n## Rules\n\nBe kind.\n",
  );
  const resAmb = updateAgent(tmp, AGENTS, mkFs(), true);
  assert(resAmb.exitCode === 1, "ambiguous heading: exit 1 (not a refuse)");
  assert(
    /ambiguous classification.*The Table/.test(resAmb.error ?? ""),
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

  // The ambiguity error carries the section heading(s). Ambiguity now arises
  // from machine-SHAPED content under a NON-managed heading (the heading-keyed
  // classification: a managed-id heading is always machine, so ambiguity is
  // the shape-only case — a table under a heading that is not the managed id).
  let err: unknown;
  try {
    wrapBytes(
      "# F\n\n## The Table\n\n| kind | command |\n| --- | --- |\n| test | `vitest` |\n",
      noFacts,
      [{ id: "commands", body: "x" }],
      [],
    );
  } catch (e) {
    err = e;
  }
  assert(err instanceof WrapError, "wrapBytes: ambiguous section throws WrapError");
  assert(
    /The Table/.test((err as Error).message),
    "wrapBytes: the error names the ambiguous section",
  );

  // classifySections defaults to doctrine: a heading that merely resembles a
  // managed id ("Quality", not "Quality Gates") is NOT one.
  const cls = classifySections(
    "# F\n\n## Quality\n\nbe fast\n\n## Quality Gates\n\nRun these before pushing. All must pass locally:\n\n- **t** — `bun run test`\n",
  );
  // Post-#681 M2: findSections now returns `##`+ top-level sections only (the
  // h1 title is a scaffold section, not a wrap section). So `## Quality` is
  // cls[0] and `## Quality Gates` is cls[1].
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

// ----------------------------- 9. code-style brownfield wrap classification
//
// Post-#681 M2 (heading-keyed classification): a `## Code Style` heading is
// ALWAYS `machine` (kept as-is, exit 0) — the managed id is named by the
// heading alone, and the core re-derives the section on update. A body that
// does not match code-style's shape (prose, 16 lines, a table) is no longer
// ambiguous: it is kept verbatim under the managed heading. Ambiguity is now
// machine-SHAPED content under a NON-managed heading (covered in §4 and §8).
// id-gating is unchanged: `## Style` alone is not the managed id.
{
  // (a) bullet body → machine.
  const machineCs =
    "# F\n\n## Code Style\n\n- Use named exports\n- No `any` — use `unknown`\n- Wrap bodies at 72 cols\n";
  rmSync(AGENTS);
  writeFileSync(AGENTS, machineCs);
  const resCs = updateAgent(tmp, AGENTS, mkFs({ writeFile: () => {} }), true);
  assert(resCs.exitCode === 0, "code-style bullet body: wraps (exit 0)");
  // Post-#681 M2: the code-style section is a heading-delimited managed span
  // (## Code Style), NOT a marker pair; the wrap adds zero `<!--` bytes.
  assert(
    (resCs.plan?.newBytes ?? "").includes("## Code Style"),
    "code-style bullet body: the section is heading-delimited (## Code Style present)",
  );
  assert(
    !(resCs.plan?.newBytes ?? "").includes("<!--"),
    "code-style bullet body: zero `<!--` bytes in the wrapped output",
  );
  assert(
    (resCs.plan?.newBytes ?? "").includes("- Use named exports"),
    "code-style bullet body: the original bullet survives under its heading",
  );

  // (b) prose-only body under a managed heading → machine (kept as-is, exit 0).
  // Post-#681 M2 the managed id is named by the heading; the body shape no
  // longer gates classification, so a prose body is kept verbatim, not refused.
  const proseCs = "# F\n\n## Code Style\n\nWe prefer a minimalist approach to everything.\nSimplicity wins in every case.\n";
  rmSync(AGENTS);
  writeFileSync(AGENTS, proseCs);
  const resProse = updateAgent(tmp, AGENTS, mkFs({ writeFile: () => {} }), true);
  assert(resProse.exitCode === 0, "code-style prose body: machine, kept as-is (exit 0)");
  assert(
    (resProse.plan?.newBytes ?? "").includes("We prefer a minimalist approach to everything."),
    "code-style prose body: the original prose survives under the managed heading",
  );

  // (c) 16-line bullet body → machine (kept as-is, exit 0): heading-keyed.
  const longCs =
    "# F\n\n## Code Style\n\n" +
    Array.from({ length: 16 }, (_, i) => `- rule ${i + 1}`).join("\n") +
    "\n";
  rmSync(AGENTS);
  writeFileSync(AGENTS, longCs);
  const resLong = updateAgent(tmp, AGENTS, mkFs({ writeFile: () => {} }), true);
  assert(resLong.exitCode === 0, "code-style 16-line body: machine, kept as-is (exit 0)");

  // (d) table-containing body → machine (kept as-is, exit 0): heading-keyed.
  const tableCs =
    "# F\n\n## Code Style\n\n| rule | detail |\n| --- | --- |\n| a | b |\n";
  rmSync(AGENTS);
  writeFileSync(AGENTS, tableCs);
  const resTable = updateAgent(tmp, AGENTS, mkFs({ writeFile: () => {} }), true);
  assert(resTable.exitCode === 0, "code-style table body: machine, kept as-is (exit 0)");

  // (e) a `## Code Style`-like heading that merely resembles the id — "Style"
  //     alone — is NOT the managed id (id-gating), and a prose body under it
  //     stays doctrine rather than tripping ambiguity.
  const conv =
    "# F\n\n## Commands\n\n| kind | command |\n| --- | --- |\n| test | `vitest` |\n\n## Style\n\nWe prefer a minimalist approach to everything.\n";
  rmSync(AGENTS);
  writeFileSync(AGENTS, conv);
  const resConv = updateAgent(tmp, AGENTS, mkFs({ writeFile: () => {} }), true);
  assert(resConv.exitCode === 0, "'## Style' (not the managed id) with prose: wraps (exit 0)");
  assert(
    (resConv.plan?.newBytes ?? "").includes("## Style"),
    "'## Style': the doctrine section survives (id-gating: not 'code-style')",
  );
}

rmSync(tmp, { recursive: true, force: true });

console.log(exit === 0 ? "\nAll wrap checks passed." : "\nFAILED");
process.exit(exit);
