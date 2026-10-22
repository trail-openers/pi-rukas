# Sourced by selftest.sh after parts A and B. Shares its helpers and fixtures.
# The fixture repo is /tmp/fanout-selftest; its triage table is rewritten per section.

FIX=/tmp/fanout-selftest
FIXW="$FIX/tmp/fanout/workers"
NOFORGE="FANOUT_FORGE_URL=https://example.invalid/x.git"
TRIAGE_HDR='issue\ttitle-bucket\tfiles-likely-touched\tblast-radius\tdepends-on\tcollides-with-live\tverdict\tblocked-reason\teffort'

echo
echo "== the budget reaches the runner (the pipe bug, finding 1) =="
# The worker writes the environment the runner would inherit and stops before any clone. The
# dump is taken after every export the worker makes, so it is the runner's environment.
rm -f "$FIX/.pi/work-state/path-claims.json"
rm -rf "$FIXW" "$FIX/tmp/fanout/runs/issue-9002"
printf "$TRIAGE_HDR\n" >"$FIX/tmp/fanout/triage.tsv"
printf '9002\tchore\tsrc/a.ts\tmodule\t-\t-\tready\t-\tS\n' >>"$FIX/tmp/fanout/triage.tsv"
expect "dump hook: real run stops before the clone" 0 env FANOUT_RUNNER_ENV_DUMP="$FIX/env.dump" FANOUT_SKIP_PUSH_CHECK=1 FANOUT_FORGE_CHECK=0 FANOUT_REPO="$FIX" $NOFORGE "$S/worker.sh" --repo "$FIX" --workers 4 9002
check "runner env: spawn cap divided by N=4" "$(grep -c '^PI_ENSEMBLE_SPAWN_CAP=16$' "$FIX/env.dump")" 1
check "runner env: verify concurrency divided" "$(grep -c '^PI_ENSEMBLE_VERIFY_CONCURRENCY=1$' "$FIX/env.dump")" 1
check "runner env: parallel work forced off" "$(grep -c '^PI_ENSEMBLE_PARALLEL_WORK=0$' "$FIX/env.dump")" 1
check "runner env: heap cap in NODE_OPTIONS" "$(grep -c '^NODE_OPTIONS=--max-old-space-size=3072$' "$FIX/env.dump")" 1
check "no clone was made" "$(test -e "$FIXW/issue-9002/repo" && echo yes || echo no)" no
printf '9705\tchore\t-\tmodule\t-\t-\tready-lean\t-\tS\n' >>"$FIX/tmp/fanout/triage.tsv"
expect "ready-lean dump run reaches the budget" 0 env FANOUT_RUNNER_ENV_DUMP="$FIX/env.lean" FANOUT_SKIP_PUSH_CHECK=1 FANOUT_FORGE_CHECK=0 FANOUT_REPO="$FIX" $NOFORGE "$S/worker.sh" --repo "$FIX" 9705
check "ready-lean applies --lean (heap 1536MB)" "$(grep -c 'heap=1536MB' "$FIX/tmp/fanout/runs/issue-9705/budget.log")" 1

echo
echo "== the divisor is the host share, not this drive's N (finding 2) =="
# A live worker lock from another run on this WORKERS_DIR makes two live workers: 64 / 2 = 32.
mkdir -p "$FIXW/issue-9800.lock"
echo "$HARNESS_PID" >"$FIXW/issue-9800.lock/pid"
expect "host share: dump hook still reached" 0 env FANOUT_RUNNER_ENV_DUMP="$FIX/env.share" FANOUT_SKIP_PUSH_CHECK=1 FANOUT_FORGE_CHECK=0 FANOUT_REPO="$FIX" $NOFORGE "$S/worker.sh" --repo "$FIX" --workers 1 9002
check "live sibling halves the cap at N=1" "$(grep -c '^PI_ENSEMBLE_SPAWN_CAP=32$' "$FIX/env.share")" 1
rm -rf "$FIXW/issue-9800.lock"

echo
echo "== the worker count is bounded before any side effect (finding 3) =="
expect "worker --workers 5 refused" 2 env FANOUT_REPO="$FIX" $NOFORGE "$S/worker.sh" --repo "$FIX" --workers 5 9002
expect "drive --parallel 5 refused" 2 env FANOUT_REPO="$FIX" "$S/drive.sh" --repo "$FIX" --parallel 5 9002
expect "drive --parallel 4 accepted (dry run)" 0 env FANOUT_REPO="$FIX" "$S/drive.sh" --repo "$FIX" --parallel 4 --dry-run 9002
check "N=4 has no clamped floor" "$(/bin/bash -c '. "$1"; fanout_budget_values 4 0 "" | awk "{print \$5}"' _ "$LIB")" none

echo
echo "== closed and attention gates say when they did not run (finding 15) =="
dry_out="$(env FANOUT_FORGE_CHECK=0 FANOUT_REPO="$FIX" $NOFORGE "$S/worker.sh" --repo "$FIX" --dry-run 9002 2>&1)"
check "dry run reports closed/attention NOT CHECKED" "$(printf '%s' "$dry_out" | grep -c 'closed/attention: NOT CHECKED')" 1
check "skipped closed gate warns" "$(printf '%s' "$dry_out" | grep -c 'closed-issue gate NOT CHECKED')" 1
drive_dry="$(env FANOUT_REPO="$FIX" $NOFORGE "$S/drive.sh" --repo "$FIX" --dry-run 9002 2>&1)"
check "drive dry run marks an unchecked forge gate" "$(printf '%s' "$drive_dry" | grep -c 'would run  (forge closed/attention NOT CHECKED)')" 1

echo
echo "== the triage header is validated once (finding 16) =="
printf 'issue\ttitle-bucket\tblast-radius\tdepends-on\tcollides-with-live\tverdict\tblocked-reason\teffort\n' >"$FIX/tmp/fanout/triage.tsv"
printf '9002\tchore\tmodule\t-\t-\tready\t-\tS\n' >>"$FIX/tmp/fanout/triage.tsv"
hdr_out="$(env FANOUT_FORGE_CHECK=0 FANOUT_REPO="$FIX" $NOFORGE "$S/worker.sh" --repo "$FIX" --dry-run 9002 2>&1)"
hdr_rc=$?
check "missing files column is exit 4" "$hdr_rc" 4
check "the message names the missing column" "$(printf '%s' "$hdr_out" | grep -c 'required column(s):.*files-likely-touched')" 1
printf "$TRIAGE_HDR\n" >"$FIX/tmp/fanout/triage.tsv"
printf '9002\tchore\tsrc/a.ts\tmodule\t-\t-\tready\t-\tS\n' >>"$FIX/tmp/fanout/triage.tsv"

echo
echo "== the reservation fence: a reserved path refuses a second worker (finding 20) =="
# A reservation is a claims-shaped file under WORKERS_DIR/reservations, held by a live pid.
mkdir -p "$FIXW/reservations"
printf '[{"issue":9700,"pid":%s,"startedAt":0,"paths":["src/a.ts"]}]\n' "$HARNESS_PID" >"$FIXW/reservations/issue-9700.json"
expect "live reservation blocks an overlapping worker" 7 env FANOUT_FORGE_CHECK=0 FANOUT_REPO="$FIX" $NOFORGE "$S/worker.sh" --repo "$FIX" --dry-run 9002
printf '[{"issue":9700,"pid":%s,"startedAt":0,"paths":["src/a.ts"]}]\n' "$DEAD_PID" >"$FIXW/reservations/issue-9700.json"
expect "a dead owner's reservation is not a collision" 0 env FANOUT_FORGE_CHECK=0 FANOUT_REPO="$FIX" $NOFORGE "$S/worker.sh" --repo "$FIX" --dry-run 9002
rm -f "$FIXW/reservations/issue-9700.json"
expect "a dry run reserves nothing" 0 env FANOUT_FORGE_CHECK=0 FANOUT_REPO="$FIX" $NOFORGE "$S/worker.sh" --repo "$FIX" --dry-run 9002
check "dry run left no reservation" "$(test -e "$FIXW/reservations/issue-9002.json" && echo yes || echo no)" no

echo
echo "== the claims path is configurable and validated (finding 21) =="
mkdir -p "$FIX/custom"
printf '[{"issue":9999,"pid":%s,"startedAt":0,"paths":["src/a.ts"]}]\n' "$HARNESS_PID" >"$FIX/custom/claims.json"
expect "FANOUT_CLAIMS_RELPATH is read" 7 env FANOUT_CLAIMS_RELPATH=custom/claims.json FANOUT_FORGE_CHECK=0 FANOUT_REPO="$FIX" $NOFORGE "$S/worker.sh" --repo "$FIX" --dry-run 9002
rm -f "$FIX/custom/claims.json"
expect "an absolute FANOUT_CLAIMS_RELPATH is refused" 2 env FANOUT_CLAIMS_RELPATH=/etc/passwd FANOUT_FORGE_CHECK=0 FANOUT_REPO="$FIX" $NOFORGE "$S/worker.sh" --repo "$FIX" --dry-run 9002
rm -rf "$FIXW"

echo
echo "== a bad forge url is refused, including option-shaped ones (finding 9) =="
refuse_url() {  # $1 = url. Subshell: die exits only the subshell, which is the real call shape.
  ( FANOUT_REPO="$FIX" FANOUT_FORGE_URL="$1" fanout_forge_url ) >/dev/null 2>&1
  check "url refused: $1" "$?" 3
}
refuse_url "-oProxyCommand=touch:x"
refuse_url "ssh://-oProxyCommand=x/repo"
refuse_url "-oProxy:x"
refuse_url "user@-oProxy:repo.git"

echo
echo "== the forge read and the install are bounded, with named reasons (finding 4) =="
TB_BIN=/tmp/fanout-selftest-tb
rm -rf "$TB_BIN"; mkdir -p "$TB_BIN"
cat >"$TB_BIN/gh" <<'GH'
#!/bin/bash
exec sleep 30
GH
chmod +x "$TB_BIN/gh"
slow_out="$(env PATH="$TB_BIN:$PATH" FANOUT_TIMEOUT_GH=1 FANOUT_FORGE_CHECK=1 FANOUT_REPO="$FIX" $NOFORGE "$S/worker.sh" --repo "$FIX" --dry-run 9002 2>&1)"
slow_rc=$?
check "a hung gh is exit 5" "$slow_rc" 5
check "the gh timeout is named" "$(printf '%s' "$slow_out" | grep -c 'timed out after 1s')" 1
check "bounded helper: a hung command returns 124" "$(/bin/bash -c '. "$1"; fanout_bounded 1 sleep 10 >/dev/null 2>&1; echo $?' _ "$LIB")" 124
check "bounded helper: a fast command keeps its output" "$(/bin/bash -c '. "$1"; fanout_bounded 5 echo ok' _ "$LIB")" ok
check "bounded helper: a finished command takes its timer with it" "$(/bin/bash -c '. "$1"; fanout_bounded 987 true; sleep 0.5; ps -axo command | grep -c "^sleep 987$"' _ "$LIB")" 0
rm -rf "$TB_BIN"

echo
echo "== a missing SSH identity is refused before the clone (finding 13) =="
check "missing ssh identity: exit 3 before the clone" "$(env -u SSH_AUTH_SOCK FANOUT_FORGE_CHECK=0 FANOUT_REPO="$FIX" $NOFORGE "$S/worker.sh" --repo "$FIX" 9002 >/dev/null 2>&1; echo $?)" 3
check "FANOUT_SSH_KEY that is unreadable is refused" "$(env FANOUT_SSH_KEY=/nonexistent/key FANOUT_FORGE_CHECK=0 FANOUT_REPO="$FIX" $NOFORGE "$S/worker.sh" --repo "$FIX" 9002 >/dev/null 2>&1; echo $?)" 3
check "FANOUT_SKIP_PUSH_CHECK lets a real run reach the dump hook" "$(env -u SSH_AUTH_SOCK FANOUT_RUNNER_ENV_DUMP="$FIX/env.skip" FANOUT_SKIP_PUSH_CHECK=1 FANOUT_FORGE_CHECK=0 FANOUT_REPO="$FIX" $NOFORGE "$S/worker.sh" --repo "$FIX" 9002 >/dev/null 2>&1; echo $?)" 0

echo
echo "== the install timeout maps to exit 10 with its reason (finding 4) =="
IN2=/tmp/fanout-selftest-timeout
rm -rf "$IN2" "$FIXW/issue-9701"
mkdir -p "$IN2/tmp/fanout" "$IN2/extension"
git init -q -b main "$IN2"
printf '{"name":"x","private":true}\n' >"$IN2/extension/package.json"
git -C "$IN2" add -A
git -C "$IN2" -c user.email=t@t -c user.name=t commit -q -m init
printf "$TRIAGE_HDR\n" >"$IN2/tmp/fanout/triage.tsv"
printf '9701\tchore\t-\tmodule\t-\t-\tready\t-\tS\n' >>"$IN2/tmp/fanout/triage.tsv"
FB=/tmp/fanout-selftest-fakebun
rm -rf "$FB"; mkdir -p "$FB"
printf '#!/bin/bash\nexec sleep 30\n' >"$FB/bun"
chmod +x "$FB/bun"
inst_out="$(env PATH="$FB:$PATH" FANOUT_ALLOW_LOCAL_BASE=1 FANOUT_JS="$JS" FANOUT_TIMEOUT_INSTALL=1 FANOUT_TIMEOUT_FETCH=5 FANOUT_SKIP_PUSH_CHECK=1 FANOUT_FORGE_CHECK=0 FANOUT_REPO="$IN2" $NOFORGE "$S/worker.sh" --repo "$IN2" 9701 2>&1)"
inst_rc=$?
check "a hung install is exit 10" "$inst_rc" 10
check "the install timeout is named" "$(printf '%s' "$inst_out" | grep -c 'bun install timed out')" 1
rm -rf "$IN2" "$FB" "$FIXW/issue-9701"

echo
echo "== the forge read is one call per issue (finding 17) =="
# A counting stub: each invocation appends a line. The dry run reads once, the cache serves the rest.
CNT_BIN=/tmp/fanout-selftest-cnt
CNT_LOG=/tmp/fanout-selftest-cnt.log
rm -rf "$CNT_BIN" "$CNT_LOG"; mkdir -p "$CNT_BIN"
cat >"$CNT_BIN/gh" <<'GH'
#!/bin/bash
echo call >>"$CNT_LOG"
echo '{"state":"OPEN","labels":[]}'
GH
chmod +x "$CNT_BIN/gh"
env PATH="$CNT_BIN:$PATH" CNT_LOG="$CNT_LOG" FANOUT_FORGE_CHECK=1 FANOUT_REPO="$FIX" $NOFORGE "$S/worker.sh" --repo "$FIX" --dry-run 9002 >/dev/null 2>&1
check "one gh issue view per worker" "$(wc -l <"$CNT_LOG" | tr -d ' ')" 1
rm -rf "$CNT_BIN" "$CNT_LOG"

echo
echo "== fanout_node resolves an explicit override or refuses (finding 14) =="
expect "FANOUT_JS pointing nowhere is refused" 2 env FANOUT_JS=/nonexistent/js /bin/bash -c ". \"$LIB\"; fanout_node"
check "FANOUT_NODE alias is honoured" "$(FANOUT_NODE="$JS" /bin/bash -c '. "$1"; fanout_node' _ "$LIB")" "$JS"

echo
echo "== the pidfile: a fresh pid-less lock is live, a stale one is cleared (finding 10) =="
PF2=/tmp/fanout-selftest-pf2.lock
rm -rf "$PF2"; mkdir "$PF2"
check "a pid-less lock younger than 5 s is live" "$(/bin/bash -c '. "$1"; fanout_pidfile_acquire "$2" x && echo acquired || echo refused' _ "$LIB" "$PF2")" refused
rm -rf "$PF2"; mkdir "$PF2"
touch -t 202001010000 "$PF2"
check "an old pid-less lock is cleared" "$(/bin/bash -c '. "$1"; fanout_pidfile_acquire "$2" x && echo acquired || echo refused' _ "$LIB" "$PF2")" acquired
rm -rf "$PF2"

RACE=/tmp/fanout-selftest-race
rm -rf "$RACE"; mkdir -p "$RACE"
cat >"$RACE/acquire.sh" <<'RACE_ACQ'
. "$1"
if fanout_pidfile_acquire "$2" race; then echo ACQ; sleep 3; else echo REFUSED; fi
RACE_ACQ
mkdir "$RACE/lock"
echo "$DEAD_PID" >"$RACE/lock/pid"
while IFS= read -r n; do
  /bin/bash "$RACE/acquire.sh" "$LIB" "$RACE/lock" >"$RACE/out.$n" 2>&1 &
done <<__RACE_N__
1
2
3
4
5
6
7
8
__RACE_N__
wait
check "8 racers on a stale lock: exactly one acquires" "$(cat "$RACE"/out.* | grep -c '^ACQ$')" 1
check "the other seven are refused" "$(cat "$RACE"/out.* | grep -c '^REFUSED$')" 7

echo
echo "== the path reservation under contention: one worker per overlapping path (finding 20) =="
rm -rf "$RACE/workers"; mkdir -p "$RACE/workers"
cat >"$RACE/reserve.sh" <<'RACE_RES'
. "$1"
FANOUT_REPO="$3"
WORKERS_DIR="$2"
fanout_reserve_paths "$4" "$2/none" "src/race.ts" 1 >/dev/null 2>&1
echo "rc=$?"
sleep 3
RACE_RES
while IFS= read -r n; do
  /bin/bash "$RACE/reserve.sh" "$LIB" "$RACE/workers" "$FIX" "$((7000 + n))" >"$RACE/res.$n" 2>&1 &
done <<__RACE_R__
1
2
3
4
5
6
7
8
__RACE_R__
wait
check "8 racers on one path: exactly one reserves" "$(cat "$RACE"/res.* | grep -c '^rc=0$')" 1
check "the other seven collide" "$(cat "$RACE"/res.* | grep -c '^rc=7$')" 7
rm -rf "$RACE"

echo
echo "== budget values: one function, read by worker and capacity (finding 5) =="
check "N=4 full budget" "$(/bin/bash -c '. "$1"; fanout_budget_values 4 0 ""' _ "$LIB")" "16 1 1 3072 none"
check "N=2 lean: workstreams and heap" "$(/bin/bash -c '. "$1"; fanout_budget_values 2 1 ""' _ "$LIB")" "32 2 1 1536 none"
check "a heap override is applied" "$(/bin/bash -c '. "$1"; fanout_budget_values 1 0 2048' _ "$LIB")" "64 4 6 2048 none"

echo
echo "== capacity and drive validate their own numbers (findings LOW) =="
expect "capacity: non-numeric heap refused" 2 env FANOUT_HEAP_MB=abc FANOUT_REPO="$FIX" "$S/capacity.sh"
expect "drive: non-integer summary lock wait refused" 2 env FANOUT_SUMMARY_LOCK_WAIT=abc FANOUT_REPO="$FIX" "$S/drive.sh" --repo "$FIX" 9002
check "sampler: a non-numeric root pid is refused" "$(/bin/bash -c '. "$1"; fanout_sampler_start /tmp/x /tmp/y abc' _ "$LIB" 2>&1 | grep -c 'positive integer')" 1

echo
echo "== gen-triage: free-text cells cannot forge a row; nothing is written on error (findings 7, 8) =="
GEN2=/tmp/fanout-selftest-gen2
rm -rf "$GEN2"; mkdir -p "$GEN2"
printf 'issue\tbucket\tfiles-likely-touched\tblast-radius\tdepends-on\tverdict\treason\teffort\n' >"$GEN2/v.tsv"
printf '201\tfix\tsrc/x.ts\tmodule\t\tVALID\ta\rb\tS\n' >>"$GEN2/v.tsv"
printf '202\tfix\tsrc/y.ts\tmodule\t\tNEEDS-HUMAN\tneeds a human\tS\n' >>"$GEN2/v.tsv"
expect "gen-triage: CR inside a reason is accepted" 0 "$JS" "$S/gen-triage.js" "$GEN2/v.tsv" "$GEN2/t.tsv"
check "the CR became a space in the reason cell" "$(awk -F'\t' '$1=="201"{print $8}' "$GEN2/t.tsv")" "a b"
check "output has the input's row count" "$(awk 'NR>1' "$GEN2/t.tsv" | wc -l | tr -d ' ')" 2
printf 'issue\tbucket\tfiles-likely-touched\tblast-radius\tdepends-on\tverdict\treason\teffort\n' >"$GEN2/bad.tsv"
printf '203\tfix\tsrc/z.ts\tmodule\t\tconstructor\t\tS\n' >>"$GEN2/bad.tsv"
printf '204\tfix\tsrc/w.ts\tmodule\t\tVALID\t\tS\n' >>"$GEN2/bad.tsv"
printf 'OLD\n' >"$GEN2/keep.tsv"
expect "gen-triage: an unmapped verdict exits 1" 1 "$JS" "$S/gen-triage.js" "$GEN2/bad.tsv" "$GEN2/keep.tsv"
check "an existing table is left untouched on error" "$(cat "$GEN2/keep.tsv")" "OLD"
rm -rf "$GEN2"

echo
echo "== drive: exit 0 only when every worker finished cleanly (finding 6) =="
DX=/tmp/fanout-selftest-dx
rm -rf "$DX"; mkdir -p "$DX/scripts" "$DX/root"
cp "$S/drive.sh" "$S"/lib*.sh "$DX/scripts/"
cat >"$DX/scripts/worker.sh" <<'FAKE_X'
#!/bin/bash
issue=""
for a in "$@"; do issue="$a"; done
mkdir -p "$FANOUT_ROOT/runs/issue-$issue"
echo "{\"exitCode\":$FAKE_RUNNER_EXIT,\"issues\":[{\"status\":\"x\",\"usage\":{\"cost\":0.1,\"dispatches\":1}}]}" >"$FANOUT_ROOT/runs/issue-$issue/result.json"
exit "$FAKE_EXIT"
FAKE_X
chmod +x "$DX/scripts/worker.sh"
drive_x() {  # $1 = worker exit, $2 = runner exitCode -> drive.sh exit status
  rm -rf "$DX/root"; mkdir -p "$DX/root"
  env FANOUT_ROOT="$DX/root" FAKE_EXIT="$1" FAKE_RUNNER_EXIT="$2" "$DX/scripts/drive.sh" --repo "$FIX" 9401 >"$DX/out" 2>&1
}
drive_x 0 0;   check "merged (0) exits 0" "$?" 0
drive_x 10 10; check "handoff (10, runner says 10) exits 0" "$?" 0
drive_x 10 0;  check "install failure (10, runner not reached) exits 1" "$?" 1
drive_x 20 20; check "aborted (20) exits 1" "$?" 1
drive_x 0 none; check "exit 0 with no parseable runner result exits 1" "$?" 1
rm -rf "$DX"

echo
echo "== a full run on a fake toolchain: build log, runner env, TERM forwarding (findings 1, 18, 19) =="
# A fake bun satisfies install and build; a fake runner records its environment and then waits
# for TERM. Real clone, real worker, no network: the only fakes are the toolchain and the runner.
FT=/tmp/fanout-selftest-full
FTB=$FT/fakebin
rm -rf "$FT"; mkdir -p "$FT/tmp/fanout" "$FT/extension" "$FTB"
git init -q -b main "$FT"
printf '{"name":"x","private":true}\n' >"$FT/extension/package.json"
git -C "$FT" add -A
git -C "$FT" -c user.email=t@t -c user.name=t commit -q -m init
cat >"$FTB/bun" <<'FAKE_BUN'
#!/bin/bash
case "$1" in
  install) mkdir -p node_modules/@earendil-works/pi-coding-agent ;;
  run)
    if [ -n "${FAKE_BUILD_FAIL:-}" ]; then echo "build exploded: missing module"; exit 1; fi
    mkdir -p dist/prompts/standard && echo ok >dist/prompts/standard/explore.md ;;
esac
FAKE_BUN
chmod +x "$FTB/bun"
cat >"$FT/fake-runner" <<'FAKE_RUN'
#!/bin/bash
env | grep -E '^PI_ENSEMBLE_SPAWN_CAP=' >"$FT_MARK.env"
trap 'echo got-term >"$FT_MARK.term"; exit 21' TERM
echo started >"$FT_MARK.started"
while :; do sleep 0.1; done
FAKE_RUN
chmod +x "$FT/fake-runner"
printf "$TRIAGE_HDR\n" >"$FT/tmp/fanout/triage.tsv"
printf '9703\tchore\t-\tmodule\t-\t-\tready\t-\tS\n' >>"$FT/tmp/fanout/triage.tsv"
printf '9704\tchore\t-\tmodule\t-\t-\tready\t-\tS\n' >>"$FT/tmp/fanout/triage.tsv"
FT_ENV="PATH=$FTB:$PATH FANOUT_ALLOW_LOCAL_BASE=1 FANOUT_JS=$JS FANOUT_SKIP_PUSH_CHECK=1 FANOUT_FORGE_CHECK=0 FANOUT_TIMEOUT_FETCH=5 FANOUT_REPO=$FT FANOUT_FORGE_URL=https://example.invalid/x.git"

build_out="$(env $FT_ENV FAKE_BUILD_FAIL=1 "$S/worker.sh" --repo "$FT" 9703 2>&1)"
check "a failed build is exit 11" "$?" 11
check "the build log tail reaches the message" "$(printf '%s' "$build_out" | grep -c 'build exploded')" 1

rm -rf "$FT/tmp/fanout/workers/issue-9704"
env $FT_ENV FT_MARK="$FT/m704" FANOUT_RUNNER="$FT/fake-runner" "$S/worker.sh" --repo "$FT" --workers 2 9704 >"$FT/w704.out" 2>&1 &
WPID=$!
n=0
while [ ! -f "$FT/m704.started" ] && [ "$n" -lt 150 ]; do sleep 0.2; n=$((n + 1)); done
kill -TERM "$WPID" 2>/dev/null
wait "$WPID"
WRC=$?
check "TERM is forwarded to the runner" "$(cat "$FT/m704.term" 2>/dev/null)" got-term
check "the worker exits 143 once the runner has stopped" "$WRC" 143
check "the runner inherited the divided budget (N=2)" "$(cat "$FT/m704.env" 2>/dev/null)" "PI_ENSEMBLE_SPAWN_CAP=32"
rm -rf "$FT"

echo
echo "== dry run and the shell scripts still parse =="
check "every script parses under bash -n" "$(for f in "$S"/*.sh; do /bin/bash -n "$f" || echo "bad:$f"; done | grep -c bad: )" 0
