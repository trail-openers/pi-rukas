#!/usr/bin/env bun
/**
 * #2295 round 1 — the prose extractor as a pure function: no repository, no git, no filesystem.
 *
 * The gate-driven half of the prose arm is pinned in
 * `test-verify-develop-provenance-prose.ts`; this file pins the SPLITTER alone, because the two
 * false-FAIL classes the classifier exists to refuse are properties of one pure function and a
 * repository fixture would assert them through three layers that could each mask the answer. A
 * fragment that looks like a path but is English (`v1.2.3`, a bar-table, an email) must yield NO
 * candidate here — not "yield one that the gate happens to forgive", since the gate's forgiveness is
 * a separate claim with its own failure mode.
 *
 * Split out of `test-verify-develop-provenance-prose.ts` for the 500-line cap, along the seam that
 * was already there: the arms below call `proseCandidatesOf` and nothing else.
 */

import { proseCandidatesOf } from "../src/work-driver-verify-develop-provenance-token.ts";
import { assert, exit } from "./lib/assert-rig.ts";

// ── 2. the extractor, as a pure function: no repository, no git, no fs ─────────────────────
{
  // The #256 value verbatim. Three fragments carry a `/` or an extension; `elapsed_s`, `of`
  // and `via` are prose and must not become candidates (they would each buy a probe and a
  // failure for a word).
  const got = proseCandidatesOf(
    "elapsed_s of widened-results.ndjson ($S/ops/c5-qual) via scripts/run-c5.sh",
  );
  assert(
    JSON.stringify(got) ===
      JSON.stringify(["widened-results.ndjson", "$S/ops/c5-qual", "scripts/run-c5.sh"]),
    `the #256 value yields exactly its three path-bearing fragments, in order (got: ${JSON.stringify(got)})`,
  );

  // Separators, not just spaces: parentheses, commas and semicolons are all split points.
  // Quotes are deliberately NOT: a quoted path is the fragment the classifier below must refuse
  // rather than one the splitter silently repairs by stripping its quotes.
  const seps = proseCandidatesOf("seen in a/x.json, then b/y.json; also (c/z.ndjson)");
  assert(
    JSON.stringify(seps) === JSON.stringify(["a/x.json", "b/y.json", "c/z.ndjson"]),
    `separators are split points (got: ${JSON.stringify(seps)})`,
  );
  assert(
    JSON.stringify(proseCandidatesOf('said "a/x.json" here')) === JSON.stringify(['"a/x.json"']),
    "a quote-clinging fragment is kept verbatim, so the classifier — not the splitter — decides its fate",
  );

  // A bare word with no `/` and no extension is not a candidate, however plausible.
  assert(
    proseCandidatesOf("measured over the weekend on the build box").length === 0,
    "a value with no slash-bearing and no extension-bearing fragment yields no candidates",
  );

  // The URL arm runs on the fragment: `scheme://` is context, never a probe target, and it is
  // not a candidate at all (the disclosure of the whole value still carries it).
  assert(
    proseCandidatesOf("from https://example.invalid/r.ndjson and ftp://h/a").length === 0,
    "a scheme:// fragment is never a candidate",
  );

  // Dedupe happens BEFORE the ceiling: eight deduped fragments is the cap, and a fragment that
  // repeats spends no slot — otherwise a value could fill the ceiling with one path eight times
  // and hide the seven real claims behind it.
  const dupes = proseCandidatesOf(
    ["p/1.json", "p/1.json", "p/1.json", "p/1.json", "p/1.json", "p/1.json", "p/1.json"].concat(
      ["a.json", "b.json", "c.json", "d.json", "e.json", "f.json", "g.json", "h.json"],
    ).join(" "),
  );
  assert(
    dupes.length === 8 && dupes[0] === "p/1.json" && dupes[1] === "a.json",
    `a repeated fragment spends no slot: the eight kept are the deduped ones in first-seen order (got ${String(dupes.length)}: ${dupes.join(" ")})`,
  );
  assert(
    dupes.includes("h.json") === false,
    "the ninth DISTINCT fragment is the one the per-value ceiling drops, not a duplicate",
  );

  // The ordinary-English side of the classifier. A fragment with no directory in it is
  // path-bearing only when it ends in a suffix this gate's data files actually use; the general
  // "dot plus up to eight alphanumerics" form turned `v1.2.3` (a version) into a probe, and a
  // probe of a token the record never claimed as data reddens a develop round over prose.
  for (const ordinary of [
    "matches v1.2.3 of the spec",
    "bumped to 3.4.5 of the runner",
    "see README for the setup",
    "see README.md for how this was measured",
    "the notes in run-notes.md explain it",
    "measured on a|b|c",
    "see a@b.com for the owner",
    "timed at 10:30.5",
  ]) {
    assert(
      proseCandidatesOf(ordinary).length === 0,
      `ordinary prose yields no candidate: ${JSON.stringify(ordinary)} (got ${JSON.stringify(proseCandidatesOf(ordinary))})`,
    );
  }
  // A slash is taken on its own, whatever the suffix — an unlisted data format under a directory is
  // a claim about a file, and refusing it would be a silent pass. A slash is also how a ratio or a
  // date gets typed, so one shape is refused at extraction: a fragment whose every `/`-separated
  // component is digits (`3/4`, `12/16`) makes no claim on a file and cannot be told from a ratio by
  // anything downstream, so probing it would redden a develop round over arithmetic.
  assert(
    JSON.stringify(proseCandidatesOf("input data/metrics.parquet summarised")) ===
      JSON.stringify(["data/metrics.parquet"]),
    `a slashed fragment is a candidate on its own, unlisted suffix or not (got ${JSON.stringify(proseCandidatesOf("input data/metrics.parquet summarised"))})`,
  );
  assert(
    proseCandidatesOf("the ratio 3/4 of rows held").length === 0,
    `an all-numeric slashed fragment is prose, not a path (got ${JSON.stringify(proseCandidatesOf("the ratio 3/4 of rows held"))})`,
  );
  // The non-vacuity pair for the digit rule: a slashed fragment carrying a single digit is a
  // versioned FILENAME (`2024/01/summary.ndjson`, `v2/1/run.log`) and stays a candidate, so the
  // rule above is not "any slash with a digit in it".
  assert(
    proseCandidatesOf("input logs/2024/01/summary.ndjson here").length === 1 &&
      proseCandidatesOf("input logs/2024/01/summary.ndjson here")[0] ===
        "logs/2024/01/summary.ndjson",
    `a slashed fragment that ENDS in a data suffix is a candidate whatever digits it carries (got ${JSON.stringify(proseCandidatesOf("input logs/2024/01/summary.ndjson here"))})`,
  );
}


console.log(`\nexit ${String(exit)}`);
process.exit(exit);
