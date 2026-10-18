# Triaging a backlog for fan-out

`scripts/triage.sh` emits the header and issue rows and leaves every judgement column
blank. Filling them is your job (or a subagent's, briefed on this file). It is not
lazy scripting: an auto-filled `verdict` is the confident-wrong-answer failure mode, and
here the confident wrong answer is *expensive* — a `ready` on an unbuildable issue burns a
full explore + plan dispatch to discover the issue was never buildable.

## Schema

```
issue  title-bucket  files-likely-touched  blast-radius  depends-on  collides-with-live  verdict  blocked-reason  effort
```

| column | read by | notes |
|---|---|---|
| `issue` | both scripts | the join key |
| `title-bucket` | nobody (sorting aid) | from the conventional-commit prefix. Never treat it as a verdict. |
| `files-likely-touched` | `worker.sh` | comma-separated repo-relative paths. **Feeds the path-claim gate** — leave blank and the collision fence is blind for that issue. |
| `blast-radius` | you | `single-file` \| `module` \| `cross-module` \| `shared-infra` |
| `depends-on` | you | issue numbers that must land first |
| `collides-with-live` | documented for humans | the script computes this itself from live pid-alive claims; your entry is for *expected future* collisions |
| `verdict` | both scripts | vocabulary below — **must be one of these exact tokens** |
| `blocked-reason` | error messages | one line, so a refusal is actionable without re-reading the issue |
| `effort` | you | `S` \| `M` \| `L`. Batch S first to bank visible progress. |

## Generating the table from a validated list

When the judgement has been made on a list of issues, `scripts/gen-triage.js` turns that list
into `triage.tsv` so no tab is typed by hand. Run it with bun, giving the paths as arguments:

```bash
bun <skill-dir>/scripts/gen-triage.js <validated-oldest.tsv> <triage.tsv>
```

The input is a tab-separated table with at least `issue`, `verdict`, `blast-radius`,
`files-likely-touched`, `depends-on`, `reason`, `effort` and (optionally) `bucket` columns, where
`verdict` is one of `VALID`, `STALE-ALREADY`, `STALE-PREMISE`, `THIN`, `NEEDS-HUMAN`. The output
is overwritten. Mapping: `VALID` becomes `ready` (or `needs-human` for `shared-infra`), the two
`STALE-*` verdicts become `park-stale`, `THIN` becomes `park-wont-merge`, and `NEEDS-HUMAN` stays
`needs-human`. An unmapped verdict is a hard error, never a default. The script then applies the
policy from the sections above: only one `shared-infra`/`cross-module` issue stays `ready`, a
dependency that is not `ready` demotes its dependents to `blocked`, and two `ready` issues that
claim the same file are not both kept. The exit code is non-zero when any row is malformed or unmapped.

## Verdict vocabulary

The scripts honour exactly these; anything else is refused as unknown.

| verdict | effect |
|---|---|
| `ready` | spawn |
| `ready-lean` | spawn with `--lean` (one workstream, 1536 MB heap; spawn cap and verify slots still divide by N) — use for small issues when pushing N high on a tight host |
| `blocked` | refuse; needs something external (a decision, a dependency, an environment change) |
| `needs-human` | refuse; a human must decide before any cycle is spent |
| `park-wont-merge` | refuse; the issue body will resolve to `intent-park` after a full explore + plan |
| `park-stale` | refuse; the ticket's premise no longer holds on current main — already implemented, the code it names is gone, or the described behaviour changed. **Close the issue; do not edit it and re-run.** |

`park-wont-merge` and `park-stale` both refuse, and conflating them wastes work in opposite
directions: a thin ticket is worth *rewriting* and re-running, a stale ticket is worth *closing*.
If you mark a stale ticket `park-wont-merge`, someone will eventually improve its prose and spend
a cycle rebuilding something that already shipped.

## The `park-stale` judgement, for the low-numbered backlog

When the queue is ordered lowest-number-first, staleness replaces thinness as the dominant
waste: an issue filed months ago describes the code as it was then. Check the body against
current main before believing it.

Mark `park-stale` when you can **prove** it, with a file+line or a merged PR:

- the described behaviour is already implemented — name the commit or PR. This is the most
  valuable verdict in the whole workflow: it retires a ticket and saves a cycle.
- a file or symbol the ticket names no longer exists, or does something different now
- the bug no longer reproduces because a later change removed the cause
- the ticket is a duplicate of another open issue (flag the pair — two workers on one change is
  a guaranteed conflict, and the fleet only fences collisions with *currently live* claims)

Epics are not one-cycle units. An EPIC spanning subsystems should be `THIN`/`needs-human` with
"must be decomposed", never `ready`.

Be careful with `chore: Follow-ups from #N (PR #M merged ...)` tickets. They are filed as
residuals of a specific review and are easy to leave open after a later PR happened to cover
them. Read what the parent PR did before treating the residual as outstanding.

## The `park-wont-merge` judgement is the highest-value one

Measured on this repo's history: 62 groups → 1 merged, 60 parked. The drain rate is not
limited by concurrency; it is limited by cycles reaching a gate they cannot pass. Running
more of them does not help. **Filtering them out before spawning is worth more than
raising N**, and it is the single cheapest thing in this whole workflow.

The expensive case is a thin body. pi-rukas resolves intent from the body — spec,
paragraph, or one-liner — and returns `proceed` / `proceed-with-assumptions` / `park` with
a machine-readable reason: `underspecified`, `contradicted-by-code`, `already-implemented`,
`too-large`, `premise-unsound`. **A missing or unreadable verdict parks** — silence is not
permission to build. So an issue whose body does not say what to build costs a complete
explore + plan (~20 min, tens of millions of tokens) and yields nothing.

Read the body and mark `park-wont-merge` when:

- **No deliverable.** Describes a symptom or a wish with no stated change ("settings are
  confusing"). Nothing to implement, so intent cannot resolve.
- **No acceptance criterion and no way to tell done from not-done.**
- **Contradicts the code as far as you can tell.** Read the file it names. If it doesn't
  match, that's `contradicted-by-code`; the fix is editing the issue, not running it.
- **Already implemented.** Check before spending a cycle to rediscover it. Grep; it's
  seconds.
- **Too large.** Multiple subsystems, or "redesign X". A single cycle cannot converge;
  it should be split into an epic plus sub-issues first.
- **Unsounded premise.** The problem it describes does not exist.

Marking one of these is not a rejection of the work — it says *the ticket is the thing to
fix*. Improving the body (`gh issue edit --body-file`, not a comment — comments get buried)
is what converts a park into a merge.

## Read the body closely when

- the title is under ~40 chars, or a bare type with no subsystem (`fix:`)
- it names a file or symbol that no longer exists (verify by reading it; a stale pointer
  makes a good-looking issue unbuildable)
- `blast-radius` is `shared-infra` — touching `.github/`, `.pi/`, `CODEOWNERS` or
  `agents.json` changes what verification means *within the same cycle*, which halts it
- `depends-on` is non-empty and those issues are still open

## Decide sequencing, don't just list

- **Batch the `S` issues first.** Fast PRs bank visible progress and validate the fleet
  mechanics on cheap cycles before you spend expensive ones.
- **Serialize `shared-infra` and epic-parent work.** One at a time.
- **Never queue two issues whose `files-likely-touched` overlap.** The script catches
  collisions with *currently live* cycles, not with other queued workers — two workers in
  the same batch are both alive and will both spawn.
- **`needs-human` is not a failure.** Moving the backlog from "unknown" to
  "blocked, because X" is the result. The point is that a cycle isn't spent finding out.

## Where to look for the facts

```bash
cd "$REPO" && gh issue view <N> --json title,body,labels,comments
```

and the code it names. The driver's own state files under
`<repo>/.pi/work-state/*.json` record what previous cycles hit — the `eventLog` tail and
`capHits` are the fastest way to see whether an issue has already parked, and why.
Prefer those to guessing, and to reading subagent transcripts.
