#!/usr/bin/env bun
/**
 * lean/review — the frozen acceptance contract, proved by committed BYTES.
 *
 * A fix round is refused if it changed a frozen test. The proof is `frozenMatches`:
 * re-hash `git show <ref>:<path>` and compare against the sha256 the `specify`
 * step recorded. Two ways that proof goes silently wrong, and both are pinned
 * here rather than assumed:
 *
 *   (x0) an object-id read (`rev-parse <ref>:<path>`) is a sha1 of a different
 *       thing and matches NOTHING, so a fixer that cheated would be waved
 *       through. And the reverse: the map reaching the step with empty keys makes
 *       the comparison never run at all, which reads as a pass.
 *
 *   (x) the map is keyed by PATH, so two path shapes have broken path-keyed
 *       proofs: a NESTED path (a read that drops the subdirectory hashes the
 *       wrong blob) and a path containing a SPACE (a read through a shell string
 *       splits into two argv). The flat case alone exercises neither.
 *
 * Split from `test-lean-review-wiring.ts` by the size ratchet; the seam is that
 * these are the only review cases whose subject is the frozen record itself
 * rather than the tree a fixer works in or the gate that asked for the fix.
 *
 * Real temp repos, stubbed models, no child spawned, no token spent.
 */

import { sha256 } from "../src/lean/specify-proof.ts";
import { ReviewInfraError } from "../src/lean/review.ts";
import type { DispatchSpec } from "../src/types.ts";
import { put } from "./lib/lean-build-fixture.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  BRANCH,
  FIXER_ROLE,
  cleanupRoots,
  ctxFor,
  depsWith,
  frozenBlob,
  git,
  makeRepo,
  result,
  runStep as run,
  setup,
} from "./lib/lean-review-fixtures.ts";

const { assert, failures } = makeAssert();

// ── (x0) a fixer that rewrote the frozen contract is refused ──────────────────
// ── (x) the frozen proof holds for paths git makes awkward ─────────────────
//
// Two path shapes break path-keyed proofs: a NESTED path (a read that drops the
// subdirectory hashes the wrong blob) and a path with a SPACE (a read through a
// shell string splits into two argv). (d) drives one flat path, so neither ran.
{
  const { repoRoot, baseSha } = makeRepo();
  const head = await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const show = (ref: string, p: string): string => git(repoRoot, "show", `${ref}:${p}`);

  // The two awkward paths, created and committed at HEAD.
  const NESTED = "tests/nested/deep/AC2.test.ts";
  const SPACED = "tests/AC 3 spaced.test.ts";
  put(repoRoot, NESTED, "// frozen nested\n");
  put(repoRoot, SPACED, "// frozen spaced\n");
  git(repoRoot, "add", "-A");
  git(repoRoot, "commit", "-q", "-m", "test: frozen contract with nested and spaced paths");

  const frozen: Record<string, string> = {
    [NESTED]: sha256(show("HEAD", NESTED)),
    [SPACED]: sha256(show("HEAD", SPACED)),
  };
  assert(
    Object.keys(frozen).length === 2 && frozen[NESTED] !== frozen[SPACED],
    "(x) precondition: the two odd paths are distinct frozen entries, read back through git",
  );

  const ctx = ctxFor(repoRoot, baseSha, BRANCH);
  ctx.run.steps.push({
    key: "7:specify:0",
    state: "specify",
    startedAt: 1,
    endedAt: 2,
    outcome: { kind: "ok", frozen, tests: { AC2: [NESTED], AC3: [SPACED] } },
  });

  // Both frozen files rewritten in one round: the refusal must name BOTH.
  const { threw } = await run(
    ctx,
    depsWith({
      adversarial: async () => result({ loopOutcome: "rejected", text: "1. silent catch" }),
      dispatch: async (spec: DispatchSpec) => {
        const wt = spec.cwd as string;
        put(wt, NESTED, "// cheated nested\n");
        put(wt, SPACED, "// cheated spaced\n");
        git(wt, "add", "-A");
        git(wt, "commit", "-q", "-m", "fix: cheated both");
        return result({ role: FIXER_ROLE });
      },
    }),
  );
  assert(
    threw instanceof ReviewInfraError && /frozen acceptance contract/.test(threw.message),
    `(x) a fixer that rewrote the nested and space-bearing frozen tests is refused (${threw?.message})`,
  );
  assert(
    threw !== undefined &&
      threw.message.includes("nested") &&
      threw.message.includes("spaced"),
    `(x) and the refusal NAMES both odd paths, so the operator can see which two files the fixer touched (${threw?.message})`,
  );
  assert(
    git(repoRoot, "rev-parse", `origin/${BRANCH}`) === head,
    "(x) neither cheat reached origin",
  );
}

// ── (x0) a fixer that rewrote the frozen contract is refused ──────────────────
{
  const { repoRoot, baseSha } = makeRepo();
  const head = await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const ctx = ctxFor(repoRoot, baseSha, BRANCH);
  const frozenFile = frozenBlob(repoRoot, "HEAD");
  const frozen = { "tests/AC1.test.ts": sha256(frozenFile) };
  // The frozen record must reach the step the way the machine puts it there: a
  // decided `specify:ok` step carrying the map.
  ctx.run.steps.push({
    key: "7:specify:0",
    state: "specify",
    startedAt: 1,
    endedAt: 2,
    outcome: { kind: "ok", frozen, tests: { AC1: ["tests/AC1.test.ts"] } },
  });
  const { threw } = await run(
    ctx,
    depsWith({
      adversarial: async () => result({ loopOutcome: "rejected", text: "1. silent catch" }),
      dispatch: async (spec: DispatchSpec) => {
        // The tree the step sent it to, never a path this file guesses: the
        // fixer's tree is named per round and per run, and a stub that hardcodes
        // a location is a stub that quietly writes where nobody is looking.
        const wt = spec.cwd as string;
        put(wt, "tests/AC1.test.ts", "// rewritten\n");
        git(wt, "add", "-A");
        git(wt, "commit", "-q", "-m", "fix: cheated");
        return result({ role: FIXER_ROLE });
      },
    }),
  );
  assert(
    threw instanceof ReviewInfraError && /frozen acceptance contract/.test(threw.message),
    `(x0) a fixer that committed a change to a frozen test is refused (${threw?.message})`,
  );
  assert(
    git(repoRoot, "rev-parse", `origin/${BRANCH}`) === head,
    "(x0) the refused fix was never pushed: origin still holds the reviewed head",
  );
}

cleanupRoots();
process.exit(failures());

cleanupRoots();
process.exit(failures());
