echo "== capacity =="
FANOUT_REPO="$REPO" "$S/capacity.sh" 2>&1 | sed 's/^/  /'
FANOUT_REPO="$REPO" FANOUT_LEAN=1 "$S/capacity.sh" --observed 2>&1 | head -8 | sed 's/^/  /'

echo
echo "== budget division is real, not cosmetic =="
FANOUT_LIB_PATH="$LIB" FANOUT_REPO="$REPO" "$JS" -e '
const {execSync}=require("child_process");
const out=execSync(`/bin/bash -c '"'"'set -uo pipefail; . "$FANOUT_LIB_PATH"; fanout_apply_budget 4 0'"'"' 2>&1`,{encoding:"utf8",env:process.env});
console.log(out.split("\n").map(l=>"  "+l).join("\n"));
const m=out.match(/spawn_cap=(\d+) verify_conc=(\d+) max_workstreams=(\d+)/);
if(!m){console.log("  FAIL no budget line");process.exit(1)}
const want=[16,1,1];
const got=[m[1],m[2],m[3]].map(Number);
const ok=got.every((v,i)=>v===want[i]);
console.log((ok?"  PASS":"  FAIL")+"  N=4 -> spawn_cap/verify/ws = "+got.join("/")+" (want "+want.join("/")+")");
process.exit(ok?0:1);'

echo
echo "== lean keeps the spawn-cap division (N=8) =="
LEAN8_OUT="$(FANOUT_LIB_PATH="$LIB" /bin/bash -c 'set -uo pipefail; . "$FANOUT_LIB_PATH"; fanout_apply_budget 8 1 ""' 2>&1 | grep -o 'spawn_cap=[0-9]*')"
check "lean N=8 spawn_cap is divided" "$LEAN8_OUT" "spawn_cap=8"

echo
echo "== the claims gate sees sibling worker clones; --override-triage cannot skip it =="
# The forge section above rewrote 9002 with no declared files, so restate its row here: the
# collision gate only sees paths the triage row declares.
printf 'issue\ttitle-bucket\tfiles-likely-touched\tblast-radius\tdepends-on\tcollides-with-live\tverdict\tblocked-reason\teffort\n' >/tmp/fanout-selftest/tmp/fanout/triage.tsv
printf '9002\tchore\tsrc/a.ts\tmodule\t-\t-\tready\t-\tS\n' >>/tmp/fanout-selftest/tmp/fanout/triage.tsv
mkdir -p /tmp/fanout-selftest/tmp/fanout/workers/issue-9500/repo/.pi/work-state
FANOUT_ALIVE_PID="$HARNESS_PID" "$JS" -e '
const fs=require("fs");
fs.writeFileSync("/tmp/fanout-selftest/tmp/fanout/workers/issue-9500/repo/.pi/work-state/path-claims.json", JSON.stringify([
  { issue: 9500, pid: parseInt(process.env.FANOUT_ALIVE_PID,10), startedAt: Date.now(), paths: ["src/a.ts"] }
]));'
expect "sibling clone claim blocks a worker" 7 env FANOUT_REPO=/tmp/fanout-selftest FANOUT_FORGE_URL=https://example.invalid/x.git "$S/worker.sh" --repo /tmp/fanout-selftest --dry-run 9002
expect "sibling claim survives --override-triage" 7 env FANOUT_REPO=/tmp/fanout-selftest FANOUT_FORGE_URL=https://example.invalid/x.git "$S/worker.sh" --repo /tmp/fanout-selftest --dry-run --override-triage 9002
rm -rf /tmp/fanout-selftest/tmp/fanout/workers

echo
echo "== the claims fence: own clone skipped, corrupt sibling fails closed =="
# Each case restates the triage table and clears the claim files it does not test.
TRIAGE_HEAD='issue\ttitle-bucket\tfiles-likely-touched\tblast-radius\tdepends-on\tcollides-with-live\tverdict\tblocked-reason\teffort'
printf "$TRIAGE_HEAD\n" >/tmp/fanout-selftest/tmp/fanout/triage.tsv
printf '9002\tchore\tsrc/a.ts\tmodule\t-\t-\tready\t-\tS\n' >>/tmp/fanout-selftest/tmp/fanout/triage.tsv
printf '9501\tchore\tsrc/q.ts\tmodule\t-\t-\tready\t-\tS\n' >>/tmp/fanout-selftest/tmp/fanout/triage.tsv
printf '9502\tchore\tsrc/z.ts\tmodule\t-\t-\tready\t-\tS\n' >>/tmp/fanout-selftest/tmp/fanout/triage.tsv
printf '9503\tchore\tsrc/c.ts (edits)\tmodule\t-\t-\tready\t-\tS\n' >>/tmp/fanout-selftest/tmp/fanout/triage.tsv
printf '9504\tchore\t-\tmodule\t-\t-\tready\t-\tS\n' >>/tmp/fanout-selftest/tmp/fanout/triage.tsv
rm -f /tmp/fanout-selftest/.pi/work-state/path-claims.json
# The worker's OWN clone holds a live claim on its own path. A cycle does not collide with its
# own leftover state, so this must pass. Read-everything-but-self would refuse it with exit 7.
mkdir -p /tmp/fanout-selftest/tmp/fanout/workers/issue-9501/repo/.pi/work-state
FANOUT_ALIVE_PID="$HARNESS_PID" "$JS" -e '
const fs=require("fs");
fs.writeFileSync("/tmp/fanout-selftest/tmp/fanout/workers/issue-9501/repo/.pi/work-state/path-claims.json", JSON.stringify([
  { issue: 9501, pid: parseInt(process.env.FANOUT_ALIVE_PID,10), startedAt: Date.now(), paths: ["src/q.ts"] }
]));'
expect "own clone's claim is not a collision" 0 env FANOUT_FORGE_CHECK=0 FANOUT_REPO=/tmp/fanout-selftest FANOUT_FORGE_URL=https://example.invalid/x.git "$S/worker.sh" --repo /tmp/fanout-selftest --dry-run 9501
rm -rf /tmp/fanout-selftest/tmp/fanout/workers/issue-9501
# A sibling clone whose claims file is corrupt must refuse the gate, not read as "no claims".
mkdir -p /tmp/fanout-selftest/tmp/fanout/workers/issue-9502/repo/.pi/work-state
printf 'not json at all' >/tmp/fanout-selftest/tmp/fanout/workers/issue-9502/repo/.pi/work-state/path-claims.json
expect "corrupt sibling clone claims is a hard error" 11 env FANOUT_FORGE_CHECK=0 FANOUT_REPO=/tmp/fanout-selftest FANOUT_FORGE_URL=https://example.invalid/x.git "$S/worker.sh" --repo /tmp/fanout-selftest --dry-run 9002
rm -rf /tmp/fanout-selftest/tmp/fanout/workers
# An annotated claim ("src/a.ts (edits)") must still block the bare path it names.
FANOUT_ALIVE_PID="$HARNESS_PID" "$JS" -e '
const fs=require("fs");
fs.writeFileSync("/tmp/fanout-selftest/.pi/work-state/path-claims.json", JSON.stringify([
  { issue: 9999, pid: parseInt(process.env.FANOUT_ALIVE_PID,10), startedAt: Date.now(), paths: ["src/a.ts (edits)"] }
]));'
expect "annotated claim blocks the bare path" 7 env FANOUT_FORGE_CHECK=0 FANOUT_REPO=/tmp/fanout-selftest FANOUT_FORGE_URL=https://example.invalid/x.git "$S/worker.sh" --repo /tmp/fanout-selftest --dry-run 9002
# An annotated CANDIDATE ("src/c.ts (edits)") must block the bare claimed path it names.
FANOUT_ALIVE_PID="$HARNESS_PID" "$JS" -e '
const fs=require("fs");
fs.writeFileSync("/tmp/fanout-selftest/.pi/work-state/path-claims.json", JSON.stringify([
  { issue: 9999, pid: parseInt(process.env.FANOUT_ALIVE_PID,10), startedAt: Date.now(), paths: ["src/c.ts"] }
]));'
expect "annotated candidate is still gated" 7 env FANOUT_FORGE_CHECK=0 FANOUT_REPO=/tmp/fanout-selftest FANOUT_FORGE_URL=https://example.invalid/x.git "$S/worker.sh" --repo /tmp/fanout-selftest --dry-run 9503
# A blank "-" cell declares no path: the gate must say it is blind, not pass in silence.
blind_out="$(env FANOUT_FORGE_CHECK=0 FANOUT_REPO=/tmp/fanout-selftest FANOUT_FORGE_URL=https://example.invalid/x.git "$S/worker.sh" --repo /tmp/fanout-selftest --dry-run 9504 2>&1)"
check "blind warning fires for a '-' cell" "$(printf '%s' "$blind_out" | grep -c 'therefore blind')" 1
# Claim-side spelling: a trailing-slash directory and a ./ path must still block src/a.ts.
FANOUT_ALIVE_PID="$HARNESS_PID" "$JS" -e '
const fs=require("fs");
fs.writeFileSync("/tmp/fanout-selftest/.pi/work-state/path-claims.json", JSON.stringify([
  { issue: 9999, pid: parseInt(process.env.FANOUT_ALIVE_PID,10), startedAt: Date.now(), paths: ["src/"] }
]));'
expect "claim 'src/' (trailing slash) blocks src/a.ts" 7 env FANOUT_FORGE_CHECK=0 FANOUT_REPO=/tmp/fanout-selftest FANOUT_FORGE_URL=https://example.invalid/x.git "$S/worker.sh" --repo /tmp/fanout-selftest --dry-run 9002
FANOUT_ALIVE_PID="$HARNESS_PID" "$JS" -e '
const fs=require("fs");
fs.writeFileSync("/tmp/fanout-selftest/.pi/work-state/path-claims.json", JSON.stringify([
  { issue: 9999, pid: parseInt(process.env.FANOUT_ALIVE_PID,10), startedAt: Date.now(), paths: ["./src/a.ts"] }
]));'
expect "claim './src/a.ts' blocks src/a.ts" 7 env FANOUT_FORGE_CHECK=0 FANOUT_REPO=/tmp/fanout-selftest FANOUT_FORGE_URL=https://example.invalid/x.git "$S/worker.sh" --repo /tmp/fanout-selftest --dry-run 9002
rm -f /tmp/fanout-selftest/.pi/work-state/path-claims.json

echo
echo "== a failed fetch refuses to build on the local main (fail closed) =="
SB=/tmp/fanout-selftest-stalebase
rm -rf "$SB"
mkdir -p "$SB/tmp/fanout"
git init -q -b main "$SB"
git -C "$SB" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
printf "$TRIAGE_HEAD\n" >"$SB/tmp/fanout/triage.tsv"
printf '9602\tchore\t-\tmodule\t-\t-\tready\t-\tS\n' >>"$SB/tmp/fanout/triage.tsv"
sb_out="$(env FANOUT_SKIP_PUSH_CHECK=1 FANOUT_FORGE_CHECK=0 FANOUT_TIMEOUT_FETCH=5 FANOUT_REPO="$SB" FANOUT_FORGE_URL=https://example.invalid/x.git "$S/worker.sh" --repo "$SB" 9602 2>&1)"
check "unreachable forge without opt-in is exit 9" "$?" 9
check "the refusal names the stale base" "$(printf '%s' "$sb_out" | grep -c 'not known to be current')" 1
rm -rf "$SB"

echo "== a failed bun install is reported as one, not masked by tail =="
# On a fresh clone with no extension/ directory, bun install cannot run. The old pipeline let
# tail's success hide that and the message the operator saw was a later, vaguer one.
IN=/tmp/fanout-selftest-install
rm -rf "$IN"
mkdir -p "$IN/tmp/fanout"
git init -q -b main "$IN"
git -C "$IN" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
printf "$TRIAGE_HEAD\n" >"$IN/tmp/fanout/triage.tsv"
printf '9601\tchore\t-\tmodule\t-\t-\tready\t-\tS\n' >>"$IN/tmp/fanout/triage.tsv"
install_out="$(env FANOUT_ALLOW_LOCAL_BASE=1 FANOUT_TIMEOUT_FETCH=5 FANOUT_SKIP_PUSH_CHECK=1 FANOUT_FORGE_CHECK=0 FANOUT_REPO="$IN" FANOUT_FORGE_URL=https://example.invalid/x.git "$S/worker.sh" --repo "$IN" 9601 2>&1)"
install_rc=$?
check "bun install failure exits 10" "$install_rc" 10
check "bun install failure names itself" "$(printf '%s' "$install_out" | grep -c 'bun install failed')" 1
rm -rf "$IN"

echo
echo "== gen-triage: dependency and file-overlap demotions reach a fixed point =="
# C(files x), A(files x), D(depends A). C is listed first, so C keeps x and A is demoted for the
# overlap. D depends on A and must follow it. Demoting in a single pass left D ready.
GEN=/tmp/fanout-selftest-gen
rm -rf "$GEN"
mkdir -p "$GEN"
printf 'issue\tbucket\tfiles-likely-touched\tblast-radius\tdepends-on\tverdict\treason\teffort\n' >"$GEN/validated.tsv"
# depends-on is a BLANK cell here. A "-" would read as an unknown dependency and block the row,
# which fails closed but is not what this case is about.
printf '101\tfix\tsrc/x.ts\tmodule\t\tVALID\t\tS\n' >>"$GEN/validated.tsv"
printf '102\tfix\tsrc/x.ts\tmodule\t\tVALID\t\tS\n' >>"$GEN/validated.tsv"
printf '103\tfix\tsrc/y.ts\tmodule\t102\tVALID\t-\tS\n' >>"$GEN/validated.tsv"
expect "gen-triage runs on the fixed-point fixture" 0 "$JS" "$S/gen-triage.js" "$GEN/validated.tsv" "$GEN/triage.tsv"
check "C (first owner of x) stays ready" "$(awk -F'\t' '$1=="101"{print $7}' "$GEN/triage.tsv")" ready
check "A (overlaps C) is blocked" "$(awk -F'\t' '$1=="102"{print $7}' "$GEN/triage.tsv")" blocked
check "D (depends on demoted A) is blocked too" "$(awk -F'\t' '$1=="103"{print $7}' "$GEN/triage.tsv")" blocked
# A verdict that names an Object.prototype member must be an unmapped verdict, not a mapper.
printf 'issue\tbucket\tfiles-likely-touched\tblast-radius\tdepends-on\tverdict\treason\teffort\n' >"$GEN/proto.tsv"
printf '105\tfix\tsrc/p.ts\tmodule\t\tconstructor\t\tS\n' >>"$GEN/proto.tsv"
printf '106\tfix\tsrc/q.ts\tmodule\t\ttoString\t\tS\n' >>"$GEN/proto.tsv"
expect "verdict 'constructor'/'toString' is unmapped (exit 1)" 1 "$JS" "$S/gen-triage.js" "$GEN/proto.tsv" "$GEN/proto-triage.tsv"
rm -rf "$GEN"

echo
echo "== pidfile: a LIVE owner refuses the second worker =="
# The holder is a real live process recorded as owner, the way acquire records it. The earlier
# version let the first acquire's own process exit, so the second acquire always saw a dead pid and
# took the stale-clear branch: the live-owner refusal (the exit-6 protection) was never exercised.
PF_LOCK=/tmp/fanout-selftest-pidfile.lock
PF_SCRIPT=/tmp/fanout-selftest-pidfile.sh
rm -rf "$PF_LOCK"
cat >"$PF_SCRIPT" <<'PF'
set -uo pipefail
. "$FANOUT_LIB_PATH"
mkdir "$PF_LOCK"
sleep 30 >/dev/null 2>&1 &
holder=$!
echo "$holder" >"$PF_LOCK/pid"
echo t >"$PF_LOCK/label"
if fanout_pidfile_acquire "$PF_LOCK" second; then echo acquired-over-live-owner; else echo "refused rc=$?"; fi
kill "$holder" >/dev/null 2>&1 || true
PF
pf_out="$(FANOUT_LIB_PATH="$LIB" PF_LOCK="$PF_LOCK" /bin/bash "$PF_SCRIPT" 2>&1)"
if [ "$pf_out" = "refused rc=1" ] && [ -d "$PF_LOCK" ]; then
  pass=$((pass+1)); echo "  PASS  live owner refused, lock kept"
else
  fail=$((fail+1)); echo "  FAIL  second acquire: out='$pf_out'"
fi
rm -rf "$PF_LOCK" "$PF_SCRIPT"

echo
echo "== drive.sh honours --parallel (the throttle counts its own children) =="
# Stand-in worker: logs start/end around a one-second sleep and writes the result drive.sh parses.
# Never clones. The peak number of concurrently running workers is what --parallel must bound.
PAR=/tmp/fanout-selftest-par
rm -rf "$PAR"
mkdir -p "$PAR/scripts" "$PAR/root"
cp "$S/drive.sh" "$S"/lib*.sh "$PAR/scripts/"
cat >"$PAR/scripts/worker.sh" <<'FAKE'
#!/bin/bash
issue=""
for a in "$@"; do issue="$a"; done
echo "start $issue" >>"$FAKE_LOG"
sleep 1
echo "end $issue" >>"$FAKE_LOG"
mkdir -p "$FANOUT_ROOT/runs/issue-$issue"
echo '{"exitCode":0,"issues":[{"status":"merged","usage":{"cost":0.1,"dispatches":1}}]}' >"$FANOUT_ROOT/runs/issue-$issue/result.json"
exit 0
FAKE
chmod +x "$PAR/scripts/worker.sh"

peak_of() { awk '/^start/{r++; if (r>m) m=r} /^end/{r--} END{print m+0}' "$1"; }
run_par() {  # $1 = --parallel value
  rm -rf "$PAR/root" "$PAR/log"
  mkdir -p "$PAR/root"
  env FANOUT_ROOT="$PAR/root" FAKE_LOG="$PAR/log" "$PAR/scripts/drive.sh" --repo /tmp/fanout-selftest --parallel "$1" 9201 9202 9203 >"$PAR/out" 2>&1
}
run_par 1
check "--parallel 1 peak concurrency" "$(peak_of "$PAR/log")" 1
expect "summary rows are 12 fields (header too)" 0 awk -F'\t' 'NF!=12{b=1} END{exit b}' "$PAR/root/summary.tsv"
run_par 2
check "--parallel 2 peak concurrency" "$(peak_of "$PAR/log")" 2
rm -rf "$PAR"

echo
echo "== drive.sh: a stuck summary lock is a bounded wait, not a hang =="
# A lock directory left behind by a killed drive.sh used to block every worker forever. The
# wait is bounded and the message names the directory to remove.
mkdir -p "$PAR/scripts" "$PAR/root"
cp "$S/drive.sh" "$S"/lib*.sh "$PAR/scripts/"
cat >"$PAR/scripts/worker.sh" <<'FAKE'
#!/bin/bash
issue=""
for a in "$@"; do issue="$a"; done
mkdir -p "$FANOUT_ROOT/runs/issue-$issue"
echo '{"exitCode":0,"issues":[{"status":"merged","usage":{"cost":0.1,"dispatches":1}}]}' >"$FANOUT_ROOT/runs/issue-$issue/result.json"
exit 0
FAKE
chmod +x "$PAR/scripts/worker.sh"
mkdir "$PAR/root/.summary.lock"
env FANOUT_ROOT="$PAR/root" FANOUT_SUMMARY_LOCK_WAIT=1 "$PAR/scripts/drive.sh" --repo /tmp/fanout-selftest 9301 >"$PAR/out" 2>&1
lock_msg="$(grep -c 'summary lock still held' "$PAR/out")"
check "stuck summary lock names itself after the bound" "$lock_msg" 1
rm -rf "$PAR"

echo
