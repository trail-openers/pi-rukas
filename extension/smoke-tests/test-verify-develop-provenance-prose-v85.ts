#!/usr/bin/env bun
/**
 * #2295 — `PI_ENSEMBLE_VERIFY_PROVENANCE_PROSE=0` is byte-identical to v0.14.85.
 *
 * The prose arm is a new failure mode on a gate that ships on: an operator who relied on
 * "prose is only ever disclosed" needs a documented way back. The escape hatch is the literal
 * `"0"`, and the promise has to be checkable rather than asserted — a switch that merely makes
 * the gate *behave* like the old one is not the same as one that makes it *be* the old one, and
 * the difference is exactly what a reader of a disclosure section cares about.
 *
 * So this file compares against shipped bytes, not a paraphrase. `lib/v0-14-85/` is a copy of
 * the three provenance modules AS THEY WERE AT v0.14.85, committed untouched (arm 1 below
 * hashes them against the digests recorded from the tag), and its module specifiers are
 * redirected into the current tree's unchanged dependencies. Each arm then drives the same
 * fixture through the v0.14.85 gate and through the current gate, and compares the three
 * out-channels — failures, notes, and the rendered PR-body disclosure section — for byte
 * equality.
 *
 * The copy is pinned by DIGEST, not by tag lookup: CI's checkout is shallow and carries no
 * tags, so a check that shelled out to `git show v0.14.85:…` died there with `fatal: invalid
 * object name` and the proof was simply never made in the place it is checked. A digest read
 * of the working tree needs no git object at all, so it runs green or red on CI exactly as it
 * does here. Recovering those digests is one command, stated once beside the constants, and a
 * retagging or a reissue of the tag has to show up there.
 *
 * The comparison is only meaningful if the two runs asked git the same questions, so the argv
 * stream of both gates is collected and compared too: a run that matched the verdicts by
 * issuing different reads is not the v0.14.85 gate, and a section that agreed while the probes
 * drifted would be a green on a module nobody shipped.
 *
 * The truth table for the switch itself lives in `test-verify-develop-provenance-bounds.ts`
 * beside the other two develop-gate switches; the docs rows are pinned in
 * `test-verify-develop-switches.ts`.
 */

import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import {
  type ProvenanceDisclosure,
  provenanceDisclosureSectionOf as currentSection,
  runProvenanceGate as currentRunProvenanceGate,
} from "../src/work-driver-verify-develop-provenance.ts";
import { assert, exit } from "./lib/assert-rig.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeProvenanceFixtureWith } from "./lib/verify-develop-provenance-harness.ts";
import { renderProse256Record } from "./lib/verify-develop-provenance-fixture.ts";
import { runProvenanceGate as v85RunProvenanceGate } from "./lib/v0-14-85/work-driver-verify-develop-provenance.ts";

/** The three shipped modules whose v0.14.85 bytes `lib/v0-14-85/` must be, in the tag's order. */
const V85_FILES = [
  "work-driver-verify-develop-provenance.ts",
  "work-driver-verify-develop-provenance-token.ts",
  "work-driver-verify-develop-provenance-walk.ts",
] as const;

/** A copy's `from "…"` specifiers rewritten to one placeholder. A copy under `smoke-tests/lib/`
 * cannot sit beside the modules it imports, so its specifiers point into `../../../src/` and
 * `../../../src/lean/` — a relocation, not an edit, and the only difference from the shipped
 * bytes this proof tolerates. Every other byte — the classifier arms, the reason strings, the
 * section text — is what the digest below covers. */
function relocateImportSpecifiers(source: string): string {
  return source
    .split("\n")
    .map((line) =>
      /^import[ ({]/.test(line) ? line.replace(/from "[^"]*"/, 'from "<relocated>"') : line,
    )
    .join("\n");
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The digest of each file AS SHIPPED AT THE TAG, with its import specifiers relocated exactly
 * the way {@link relocateImportSpecifiers} relocates the copy's, so the two hashes are hashes of
 * the same text. Recomputed locally from a clone that holds the tag — there is nothing to
 * recompute in CI, which is the whole point:
 *
 * ```sh
 * for f in work-driver-verify-develop-provenance.ts \
 *          work-driver-verify-develop-provenance-token.ts \
 *          work-driver-verify-develop-provenance-walk.ts; do
 *   git show v0.14.85:extension/src/$f | sed -E '/^import[ ({]/ s|from "[^"]*"|from "<relocated>"|' \
 *     | sha256sum
 * done
 * ```
 *
 * A copy edited to agree with a new implementation hashes elsewhere, every arm below turns from
 * a byte-identity proof into a tautology, and this is the row that reddens first. */
const V85_SHIPPED_SHA256: Record<(typeof V85_FILES)[number], string> = {
  "work-driver-verify-develop-provenance.ts":
    "ea510824793caa072052baa560a56401bf46387f181cbf3fd2ce63cd1d00f627",
  "work-driver-verify-develop-provenance-token.ts":
    "645b4e0203b128ea0a735f7c975474270e174d77acf28e953b5430815a14484e",
  "work-driver-verify-develop-provenance-walk.ts":
    "2d5844e0fa57f9783576900c9b70218c1cf4b66444f2b6530fa87f8669dc2cc1",
};

type Fixture = Awaited<ReturnType<typeof makeProvenanceFixtureWith>>;
type Exec = Fixture["execFn"];
type Drive = { failures: string[]; notes: string[]; disclosures: ProvenanceDisclosure[] };

/** Wrap a fixture's executor so every git read it makes is recorded as one string. Two runs
 * agree on their verdicts for the wrong reason if they asked git different questions, so the
 * argv stream is part of the comparison rather than an afterthought. */
function recording(base: Exec, calls: string[]): Exec {
  return async (cmd, o) => {
    calls.push(`${cmd} ${(o?.argv ?? []).join(" ")}`);
    return base(cmd, o);
  };
}

/** A drive through the CURRENT gate's OWN provenance pass — `runProvenanceGate`, the same entry
 * point `verifyDevelopOutcome` reaches — with the argv stream of every git read it issued.
 *
 * Driving the whole develop step instead would compare two runs that share only some of their
 * git traffic: the pass also issues the status / diff / rev-list reads of the uncommitted-work,
 * diff-evidence and doctrine gates, which `runProvenanceGate` never asks. Asking both gates
 * through their own entry point is what makes "the same questions, in the same order" a
 * claim that can hold at all. */
async function driveCurrent(
  f: Fixture,
  env: Record<string, string | undefined>,
): Promise<Drive & { argv: string[] }> {
  const calls: string[] = [];
  const failures: string[] = [];
  const notes: string[] = [];
  const sink: { disclosures?: ProvenanceDisclosure[] } = { disclosures: [] };
  await withEnv(env, async () => {
    await currentRunProvenanceGate({
      execFn: recording(f.execFn, calls),
      worktrees: { a: f.worktree },
      effectiveBaseFor: () => f.baseSha,
      failures,
      notes,
      options: { provenanceDisclosures: sink } as never,
    });
  });
  return { failures, notes, disclosures: sink.disclosures ?? [], argv: calls };
}

/** A drive through the v0.14.85 copy of the gate over the same fixture. The copy's
 * `runProvenanceGate` is handed a fresh failures/notes/sink triple exactly as
 * `verifyDevelopOutcome` hands it to the current gate, so the two runs are driven the same way
 * and differ only in the module that judges. */
async function driveV85(f: Fixture): Promise<Drive & { argv: string[] }> {
  const calls: string[] = [];
  const failures: string[] = [];
  const notes: string[] = [];
  const sink: { disclosures?: ProvenanceDisclosure[] } = { disclosures: [] };
  await v85RunProvenanceGate({
    execFn: recording(f.execFn, calls),
    worktrees: { a: f.worktree },
    effectiveBaseFor: () => f.baseSha,
    failures,
    notes,
    options: { provenanceDisclosures: sink } as never,
  });
  return { failures, notes, disclosures: sink.disclosures ?? [], argv: calls };
}

/** This gate's own rows out of a drive's notes: both drives enter through `runProvenanceGate`,
 * so this filter is a guard rather than a rescue — if a future version of the gate wrote a row
 * on another prefix, the comparison would still name the channel it owns. */
function provNotes(notes: readonly string[]): string[] {
  return notes.filter((n) => n.startsWith("data provenance:"));
}

/** The #256 prose value plus every host-provenance shape v0.14.85 disclosed. Every value sits
 * under a key v0.14.85 ALREADY walked (`source`, `sourceFile`, `inputFile`, `resultsFile`):
 * `provenance` and `inputs` are #2295's additions and belong to the on-arm cases, not to a
 * comparison whose whole point is what v0.14.85 did. */
const OFF_CORPUS: Record<string, string> = {
  "tasks/record.json": renderProse256Record(),
  "runs/absolute.json": JSON.stringify({ source: "/etc/passwd" }),
  "runs/url.json": JSON.stringify({ resultsFile: "https://example.invalid/r.ndjson" }),
  "runs/drive.json": JSON.stringify({ inputFile: "C:\\results\\run.ndjson" }),
  "runs/dollar.json": JSON.stringify({ source: "$S/ops/c5-qual" }),
  // Three bare repo-relative claims v0.14.85 probed itself — two git answers absent, one
  // present — so the off arm is not vacuous: it fails, it passes a probe, and it prints its
  // `judged N` note. These are the rows the on arm must grow past.
  "runs/bare1.json": JSON.stringify({ sourceFile: "results/gone-1.ndjson" }),
  "runs/bare2.json": JSON.stringify({ resultsFile: "results/gone-2.ndjson" }),
  "runs/bare3.json": JSON.stringify({ source: "results/live.ndjson" }),
  // Prose that hides a claim git answers PRESENT. The prose arm never reaches it while the
  // switch is off, so it cannot leak a verdict into the comparison.
  "runs/prose2.json": JSON.stringify({
    source: "12s of results/live.ndjson via $H/run",
  }),
  "results/live.ndjson": '{"task":"t1"}\n',
};

// ── 1. the shipped bytes are the shipped bytes ──────────────────────────────────────────────
{
  // A comparison against a copy nobody is allowed to edit. If the copy were edited to agree
  // with a new implementation, every arm below would turn from a byte-identity proof into a
  // tautology, so the copy is hashed against the tag's own recorded digest before any of them
  // counts. No git object is consulted: CI's checkout has neither the tag nor its blobs.
  for (const name of V85_FILES) {
    const copy = readFileSync(new URL(`./lib/v0-14-85/${name}`, import.meta.url), "utf8");
    const digest = sha256(relocateImportSpecifiers(copy));
    assert(
      digest === V85_SHIPPED_SHA256[name],
      `lib/v0-14-85/${name} hashes to the bytes v0.14.85 shipped under \`extension/src/\`, once its import specifiers are relocated — every judgement, reason string and section byte is the shipped one (got ${digest}; shipped ${V85_SHIPPED_SHA256[name]})`,
    );
  }
}

// ── 2. the off arm is the v0.14.85 run, on every channel and every git read ─────────────────
{
  const f = await makeProvenanceFixtureWith(OFF_CORPUS);
  try {
    // Both drives take the same spy-wrapped executor built over one fixture, so the argv
    // comparison below compares two runs of the same repository rather than a pass and a gate
    // entry point. The comparison itself is the provenance gate's own channels: the whole
    // develop pass also writes scope and criteria rows that `runProvenanceGate` never produces,
    // and asks the status / rev-list questions this gate never asks.
    const v85Calls: string[] = [];
    const v85 = await driveV85({ ...f, execFn: recording(f.execFn, v85Calls) });
    const off = await driveCurrent(f, { PI_ENSEMBLE_VERIFY_PROVENANCE_PROSE: "0" });
    assert(
      JSON.stringify(off.failures) === JSON.stringify(v85.failures),
      `PROSE=0: the failures array is byte-identical to the v0.14.85 gate's (off=${JSON.stringify(off.failures)}; v85=${JSON.stringify(v85.failures)})`,
    );
    assert(
      JSON.stringify(provNotes(off.notes)) === JSON.stringify(v85.notes),
      `PROSE=0: the notes this gate writes are byte-identical to the v0.14.85 gate's (off=${JSON.stringify(provNotes(off.notes))}; v85=${JSON.stringify(v85.notes)})`,
    );
    assert(
      currentSection(off.disclosures) === currentSection(v85.disclosures),
      `PROSE=0: the rendered PR-body disclosure section is byte-identical (off=${JSON.stringify(currentSection(off.disclosures))}; v85=${JSON.stringify(currentSection(v85.disclosures))})`,
    );
    assert(
      off.disclosures.length === v85.disclosures.length &&
        off.disclosures.every(
          (d, i) =>
            d.file === v85.disclosures[i]?.file &&
            d.key === v85.disclosures[i]?.key &&
            d.token === v85.disclosures[i]?.token &&
            d.reason === v85.disclosures[i]?.reason,
        ),
      `PROSE=0: every structured disclosure row matches field for field, so the section above is not identical by a coincidence of rendering (off=${JSON.stringify(off.disclosures)}; v85=${JSON.stringify(v85.disclosures)})`,
    );
    // The streams are now comparable byte for byte and in order: both sides entered through
    // their own gate's `runProvenanceGate`, so neither carries another gate's reads. Equality
    // here is the strongest statement the two implementations are the same procedure.
    assert(
      off.argv.length > 0 &&
        JSON.stringify(off.argv) === JSON.stringify(v85.argv) &&
        off.argv.some((c) => / show /.test(c)) &&
        off.argv.some((c) => /ls-tree/.test(c)),
      `PROSE=0: the two gates asked git the SAME questions in the SAME order — a matching verdict reached by different reads is not the shipped gate (off ${String(off.argv.length)} reads; v85 ${String(v85.argv.length)} reads)`,
    );
    // The vacuity guard for the whole file: if the corpus disclosed nothing and judged nothing,
    // every equality above would pass on two empty runs.
    assert(
      v85.disclosures.length >= 5 && v85.notes.some((n) => n.includes("judged")) === true,
      `the corpus really does exercise the gate under v0.14.85 — disclosures and a judged-token note, so the equality above is not two empty runs agreeing (disclosures ${String(v85.disclosures.length)}; notes ${String(v85.notes.length)})`,
    );
    // And the off arm is NOT the on arm: the same fixture under the default judges prose.
    const onCorpus = await driveCurrent(f, { PI_ENSEMBLE_VERIFY_PROVENANCE_PROSE: undefined });
    // The #256 record contributes TWO failures and the two bare `sourceFile`/`resultsFile`
    // claims one apiece, so the on arm must carry four where the off arm carries two. Naming the
    // numbers here is what makes "the switch is real" a checked claim rather than a hope.
    assert(
      onCorpus.failures.length === 4 && v85.failures.length === 2,
      `the same corpus fails FOUR times with the switch on and TWO with it off — the two extra are exactly the prose claims v0.14.85 disclosed (on ${String(onCorpus.failures.length)}; off ${String(v85.failures.length)})`,
    );
    assert(
      off.failures.length > 0 && v85.failures.length > 0,
      `and the off arm is not vacuous either — the corpus still fails the bare claim v0.14.85 itself failed, which is what makes its note and section rows worth comparing (off ${String(off.failures.length)}, v85 ${String(v85.failures.length)})`,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

// ── 3. only the literal "0" turns the prose arm off ─────────────────────────────────────────
{
  const f = await makeProvenanceFixtureWith({ "tasks/record.json": renderProse256Record() });
  try {
    const on = await driveCurrent(f, { PI_ENSEMBLE_VERIFY_PROVENANCE_PROSE: undefined });
    for (const value of ["false", "off", " 0 ", "", "1", "nope"]) {
      const r = await driveCurrent(f, { PI_ENSEMBLE_VERIFY_PROVENANCE_PROSE: value });
      assert(
        JSON.stringify(r.failures) === JSON.stringify(on.failures) && r.failures.length === 2,
        `PROVENANCE_PROSE=${JSON.stringify(value)} is NOT a disable — the prose arm still judges the #256 value and both of its claims still fail (got ${String(r.failures.length)})`,
      );
    }
    const off = await driveCurrent(f, { PI_ENSEMBLE_VERIFY_PROVENANCE_PROSE: "0" });
    assert(
      off.failures.length === 0 && off.disclosures.length === 1,
      `only the literal "0" restores the v0.14.85 behaviour for the same record (got ${String(off.failures.length)} failures, ${String(off.disclosures.length)} disclosures)`,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

console.log(`\nexit ${String(exit)}`);
process.exit(exit);
