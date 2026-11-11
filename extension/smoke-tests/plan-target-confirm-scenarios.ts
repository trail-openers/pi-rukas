#!/usr/bin/env bun
/**
 * #1854 — the digest/confirm half of the target-repository feature, as a shared
 * scenario module (not a test file).
 *
 * These are the scenarios that decide whether the feature is safe: the digest is
 * the operator's authorisation to file specific bytes into a specific repository,
 * and the cache lineage is what keeps two repositories' runs apart. Both key on
 * ONE term — the canonical identity `plan-target.ts` derives — and every hasher
 * must read the same value. The defect this guards is a hasher that reaches for
 * the caller's raw `targetRepository` instead: the bytes are identical, so every
 * other term agrees, and the guard silently disarms on a spelling the dry run
 * never produced.
 *
 * They live here, beside the cache stubs they drive, for the same reason
 * `plan-confirm-label-scenarios.ts` does: `test-plan-target-repository.ts` stays
 * one readable file under the 500-line cap (AGENTS.md §12).
 */
import type { Forge } from "../src/forge.ts";
import { heldForReview } from "../src/plan-confirm.ts";
import { reviewedDigestOf } from "../src/plan-filing-claim.ts";
import { setPlanForge } from "../src/plan-filing.ts";
import { setPlanGitStateFn } from "../src/plan-investigation-cache.ts";
import { planTargetFacts } from "../src/plan-target.ts";
import type { PlanDriverInput } from "../src/plan-types.ts";
import { forgeStub } from "./plan-test-stubs.ts";

/** Count failures the way the calling test does: one exit code for the whole file. */
export type TargetAssert = (cond: boolean, msg: string) => void;

/** The forge stub's create-call recorder, with `labelList` answering from `existing`. */
function recordingForge(cwd: string): Forge {
  return {
    issueCreate: (title: string, body: string, opts?: { labels?: string[] }) => {
      forgeStub.created.push({ title, body, labels: opts?.labels });
      return Promise.resolve({ url: "https://example.invalid/x/issues/7", number: 7 });
    },
    labelList: () => {
      forgeStub.labelListCalls++;
      return Promise.resolve({ names: forgeStub.existing ?? [], truncated: false });
    },
  } as unknown as Forge;
}

/**
 * Install a forge whose adapter records the cwd it was handed at resolve time.
 *
 * This is the assertion channel the forge stub alone cannot provide: `setPlanForge`
 * replaces the adapter wholesale, so `created` proves a create happened but not
 * which repository the real adapter would have addressed. `createForge` captures
 * `cwd` once in a closure and every command runs through it, so the cwd the
 * resolver was asked for IS the repository the filing targets — the assertion the
 * live incident turned on.
 */
export const resolvedCwds: string[] = [];
export function installRecordingForge(cwd: string): void {
  resolvedCwds.length = 0;
  forgeStub.created.length = 0;
  forgeStub.labelListCalls = 0;
  forgeStub.resolveCalls = 0;
  forgeStub.existing = null;
  setPlanForge(() => {
    forgeStub.resolveCalls++;
    resolvedCwds.push(cwd);
    return Promise.resolve(recordingForge(cwd));
  });
}

/**
 * The `call` / forge-recorder shape `test-plan-target-repository.ts` owns. The
 * scenarios need them rather than a second harness: a verbatim confirm is only
 * proven verbatim by the SAME recorder that counts children and create calls.
 */
export interface TargetHarness {
  /** One tool call driven to its delivered report (or its pre-launch refusal). */
  call: (params: Record<string, unknown>) => Promise<{
    details: Record<string, unknown>;
    /** The rendered completion report — where the target section lives. */
    text: string;
  }>;
  /** Install the forge recorder aimed at a directory, resetting its counters. */
  installForge: (cwd: string) => void;
  /** The cwds the forge resolver was asked for, since the last install. */
  resolvedCwds: string[];
  /** Every dispatched child, since the last call. */
  seen: unknown[];
  /** Create calls recorded by the forge stub. */
  created: unknown[];
  /** The target clone's directory — the cwd a correct filing builds its forge with. */
  targetDir: string;
  /** The canonical identity of the target clone, as its origin reports it. */
  targetId: string;
  /** Fresh temp cache the git-state stub points at. */
  makeCacheDir: () => Promise<string>;
}

/**
 * (a) A confirm whose target is spelled differently from its dry run's still
 * files the reviewed bytes VERBATIM. The resolver canonicalises a trailing `/`,
 * so the two calls name one destination and one lineage — two tool calls, the
 * string written twice by the caller. Anything but a verbatim filing here means
 * a hasher disagreed with the dry run's hasher on the target term.
 */
export async function confirmAcrossTargetSpellings(
  assert: TargetAssert,
  h: TargetHarness,
): Promise<void> {
  const cacheDir = await h.makeCacheDir();
  setPlanGitStateFn(async () => ({ keySha: "c".repeat(40), cacheDir }));
  const canonical = h.targetId;
  const trailing = `${h.targetId}/`;

  // The unit half: the term every hasher feeds the digest is the canonical text,
  // so a spelling that differs only in the separator hashes identically. A hasher
  // that used the raw parameter hashes a term no dry run ever produced.
  assert(
    reviewedDigestOf("T", "S", { target: planTargetFacts(trailing).targetIdentity }) ===
      reviewedDigestOf("T", "S", { target: planTargetFacts(canonical).targetIdentity }),
    "confirm: a trailing slash is the same digest term as the canonical identity",
  );
  assert(
    reviewedDigestOf("T", "S", { target: planTargetFacts(canonical).targetIdentity }) !==
      reviewedDigestOf("T", "S", { target: "plan-target.test/team-three/target-repo" }),
    "confirm: a different repository is a different digest term",
  );

  h.installForge(h.targetDir);
  const dry = await h.call({ targetRepository: canonical, dryRun: true });
  const digest = dry.details.reviewedDigest as string;
  assert(/^[0-9a-f]{16}$/.test(digest), `confirm: the dry run reported a digest (${digest})`);

  h.installForge(h.targetDir);
  const c = await h.call({ targetRepository: trailing, dryRun: false, reviewedDigest: digest });
  assert(
    c.details.filed === true && c.details.filedFromDryRun !== undefined,
    `confirm: the same destination spelled with a trailing slash files the reviewed bytes verbatim (held: ${JSON.stringify(c.details.reviewedSpecChanged)}, failure: ${JSON.stringify(c.details.filingFailure)})`,
  );
  assert(
    h.resolvedCwds.length === 1 && h.resolvedCwds[0] === h.targetDir,
    `confirm: it filed through the target's adapter (got ${JSON.stringify(h.resolvedCwds)})`,
  );
  assert(
    h.created.length === 1 && h.seen.length === 0,
    "confirm: one create call and zero children — the verbatim path ran, not a re-draft",
  );
  // The verbatim path builds its result directly, so the target has to be
  // threaded to it explicitly. Without that the ONE run that mints the issue
  // renders no target section while its own dry run rendered one — and the
  // mis-targeted filing is again visible only after a number exists.
  assert(
    c.text.includes("=== TARGET REPOSITORY ===") &&
      c.text.includes("issue was filed into") &&
      c.text.includes(h.targetId),
    `confirm: the verbatim filing still names the destination it filed into (got ${JSON.stringify(c.text.split("=== TARGET REPOSITORY ===")[1] ?? "")})`,
  );
  setPlanGitStateFn(null);
}

/**
 * (b) The #1224 held-for-review guard hashes the IDENTITY, not the caller's text.
 * A confirm that could not file verbatim is held rather than filed, and the
 * decision is one digest comparison against the dry run's digest. The dry run's
 * builder (plan-driver-result.ts) and this guard must feed the target term
 * identically, or the guard compares bytes hashed under two different destinations
 * and holds a run whose bytes the operator did review — nothing filed, a pipeline
 * paid for, and a fresh digest nobody saw.
 */
export function heldForReviewHashesIdentity(
  assert: TargetAssert,
  descriptor: string,
  targetId: string,
): void {
  const reviewed = reviewedDigestOf("T", "S", { target: targetId });
  const input: PlanDriverInput = { descriptor, type: "bug", reviewedDigest: reviewed };
  // The driver passes the canonical identity it derived (plan-driver.ts), never
  // the caller's text, so a non-canonical spelling cannot move the hash.
  const spellings = [`${targetId}/`, `${targetId}.git`, targetId.replace("team-two", "Team-Two")];
  for (const spelling of spellings) {
    assert(
      heldForReview({ ...input, targetRepository: spelling }, undefined, "T", "S", targetId) ===
        undefined,
      `held: a confirm spelled ${JSON.stringify(spelling)} is not held — the guard hashed the identity, not the caller's text`,
    );
  }
  assert(
    heldForReview({ ...input, targetRepository: targetId }, undefined, "T", "CHANGED", targetId)
      ?.reason !== undefined,
    "held: a confirm whose spec actually changed is still held",
  );
  assert(
    heldForReview(
      { ...input, targetRepository: "plan-target.test/team-three/target-repo" },
      undefined,
      "T",
      "S",
      "plan-target.test/team-three/target-repo",
    )?.reason !== undefined,
    "held: a confirm aimed at another repository is held, not filed on A's digest",
  );
}
