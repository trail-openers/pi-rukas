#!/usr/bin/env bun
/**
 * #1377 — the confirm/digest half of the labels+provenance feature, as a
 * shared scenario module (not a test file).
 *
 * These scenarios are the ones that matter: labels are NOT body text, so the
 * body hash alone cannot prove a verbatim filing matches what the operator
 * reviewed. The scenarios live here — beside the cache stubs they drive — and
 * are called from test-plan-provenance.ts, which keeps the pure validators, the
 * input gate, the label gate, the provenance render, the budget reservation and
 * the fileIssue contract in one readable file under the 500-line cap.
 */
import {
  GAP_HIGH,
  type RawCacheEntry,
  cacheFiles,
  forgeStub,
  installCountingDispatch,
  installForgeStub,
  installOfflineVipuneStub,
  mutateEntry,
  newPlanCache,
  pipeline,
} from "./plan-test-stubs.ts";

/** Count failures the way the calling test does: one exit code for the whole file. */
export type ConfirmAssert = (cond: boolean, msg: string) => void;

/**
 * The digest guard, end to end. Split from the file's tail (#1377) to keep
 * every source file under the 500-line cap; run by the `budget`-stage caller
 * below so a cache-touching scenario stays beside the cache stubs it needs.
 */
export async function confirmDigestScenarios(assert: ConfirmAssert): Promise<void> {
  {
    // End to end, the guard is the DIGEST, not the cache key: a cache entry whose
    // labels the confirm's set does not match is filed under the ENTRY's labels,
    // never the caller's (a confirm cannot relabel reviewed bytes). So a changed
    // label set must be refused by the digest — and the refusal must be visible
    // in the result, not just absent.
    await newPlanCache();
    installOfflineVipuneStub();
    installCountingDispatch(GAP_HIGH);
    forgeStub.existing = ["auto-filed", "other"];
    installForgeStub();
    const dry = await pipeline({ dryRun: true, labels: ["auto-filed"] });
    assert(!!dry.reviewedDigest, "confirm: the labelled dry run reports a digest");
    assert((await cacheFiles()).length === 1, "confirm: the labelled dry run cached its entry");

    // (a) The correct confirm: verbatim, under the dry run's labels.
    forgeStub.created.length = 0;
    const correct = await pipeline({
      dryRun: false,
      labels: ["auto-filed"],
      reviewedDigest: dry.reviewedDigest,
    });
    assert(
      correct.filed === true && correct.filedFromDryRun !== undefined,
      "confirm: the same labels + the same digest file verbatim",
    );
    assert(
      JSON.stringify(forgeStub.created[0]?.labels) === JSON.stringify(["auto-filed"]),
      `confirm: the verbatim filing carries the dry run's labels (got ${JSON.stringify(forgeStub.created[0]?.labels)})`,
    );

    // (b) A DIFFERENT label set must not authorise a second filing of the same
    // bytes: the digest (which covers the entry's labels) no longer matches, so
    // nothing is filed. This is the assertion that fails if the digest stops
    // covering labels — the call would file the reviewed spec under a label set
    // the operator never saw.
    forgeStub.created.length = 0;
    const tampered = await pipeline({
      dryRun: false,
      labels: ["other"],
      reviewedDigest: dry.reviewedDigest,
    });
    assert(
      forgeStub.created.length === 0,
      "confirm: a changed label set files NOTHING (the digest, not the cache key, is the guard)",
    );
    assert(
      tampered.filedFromDryRun === undefined &&
        (tampered.filingFailure !== undefined || tampered.reviewedSpecChanged !== undefined),
      `confirm: the mismatch is surfaced in the result, not silently ignored (got ${JSON.stringify({ f: tampered.filingFailure, c: tampered.reviewedSpecChanged })})`,
    );

    // (c) A wrong digest must leave the entry in place for a later correct call.
    await newPlanCache();
    forgeStub.existing = ["auto-filed"];
    installForgeStub();
    installCountingDispatch(GAP_HIGH);
    const dry2 = await pipeline({ dryRun: true, labels: ["auto-filed"] });
    forgeStub.created.length = 0;
    await pipeline({ dryRun: false, labels: ["auto-filed"], reviewedDigest: "ffffffffffffffff" });
    assert(
      (await cacheFiles()).length === 1,
      "confirm: a digest miss never consumes the entry (a correct confirm can still file)",
    );
  }
}

/**
 * The entry guard on the two #1377 fields. A hand-edited cache file must be a
 * MISS, never a verbatim filing of bytes no validator admitted — the guard runs
 * before the digest, so a malformed `labels` or `provenance` cannot reach the
 * create call by echoing a digest that was computed over honest bytes.
 *
 * The provenance cases are the ones where the two shape checks used to drift:
 * the cache guard read inherited bytes while the render and the digest enumerated
 * only own ones, so a fileable entry could carry a marker that rendered nothing
 * while its digest claimed pairs. Both readers now go through `isProvenanceShape`.
 */
export async function cacheGuardScenarios(assert: ConfirmAssert): Promise<void> {
  {
    await newPlanCache();
    installOfflineVipuneStub();
    installCountingDispatch(GAP_HIGH);
    const dry = await pipeline({ dryRun: true });
    await mutateEntry((e: RawCacheEntry) => {
      (e.reviewed as Record<string, unknown>).labels = [42];
    });
    forgeStub.created.length = 0;
    const conf = await pipeline({ reviewedDigest: dry.reviewedDigest });
    assert(
      conf.filedFromDryRun === undefined,
      "cache guard: a malformed labels field is not filed verbatim",
    );
  }

  {
    await newPlanCache();
    installOfflineVipuneStub();
    installCountingDispatch(GAP_HIGH);
    const dry = await pipeline({
      dryRun: true,
      provenance: { line: "filed by the loop", marker: { run: "cron" } },
    });
    for (const [name, badMarker] of [
      ["a __proto__-keyed marker", JSON.parse('{"__proto__":"x"}')],
      ["an array marker", []],
      ["a null marker", null],
      ["a marker with a non-string value", { run: 7 }],
      ["a marker with no own pairs", Object.create({ run: "cron" })],
    ] as [string, unknown][]) {
      await mutateEntry((e: RawCacheEntry) => {
        (e.reviewed as Record<string, unknown>).provenance = {
          line: "filed by the loop",
          marker: badMarker,
        };
      });
      forgeStub.created.length = 0;
      const again = await pipeline({ reviewedDigest: dry.reviewedDigest });
      assert(
        again.filedFromDryRun === undefined && forgeStub.created.length === 0,
        `cache guard: ${name} makes the entry a miss, never a verbatim filing`,
      );
    }
  }
}
