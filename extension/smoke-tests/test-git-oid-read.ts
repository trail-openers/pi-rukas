#!/usr/bin/env bun
/**
 * #2162 — the shared ref-to-OID read: one argv shape, and a verdict that comes
 * from what git PRINTED rather than from the fact that it exited.
 *
 * Three things this file exists to keep true:
 *
 *   - **The argv.** One `rev-parse --verify [–-quiet] <ref>[^{peel}]`, the
 *     terminator token nowhere in it. A fake that THROWS on any unscripted argv
 *     is the only way to assert a command shape: a permissive one answers a
 *     drifted command and the test passes having tested nothing.
 *   - **The regression.** On a git older than 2.43, `rev-parse` echoes the
 *     literal `--end-of-options` on stdout ahead of the object id AND exits 0.
 *     Every case here therefore drives a fake that prints exactly that and
 *     asserts the read refuses it, so the field-reported hold cannot come back
 *     by way of this helper.
 *   - **The leading-dash refusal.** It is what replaces the terminator flag as
 *     the injection guard, so it must fire BEFORE any git call, not merely
 *     produce a refusal the caller happens to notice.
 *
 * Each site's own accepted shape is asserted too, since the helper takes the
 * predicate as a parameter: a change there silently reclassifies `absent`
 * against `unknown` at the caller.
 */

import { readCommitOid } from "../src/git-oid-read.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const OID40 = "a".repeat(40);
/** What a pre-2.43 git prints for `rev-parse --end-of-options <ref>`: exit 0, the literal first. */
const ECHOED = `--end-of-options\n${OID40}\n`;

type Call = { line: string; argv: string[] };

/**
 * An executor that answers ONLY the exact argv a route names and THROWS on any
 * other call. A helper that drifted its argv — grew a flag, dropped `--verify`,
 * moved the peel suffix — hits the throw rather than being handed an OID.
 */
function scripted(
  routes: Array<[string, { stdout: string } | { error: unknown }]>,
): { exec: (cmd: string, o?: { argv?: string[] }) => Promise<{ stdout: string }>; calls: Call[] } {
  const calls: Call[] = [];
  const exec = async (cmd: string, o?: { argv?: string[] }) => {
    const argv = o?.argv ?? [];
    const line = [cmd, ...argv].join(" ");
    calls.push({ line, argv });
    for (const [want, answer] of routes) {
      if (line === want) {
        if ("error" in answer) throw answer.error;
        return answer;
      }
    }
    throw new Error(`unscripted call: ${line}`);
  };
  return { exec, calls };
}

const HEX = (s: string) => /^[0-9a-f]{40,64}$/.test(s);
const BASE = { accept: HEX, timeoutMs: 30_000 };

// ── the argv, exactly ────────────────────────────────────────────────────────

{
  const { exec, calls } = scripted([["git rev-parse --verify origin/main", { stdout: `${OID40}\n` }]]);
  const r = await readCommitOid(exec, "/repo", "origin/main", BASE);
  assert(r.ok && r.oid === OID40, `bare read resolves (${JSON.stringify(r)})`);
  assert(
    calls.length === 1 && calls[0]?.argv.join(" ") === "rev-parse --verify origin/main",
    `the argv is exactly \`rev-parse --verify <ref>\` (${JSON.stringify(calls[0]?.argv)})`,
  );
}

{
  const { exec, calls } = scripted([
    ["git rev-parse --verify --quiet origin/main^{commit}", { stdout: `${OID40}\n` }],
  ]);
  const r = await readCommitOid(exec, "/repo", "origin/main", { ...BASE, peel: "commit", quiet: true });
  assert(r.ok, `quiet + peel reaches git with both (${JSON.stringify(r)})`);
  assert(
    calls[0]?.argv.join(" ") === "rev-parse --verify --quiet origin/main^{commit}",
    `the quiet and peel flags are placed before the ref (${JSON.stringify(calls[0]?.argv)})`,
  );
}

{
  const { exec } = scripted([["git rev-parse --verify HEAD^{tree}", { stdout: `${OID40}\n` }]]);
  const r = await readCommitOid(exec, "/repo", "HEAD", { ...BASE, peel: "tree" });
  assert(r.ok, "a tree peel resolves");
}

{
  // The control on the strict fake above: an executor that answers only a
  // drifted argv must NOT be able to satisfy the bare read.
  const { exec } = scripted([
    ["git rev-parse --verify --end-of-options origin/main", { stdout: `${OID40}\n` }],
  ]);
  let caught: unknown = undefined;
  try {
    await readCommitOid(exec, "/repo", "origin/main", BASE);
  } catch (err) {
    caught = err;
  }
  assert(
    String(caught instanceof Error ? caught.message : caught).includes("unscripted call"),
    `control: the fake throws on an argv nobody scripted (${String(caught).slice(0, 90)})`,
  );
}

// ── the bug: a git that echoes the terminator, exit 0 ────────────────────────

for (const [label, argv, ref, opts] of [
  ["bare read", "rev-parse --verify origin/x", "origin/x", {}],
  ["peeled + quiet", "rev-parse --verify --quiet origin/x^{commit}", "origin/x", { peel: "commit", quiet: true }],
] as const) {
  const { exec, calls } = scripted([[`git ${argv}`, { stdout: ECHOED }]]);
  const r = await readCommitOid(exec, "/repo", ref, { ...BASE, ...opts });
  assert(
    !r.ok && r.kind === "odd-output" && r.problem.includes("--end-of-options"),
    `a git that exits 0 while echoing the terminator (${label}) is refused, naming the output (${JSON.stringify(r)})`,
  );
  assert(calls.length === 1, `...and exactly one git call ran (${label})`);
}

// ── other answers that are not an object id ──────────────────────────────────

const ODD_ARGV = "git rev-parse --verify origin/x";
for (const [label, stdout] of [
  ["empty", ""],
  ["whitespace", "  \n"],
  ["a branch name", "origin/main\n"],
  ["a warning line", "warning: anything\n"],
  ["two ids", `${OID40}\n${"b".repeat(40)}`],
] as const) {
  const { exec } = scripted([[ODD_ARGV, { stdout }]]);
  const r = await readCommitOid(exec, "/repo", "origin/x", BASE);
  assert(
    !r.ok && r.kind === "odd-output" && !r.problem.includes("failed:"),
    `exit 0 with ${label} is odd-output, not a git failure (${JSON.stringify(r)})`,
  );
}

// A caller whose predicate is the single-line one (git-range) rejects an answer
// that a {40,64}-hex caller alone would have accepted — the predicates are the
// sites', not the helper's.
{
  const { exec } = scripted([["git rev-parse --verify origin/x", { stdout: `${OID40}\n${OID40}\n` }]]);
  const r = await readCommitOid(exec, "/repo", "origin/x", {
    accept: (t) => !t.includes("\n") && HEX(t),
    timeoutMs: 30_000,
  });
  assert(!r.ok, "the caller's own predicate decides: a two-line answer is refused");
}

// ── a git that exits non-zero ────────────────────────────────────────────────

{
  const err = Object.assign(new Error("Command failed: git rev-parse"), {
    code: 128,
    killed: false,
    signal: null,
    stderr: "fatal: Needed a single revision\n",
  });
  const { exec } = scripted([["git rev-parse --verify origin/gone", { error: err }]]);
  const r = await readCommitOid(exec, "/repo", "origin/gone", BASE);
  assert(
    !r.ok && r.kind === "odd-output" && r.cause === err,
    `a non-zero exit carries the executor's own rejection through as cause (${JSON.stringify(Object.keys(r ?? {}))})`,
  );
}

// ── the leading-dash refusal happens BEFORE git ──────────────────────────────

for (const ref of ["-x", "--help", "--end-of-options"]) {
  const { exec, calls } = scripted([]);
  const r = await readCommitOid(exec, "/repo", ref, BASE);
  assert(
    !r.ok && r.kind === "refused" && r.problem.includes("begins with"),
    `a ref beginning with '-' is refused (${JSON.stringify(ref)}): ${JSON.stringify(r)}`,
  );
  assert(calls.length === 0, `...and no git ran for ${JSON.stringify(ref)}`);
}

{
  // The control on the two assertions above: the same fake DOES answer a plain
  // ref, so "no calls" above is the refusal, not a fake that never answers.
  const { exec, calls } = scripted([["git rev-parse --verify origin/x", { stdout: `${OID40}\n` }]]);
  const r = await readCommitOid(exec, "/repo", "origin/x", BASE);
  assert(r.ok && calls.length === 1, "control: the fake answers a ref with no leading dash");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
