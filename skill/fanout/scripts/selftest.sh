#!/bin/bash
# Test harness for skill/fanout/scripts. Written as a file because the host's bash guard
# denies `for ... in` loops and certain literal tokens in a command string, so an inline
# test of this matrix is not runnable by an agent -- which is itself a documented finding.
#
# Runs from any working directory. The skill dir comes from this script's own location; the
# repo under test comes from FANOUT_REPO, else the git toplevel of the current directory, else
# the git toplevel of the skill's own checkout (so a run from /tmp still tests the checkout the
# skill lives in).
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)" || exit 1
REPO="${FANOUT_REPO:-}"
[ -n "$REPO" ] || REPO="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$REPO" ] || REPO="$(git -C "$SKILL_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$REPO" ] || { echo "selftest: no git checkout to test against (set FANOUT_REPO)" >&2; exit 2; }
cd "$REPO" || exit 1
S="$SKILL_DIR/scripts"
LIB="$S/lib.sh"
# Sourced so the asserts can call the library directly through its real entry points
# (fanout_forge_url, fanout_apply_budget). Without this those calls exit 127 -- command not
# found -- and an assert that never actually invoked the code would report a plain FAIL rather
# than a false PASS, which is the only reason this was caught.
# shellcheck source=lib.sh
. "$LIB"
# The JS runtime every node-style probe below runs under: bun first, node as fallback, via the
# same resolver the harness uses, so the tests exercise the runtime the harness really picks.
JS="$(fanout_node)"
pass=0; fail=0
expect() {  # $1 label, $2 expected exit, rest = command
  local label="$1" want="$2"; shift 2
  "$@" >/tmp/fanout-test.out 2>&1
  local got=$?
  if [ "$got" = "$want" ]; then
    pass=$((pass+1)); printf '  PASS  %-46s exit=%s\n' "$label" "$got"
  else
    fail=$((fail+1)); printf '  FAIL  %-46s exit=%s want=%s\n' "$label" "$got" "$want"
    tail -2 /tmp/fanout-test.out | sed 's/^/          | /'
  fi
}

check() {  # $1 label, $2 got, $3 want
  if [ "$2" = "$3" ]; then pass=$((pass+1)); printf '  PASS  %-46s %s\n' "$1" "$2"
  else fail=$((fail+1)); printf '  FAIL  %-46s got=%s want=%s\n' "$1" "$2" "$3"; fi
}

echo "== forbidden flags are refused before ANY side effect =="
expect "worker --restart"            2 "$S/worker.sh" --repo . --restart 1514
expect "worker --merge"              2 "$S/worker.sh" --repo . --merge 1514
expect "worker --auto-merge"         2 "$S/worker.sh" --repo . --auto-merge 1514
expect "worker --sandboxed"          2 "$S/worker.sh" --repo . --sandboxed 1514
expect "worker --allow-protected"    2 "$S/worker.sh" --repo . --allow-protected .pi 1514
expect "drive --restart"             2 "$S/drive.sh"  --repo . --restart 1514 1515
expect "drive --merge"               2 "$S/drive.sh"  --repo . --merge 1514 1515

echo
echo "== usage errors =="
expect "worker: no issue"            2 "$S/worker.sh" --repo .
expect "worker: two issues"          2 "$S/worker.sh" --repo . 1514 1515
expect "worker: non-numeric issue"   2 "$S/worker.sh" --repo . notanumber
expect "worker: --timeout no value"  2 "$S/worker.sh" --repo . 1514 --timeout
expect "worker: --timeout non-int"   2 "$S/worker.sh" --repo . 1514 --timeout 5x
expect "drive: no issues"            2 "$S/drive.sh"  --repo .
expect "drive: junk in queue"        2 "$S/drive.sh"  --repo . 1514 abc
expect "drive: unknown flag"         2 "$S/drive.sh"  --repo . --bogus 1514

echo
echo "== environment validation =="
expect "worker: repo does not exist" 2 "$S/worker.sh" --repo /nonexistent-dir 1514
expect "capacity: no repo"           2 env -u FANOUT_REPO "$S/capacity.sh"

echo
echo "== the no-forge-url trap (a worker pushing to a local path ships nothing) =="
# The fixture's own origin must be a local path AND the fixture must have a triage row marked
# ready: the triage gate runs before the forge check and would otherwise exit 4, which is what
# this case first mistook for a wrong exit code. Clear any clone left by an earlier run -- a
# stale clone makes this case fail at the clone step for reasons that have nothing to do with
# what it is testing.
# Root is derived the same way lib.sh derives it, rather than assuming the helper has already
# run in this shell.
SELFTEST_ROOT="${FANOUT_ROOT:-/tmp/fanout-selftest/tmp/fanout}"
rm -rf /tmp/fanout-localorigin "$SELFTEST_ROOT/workers/issue-1514" "$SELFTEST_ROOT/runs/issue-1514"
mkdir -p /tmp/fanout-localorigin/tmp/fanout
/bin/bash -c 'cd /tmp/fanout-localorigin && git init -q . && git remote add origin /some/local/path'
printf 'issue\ttitle-bucket\tfiles-likely-touched\tblast-radius\tdepends-on\tcollides-with-live\tverdict\tblocked-reason\teffort\n' >/tmp/fanout-localorigin/tmp/fanout/triage.tsv
printf '1514\tchore\t-\tmodule\t-\t-\tready\t-\tS\n' >>/tmp/fanout-localorigin/tmp/fanout/triage.tsv
expect "worker: local origin refused" 3 env FANOUT_FORGE_URL= "$S/worker.sh" --repo /tmp/fanout-localorigin 1514

# Asserted through the REAL entry point rather than by duplicating its regex here -- a copy of
# the logic in the test would keep passing while the production path drifted, which is the
# exact failure mode this whole skill exists to avoid. fanout_forge_url exits 3 for local and
# unknown and prints the url for remote, so the exit code is the verdict.
assert_url() {  # $1 url, $2 expected kind (local|remote|unknown)
  local got out rc
  out="$(FANOUT_REPO=/tmp/fanout-selftest FANOUT_FORGE_URL="$1" fanout_forge_url 2>/dev/null)"
  rc=$?
  case "$rc" in
    0) got=remote ;;
    3) if [ "$2" = unknown ]; then got=unknown; else got=local; fi ;;
    *) got="exit-$rc" ;;
  esac
  if [ "$got" = "$2" ]; then pass=$((pass+1)); printf '  PASS  url %-52s %s\n' "$1" "$got"
  else fail=$((fail+1)); printf '  FAIL  url %-52s got=%s want=%s\n' "$1" "$got" "$2"; fi
}
assert_url "/some/local/path"                                local
assert_url "/srv/git/example-repo"                           local
assert_url "./relative/repo"                                 local
assert_url "../sibling/repo"                                 local
assert_url "~/home/repo"                                     local
assert_url "/a/b/myrepo.git"                                 local   # the .git-suffix trap
assert_url "file:///srv/repo.git"                          local   # a file scheme is a local repo
assert_url "git+file:///srv/repo.git"                      local
assert_url "FILE:///srv/repo.git"                          local
assert_url "https://github.com/o/r.git"                      remote
assert_url "http://host/r"                                   remote
assert_url "ssh://git@github.com/o/r.git"                    remote
assert_url "git@github.com:trail-openers/pi-rukas.git"       remote
assert_url "gitlab.example.com:group/repo.git"               remote
assert_url "origin"                                          unknown
assert_url ""                                                unknown
assert_url "garbage with spaces"                             unknown

# The fixture must be a git repo: fanout_resolve_repo validates that, because a worker clones
# from it. It does NOT need the repo's contents -- the triage and claim gates read tmp/ and
# .pi/, and nothing here clones. Sharing the real repo's .git would be wrong anyway: it is
# huge, and a clone of it would exercise code paths these cases are not testing.
rm -rf /tmp/fanout-selftest
mkdir -p /tmp/fanout-selftest/tmp/fanout /tmp/fanout-selftest/.pi/work-state
/bin/bash -c 'cd /tmp/fanout-selftest && git init -q .'

echo
echo "== triage gate =="
# Fixtures are generated with printf so the column separators are REAL tabs. A TSV typed by
# hand into a heredoc silently becomes space-separated, the verdict column then reads empty,
# and the gate refuses for the wrong reason -- which is how these two cases first passed while
# testing nothing.
printf 'issue\ttitle-bucket\tfiles-likely-touched\tblast-radius\tdepends-on\tcollides-with-live\tverdict\tblocked-reason\teffort\n' >/tmp/fanout-selftest/tmp/fanout/triage.tsv
printf '9001\tbug\t-\tmodule\t-\t-\tpark-wont-merge\tno acceptance criteria\tS\n' >>/tmp/fanout-selftest/tmp/fanout/triage.tsv
printf '9002\tchore\tsrc/a.ts\tmodule\t-\t-\tready\t-\tS\n' >>/tmp/fanout-selftest/tmp/fanout/triage.tsv
printf '9003\tbug\tsrc/gone.ts\tmodule\t-\t-\tpark-stale\talready implemented by PR 1500\tS\n' >>/tmp/fanout-selftest/tmp/fanout/triage.tsv
expect "triage refuses a park-wont-merge"  5 env FANOUT_REPO=/tmp/fanout-selftest FANOUT_FORGE_URL=https://example.invalid/x.git "$S/worker.sh" --repo /tmp/fanout-selftest --dry-run 9001
expect "triage refuses a park-stale"       5 env FANOUT_REPO=/tmp/fanout-selftest FANOUT_FORGE_URL=https://example.invalid/x.git "$S/worker.sh" --repo /tmp/fanout-selftest --dry-run 9003
expect "triage allows a ready issue"        0 env FANOUT_REPO=/tmp/fanout-selftest FANOUT_FORGE_URL=https://example.invalid/x.git "$S/worker.sh" --repo /tmp/fanout-selftest --dry-run 9002
expect "dry-run made no clone"              1 test -e /tmp/fanout-selftest/tmp/fanout/workers/issue-9002

echo
echo "== path-claim collision =="
mkdir -p /tmp/fanout-selftest/.pi/work-state
# The claim owner pid must still be alive when worker.sh checks it. A transient `node -e` pid
# is gone by then, so the claim reads as dead and every collision test would pass for the wrong
# reason. Bind claims to the harness pid, which outlives the whole run.
HARNESS_PID=$$
# The "dead" pid must be a REAL pid value that simply is not running. Values outside the
# system pid_max are not ESRCH but an error, which would make a live-looking claim read as
# dead and silently disable the collision fence. A port/procfs probe confirms 999998 is free
# on this host; do not replace it with an arbitrary huge number.
# A real dead pid: one the OS reports as ESRCH. Values above the system pid_max are NOT
# ESRCH but an error, and a claim whose owner cannot be resolved must not be treated as dead
# -- that would silently disable the collision fence. Probe it rather than assume it.
DEAD_PID="$("$JS" -e '
  // Walk down from a plausible upper bound until the OS says ESRCH.
  for (let pid = 99999; pid > 30000; pid -= 1) {
    try { process.kill(pid, 0); } catch (e) { if (e.code === "ESRCH") { process.stdout.write(String(pid)); break; } }
  }')"
if [ -z "$DEAD_PID" ]; then
  echo "SKIP: could not find a provably-dead pid on this host; dead-claim cases are unreliable" >&2
  DEAD_PID=30001
fi
echo "using provably-dead pid: $DEAD_PID"
FANOUT_ALIVE_PID="$HARNESS_PID" FANOUT_DEAD_PID="$DEAD_PID" "$JS" -e '
const fs=require("fs");
const alive=parseInt(process.env.FANOUT_ALIVE_PID,10);
const dead=parseInt(process.env.FANOUT_DEAD_PID,10);
fs.writeFileSync("/tmp/fanout-selftest/.pi/work-state/path-claims.json", JSON.stringify([
  { issue: 9099, pid: alive,  startedAt: Date.now(), paths: ["src/a.ts"] },
  { issue: 9098, pid: dead,   startedAt: Date.now(), paths: ["src/dead.ts"] }
]));'
# Write only the DEAD-owner claim here. The previous fixture wrote the live and dead claims
# together, so the live src/a.ts claim was still present and refusing was CORRECT -- the case
# was asserting a collision-free outcome against a fixture that contained a real collision.
# Each case must contain only the evidence that case is about.
FANOUT_DEAD_PID="$DEAD_PID" "$JS" -e '
const fs=require("fs");
fs.writeFileSync("/tmp/fanout-selftest/.pi/work-state/path-claims.json", JSON.stringify([
  { issue: 9098, pid: parseInt(process.env.FANOUT_DEAD_PID,10), startedAt: Date.now(), paths: ["src/dead.ts"] }
]));'
# containment: claiming the directory must catch the file under it
FANOUT_ALIVE_PID="$HARNESS_PID" "$JS" -e '
const fs=require("fs");
fs.writeFileSync("/tmp/fanout-selftest/.pi/work-state/path-claims.json", JSON.stringify([
  { issue: 9099, pid: parseInt(process.env.FANOUT_ALIVE_PID,10), startedAt: Date.now(), paths: ["src"] }
]));'
expect "directory claim catches nested file" 7 env FANOUT_REPO=/tmp/fanout-selftest FANOUT_FORGE_URL=https://example.invalid/x.git "$S/worker.sh" --repo /tmp/fanout-selftest --dry-run 9002
# a shared prefix is NOT containment
FANOUT_ALIVE_PID="$HARNESS_PID" "$JS" -e '
const fs=require("fs");
fs.writeFileSync("/tmp/fanout-selftest/.pi/work-state/path-claims.json", JSON.stringify([
  { issue: 9099, pid: parseInt(process.env.FANOUT_ALIVE_PID,10), startedAt: Date.now(), paths: ["src/b.ts"] }
]));'
expect "shared prefix is not a collision" 0 env FANOUT_REPO=/tmp/fanout-selftest FANOUT_FORGE_URL=https://example.invalid/x.git "$S/worker.sh" --repo /tmp/fanout-selftest --dry-run 9002

echo
echo "== the claims gate fails LOUD, not open =="
# A present-but-unreadable claims file must not read as "no collisions": that is the shape of
# a gate that can never fail. The helper distinguishes empty output (fine, nothing live) from
# a nonzero exit (fatal), which is what these two cases assert.
printf 'not json at all' > /tmp/fanout-selftest/.pi/work-state/path-claims.json
expect "corrupt claims file is a hard error" 11 env FANOUT_REPO=/tmp/fanout-selftest FANOUT_FORGE_URL=https://example.invalid/x.git "$S/worker.sh" --repo /tmp/fanout-selftest --dry-run 9002
# A row with a non-numeric issue or a non-array paths is a claim we cannot judge. It was skipped
# silently, which passed a collision for the same reason an unreadable file must not.
FANOUT_ALIVE_PID="$HARNESS_PID" "$JS" -e '
const fs=require("fs");
fs.writeFileSync("/tmp/fanout-selftest/.pi/work-state/path-claims.json", JSON.stringify([
  { issue: "9093", pid: parseInt(process.env.FANOUT_ALIVE_PID,10), startedAt: Date.now(), paths: ["src/a.ts"] }
]));'
expect "claim with a string issue is a hard error" 11 env FANOUT_REPO=/tmp/fanout-selftest FANOUT_FORGE_URL=https://example.invalid/x.git "$S/worker.sh" --repo /tmp/fanout-selftest --dry-run 9002
FANOUT_ALIVE_PID="$HARNESS_PID" "$JS" -e '
const fs=require("fs");
fs.writeFileSync("/tmp/fanout-selftest/.pi/work-state/path-claims.json", JSON.stringify([
  { issue: 9092, pid: parseInt(process.env.FANOUT_ALIVE_PID,10), startedAt: Date.now(), paths: "src/a.ts" }
]));'
expect "claim with a non-array paths is a hard error" 11 env FANOUT_REPO=/tmp/fanout-selftest FANOUT_FORGE_URL=https://example.invalid/x.git "$S/worker.sh" --repo /tmp/fanout-selftest --dry-run 9002
# A claim owned by the worker's OWN pid is valid evidence of a live cycle and must never be
# treated as stale. Write the file, then let that node exit, so the claim names a pid that has
# definitively gone -- the same ESRCH distinction as DEAD_PID, reached from the other side.
# No `$!` here: a short-lived `node -e` can be reaped before bash records it, which under
# `set -u` aborts the whole harness with an unbound-variable error.
"$JS" -e '
const fs=require("fs");
fs.writeFileSync("/tmp/fanout-selftest/.pi/work-state/path-claims.json", JSON.stringify([
  { issue: 9097, pid: process.pid, startedAt: Date.now(), paths: ["src/a.ts"] }
]));'
sleep 1
expect "exited owner pid is a dead claim, not a collision" 0 env FANOUT_REPO=/tmp/fanout-selftest FANOUT_FORGE_URL=https://example.invalid/x.git "$S/worker.sh" --repo /tmp/fanout-selftest --dry-run 9002
# A malformed claim must never block a path forever. kill(-1,0) succeeds and signals every
# process, so a claim carrying pid -1 would otherwise read as permanently live.
"$JS" -e '
const fs=require("fs");
fs.writeFileSync("/tmp/fanout-selftest/.pi/work-state/path-claims.json", JSON.stringify([
  { issue: 9096, pid: -1, startedAt: Date.now(), paths: ["src/a.ts"] },
  { issue: 9095, pid: 0,  startedAt: Date.now(), paths: ["src/a.ts"] },
  { issue: 9094, pid: "999998", startedAt: Date.now(), paths: ["src/a.ts"] }
]));'
expect "malformed owner pids cannot block a path forever" 0 env FANOUT_REPO=/tmp/fanout-selftest FANOUT_FORGE_URL=https://example.invalid/x.git "$S/worker.sh" --repo /tmp/fanout-selftest --dry-run 9002
rm -f /tmp/fanout-selftest/.pi/work-state/path-claims.json
rm -f /tmp/fanout-selftest/.pi/work-state/path-claims.json
expect "absent claims file means genuinely no collision" 0 env FANOUT_REPO=/tmp/fanout-selftest FANOUT_FORGE_URL=https://example.invalid/x.git "$S/worker.sh" --repo /tmp/fanout-selftest --dry-run 9002

echo
echo "== an issue MISSING from the table is not a clean verdict =="
# Only 9002 is in the table, so asking about 9001 must refuse: absence means nobody judged it,
# and the lowest-numbered, least-triaged issues are the ones most likely to be stale.
printf 'issue\ttitle-bucket\tfiles-likely-touched\tblast-radius\tdepends-on\tcollides-with-live\tverdict\tblocked-reason\teffort\n' >/tmp/fanout-selftest/tmp/fanout/triage.tsv
printf '9002\tchore\tsrc/a.ts\tmodule\t-\t-\tready\t-\tS\n' >>/tmp/fanout-selftest/tmp/fanout/triage.tsv
expect "issue absent from the table is refused" 5 env FANOUT_REPO=/tmp/fanout-selftest FANOUT_FORGE_URL=https://example.invalid/x.git "$S/worker.sh" --repo /tmp/fanout-selftest --dry-run 9001
# A table with a header and no rows is the same case and must not read as "all clear".
printf 'issue\ttitle-bucket\tfiles-likely-touched\tblast-radius\tdepends-on\tcollides-with-live\tverdict\tblocked-reason\teffort\n' >/tmp/fanout-selftest/tmp/fanout/triage.tsv
expect "header-only table cannot bless anything" 5 env FANOUT_REPO=/tmp/fanout-selftest FANOUT_FORGE_URL=https://example.invalid/x.git "$S/worker.sh" --repo /tmp/fanout-selftest --dry-run 9002

echo
echo "== missing triage.tsv refuses rather than spawning blind =="
rm -f /tmp/fanout-selftest/tmp/fanout/triage.tsv
expect "no triage.tsv" 4 env FANOUT_REPO=/tmp/fanout-selftest FANOUT_FORGE_URL=https://example.invalid/x.git "$S/worker.sh" --repo /tmp/fanout-selftest --dry-run 9002

echo
echo "== declared-file entries are normalised before the existence check =="
check "norm: (new) entry is skipped" "$(fanout_norm_path 'src/a.ts (new)')" ""
check "norm: annotation stripped" "$(fanout_norm_path 'src/a.ts (edits)')" "src/a.ts"
check "norm: leading space trimmed" "$(fanout_norm_path ' src/b.ts')" "src/b.ts"
check "norm: blank cell dash skipped" "$(fanout_norm_path -)" ""
check "norm_list: dash and (new) entries vanish" "$(fanout_norm_list '-,src/q.ts (new),src/r.ts (edits)')" "src/r.ts"
# The runtime is used as "$(fanout_node)". It must resolve to one executable path, never to a
# multi-word command like the old "/usr/bin/env bun" fallback.
node_path="$(fanout_node)"
case "$node_path" in /*) node_kind=absolute ;; *) node_kind="not absolute: $node_path" ;; esac
check "fanout_node is one absolute path" "$node_kind" absolute

echo
echo "== forge repo slug (gh/glab --repo) is derived from the origin url =="
check "slug: https with .git" "$(FANOUT_REPO=/tmp/fanout-selftest fanout_url_slug https://github.com/acme/widgets.git)" github.com/acme/widgets
check "slug: scp-style ssh" "$(FANOUT_REPO=/tmp/fanout-selftest fanout_url_slug git@github.com:acme/widgets.git)" github.com/acme/widgets
check "slug: ssh with port and nested group" "$(FANOUT_REPO=/tmp/fanout-selftest fanout_url_slug ssh://git@gitlab.example.com:2222/grp/sub/repo.git)" gitlab.example.com/grp/sub/repo
check "slug: a local path is not a forge slug" "$(FANOUT_REPO=/tmp/fanout-selftest fanout_url_slug /srv/git/repo >/dev/null 2>&1; echo $?)" 3

echo
echo "== forge reads fail closed (stub gh, no network) =="
FG_BIN=/tmp/fanout-selftest-bin
rm -rf "$FG_BIN"
mkdir -p "$FG_BIN"
cat >"$FG_BIN/gh" <<'GH'
#!/bin/bash
[ -z "${GH_ARGS_LOG:-}" ] || printf '%s\n' "$*" >>"$GH_ARGS_LOG"
case "$GH_STUB" in
  dead) exit 1 ;;
  slow) sleep 30 ;;
  open) echo '{"state":"OPEN","labels":[]}' ;;
  closed) echo '{"state":"CLOSED","labels":[]}' ;;
esac
GH
chmod +x "$FG_BIN/gh"
printf 'issue\ttitle-bucket\tfiles-likely-touched\tblast-radius\tdepends-on\tcollides-with-live\tverdict\tblocked-reason\teffort\n' >/tmp/fanout-selftest/tmp/fanout/triage.tsv
printf '9002\tchore\t-\tmodule\t-\t-\tready\t-\tS\n' >>/tmp/fanout-selftest/tmp/fanout/triage.tsv
FG_ENV="FANOUT_REPO=/tmp/fanout-selftest FANOUT_FORGE_URL=https://example.invalid/x.git FANOUT_FORGE_CHECK=1"
expect "unreadable forge refuses (fail closed)" 5 env $FG_ENV GH_STUB=dead PATH="$FG_BIN:$PATH" "$S/worker.sh" --repo /tmp/fanout-selftest --dry-run 9002
expect "CLOSED issue refused" 5 env $FG_ENV GH_STUB=closed PATH="$FG_BIN:$PATH" "$S/worker.sh" --repo /tmp/fanout-selftest --dry-run 9002
expect "OPEN, unlabelled issue passes" 0 env $FG_ENV GH_STUB=open PATH="$FG_BIN:$PATH" "$S/worker.sh" --repo /tmp/fanout-selftest --dry-run 9002
# Run from an unrelated cwd: the forge read must name the origin repo itself, not inherit the
# caller's checkout (drive.sh run from another repo read that repo's issues).
FG_LOG=/tmp/fanout-selftest-gh.args
rm -f "$FG_LOG"
( cd /tmp && env $FG_ENV GH_STUB=open GH_ARGS_LOG="$FG_LOG" PATH="$FG_BIN:$PATH" "$S/worker.sh" --repo /tmp/fanout-selftest --dry-run 9002 >/dev/null 2>&1 )
check "forge read names the origin repo with --repo" "$(grep -c -- '--repo example.invalid/x' "$FG_LOG" 2>/dev/null)" 1
rm -f "$FG_LOG"
rm -rf "$FG_BIN"

echo

# The remaining sections live beside this file. They run in this shell, so the helpers and
# fixtures above are shared with them. Kept apart to hold each file under the size gate.
. "$S/selftest-part-b.sh"
. "$S/selftest-part-c.sh"
. "$S/selftest-part-d.sh"

echo
echo "===================================="
echo "  passed=$pass  failed=$fail"
echo "===================================="
exit $((fail > 0 ? 1 : 0))
