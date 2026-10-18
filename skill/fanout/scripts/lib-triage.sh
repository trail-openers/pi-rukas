#!/usr/bin/env bash
# lib-triage.sh — triage.tsv readers and the staleness gate, run before any clone is paid for.
# Sourced by lib.sh, never executed directly.
#
# Verdicts honoured by worker.sh and drive.sh:
#   ready            spawn it
#   ready-lean       spawn it with --lean
#   blocked          refuse, name the blocker
#   needs-human      refuse, a human must decide first
#   park-wont-merge  refuse, the issue text will intent-park after a full explore+plan
#   park-stale       refuse, the ticket's premise no longer holds on main
#
# An issue ABSENT from the table is refused: absence means nobody judged it.

FANOUT_FORGE_READ_ISSUE=""
FANOUT_FORGE_STATE=""
FANOUT_FORGE_LABELS=""

fanout_triage_file() { printf '%s' "${FANOUT_TRIAGE_FILE:-$FANOUT_ROOT/triage.tsv}"; }

fanout_row() {  # $1 = issue, $2 = column name -> cell value, or empty
  [ -f "$(fanout_triage_file)" ] || return 0
  FANOUT_TSV="$(fanout_triage_file)" FANOUT_ISSUE="$1" FANOUT_COL="$2" \
    "$(fanout_node)" --input-type=module -e '
      import fs from "node:fs";
      const rows = fs.readFileSync(process.env.FANOUT_TSV, "utf8")
        .split("\n").filter((l) => l.trim() !== "" && !l.startsWith("#"));
      if (rows.length < 2) process.exit(0);
      const head = rows[0].split("\t");
      const ci = head.indexOf("issue"), vi = head.indexOf(process.env.FANOUT_COL);
      if (ci < 0 || vi < 0) process.exit(0);
      const row = rows.slice(1).map((l) => l.split("\t")).find((r) => r[ci] === process.env.FANOUT_ISSUE);
      if (!row) process.exit(0);
      process.stdout.write((row[vi] ?? "") + "\n");
    '
}

# Exit 4 naming the first missing column. Run once per worker, so a table without the
# files column cannot make the collision fence silently blind.
fanout_check_triage_header() {
  local f head missing="" c tab
  f="$(fanout_triage_file)"
  [ -f "$f" ] || return 0
  tab="$(printf '\t')"
  head="$(awk '!/^#/ && NF { print; exit }' "$f")"
  for c in issue files-likely-touched verdict blocked-reason; do
    case "$tab$head$tab" in
      *"$tab$c$tab"*) ;;
      *) missing="$missing $c" ;;
    esac
  done
  [ -z "$missing" ] || die "triage table $f has no required column(s):$missing. Regenerate it (references/triage.md)." 4
  # Two rows for one issue: fanout_row would take the first silently, whatever its verdict.
  dup="$(FANOUT_TSV="$f" "$(fanout_node)" --input-type=module -e '
    import fs from "node:fs";
    const rows = fs.readFileSync(process.env.FANOUT_TSV, "utf8")
      .split("\n").filter((l) => l.trim() !== "" && !l.startsWith("#"));
    if (rows.length < 2) process.exit(0);
    const ci = rows[0].split("\t").indexOf("issue");
    const seen = new Set(), dups = [];
    for (const l of rows.slice(1)) { const k = l.split("\t")[ci]; if (seen.has(k)) dups.push(k); seen.add(k); }
    process.stdout.write([...new Set(dups)].join(" "));
  ' 2>/dev/null)"
  [ -z "$dup" ] || die "triage table $f lists issue(s) more than once: $dup. Keep one row per issue; the first match was being used silently." 4
}

fanout_require_ready() {  # $1 = issue; exits 5 when triage says do not run it
  local v verdict reason
  v="$(fanout_row "$1" verdict)"
  if [ -z "$v" ]; then
    die "issue $1 has no row in the triage table. Add one with an explicit verdict, or pass --override-triage only if you have personally read the issue." 5
  fi
  verdict="${v%%	*}"
  reason="$(fanout_row "$1" blocked-reason)"
  case "$verdict" in
    ready | ready-lean) return 0 ;;
    *) die "triage marks issue $1 as '$verdict'${reason:+ ($reason)}. Fix the table, or pass --override-triage if you have personally checked it." 5 ;;
  esac
}

# One declared-files cell entry -> a repo-relative path, or empty. An annotation is stripped:
# "src/a.ts (new)" and "src/a.ts (edits)" both keep the path, so a file that does not exist yet
# still claims its path in the collision fence. A blank cell arrives as "-" and is skipped.
# The existence check (fanout_require_current) is what skips "(new)" entries.
fanout_norm_path() {  # $1 = raw entry
  local p="$1"
  p="${p%%" ("*}"
  p="${p#"${p%%[![:space:]]*}"}"
  p="${p%"${p##*[![:space:]]}"}"
  case "$p" in ''|-) return 0 ;; esac
  printf '%s' "$p"
}

# ---------------------------------------------------------------------------
# forge state — one bounded read per issue per process
# ---------------------------------------------------------------------------
# fanout_forge_read <issue>: one `gh issue view --json state,labels`, cached for this
# process, so the pre-clone and post-clone gates share one round-trip. Sets
# FANOUT_FORGE_STATE and FANOUT_FORGE_LABELS. Failure and timeout both exit 5 (fail closed).
# No `gh -q` template: its pipes read as a shell pipe to the host guard.
fanout_forge_read() {
  local issue="$1" raw rc parsed slug
  [ "$FANOUT_FORGE_READ_ISSUE" = "$issue" ] && return 0
  # --repo, never the caller's cwd: the same origin worker.sh clones from and pushes to.
  slug="$(fanout_url_slug "$(fanout_forge_url)")" \
    || die "cannot derive the forge repo from origin for $FANOUT_REPO. Pass --forge-url <ssh-or-https-url>." 3
  raw="$(fanout_bounded "${FANOUT_TIMEOUT_GH:-60}" gh issue view "$issue" --repo "$slug" --json state,labels 2>/dev/null)"
  rc=$?
  [ "$rc" != 124 ] || die "gh issue view $issue timed out after ${FANOUT_TIMEOUT_GH:-60}s (FANOUT_TIMEOUT_GH), so forge state is unknown. Fix the forge connection, raise the bound, or set FANOUT_FORGE_CHECK=0." 5
  parsed="$(printf '%s' "$raw" | "$(fanout_node)" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);if(typeof o.state==="string")process.stdout.write("OK:"+o.state+"\t"+(o.labels||[]).map((l)=>l.name).join(","))}catch{}})')"
  case "$parsed" in
    OK:*) ;;
    *) die "could not read the forge state for issue $issue (gh unavailable or unauthenticated). Fix gh auth, or set FANOUT_FORGE_CHECK=0 to run without the closed and attention checks." 5 ;;
  esac
  parsed="${parsed#OK:}"
  FANOUT_FORGE_STATE="${parsed%%	*}"
  FANOUT_FORGE_LABELS="${parsed#*	}"
  FANOUT_FORGE_READ_ISSUE="$issue"
}

# ---------------------------------------------------------------------------
# staleness gate — a valid-looking ticket against a moved-ahead mainline
# ---------------------------------------------------------------------------
# Checks only facts obtainable in-process with no LLM: the issue is not CLOSED or MERGED on
# the forge, it does not carry needs-human-attention (unless FANOUT_ALLOW_ATTENTION=1), and
# the files it names exist in the clone. Whether the premise still holds is a judgement and
# belongs in triage as park-stale (references/triage.md).
#
# $2 is the clone, or empty before the clone exists. FANOUT_FORGE_CHECK=0 skips the forge
# reads, and each skipped gate says so.
fanout_require_current() {
  local issue="$1" clone="${2:-}" f missing=""
  if [ "${FANOUT_SKIP_STALE:-0}" = 1 ]; then
    warn "staleness gate SKIPPED for issue $issue (FANOUT_SKIP_STALE=1)"
    return 0
  fi
  if [ "${FANOUT_FORGE_CHECK:-1}" = 1 ]; then
    fanout_forge_read "$issue"
    case "$(printf '%s' "$FANOUT_FORGE_STATE" | tr '[:lower:]' '[:upper:]')" in
      CLOSED|MERGED) die "issue $issue is $FANOUT_FORGE_STATE on the forge — do not spawn a cycle for it" 5 ;;
    esac
    if [ "${FANOUT_ALLOW_ATTENTION:-0}" = 1 ]; then
      warn "needs-human-attention gate SKIPPED for issue $issue (FANOUT_ALLOW_ATTENTION=1)"
    else
      case ",$FANOUT_FORGE_LABELS," in
        *,needs-human-attention,*)
          die "issue $issue carries needs-human-attention: a previous cycle handed it off and nothing has revised it. Have the reason resolved, or set FANOUT_ALLOW_ATTENTION=1 if you know better." 5 ;;
      esac
    fi
  else
    warn "closed-issue gate NOT CHECKED for issue $issue (FANOUT_FORGE_CHECK=0)"
    warn "needs-human-attention gate NOT CHECKED for issue $issue (FANOUT_FORGE_CHECK=0)"
  fi
  if [ -n "$clone" ] && [ -d "$clone" ]; then
    while IFS= read -r f; do
      case "$f" in *"(new)"*) continue ;; esac
      f="$(fanout_norm_path "$f")"
      [ -n "$f" ] || continue
      [ -e "$clone/$f" ] || missing="$missing $f"
    done <<__FILES__
$(fanout_row "$issue" files-likely-touched | tr ',' '\n')
__FILES__
    if [ -n "$missing" ]; then
      die "issue $issue names file(s) that do not exist in $clone:$missing — the ticket has drifted from main. Verify it still applies, correct files-likely-touched, or mark it park-stale." 5
    fi
  fi
  return 0
}
