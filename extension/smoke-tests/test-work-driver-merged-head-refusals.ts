/**
 * #1533 — every unreadable input is a refusal, never a merge.
 *
 * The head verification reaches its verdict through a remote, a mainline, a
 * fetch, a ledger file and two git reads. Each of those can fail, and each
 * failure has exactly one correct outcome: no merge. The interesting property is
 * not that they refuse — any check refuses on nothing — but that they refuse for
 * the reason that actually happened, because the park is what an operator reads
 * when a cycle stops and a refusal that names the wrong fault sends them to the
 * wrong file.
 *
 * Three refusals therefore say more than "no":
 *
 *   - an ABSENT ledger file names the path it looked in, and does not report
 *     "the review recorded nothing": a broken or redirected clone and a cycle
 *     that was never reviewed are different faults with different remedies, and
 *     `readLedgerAt`'s permissive ENOENT-to-empty-list contract is right for the
 *     question "what did the review record" and wrong for "may this merge
 *     proceed";
 *   - an unresolvable git common dir refuses on the LEDGER, distinct from the
 *     no-remote refusal the step already made — collapsing the two would let a
 *     broken remote lookup read as a missing ledger and vice versa;
 *   - a fetch failure refuses rather than answering from the refs already on
 *     disk, which is the exact failure the check exists to prevent.
 *
 * Each case is posed against the stub clone, whose every read is answered, so a
 * refusal is attributable to the check and not to an absent fixture. A case that
 * passed only because a fixture omitted something is not a test of the rule.
 */

import { setupSpawnGuard } from "./test-helpers.ts";
import {
  assert,
  evidence,

  lensRow,
  ledgerAt,
  state,
} from "./lib/merged-head-fixtures.ts";
import { fakeClone, fetched } from "./lib/merged-head-refusals.ts";
import { verifyMergeHead } from "../src/work-driver-merged-head.ts";
import type { MergeEvidence } from "../src/work-driver-merge-authority.ts";
import type { VerifyExecFn } from "../src/work-driver-git.ts";
import { rmSync } from "node:fs";

setupSpawnGuard();

/**
 * Evidence whose verified head differs from the reviewed head the stub ledger
 * names — the shape that reaches the fetch, the mainline resolution and the
 * identity reads. With the two equal the check takes its "nothing moved" fast
 * path and none of the reads this file is about ever happen, so every case here
 * is posed with a head that has genuinely moved.
 */
function movedEvidence(): MergeEvidence {
  return evidence({ headOid: "2".repeat(39) + "b" });
}

{
  const cases: Array<[string, Parameters<typeof fakeClone>[0], string]> = [
    ["fetch failure", { failFetch: true }, "git fetch"],
    ["no remote", { noRemote: true }, "no git remote"],
    ["no mainline", { noMainline: true }, "mainline"],
  ];
  for (const [label, opts, want] of cases) {
    const c = fakeClone(opts);
    const ledger = ledgerAt(lensRow("feature/x"), c.dir);
    const r = await verifyMergeHead(c.exec, c.dir, "feature/x", movedEvidence(), {
      ledgerFile: ledger,
    });
    assert(
      !r.ok && r.refusal.reason.includes(want),
      `refusal ${label}: parks naming "${want}" (${JSON.stringify(r)})`,
    );
    rmSync(c.dir, { recursive: true, force: true });
  }
}

{
  // An absent ledger is a refusal, and the refusal says so rather than reporting
  // "the review recorded nothing": the first is a broken or redirected clone and
  // the second is a cycle that was never reviewed, and an operator following the
  // park needs to know which one to go and look at. The case pins the path it
  // reads rather than trusting the resolver, so an environment override the
  // harness carries cannot turn it into a silent pass.
  const c = fakeClone();
  const absentFile = `${c.dir}/absent/review-ledger.json`;
  const r = await verifyMergeHead(c.exec, c.dir, "feature/x", evidence(), {
    ledgerFile: absentFile,
  });
  assert(
    !r.ok && r.refusal.reason.includes(`no review ledger at ${absentFile}`),
    `an absent ledger parks, naming the file it looked in (${JSON.stringify(r)})`,
  );
  assert(
    !r.ok && !r.refusal.reason.includes("no lens review row"),
    `an absent ledger is not reported as an unreviewed branch — the two have different remedies (${JSON.stringify(r)})`,
  );
  rmSync(c.dir, { recursive: true, force: true });
}

{
  // The clone's own git dir cannot resolve, so the ledger path cannot be resolved
  // either — which is a refusal, not "no rows", and NOT the "no remote" refusal
  // the step's first check already covers. The two faults are separate assertions
  // on purpose: collapsing them would let a broken remote lookup read as a missing
  // ledger and vice versa, and an operator would chase the wrong one.
  const c = fakeClone();
  const exec: VerifyExecFn = async (cmd, o) => {
    const args = o?.argv ?? cmd.split(" ").slice(1);
    if (args.includes("--git-common-dir")) throw new Error("not a git repository");
    return c.exec(cmd, o);
  };
  const r = await verifyMergeHead(exec, c.dir, "feature/x", evidence());
  assert(
    !r.ok && r.refusal.reason.includes("ledger"),
    `refusal no ledger path: parks naming the ledger (${JSON.stringify(r)})`,
  );
  assert(
    !r.ok && !r.refusal.reason.includes("no git remote"),
    `an unresolvable git dir is not reported as a missing remote (${JSON.stringify(r)})`,
  );
  rmSync(c.dir, { recursive: true, force: true });
}

{
  // A ledger whose ENVELOPE is unreadable is a refusal that names the read, while
  // a ledger whose ROWS are unusable is a refusal that names the review — and the
  // two must stay distinguishable, because the first is a broken or redirected
  // clone and the second is a cycle that was never reviewed. `readLedgerAt` is the
  // ledger's permissive read: it swallows every fs and parse fault to an empty
  // list, which is right for "what did the review record" and would be dangerous
  // here, so the merge gate keeps its own `existsSync` + throwing read in front of
  // it. The two shapes are posed together, against a control that passes, so
  // neither refusal is an artefact of the fixture being broken in both cases.
  const { writeFileSync } = await import("node:fs");
  const good = fakeClone();
  const goodLedger = ledgerAt(lensRow("feature/x"), good.dir);

  // Shape 1: the file is not JSON the reader can parse at all. The payload is
  // deliberately NOT an object with an `entries` array: `readLedgerFile` returns
  // `{entries: []}` for any parseable value of the wrong shape, which is the
  // "unusable rows" case below and reaches the check through the same empty list.
  // Only a value `JSON.parse` itself rejects takes the throwing path.
  const torn = fakeClone();
  const tornFile = `${torn.dir}/review-ledger.json`;
  writeFileSync(tornFile, "{ this is not json", "utf8");
  // Shape 2: valid JSON, rows that fail the reader's validation (a row with no
  // `kind`, no `patchId` and a non-numeric `at`). The reader drops them, which is
  // indistinguishable from "no rows" — and an empty list here is a real answer
  // about the review, so this one SHOULD name the review rather than the read.
  const junk = fakeClone();
  const junkFile = `${junk.dir}/review-ledger.json`;
  writeFileSync(junkFile, JSON.stringify({ entries: [{ branch: "feature/x", at: "nope" }] }), "utf8");

  const rTorn = await verifyMergeHead(torn.exec, torn.dir, "feature/x", evidence(), {
    ledgerFile: tornFile,
  });
  const rJunk = await verifyMergeHead(junk.exec, junk.dir, "feature/x", evidence(), {
    ledgerFile: junkFile,
  });
  const rGood = await verifyMergeHead(good.exec, good.dir, "feature/x", evidence(), {
    ledgerFile: goodLedger,
  });
  assert(
    !rTorn.ok && rTorn.refusal.reason.includes("could not be read"),
    `an unparseable ledger parks naming the read that failed (${JSON.stringify(rTorn)})`,
  );
  assert(
    !rJunk.ok && rJunk.refusal.reason.includes("no lens review row"),
    `a ledger of unusable rows parks naming the review, not the read (${JSON.stringify(rJunk)})`,
  );
  assert(rGood.ok, `the control case — a well-formed ledger — passes (${JSON.stringify(rGood)})`);
  rmSync(good.dir, { recursive: true, force: true });
  rmSync(torn.dir, { recursive: true, force: true });
  rmSync(junk.dir, { recursive: true, force: true });
}

console.log(`\nexit ${state.exit}`);
process.exit(state.exit);
