# selftest-part-d.sh — triage.sh's forge listing and gen-triage's dependency reading.
# Sourced by selftest.sh, which shares its helpers (expect, check) and $S / $JS. Kept apart to
# hold each file under the size gate.

echo
echo "== triage.sh: a failed, empty or truncated forge listing writes nothing =="
TRI_REPO=/tmp/fanout-triage-repo
rm -rf "$TRI_REPO"
mkdir -p "$TRI_REPO"
git -C "$TRI_REPO" init -q .
git -C "$TRI_REPO" remote add origin https://github.com/acme/widgets.git
TB_GH=/tmp/fanout-triage-bin
rm -rf "$TB_GH"
mkdir -p "$TB_GH"
# A stub gh. TRIAGE_STUB picks the failure; the default prints TRIAGE_N issues, capped at the
# --limit it was given, as the real CLI does.
cat >"$TB_GH/gh" <<'GH'
#!/bin/bash
[ -z "${GH_ARGS_LOG:-}" ] || printf '%s\n' "$*" >>"$GH_ARGS_LOG"
case "$TRIAGE_STUB" in
  fail)  echo "HTTP 401: Bad credentials" >&2; exit 4 ;;
  junk)  echo "<html>not json</html>" ;;
  empty) echo "[]" ;;
  *)
    lim=0; prev=""
    for a in "$@"; do [ "$prev" = --limit ] && lim="$a"; prev="$a"; done
    n="${TRIAGE_N:-3}"; [ "$n" -le "$lim" ] || n="$lim"
    awk -v n="$n" 'BEGIN { printf "["; for (i = 1; i <= n; i++) printf "%s{\"number\":%d,\"title\":\"t%d\"}", (i > 1 ? "," : ""), i, i; print "]" }' ;;
esac
GH
chmod +x "$TB_GH/gh"
TRI_LOG=/tmp/fanout-triage.args
triage_run() {  # $1 = stub mode; TRIAGE_N may be set by the caller for this call
  env TRIAGE_STUB="$1" TRIAGE_N="${TRIAGE_N:-3}" GH_ARGS_LOG="$TRI_LOG" PATH="$TB_GH:$PATH" "$S/triage.sh" "$TRI_REPO"
}
check "gh failure: named refusal, exit 3" "$(triage_run fail >/dev/null 2>&1; echo $?)" 3
check "gh failure: no table on stdout" "$(triage_run fail 2>/dev/null | wc -l | tr -d ' ')" 0
check "gh non-JSON reply: exit 3" "$(triage_run junk >/dev/null 2>&1; echo $?)" 3
check "gh empty list: exit 3, not a header-only table" "$(triage_run empty 2>/dev/null | wc -l | tr -d ' ')" 0
check "gh listing at the cap is refused (truncated)" "$(TRIAGE_N=5000 triage_run full >/dev/null 2>&1; echo $?)" 3
rm -f "$TRI_LOG"
check "gh healthy listing: exit 0 with header + rows" "$(triage_run full 2>/dev/null | wc -l | tr -d ' ')" 4
check "gh is given --repo owner/repo, not the remote url" "$(grep -c -- '--repo github.com/acme/widgets' "$TRI_LOG" 2>/dev/null)" 1

echo
echo "== gen-triage: a '-' depends-on cell is no dependency =="
GT_IN=/tmp/fanout-gentriage.validated.tsv
GT_OUT=/tmp/fanout-gentriage.triage.tsv
printf 'issue\tbucket\tfiles-likely-touched\tblast-radius\tdepends-on\tverdict\treason\teffort\n' >"$GT_IN"
printf '7001\tchore\tsrc/x.ts\tmodule\t-\tVALID\tok\tS\n' >>"$GT_IN"
printf '7002\tchore\tsrc/y.ts\tmodule\t\tVALID\tok\tS\n' >>"$GT_IN"
printf '7003\tchore\tsrc/z.ts\tmodule\t9999\tVALID\tok\tS\n' >>"$GT_IN"
rm -f "$GT_OUT"
expect "gen-triage: accepts the validated table" 0 "$JS" "$S/gen-triage.js" "$GT_IN" "$GT_OUT"
check "gen-triage: '-' depends-on stays ready" "$(awk -F'\t' '$1==7001{print $7}' "$GT_OUT")" ready
check "gen-triage: blank depends-on stays ready" "$(awk -F'\t' '$1==7002{print $7}' "$GT_OUT")" ready
check "gen-triage: a real unknown dependency still blocks" "$(awk -F'\t' '$1==7003{print $7}' "$GT_OUT")" blocked
