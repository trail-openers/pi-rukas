#!/usr/bin/env bash
# triage.sh — emit the triage.tsv skeleton for a repo's open backlog.
#
#   triage.sh <repo-path> [remote] > <repo>/tmp/fanout/triage.tsv
#
# Emits the header and the issue rows, with issue numbers and title buckets from the
# forge and every judgement column left BLANK for you to fill.
#
# WHY IT DOES NOT AUTO-FILL VERDICTS
# "Is this issue safe to spend a cycle on" is a reading-comprehension judgement over the
# issue body, not a rule. A script that guessed would produce a confident wrong answer,
# and the expensive failure mode here is precisely the confident one: a `ready` verdict on
# an issue that will `intent-park` burns a full explore+plan dispatch to discover the
# issue was never buildable. So the mechanical part is scripted and the judgement is
# yours (or a subagent's, briefed on references/triage.md).
#
# Columns to fill: files-likely-touched, blast-radius, depends-on, collides-with-live,
# verdict, blocked-reason, effort. See references/triage.md for the vocabulary and for
# which bodies are worth reading closely.
#
# WHY IT REFUSES RATHER THAN PRINTS A SHORT TABLE
# A failed listing, an empty one and a truncated one all look like a table with few rows.
# Nothing is printed for any of them: an empty table reads as "nothing to triage", and a
# truncated one silently drops the OLDEST issues, since both CLIs list newest first.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

REPO="${1:-$FANOUT_REPO}"
[ -n "$REPO" ] || die "usage: triage.sh <repo-path> [remote]" 2
FANOUT_REPO="$REPO"
fanout_resolve_repo

# Detect the forge rather than assuming GitHub: this repo is on GitHub, but the skill is
# not specific to it, and a silent `gh` on a GitLab project produces an empty table that
# reads as "no open issues".
FORGE="$(git -C "$FANOUT_REPO" remote get-url "${2:-origin}" 2>/dev/null || true)"
[ -n "$FORGE" ] || die "no remote '${2:-origin}' in $FANOUT_REPO" 3

# Passed as --repo, never left to the caller's cwd: the same owner/repo worker.sh reads.
SLUG="$(fanout_url_slug "$FORGE")" \
  || die "cannot derive owner/repo from remote '${2:-origin}' ($FORGE)" 3

# A listing at the cap is truncated. gh takes the cap as --limit; glab pages at 100, GitLab's
# maximum per page, so its cap is that page size.
if printf '%s' "$FORGE" | grep -qi gitlab; then
  which glab >/dev/null 2>&1 || die "remote is GitLab but glab is not on PATH" 3
  echo "# source: glab, remote $FORGE" >&2
  RAW="$(glab issue list -R "$SLUG" --output json -P 100 2>/dev/null)"; rc=$?
  ID_FIELD=iid; CAP=100
else
  which gh >/dev/null 2>&1 || die "gh is not on PATH and the remote is not GitLab" 3
  echo "# source: gh, remote $FORGE" >&2
  CAP="${FANOUT_TRIAGE_LIMIT:-2000}"
  # --json, not a text table: a title containing a tab or newline would corrupt the TSV,
  # and titles ending mid-clause are common in this backlog.
  RAW="$(gh issue list --state open --limit "$CAP" --repo "$SLUG" --json number,title 2>/dev/null)"; rc=$?
  ID_FIELD=number
fi
[ "$rc" = 0 ] || die "forge listing failed (exit $rc) for $SLUG. Check gh/glab auth and that the remote is reachable. Nothing was written." 3

# The header is printed only once the listing has passed every check, so a refusal leaves
# stdout empty and no table can be mistaken for a clean one.
printf '%s' "$RAW" | TRIAGE_ID="$ID_FIELD" TRIAGE_CAP="$CAP" "$(fanout_node)" -e '
    let raw = ""; process.stdin.on("data", (d) => (raw += d)).on("end", () => {
      const cap = Number(process.env.TRIAGE_CAP);
      let rows = null; try { rows = JSON.parse(raw); } catch { }
      if (!Array.isArray(rows)) {
        console.error("[fanout][error] the forge listing is not a JSON array; the table would be empty or wrong. Nothing written.");
        process.exit(3);
      }
      if (rows.length === 0) {
        console.error("[fanout][error] the forge returned no open issues. An empty table reads as nothing to triage; if the backlog really is empty there is nothing to do. Nothing written.");
        process.exit(3);
      }
      if (rows.length >= cap) {
        console.error("[fanout][error] the listing hit its cap of " + cap + " and is truncated: the oldest issues are the ones dropped. Raise FANOUT_TRIAGE_LIMIT (gh) or split the backlog. Nothing written.");
        process.exit(3);
      }
      console.log("issue\ttitle-bucket\tfiles-likely-touched\tblast-radius\tdepends-on\tcollides-with-live\tverdict\tblocked-reason\teffort");
      for (const r of rows) {
        const title = (r.title || "").replace(/[\t\n]/g, " ");
        console.log([r[process.env.TRIAGE_ID], JSON.stringify(title.slice(0, 60)), "", "unknown", "", "", "", "", ""].join("\t"));
      }
    });' || die "triage table not written (see the error above)" 3
