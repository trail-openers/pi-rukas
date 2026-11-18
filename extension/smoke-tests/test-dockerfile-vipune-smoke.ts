#!/usr/bin/env bun
/** vipune image smoke gate. Under a cgroup cpuset, onnxruntime pins its default thread pool to host CPUs the container may not use and
 * logs an error per thread on every vipune call. The image sets an explicit thread count and its smoke step fails the build on any vipune stderr.
 * The step is RUN, not read: its body runs under sh, as Docker runs it, with a stub `vipune` first on PATH, so a step that ignores stderr or the search hit fails here. */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

// argv[2] retargets the texts so a mutant Dockerfile can be run through this gate —
// an assertion nobody has seen fail on a mutant is an assertion that may be vacuous.
const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(import.meta.dirname, "..", "..");
const dockerfile = readFileSync(path.resolve(root, ".devcontainer", "Dockerfile"), "utf8");
const fails: string[] = [];
const say = (ok: boolean, what: string) => {
  console.log(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) fails.push(what);
};

const lines = dockerfile.split("\n");
const start = lines.findIndex((l) => l.startsWith("RUN ") && l.includes("VIPUNE_DATABASE_PATH"));
const env = lines.findIndex((l) => /^ENV ORT_INTRA_OP_NUM_THREADS=[1-9]\d*$/.test(l));
say(env >= 0 && env < start, "Dockerfile sets ORT_INTRA_OP_NUM_THREADS to a positive integer before the smoke step");
const body: string[] = [];
for (let i = start; start >= 0 && i < lines.length; i++) {
  body.push(lines[i]!.replace(/\\$/, ""));
  if (!lines[i]!.endsWith("\\")) break;
}
say(start >= 0, "Dockerfile has a vipune smoke RUN with a scratch VIPUNE_DATABASE_PATH");
// An unbounded vipune call can hang the image build with no output at all, so each
// invocation is wrapped in coreutils `timeout <n>`. The `\s*` after the statement
// separator crosses a continuation's trailing backslash and newline, so a call counts
// as invoked even when it sits on its own physical line. The bounded check stays on
// that one line — no `\s*` after the separator, only a run of non-newline characters —
// so a bare `vipune` is never credited to a `timeout` belonging to the command above it.
const INVOKED = /(?:^|[;&|])\s*(?:timeout\s+\d+\s+)?vipune\s/;
const BOUNDED = /(?:^|[;&|])[^\n\r]*timeout\s+\d+\s+vipune\s/;
const invoked = body.filter((l) => INVOKED.test(l));
const unbounded = invoked.filter((l) => !BOUNDED.test(l));
const boundedOk = invoked.length >= 2 && unbounded.length === 0;
// Canary pair: the real step passes, and an unbounded copy of it must fail the same
// assertion — mutated in code rather than read from a fixture, so the red side cannot
// itself be mutated into green. Without it the check cannot be told apart from one whose
// regex matches nothing, which is how the first version of it shipped green detecting zero
// calls.
const unboundedStep = dockerfile.replace(/timeout 60 vipune add/g, "vipune add");
say(
  (() => {
    const mb: string[] = [];
    const ml = unboundedStep.split("\n");
    const ms = ml.findIndex((l) => l.startsWith("RUN ") && l.includes("VIPUNE_DATABASE_PATH"));
    for (let i = ms; ms >= 0 && i < ml.length; i++) {
      mb.push(ml[i]!.replace(/\\$/, ""));
      if (!ml[i]!.endsWith("\\")) break;
    }
    const mi = mb.filter((l) => INVOKED.test(l));
    return !(mi.length >= 2 && mi.every((l) => BOUNDED.test(l)));
  })(),
  `canary: a step with an unbounded vipune call fails the check (${invoked.length} calls found, ${unbounded.length} unbounded)`,
);
say(
  boundedOk,
  `every vipune call in the smoke step is bounded by \`timeout <n>\` (${invoked.length} calls, ${unbounded.length} unbounded)`,
);

const scratch = mkdtempSync(path.join(tmpdir(), "vipune-smoke-gate-"));
const run = (stub: string): number => {
  writeFileSync(path.join(scratch, "vipune"), `#!/usr/bin/env bash\n${stub}\n`);
  chmodSync(path.join(scratch, "vipune"), 0o755);
  const script = body.join("\n").replace(/^RUN /, "");
  const r = spawnSync("sh", ["-c", script], { env: { ...process.env, PATH: `${scratch}:${process.env.PATH}` }, timeout: 5000 });
  return r.status ?? -1;
};
const hit = `case "$1" in add) echo "Added memory: x" ;; search) echo '{"results":[{"content":"image smoke"}]}' ;; esac`;
say(run(hit) === 0, "smoke step passes on a quiet vipune that finds the memory");
say(run(`${hit}; echo "[E:onnxruntime:default] pthread_setaffinity_np failed" >&2`) !== 0, "smoke step fails when vipune writes to stderr");
say(run(`case "$1" in search) echo '{"results":[]}' ;; esac`) !== 0, "smoke step fails when search does not find the memory");
rmSync(scratch, { recursive: true, force: true });

if (fails.length) process.exit(1);
console.log("dockerfile-vipune-smoke gate: PASS");
