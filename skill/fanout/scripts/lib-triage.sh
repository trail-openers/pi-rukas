#!/usr/bin/env bash
# lib-triage.sh — triage.tsv readers and the staleness gate, run before any clone is paid for.
# Sourced by lib.sh, never executed directly.
#
# ---------------------------------------------------------------------------
# triage.tsv readers — column layout defined once, here
# ---------------------------------------------------------------------------
# Verdict vocabulary honoured by worker.sh and drive.sh:
#   ready            spawn it
#   ready-lean       spawn it with --lean
#   blocked          refuse, name the blocker
#   needs-human      refuse, a human must decide first
#   park-wont-merge  refuse, the issue text will intent-park after a full explore+plan
fanout_row() {  # $1 = issue, $2 = column name -> cell value, or empty
  [ -f "${FANOUT_TRIAGE_FILE:-$FANOUT_ROOT/triage.tsv}" ] || return 0
  FANOUT_TSV="${FANOUT_TRIAGE_FILE:-$FANOUT_ROOT/triage.tsv}" FANOUT_ISSUE="$1" FANOUT_COL="$2" \
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

fanout_require_ready() {  # $1 = issue; exits 5 when triage says do not run it
  local v verdict reason
  v="$(fanout_row "$1" verdict)"
  if [ -z "$v" ]; then
    # An issue MISSING from the table is not a table that cleared it. The table is the record
    # that someone read the body and judged it runnable; treating absence as consent spawns
    # the fleet at exactly the issues nobody triaged -- which, in a backlog ordered lowest-
    # number-first, are the oldest and most likely to be stale.
    die "issue $1 has no row in the triage table. Add one with an explicit verdict, or pass --override-triage only if you have personally read the issue." 5
  fi
  verdict="${v%%	*}"
  reason="$(fanout_row "$1" blocked-reason)"
  case "$verdict" in
    ready | ready-lean) return 0 ;;
    *) die "triage marks issue $1 as '$verdict'${reason:+ ($reason)}. Fix the table, or pass --override-triage if you have personally checked it." 5 ;;
  esac
}

# ---------------------------------------------------------------------------
# staleness gate — a valid-looking ticket against a moved-ahead mainline
# ---------------------------------------------------------------------------
# The fleet orders the queue lowest-numbered first, which is the right priority rule and the
# wrong staleness rule: the oldest open tickets have had the most upstream change happen under
# them. A ticket that was valid when filed can now be already implemented, or may name a file
# that no longer exists. A cycle cannot discover either cheaply — it pays a full explore+plan
# (~20 min, tens of millions of tokens) and returns a park, or in the already-implemented case
# builds a duplicate of something that already merged.
#
# This gate therefore checks only facts obtainable in-process, in milliseconds, with no LLM:
#   - the issue is CLOSED on the forge            -> refuse (exit 5)
#   - the issue carries needs-human-attention     -> refuse unless FANOUT_ALLOW_ATTENTION=1
#   - a named file no longer exists in the clone  -> refuse (exit 5)
#
# What it does NOT do is decide whether the ticket's PREMISE still holds. "Does this bug still
# reproduce" and "is this already done" are reading-comprehension judgements over the body
# against current main. Those belong in triage as `park-stale` (references/triage.md), made by a
# human or a briefed subagent, not by a rule here. The distinction matters: `park-stale` means
# the ticket is wrong and should be closed, `park-wont-merge` means the ticket is thin and should
# be rewritten. Both refuse; only one is worth re-running after an edit.
# One declared-files cell entry -> a repo-relative path, or empty. Planner annotations are prose:
# "src/a.ts (new)" names a file that does not exist yet and is skipped; "src/a.ts (edits)" keeps the
# path. A blank cell arrives as "-" and is skipped. Whitespace around the path is trimmed (a cell
# "src/a.ts, src/b.ts" yields " src/b.ts" after the comma split).
fanout_norm_path() {  # $1 = raw entry
  local p="$1"
  case "$p" in *"(new)"*) return 0 ;; esac
  p="${p%%" ("*}"
  p="${p#"${p%%[![:space:]]*}"}"
  p="${p%"${p##*[![:space:]]}"}"
  case "$p" in ''|-) return 0 ;; esac
  printf '%s' "$p"
}

fanout_require_current() {  # $1 = issue, $2 = clone dir (may be empty for pre-clone checks)
  local issue="$1" clone="${2:-}"

  if [ "${FANOUT_SKIP_STALE:-0}" = 1 ]; then
    warn "staleness gate SKIPPED for issue $issue (FANOUT_SKIP_STALE=1) — you are on your own"
    return 0
  fi

  # Closed / merged upstream. Read from the forge, not from the state file: the state file
  # records what a cycle did, not what the ticket says now.
  #
  # No `gh ... -q <template>` here on purpose. A -q template contains pipe characters, and on
  # hosts whose permission layer is not in trust mode a pipe makes the whole call an ask, which
  # in headless mode hard-denies -- the gate would then silently warn and let a CLOSED issue
  # through. Plain --json output is one argv token, cannot be mistaken for a shell construct,
  # and parsing it here is free.
  if [ "${FANOUT_FORGE_CHECK:-1}" = 1 ]; then
    local raw state
    raw="$(gh issue view "$issue" --json state 2>/dev/null || true)"
    # Prefix OK: on success so an unparseable or empty reply is distinguishable from a real value.
    state="$(printf '%s' "$raw" | "$(fanout_node)" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);if(typeof o.state==="string")process.stdout.write("OK:"+o.state)}catch{}})')"
    case "$state" in
      OK:?*) state="${state#OK:}" ;;
      *) die "could not read the forge state for issue $issue (gh unavailable or unauthenticated). Fix gh auth, or set FANOUT_FORGE_CHECK=0 to run without the closed-issue check." 5 ;;
    esac
    # tr, not a case-transformation operator: macOS ships bash 3.2 and that operator is bash 4+.
    case "$(printf '%s' "$state" | tr '[:lower:]' '[:upper:]')" in
      CLOSED|MERGED) die "issue $issue is $state on the forge — do not spawn a cycle for it" 5 ;;
    esac
  fi

  # Handed off previously. Re-running an unchanged issue against the same gate reproduces the
  # same park; the human the label was addressed to has not been consulted.
  if [ "${FANOUT_ALLOW_ATTENTION:-0}" != 1 ]; then
    local lraw labels
    lraw="$(gh issue view "$issue" --json labels 2>/dev/null || true)"
    labels="$(printf '%s' "$lraw" | "$(fanout_node)" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);process.stdout.write("OK:"+(o.labels||[]).map((l)=>l.name).join(","))}catch{}})')"
    # An empty or unparseable reply must not read as "no labels": that would let a handed-off
    # issue through exactly when gh is failing. Only an explicit OK: prefix counts as a read.
    case "$labels" in
      OK:*) labels="${labels#OK:}" ;;
      *) die "could not read the labels for issue $issue (gh unavailable or unauthenticated). Fix gh auth, or set FANOUT_ALLOW_ATTENTION=1 to skip the attention check." 5 ;;
    esac
    case ",$labels," in
      *,needs-human-attention,*)
        die "issue $issue carries needs-human-attention: a previous cycle handed it off and nothing has revised it. Re-running reproduces the same park. Have the reason resolved, or set FANOUT_ALLOW_ATTENTION=1 if you know better." 5 ;;
    esac
  fi

  # Files the ticket names must still exist. Only checked once a clone exists, since "exists"
  # is relative to the tree being built.
  if [ -n "$clone" ] && [ -d "$clone" ]; then
    local f missing=""
    while IFS= read -r f; do
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

