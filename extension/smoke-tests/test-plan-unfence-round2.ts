#!/usr/bin/env bun
/**
 * #1167 round 2 — the three findings the adversarial review raised against the
 * first unfence implementation, each pinned by the case that reproduced it.
 *
 * A. **Prohibitions with no auxiliary.** The first `NEGATION` read only
 *    auxiliary negation ("do not …"), so eight phrasings that refuse without
 *    one — "keep X untouched", "leave X alone", "X remains unchanged", "skip
 *    X", "X is not part of this change", "off-limits", "leave X as is" — were
 *    treated as requirements and their fences REMOVED. That is the wrong
 *    direction of failure for a pass whose rule is *when in doubt, keep the
 *    fence*. Widening the verbs then produced the mirror-image bug, which is
 *    why the required sentences below are asserted too: `keep` / `leave` /
 *    `skip` are ordinary English, and a bare `keep <pronoun>` matched
 *    "Dispatch keeps its own seam" — the very #1020 sentence this feature
 *    exists to read — so the replay regressed to the parked cycle.
 *
 * B. **Code blocks leaking into the extraction.** An issue's DECISIONS section
 *    quotes an example to show the shape the change must NOT become. A path
 *    inside it is an illustration, not a requirement, and must not unfence
 *    anything.
 *
 * C. **Broad directory fences, and unfence-without-an-owner.** Naming
 *    `config/app.ts` must not lift a `config/` fence the issue never spoke to
 *    (the first implementation was containment-aware and did exactly that);
 *    and with N>1 a path no workstream can own keeps its fence — the removal
 *    is rolled back, so a note saying "left fenced" describes the plan the
 *    operator actually has.
 *
 * Split out of test-plan-unfence-issue-named.ts for the AGENTS.md §12 line cap.
 */

import { stripCodeBlocks } from "../src/work-driver-plan-unfence-code.ts";
import { isProhibition, issueNamedTokens } from "../src/work-driver-plan-unfence-extract.ts";
import { unfenceIssueNamedPaths } from "../src/work-driver-plan-unfence.ts";
import type { Workstream } from "../src/workflow-state-schema.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** A grep/read stub: every named symbol is defined in exactly one source file. */
function stubExec(definitions: Record<string, string[]>) {
  return async (_cmd: string, opts?: { argv?: string[] }) => {
    const argv = opts?.argv ?? [];
    if (argv[0] === "grep") {
      const name = argv[4] ?? "";
      return { stdout: (definitions[name] ?? []).map((f) => `${f}\n`).join("") };
    }
    if (argv[0] === "show") {
      const file = (argv[1] ?? "").split(":")[1] ?? "";
      const defining = Object.entries(definitions).find(([, files]) => files.includes(file))?.[0];
      return {
        stdout: defining
          ? `export function ${defining}(opts: unknown) {\n  return 1;\n}\n`
          : "//\n",
      };
    }
    return { stdout: "" };
  };
}

const WS = (id: string, paths: string[], outOfScope: string[]): Workstream => ({
  id,
  scope: id,
  paths,
  outOfScope,
});

const OPTS = {
  execFn: stubExec({ dispatchCore: ["extension/src/dispatch.ts"] }),
  repoRoot: "/repo",
  ref: "origin/main",
};

// ---------------------------------- A: prohibition phrasings, both directions

{
  // A false positive is the expensive direction: it silently drops a
  // requirement and the plan then fences a file the issue demands.
  const PROHIBITED = [
    "Keep src/k1.ts untouched",
    "Leave src/k2.ts alone",
    "src/k3.ts remains unchanged",
    "Skip src/k4.ts this cycle",
    "src/k5.ts is not part of this change",
    "src/k6.ts is off-limits",
    "leave src/k7.ts as is",
    "Do not modify src/k8.ts",
  ];
  const REQUIRED = [
    "Reuse src/helper.ts for the new path.",
    "The seam lives in extension/src/dispatch.ts.",
    "dispatchCore gains a host parameter.",
    "Keep the existing tests green in src/keep-tests.ts.",
    "The change leaves src/behaviour.ts behaviour intact.",
    // The #1020 sentence's own words. `keep <pronoun>` matched anywhere made
    // this a prohibition and the replay lost dispatchCore.
    "Dispatch keeps its own seam: dispatchCore/startJob take a narrow DispatchHost.",
    // `remains a candidate` is a status, not a refusal — which is why the
    // predicate is required after `remains`/`stays`.
    "X remains a candidate until promoted; edit src/x.ts.",
  ];
  for (const sentence of PROHIBITED)
    assert(isProhibition(sentence), `prohibition detected: ${sentence}`);
  for (const sentence of REQUIRED)
    assert(!isProhibition(sentence), `requirement survives: ${sentence.slice(0, 46)}…`);
  assert(
    issueNamedTokens(`## Decisions\n- ${REQUIRED[5]}\n`).includes("dispatchCore"),
    "the #1020 decision sentence still yields dispatchCore",
  );
}

// ------------------------------------------------- B: code blocks never unfence

{
  const strip = (lines: string[]): string => stripCodeBlocks(lines.join("\n"));
  const fenced = strip([
    "## Decisions",
    "- Use src/real.ts.",
    "```ts",
    "import x from 'src/example.ts';",
    "```",
    "- src/plain.ts is required.",
  ]);
  assert(
    !fenced.includes("src/example.ts") &&
      fenced.includes("src/real.ts") &&
      fenced.includes("src/plain.ts"),
    "a fenced example is stripped and the prose around it survives",
  );
  assert(
    !issueNamedTokens(
      `## Decisions\n${["- Use src/real.ts.", "~~~", "cat src/tilde.ts", "~~~"].join("\n")}`,
    ).includes("src/tilde.ts"),
    "tilde fences are stripped too",
  );
  assert(
    !issueNamedTokens(
      [
        "## Decisions",
        "- Use src/real.ts.",
        "    const src/indent.ts = 1;",
        "- src/after.ts too.",
      ].join("\n"),
    ).includes("src/indent.ts"),
    "a 4-space indented block is stripped",
  );
  // Fail-closed: `- ``` ` is a list item, not a delimiter, so nothing a reader
  // could call prose is ever removed.
  const listItem = strip(["## Decisions", "- ```", "cat src/mark.ts", "```"]);
  assert(
    listItem.includes("src/mark.ts"),
    "a list-marker 'fence' is prose, not a delimiter (fail closed: it stays)",
  );
  const unterminated = strip([
    "## Decisions",
    "- Use src/real.ts.",
    "```",
    "cat src/leak.ts",
    "## Acceptance Criteria",
    "- src/ac.ts passes.",
  ]);
  assert(
    !unterminated.includes("src/leak.ts") && unterminated.includes("src/ac.ts"),
    "an unterminated fence stops at the next heading, not at the body's end",
  );
}

// ---------------------------- C: broader fences + placement, both directions

{
  const body = "## Decisions\n- dispatchCore changes.\n";

  // A directory fence the issue never spoke to is NOT lifted by a file mention.
  const broader = await unfenceIssueNamedPaths(
    { default: WS("default", ["extension/src/app.ts"], ["extension/src/", "other/"]) },
    body,
    { ...OPTS, defaultToSingle: true },
  );
  assert(
    broader.workstreams.default.outOfScope.includes("extension/src/"),
    "an issue naming one file does not lift a broader directory fence",
  );
  assert(
    broader.notes.some(
      (n) =>
        n ===
        "kept fence extension/src/: the issue named extension/src/dispatch.ts, not the whole directory",
    ),
    "the kept fence is recorded as a note rather than passing silently",
  );

  // #1167 round-4 — the SAME fence written as a glob (`extension/src/**`) is
  // the same directory, and a fence that has to be spelled one way to be seen
  // is a fence the "we declined to open a wider fence" note silently misses.
  const globbed = await unfenceIssueNamedPaths(
    { default: WS("default", ["extension/src/app.ts"], ["extension/src/**", "other/"]) },
    body,
    { ...OPTS, defaultToSingle: true },
  );
  assert(
    globbed.workstreams.default.outOfScope.includes("extension/src/**"),
    "an issue naming one file does not lift a broader `dir/**` fence either",
  );
  assert(
    globbed.notes.some(
      (n) =>
        n ===
        "kept fence extension/src/**: the issue named extension/src/dispatch.ts, not the whole directory",
    ),
    "the glob-shaped directory fence is recognised as broader and recorded as a kept fence",
  );

  // N>1 with no shared directory: the removal is ROLLED BACK, so "left fenced"
  // is literally true rather than a note describing a plan that does not exist.
  const orphan = await unfenceIssueNamedPaths(
    {
      "task-a": WS("task-a", ["src/a.ts"], ["extension/src/dispatch.ts"]),
      "task-b": WS("task-b", ["docs/b.md"], []),
    },
    body,
    OPTS,
  );
  assert(
    orphan.workstreams["task-a"].outOfScope.includes("extension/src/dispatch.ts"),
    "N>1: a path no workstream can own keeps its fence (the removal is rolled back)",
  );
  assert(
    orphan.removed.length > 0 && orphan.removed.every((r) => r.restored !== undefined),
    "the rollback is recorded on the removal, not merely asserted in prose",
  );
  assert(
    orphan.warnings.some((w) => w.includes("left fenced for placement")),
    "the warning says why the path stayed fenced",
  );
  // #1167 round-4 — and the NOTES agree with that warning. Round-3 removed the
  // long-form `unfenced … — placed in workstream X` line on rollback but left
  // the plain `unfenced <path>: named by the issue`, so a fully rolled-back
  // path still announced itself as unfenced in `notes` while `warnings` said it
  // was left fenced. Nothing was removed, so no note may claim otherwise.
  assert(
    !orphan.notes.some((n) => n.startsWith("unfenced ")),
    "a path whose every removal was rolled back leaves no 'unfenced' note (the notes cannot contradict the 'left fenced' warning)",
  );

  // N>1 WITH a shared directory: placement happens and the fence stays gone.
  const placed = await unfenceIssueNamedPaths(
    {
      "task-a": WS("task-a", ["extension/src/dispatch-core.ts"], ["extension/src/dispatch.ts"]),
      "task-b": WS("task-b", ["docs/b.md"], []),
    },
    body,
    OPTS,
  );
  assert(
    !placed.workstreams["task-a"].outOfScope.includes("extension/src/dispatch.ts") &&
      placed.workstreams["task-a"].paths.includes("extension/src/dispatch.ts"),
    "N>1: a path sharing a directory is unfenced AND placed with the nearest workstream",
  );
  assert(
    !placed.workstreams["task-b"].paths.includes("extension/src/dispatch.ts"),
    "the path is not handed to the unrelated workstream",
  );
}

console.log(exit === 0 ? "\nAll plan-unfence round-2 assertions passed." : "\nFAILURES above.");
process.exit(exit);
