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

if printf '%s' "$FORGE" | grep -qi gitlab; then
  which glab >/dev/null 2>&1 || die "remote is GitLab but glab is not on PATH" 3
  echo "# source: glab, remote $FORGE" >&2
  glab issue list --output json 2>/dev/null \
    | "$(fanout_node)" -e '
        let raw = ""; process.stdin.on("data", (d) => (raw += d)).on("end", () => {
          let rows = []; try { rows = JSON.parse(raw); } catch { }
          console.log("issue\ttitle-bucket\tfiles-likely-touched\tblast-radius\tdepends-on\tcollides-with-live\tverdict\tblocked-reason\teffort");
          for (const r of rows) console.log([r.iid, JSON.stringify((r.title || "").slice(0, 60)),
            "", "unknown", "", "", "", "", ""].join("\t"));
        });'
else
  which gh >/dev/null 2>&1 || die "gh is not on PATH and the remote is not GitLab" 3
  echo "# source: gh, remote $FORGE" >&2
  # --json, not a text table: a title containing a tab or newline would corrupt the TSV,
  # and titles ending mid-clause are common in this backlog.
  gh issue list --state open --limit 500 --json number,title --repo "$FORGE" 2>/dev/null \
    | "$(fanout_node)" -e '
        let raw = ""; process.stdin.on("data", (d) => (raw += d)).on("end", () => {
          let rows = []; try { rows = JSON.parse(raw); } catch { }
          console.log("issue\ttitle-bucket\tfiles-likely-touched\tblast-radius\tdepends-on\tcollides-with-live\tverdict\tblocked-reason\teffort");
          for (const r of rows) {
            const title = (r.title || "").replace(/[\t\n]/g, " ");
            console.log([r.number, JSON.stringify(title.slice(0, 60)), "", "unknown", "", "", "", "", ""].join("\t"));
          }
        });'
fi
