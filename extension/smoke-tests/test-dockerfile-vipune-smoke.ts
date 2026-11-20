#!/usr/bin/env bun
/** vipune image smoke gate. The image's smoke step judges vipune by its exit status first and its stderr second: a non-zero `add` or `search`
 * fails the build whatever it printed, while stderr is filtered down to nothing but one benign line — the onnxruntime cpu probe's
 * `cpuid_info warning: Unknown CPU vendor`, which QEMU emulation writes on every call — and the search hit is grepped from the UNFILTERED
 * stdout file. Each of those three rules is a separate arm here, run under `sh` with a stub `vipune` first on PATH and an explicitly listed
 * env: a step that ignores an exit code, tolerates an unexpected stderr line, or greps the hit out of a filtered buffer fails here. */
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

/** The RUN body of a Dockerfile text, one entry per continuation line, trailing backslashes
 * stripped — the shape `sh` reads once Docker has joined it. */
function extractBody(text: string): string[] {
  const ls = text.split("\n");
  const from = ls.findIndex((l) => l.startsWith("RUN ") && l.includes("VIPUNE_DATABASE_PATH"));
  const out: string[] = [];
  for (let i = from; from >= 0 && i < ls.length; i++) {
    out.push(ls[i]!.replace(/\\$/, ""));
    if (!ls[i]!.endsWith("\\")) break;
  }
  return out;
}
const lines = dockerfile.split("\n");
const start = lines.findIndex((l) => l.startsWith("RUN ") && l.includes("VIPUNE_DATABASE_PATH"));
const env = lines.findIndex((l) => /^ENV ORT_INTRA_OP_NUM_THREADS=[1-9]\d*$/.test(l));
say(env >= 0 && env < start, "Dockerfile sets ORT_INTRA_OP_NUM_THREADS to a positive integer before the smoke step");
const body = extractBody(dockerfile);
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
const unboundedBody = extractBody(unboundedStep).filter((l) => INVOKED.test(l));
say(
  !(unboundedBody.length >= 2 && unboundedBody.every((l) => BOUNDED.test(l))),
  `canary: a step with an unbounded vipune call fails the check (${invoked.length} calls found, ${unbounded.length} unbounded)`,
);
say(
  boundedOk,
  `every vipune call in the smoke step is bounded by \`timeout <n>\` (${invoked.length} calls, ${unbounded.length} unbounded)`,
);

// The line QEMU emulation makes onnxruntime's cpu probe write on every vipune call, and
// the affinity line the shipped `ORT_INTRA_OP_NUM_THREADS` exists to stop. Both carry the
// substring `onnxruntime`, so a filter that drops any line merely mentioning it passes on
// the affinity case and reintroduces the failure #2343 guards against. The literals are
// here, not in the Dockerfile, because the step judges them and the gate supplies them.
const CPUID = "\x1b[0;93m2026-11-20 10:11:02.123456 [W:onnxruntime:Default, cpu_info.cc:118 cpuid_info] onnxruntime cpuid_info warning: Unknown CPU vendor. cpuinfo_vendor value: 0\x1b[0m";
const AFFINITY = "\x1b[1;31m[E:onnxruntime:Default, env.cc:374 ThreadMain] pthread_setaffinity_np failed : Operation not permitted (22)\x1b[0m";

const scratch = mkdtempSync(path.join(tmpdir(), "vipune-smoke-gate-"));
let counter = 0;
/** Run a step body under `sh` with a stub `vipune` first on PATH. The stub's stderr comes
 * from a file and is `cat`ed, never echoed: a shell `echo` would eat the ANSI escapes or
 * print them literally depending on which shell reads it, and the escapes are the point.
 * The env is enumerated, never inherited — a host `ORT_*` or `VIPUNE_*` would change what the
 * child sees, and a green passing arm could be inherited rather than earned. */
function runBody(bodyLines: string[], opts: { stderr?: string; rc?: number; hit?: boolean } = {}): number {
  // A fresh file per run: the step appends to `$d/err` with `>>`, so reusing one path across
  // arms would let an earlier arm's stderr survive into a later one and fail it for a reason
  // the later arm never caused. A line is appended only when the arm supplies one — a lone
  // newline is a non-empty file, and `[ -s ]` would then fail the very arms that mean "vipune
  // wrote nothing".
  const errFile = path.join(scratch, `stub-err-${(counter += 1)}.txt`);
  writeFileSync(errFile, opts.stderr ? `${opts.stderr}\n` : "");
  writeFileSync(
    path.join(scratch, "vipune"),
    [
      "#!/usr/bin/env bash",
      'case "$1" in',
      '  add) echo "Added memory: x" ;;',
      '  search) if [ -n "$STUB_NOHIT" ]; then echo \'{"results":[]}\'; else echo \'{"results":[{"content":"image smoke"}]}\'; fi ;;',
      "esac",
      `cat ${JSON.stringify(errFile)} >&2`,
      `exit ${opts.rc ?? 0}`,
      "",
    ].join("\n"),
  );
  chmodSync(path.join(scratch, "vipune"), 0o755);
  const r = spawnSync("sh", ["-c", bodyLines.join("\n").replace(/^RUN /, "")], {
    env: {
      PATH: `${scratch}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      HOME: scratch,
      TMPDIR: tmpdir(),
      LANG: "C",
      STUB_NOHIT: opts.hit === false ? "1" : "",
    },
    timeout: 5000,
  });
  return r.status ?? -1;
}
const run = (opts: { stderr?: string; rc?: number; hit?: boolean } = {}): number => runBody(body, opts);

say(run() === 0, "smoke step passes on a quiet vipune that finds the memory");
say(run({ stderr: CPUID }) === 0, "smoke step passes when the only stderr is the benign onnxruntime cpuid_info warning (ANSI-coloured)");
say(run({ stderr: CPUID.replace(/\x1b\[[0-9;]*m/g, "") }) === 0, "smoke step passes on the same warning without its ANSI escapes");
say(run({ stderr: AFFINITY }) !== 0, "smoke step still fails on an onnxruntime pthread_setaffinity_np line");
say(run({ stderr: "something else complained" }) !== 0, "smoke step fails on any other stderr line");
say(run({ stderr: `${CPUID}\n${AFFINITY}` }) !== 0, "smoke step fails when the benign warning travels with an affinity line");
// R1: exit status decides, so a broken vipune cannot hide behind an empty stderr. The
// measured no-model failure exits 101 having written nothing at all.
say(run({ stderr: "", rc: 101 }) !== 0, "smoke step fails when vipune exits non-zero with empty stderr (the no-model case)");
say(run({ stderr: CPUID, rc: 1 }) !== 0, "smoke step fails when vipune exits non-zero even though its stderr filtered clean");
// R2: the hit check reads the unfiltered stdout file, so filtering can never stand in for it.
say(run({ stderr: "", hit: false }) !== 0, "smoke step fails when search does not find the memory");
say(run({ stderr: CPUID, hit: false }) !== 0, "smoke step fails on a missing search hit even with only benign stderr");

// Canary pair for the exit-status judgement: `|| true` on BOTH vipune arms is the shape that
// would let a broken vipune through the build — masking one arm alone still leaves the other
// to record the exit in `f`, so it is the pair that fakes a good image. Nothing about it is
// visible to a reader of the step; only running it shows that the failures it hides are the
// ones the step exists to catch. The real step must fail that stub and the mutant must pass
// it — a pair, so a judgement that checks nothing can't report both sides green. The
// substitution is confined to the vipune calls by the pattern itself: the comment above the
// RUN quotes `|| f=1` as prose, and rewriting there would mutate a sentence, not a command.
const masked = dockerfile.replace(/(timeout 60 vipune [^\n]*?) \|\| f=1/g, "$1 || true");
say(
  (masked.match(/\|\| true/g) ?? []).length - (dockerfile.match(/\|\| true/g) ?? []).length === 2 && /vipune add[^\n]*\|\| true/.test(masked) && /vipune search[^\n]*\|\| true/.test(masked),
  "canary fixture: the masked-vipune mutant rewrote exactly the two vipune arms' exit guard",
);
// Each side is named separately: a pair reported as one line cannot tell "the shipped step
// rejects the broken exit" from "nothing ran", which is the half of the pair that matters.
const brokenRc = 101;
const realCode = run({ stderr: "", rc: brokenRc });
const mutantCode = runBody(extractBody(masked), { stderr: "", rc: brokenRc });
say(realCode !== 0, `canary: the shipped step rejects a vipune that exits ${brokenRc} with empty stderr (got ${realCode})`);
say(mutantCode === 0, `canary: the masked mutant accepts that same vipune, so the judgement above is what rejects it (got ${mutantCode})`);

if (fails.length) process.exit(1);
console.log("dockerfile-vipune-smoke gate: PASS");
