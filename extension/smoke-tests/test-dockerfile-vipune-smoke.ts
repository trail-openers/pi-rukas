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
// The benign warning is the bare line the cpu probe writes: the failing publish-image run's own
// stderr carried no logger prefix at all, so a pattern that required one would leave the build
// broken. Anything else that mentions `onnxruntime` — the affinity line below — is residue.
const CPUID_TAIL = "onnxruntime cpuid_info warning: Unknown CPU vendor. cpuinfo_vendor value: 0";
// The joined-error line's own prefix, so a pattern anchored to the warning alone could not pass
// for the wrong reason on a line that carries its own report.
const ERROR_PREFIX = "E:onnxruntime, default_allocator.cc:42 Load model from /home/vscode/.cache/huggingface/hub/model.onnx";
const CPUID = `\x1b[0;93m${CPUID_TAIL}\x1b[0m`;
const AFFINITY = "\x1b[1;31m[E:onnxruntime:Default, env.cc:374 ThreadMain] pthread_setaffinity_np failed : Operation not permitted (22)\x1b[0m";
// The shape the actual failing publish-image run wrote (`gh run view` of run 44717094942:
// `onnxruntime cpuid_info warning: Unknown CPU vendor. cpuinfo_vendor value: 0`, with no
// `[W:…]` prefix — the `18.64` in the log is buildx's own step timer, not the container's
// bytes). This is the line the filter MUST drop: a pattern anchored on `[W:` does not match
// it, and the build stays broken.
const CPUID_BARE = CPUID_TAIL;

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
// The shape the failing CI run actually wrote. Split from the coloured arm above on purpose:
// a filter that anchors on the `[W:…]` logger prefix passes that arm and fails this one, and
// a merged assertion would hide the re-break.
say(run({ stderr: CPUID_BARE }) === 0, "smoke step passes on the bare cpu-probe warning exactly as the failing publish-image run wrote it");
say(run({ stderr: CPUID_TAIL.replace(/value: 0$/, "value: 12") }) === 0, "smoke step passes on the warning whatever enum value the probe reports");
say(run({ stderr: CPUID_TAIL.replace(/value: 0$/, "value: 00") }) === 0, "smoke step passes on the warning with a zero-padded enum value");
// The HIGH finding: the logger closes a record with a bare `\x1b[0m`, and after the ANSI strip
// that line is nothing but whitespace, so a residue test that counts it as content fails a
// perfectly good image. Blank (and whitespace-only) lines left by the strip are no residue;
// a real error line is residue even when blank lines surround it.
say(run({ stderr: `${CPUID_TAIL}\n\x1b[0m` }) === 0, "smoke step passes when a stderr line is only an ANSI escape and the strip leaves it blank");
say(run({ stderr: `\x1b[0m\n\x1b[1;33m   \x1b[0m` }) === 0, "smoke step passes when every stderr line is only ANSI escapes and spaces");
say(run({ stderr: `\n${CPUID_TAIL}\n\nsomething else complained\n\n` }) !== 0, "smoke step still fails on a real error line surrounded by blank lines");
say(run({ stderr: AFFINITY }) !== 0, "smoke step still fails on an onnxruntime pthread_setaffinity_np line");
say(run({ stderr: "something else complained" }) !== 0, "smoke step fails on any other stderr line");
say(run({ stderr: `${CPUID}\n${AFFINITY}` }) !== 0, "smoke step fails when the benign warning travels with an affinity line");
// R9, the exact-line rule. A drop that tests only for the two substrings also deletes a real
// onnxruntime failure that QUOTES the warning, and a broken-model image then publishes. Each
// of these is genuine stderr that contains the warning's text but is NOT that warning: the line
// carries its own report after the phrase, which is what a whole-line pattern leaves behind and
// a substring drop would erase. (A line that merely ENDS in the phrase is indistinguishable from
// the warning itself, so no pattern can drop one and keep the other — these fixtures put content
// after it, which is where the two rules actually disagree and the only shape worth pinning.)
const MODEL_LOAD = `E:onnxruntime, default_allocator.cc:42 Load model from /home/vscode/.cache/huggingface/hub/model.onnx failed: Protobuf parsing failed. ${CPUID_TAIL} while loading the embedding model`;
const EMBED_ZERO = `E:onnxruntime, tokenizer.cc:88 Embedding model returned zero vector for "image smoke", see cpuid_info warning: Unknown CPU vendor then a hard failure`;
const PYBIND = `terminate called after throwing an instance of 'onnxruntime::OnnxRuntimeException' what(): Load model failed: ${CPUID_TAIL} in Session::Load`;
const TYPED = `${CPUID_TAIL} and then the model loader died`;
for (const [what, line] of [
  ["a model-load failure that quotes the warning", MODEL_LOAD],
  ["an embedding failure that quotes the warning", EMBED_ZERO],
  ["a pybind rethrow that quotes the warning", PYBIND],
  ["the warning with anything after its numeric tail", TYPED],
] as const) {
  say(run({ stderr: line }) !== 0, `smoke step fails on ${what} (a substring drop would delete it and publish a broken image)`);
}
// The same quoting lines appended to real, passing vipune output: the exit is 0 and the search
// hit is present, so only the residue rule can catch these.
say(run({ stderr: `${CPUID}\n${MODEL_LOAD}\n${EMBED_ZERO}\n${PYBIND}` }) !== 0, "smoke step fails on model errors quoting the warning even alongside benign stderr and a passing hit");
// R10, the BOTH-ENDS rule. The logger terminates a record with an ANSI reset, so a
// real error and the benign warning can reach the stderr file joined on ONE line: the error's
// text, then `\x1b[0m`, then the warning. After the ANSI strip the line ENDS in the warning, so
// a pattern anchored only at the end matches the whole line, leaves zero bytes of residue, and
// a broken-model image publishes with a green smoke step. Anchoring the drop at the start as
// well — a line consisting only of the warning — is what makes that line survive.
const ERROR_JOINED_TO_WARNING = `${ERROR_PREFIX} failed: Segfault at 0x7f4a2c1b3d00\x1b[0m${CPUID_TAIL}`;
say(
  run({ stderr: ERROR_JOINED_TO_WARNING }) !== 0,
  "smoke step fails when a real error is joined to the benign warning on one line by an ANSI reset (an end-anchored-only drop deletes the whole line)",
);

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

// Structural half of the same rule: the drop must be anchored at BOTH ends of the line — a
// leading anchor so a joined error survives the ANSI strip, a trailing one so a line that merely
// QUOTES the warning is kept — and it must require the numeric vendor tail and the whole phrase.
// Dropping either anchor is the substring drop that published a broken model, and it is not a
// comment away from shipping again — so the shipped arm is pinned, not just exercised. The
// pattern is the bare warning only: nothing in it may be a hard-coded logger prefix, which is
// why the anchor is the whole line rather than a prefix alternative.
say(
  body.some((l) => /grep -E -v '\^onnxruntime cpuid_info warning: Unknown CPU vendor\\\. cpuinfo_vendor value: \[0-9\]\+\$'/.test(l)),
  "smoke step's filter is anchored at both ends of the line, requires the numeric vendor tail, and carries no hard-coded logger prefix (not a substring drop)",
);
// The benign line the failing publish-image run ACTUALLY wrote, byte for byte
// (`gh run view 44717094942 --log-failed`; the `18.64` in that log is buildx's step timer, so
// the container wrote no prefix). It is the one line the step must tolerate: drop the tail and
// this fails the build, which is the original #2418 outage, and this row is the one that catches
// it without a QEMU emulator to reproduce on.
say(CPUID_BARE === "onnxruntime cpuid_info warning: Unknown CPU vendor. cpuinfo_vendor value: 0", "gate fixture: the benign literal is the failing run's stderr line verbatim");

// Canary pair for the stderr filter. The pre-fix step dropped any line merely CONTAINING
// `onnxruntime` and the warning; on the quoting-error fixtures above that filter deletes every
// byte of stderr, the residue test sees an empty file, and a broken-model image publishes. The
// mutant is that substring drop, substituted into the shipped body — the substitution is keyed on
// the leading anchor plus the phrase, so it can only land on a real filter arm. It must PASS the
// quoting fixture while the shipped step fails it. Both sides are named, because a single-line
// "the filter is tight" assertion is exactly the assertion that reads green when nothing ran.
const substringDrop = dockerfile.replace(
  /grep -E -v '\^[^']*cpuid_info warning[^']*\$'/,
  "grep -E -v 'onnxruntime.*cpuid_info warning: Unknown CPU vendor'",
);
const dropMutantBody = extractBody(substringDrop);
say(
  dropMutantBody.length === body.length &&
    dropMutantBody.some((l) => l.includes("'onnxruntime.*cpuid_info warning: Unknown CPU vendor'")) &&
    !body.some((l) => l.includes("'onnxruntime.*cpuid_info warning: Unknown CPU vendor'")),
  "canary fixture: the substring-drop mutant rewrote exactly the filter arm and nothing else",
);
const realQuote = run({ stderr: MODEL_LOAD });
const mutantQuote = runBody(dropMutantBody, { stderr: MODEL_LOAD });
say(realQuote !== 0, `canary: the shipped step fails on a model error that quotes the warning (got ${realQuote})`);
say(mutantQuote === 0, `canary: the substring-drop mutant accepts that same stderr, so the shipped pattern is what rejects it (got ${mutantQuote})`);

// The filter must not be silently skipped: if the ANSI strip cannot read the stderr file, a form
// that swallowed the failure would hand `grep` empty input, leave `$d/rest` empty, and the step
// would read "no residue" as "no stderr" — publishing a broken image on an I/O error. Under the
// image's shell the pipeline's own status cannot tell those apart (measured: `sed` failing inside
// `sed … | grep -E -v …` still leaves exit 1 and an empty residue file, exactly the benign case),
// so the strip runs as its own command and its status is guarded. Deleting that guard is the
// mutation here; it rewrites one line and one line only, which is what makes the shipped guard
// observable rather than assumed.
const unguarded = dockerfile.replace(
  /sed 's\/\\x1b\\\[\[0-9;\]\*m\/\/g;\/\^\[\[:space:\]\]\*\$\/d' "\$d\/err" >"\$d\/clean" \|\| \{ echo "vipune smoke: stderr unreadable" >&2; exit 1; \};/,
  'sed \'s/\\x1b\\[[0-9;]*m//g;/^[[:space:]]*$/d\' "$d/err" >"$d/clean" || true;',
);
say(
  unguarded !== dockerfile && extractBody(unguarded).some((l) => /"\$d\/clean" \|\| true;/.test(l)),
  "canary fixture: the unguarded-sed mutant rewrote exactly the filter's read guard",
);
say(
  extractBody(unguarded).filter((l, i) => l !== body[i]).length === 1,
  "canary: the unguarded-sed mutant differs from the shipped step in the read guard alone",
);

rmSync(scratch, { recursive: true, force: true });

if (fails.length) process.exit(1);
console.log("dockerfile-vipune-smoke gate: PASS");
