# The lean engine

A second, deterministic `/work`. Where the compiled `/work` driver narrates a
pipeline to specialists, lean runs a pure transition table whose only
specification is a set of tests proved to fail before anybody wrote the
feature. Phase 1 of epic #1883. Source: `extension/src/lean/`; headless entry:
`extension/src/headless/work-lean.ts`.

## What lean is

One issue, one run, one state file. Each step decides its own verdict, the table
in `machine.ts` decides where the run goes, and the step log is the record — not
a model's recollection of what happened.

    ready → specify → build → challenge → build → verify → publish → review → ci → land

Every state in that walk has a handler. A review that fixed its head re-enters
`verify` before it goes to `ci` — see [`review`](#the-steps).

| Step | Who | What it does |
|---|---|---|
| `ready` | driver | Fetches the issue, parses its `pi-spec v1` block, judges readiness, resolves the mainline sha, loads `.pi/work.json` **at that sha**. Any failure is a `fail` outcome. |
| `specify` | adversary (a `developer` child) | Writes the acceptance tests and submits them. Before the adversary is dispatched, the step asks the project's runner one question with an empty probe file (outside the configured `verify.testDir`, removed again on every path): exit **0 or 5** is healthy; anything else — a runner that dies before collection, a hang, a runner that never started — is an **infrastructure hand-back** naming the command, not a verdict, and costs no dispatch. Submodules the base carries are initialised after every reset (`clean -fdx` de-populates them), and a failure there is the same hand-back. Each submitted file is then run against the base commit; a file that passes there is dropped. Freeze a contract with no red test and the step returns `no-red-test` and the run is refused, with the reason naming which of the two happened: **`the child never submitted a test`** when the adversary ended without calling `submit_tests` at all, or **`criterion <id> has no red test`** when it submitted files that nothing proved red (each dropped file's reason following). That clause is the FIRST clause of every rule it appears in, so the decline comment and the step record both lead with the cause. The probe, the submodule initialisation, and which of those two clauses a silent child is reported under are one switch: `PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT=0` restores v0.14.71, where no probe is run, no reset populates a submodule, and a silent child is reported as `criterion <id> has no red test` ([configuration.md](configuration.md)). If the boundary dropped a submitted test, `specify` retries once with the refusal reasons in the adversary's prompt; if the adversary ended without calling `submit_tests` once while the spec has test criteria, it retries once with a fixed note telling it to submit — and that retry still fires on the never-submitted decline. Either way the second attempt is a fresh child, both are billed to the step, and the second attempt's result is final. Before freezing, the adversary is also asked — prompt text only — for requirements the issue implies but does not state, each grounded in a `path:line` at the base commit that the adversary is asked to cite but no gate verifies, and filed as an extra test case under the criterion it refines; an implied requirement never becomes a criterion of its own. |
| `build` | builder (a `developer` child) | Makes the frozen tests pass. The frozen paths are named individually and marked untouchable. The brief also carries a `## The issue` section — the issue body the step read once for its own spec parse, its `pi-spec` block stripped and the rest fenced — between the problem and the criteria, because the criteria summarise that text and a requirement stated only in prose was otherwise invisible to the one seat that writes the code; `PI_ENSEMBLE_LEAN_BUILD_ISSUE_PROSE=0` takes it back out of that seat **only** — the builder consults its own switch at its own call site, so the two oracle briefs keep rendering (and `PI_ENSEMBLE_LEAN_ISSUE_PROSE=0` takes it out of all three seats — see [configuration.md](configuration.md)). At most 3 build rounds (`MAX_BUILD_ATTEMPTS`, `machine.ts`) — one round per **dispatched** build, billed on entering `build` and never on leaving it, so a red verify, a challenge's new tests and a child stopped by its own budget all draw from the same three. |
| `challenge` | adversary | Tries to break the builder's claim with new tests. Runs at most once. New tests earn one more build round, within the same bound of at most 3 build rounds; none — or a round stopped by its own budget — go to verify. |
| `verify` | driver | The run's own gate, no model in it: clean tree, frozen-test integrity (blobs still hash to their records), a compiler canary, every frozen test, then `verify.fast` / `verify.full`, then the spec's `command` criteria. `green` or `red`.  A tier red at HEAD re-runs once (a flake is excused on a green re-run); still red, it is re-run at the run's base commit in a throwaway checkout, and a base that is not red leaves the tier's own red standing. A base that IS red is excused by ONE rule, stated in full once and applied by both `verify` and `ci`: compare the WHOLE FAILURE LINES of both runs — every line each run printed, trimmed, with that run's own tree root stripped from the front of its path, and grade the tier `green` (the failures recorded as `preexistingFailures` and disclosed in the PR body) **only when every head line is one the base printed, verbatim** — not by colour alone, and over EVERY line the head printed, not merely the lines the classifier reads. Nothing else is folded, normalised or discounted. The refusals beside it: any line past the classifier's own scan window on either side; a tier whose re-run or a base run that observed nothing; a base red shaped like an unprovisioned tree; two trees that are one tree; an empty recognised set on either side; a record the step log's reader would refuse — every one of these keeps the `baseline red:` hand-back; the frozen acceptance tests green is a precondition of grading an excuse at all. What hands back, by design: any head line the base did not print, INCLUDING the ones the classifier cannot read — a bare `killed` or `Exit code: 1`, a jest `●` block, a `# not ok 9` TAP comment, a zero-width character inside a name — so too a PR that adds passing tests to a suite already red at base (its pass-count summary is a head-only line), renumbered TAP/bats output, a moved pass-count or duration line, and a `Command failed: <cmd>` echo that quotes a command other than the one both runs ran. Every one is a hand-back, never a green. Neither arm bills a build round. |
| `publish` | driver | Pushes the branch under a lease bound to a sha it just read from origin, and opens (or reuses) the PR. Refuses to publish a green it did not observe at the head it is pushing. The branch it force-pushes is state-file data, so it first asks the publishable-branch guard — charset, `lean/` prefix, then the mainline — which is **fail-closed**: a mainline neither the clone nor origin will name refuses the push rather than passing it ([below](#the-publishable-branch-guard-and-the-mainline-it-refuses-against); `PI_ENSEMBLE_LEAN_GUARD_FAIL_CLOSED=0` restores the old pass). |
| `review` | both gates, driver-routed | The run's gate. One report-only adversarial pass and one six-lens round at a resolved commit from origin — the full review. Only a blocking verdict from the adversarial gate, or a lens row at the run's resolved review threshold, buys the wave: ONE fixer, given every blocking finding at once, in a disposable worktree of its own, then ONE re-review — the whole branch when pass 1 carried a CRITICAL (a row in either tier, `reported` or the discounted `advisory`), since the layer retires that class on a complete full round only and a delta can never clear it; otherwise a delta over the fix, which answers each blocking row ADDRESSED or NOT ADDRESSED. That upgrade REPLACES the delta round. An `REVIEW_INCOMPLETE` re-review is re-bought ONCE, behind a FRESH read of the step clock (a step already past its bound routes `fixed`, disclosed, rather than throwing); a round-cap or streak verdict is another component's budget and buys nothing. There is no second wave. Both gates clean passes, on one of two kinds: `done` when no fix wave ran, which goes to `ci`, or `fixed` when the wave integrated and pushed commits, which goes back through `verify` — the green `ci` demands has to be about the head the PR stands on. Anything else throws and the run hands back, with a named cause: a blocking finding the wave did not address, a CRITICAL the fix introduced, a fix that changed nothing, a round that ran no lens, a gate with no verdict, a re-review that did not range over the fix, a fixer that rewrote the frozen contract, a child its budget stopped. **What the review children see:** all three seats — the six lenses, the adversarial reviewer and the fixer — read the issue's prose with its `pi-spec v1` block stripped and bounded like any other issue block, and the spec's acceptance criteria as their **own section, printed in full**, so a long statement can no longer cut the criteria (or the statement's own tail) by competing with the block for one bound; an issue with no parsable block, or with an unterminated fence, gets no criteria section and the prose exactly as before. `PI_ENSEMBLE_LEAN_REVIEW_SPEC_SPLIT=0` restores the single bounded block byte for byte ([configuration.md](configuration.md)). |
| `ci` | driver | Observes the pipeline: the forge's required-check verdict (`mergeStateStatus` + `gh pr checks`) read at the PR head, and the project's full tier run in the run's worktree — both about the newest decided `verify`'s `verifiedHead`, which the disk is re-read against immediately before the tier. The forge is **polled**, not read once: both reads re-issue every 60 s while any row is still running (`pending`/`queued`/`in_progress`/`waiting`, or a state this step has never seen), because a check that has not finished is not a check that failed and grading one red spends a build round on code that is not broken. `green` needs `mergeStateStatus` `CLEAN` with every row passing; `red` names the rows that actually failed or came in `skipped`/`neutral`, or reports a PR that is not `OPEN`, no rows at all, or a head that moved off the verified one — the head is re-read on every poll and the poll that sees the move settles the step. The wait is bounded by `budgets.ci.minutes` (the tier keeps its own separate bound of the same size afterwards), and a wait that expires — or reaches the run's cycle deadline — **throws** `VerifyInfraError` naming the checks that never finished, so the run hands back instead of taking a build round; a worktree that has moved off that head throws too.  A red full tier is excused by the same LINE rule `verify` applies — every WHOLE FAILURE LINE the shared classifier reads from the head run, trimmed and with its tree root stripped, printed verbatim by the base, from a tier run that observed the work: a killed, un-startable or buffer-overflowed full tier never excuses, it keeps its red. `ci` always re-probes the base in its own throwaway checkout and excuses only on that probe's output; it never replays a `verify` record, and no recorded `baseNames`-style set — not even a byte-identical command from the newest decided verify — buys it a shorter path. The cost is one extra tier run per red full tier. |
| `land` | driver | The one irreversible act. Refuses unless `.pi/work.json` **at the run's base** grants `autoMerge: true`, the forge's merge evidence is clean, and the PR head equals the verified head; then merges squashed through the adapter, pinned to that head, and reads the result back. `merged` or `refused`; it never throws. |
| `handback` | driver | Ships the last verified head, then posts one issue comment saying what the run still needs and ends the run. |

Two refusals sit beside the main line: `decline` posts the rules an unreadable
or unready spec failed and ends the run `not-ready`, and any handler that
throws ends the run `handed-back` with `handler error at <state>: …`.

The load-bearing rule: only `ci` + `green` enters `land`, and even then the
engine re-reads its own log — the newest decided `verify` **and** `ci` must both
be green and no `draft` marker may be standing. Green is the only verdict that
clears a draft.

## What an issue needs

The issue body carries **one** fenced block whose info string is exactly
`pi-spec v1`. Its content is JSON, and it is the whole contract: the driver
does not infer scope, criteria or size from prose.

| Field | Type | Notes |
|---|---|---|
| `problem` | string, non-empty | What the run is for. |
| `criteria` | array, ≥1 | Each: `id` matching `AC1`, `AC2`, … ; `text` non-empty; `verify` one of `test`, `command`, `manual`; optional `command`. |
| `scope` | optional object | `paths` (may touch) and `out` (must not), both `string[]`. |
| `size` | `"S"`, `"M"` or `"L"` | `L` is refused: *"size L is too large for one run — split it"*. |

Verify kinds: **`test`** — an acceptance test proves it, and only `test`
criteria may have frozen files submitted against them. **`command`** — must
carry a non-empty `command`, which the gate executes and records separately; a
`command` criterion the gate could not run holds the PR as a draft.
**`manual`** — nobody can check it, so the PR is always a draft.

A minimal example:

````markdown
```pi-spec v1
{
  "problem": "work-lean ignores a project's configured test directory",
  "criteria": [
    { "id": "AC1", "text": "a submitted test outside the configured dir is refused", "verify": "test" },
    { "id": "AC2", "text": "the config loader refuses a half-set pair", "verify": "test" }
  ],
  "scope": { "paths": ["extension/src/lean/config.ts"] },
  "size": "S"
}
```
````

Failures name themselves — "no pi-spec v1 block", "2 pi-spec v1 blocks",
"pi-spec v1 block is empty", "…is not valid JSON", "spec.size must be one of
S, M, L" are distinct reasons, and they are the rules `decline` posts.

**`/plan` writes it on the filing path.** The driver assembles the body once
(`assembleFinalBody` in `plan-driver-final-body.ts`, which calls
`plan-pi-spec.ts`), and that assembled body is the one the driver files — the
block is not injected any other way. `plan-pi-spec.ts` maps the
drafted spec onto the contract, bounds every field it emits (the `problem` line is
`descriptorProblem(body) || title` — the body's `Descriptor:` line, or the filed title when the
body states none — passed through `oneLine`, then `neutraliseFenceRuns`, then
`clip(…, PI_SPEC_PROBLEM_MAX_CHARS)`; at most 12 criteria, all `verify: "test"`, no
`scope`), and **never files a criterion
cut**: ANY acceptance-criterion bullet longer than 200 characters — including the
ones past the 12 the block embeds — makes the whole block omit, with a plain
`pi-spec block omitted:` line in the body naming every over-long criterion and its
length — the issue then reads as not ready rather than as a
contract nobody wrote. It places the section at the
**top** of the body (so an unclosed fence in prose below cannot swallow it), and
reads the block back through the real parser before filing. Any `pi-spec v1`
fence already in the drafted prose is renamed to `pi-spec-example v1`, so a
quoted example can never become the contract.

## Configuration

Full field-by-field reference — including every `verify.*` rule, the
`.pi/verify-cmd` fallback, and what each refusal says:
[configuration.md](configuration.md) → the `.pi/work.json` row. Headless flags
and exit codes: [headless.md](headless.md). What follows is the shape of it.

`.pi/work.json` is read with `git show <baseSha>:.pi/work.json` — never from
the working tree — so a run is not judged by bytes it wrote itself. **Absent
means defaults.** An invalid file is *not* defaulted: it raises
`LeanConfigError`, because a typo'd budget must not silently become "no budget".

```json
{
  "version": 1,
  "autoMerge": false,
  "verify": {
    "fast": "cd extension && bun run check",
    "full": "cd extension && bun test",
    "test": "bun run {file}",
    "testDir": "extension/smoke-tests",
    "testGlob": "test-*.ts"
  },
  "budgets": { "build": { "turns": 100, "tokens": 5000000, "minutes": 10 } }
}
```

- **`version`** — must be exactly `1`; anything else, including absent, is
  invalid.
- **`verify.fast` / `verify.full`** — shell strings run with `cwd` at the
  worktree root, fast before full — the first red tier ends the loop, and it is
  reported beside a red frozen contract rather than behind it, each under its own
  30-minute bound. A committed `.pi/verify-cmd` is the fallback for the full
  tier **only when `work.json` is absent**.
- **`verify.test`** — the per-file runner template `specify` uses to prove a
  test red on the base: argv form, never a shell, exactly one whole-word
  `{file}`. The same template answers the runner preflight before the adversary
  is dispatched (see the `specify` row above), so a runner that cannot collect a
  test at all hands the run back at exit 10 rather than declining the issue — and
  every `specify` pays one extra runner invocation for that answer, bounded at
  120 s. `PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT=0` restores v0.14.71, where neither is
  paid. A project that configures no `verify.test` keeps its ordinary
  `no test runner configured` verdict, not that hand-back.
  The template is read by **four** steps, not one, and each answers a different
  question: `specify` proves a submitted file red with it, `challenge` hands it to
  its own adversary, `verify` runs the frozen tests through it and then the spec's
  `command` criteria, and `build` re-runs a child's "these tests cannot all pass
  together" report with it — a missing template there is only traced, and the
  report is ignored. Only `specify` and `challenge` refuse on its absence —
  `specify` declines a spec with `test` criteria with `no test runner configured
  (.pi/work.json verify.test)`, a verdict and not a hand-back, and `challenge`
  throws the same words as infrastructure. A spec whose criteria are
  all `command` (or all `manual`) reaches neither refusal — `ready` never asks for a
  template, and `specify` dispatches its adversary without one. It still cannot get
  far: the `command` tier throws `no verify.test runner template is configured for
  the spec's command criteria` and the run hands back, so a project with no test
  runner points the template at the file itself — `"verify": { "test":
  "sh {file}" }` — which satisfies every one of those reads without a runner.
  Two caveats travel with that choice. A `command` criterion is run through the
  template in **argv form**, and `command` is itself accepted only as a plain
  repo-relative file path: anything else (a command line, a metacharacter, a path
  outside the normalised repo-relative form, a file that changed since the base) is
  recorded as *not runnable* — never red, never passed — and `publish` keeps the PR
  a draft. And `sh {file}` executes the file, so a criterion's file must be a
  script `sh` can run and must exit **0** to count as held.
- **`verify.testDir` / `verify.testGlob`** — a pair or neither: where the
  adversary's acceptance tests live and what they are called, so the frozen
  tests land where your own CI runs them.
- **`verify.freezeCheck`** — optional shell string, run with `cwd` at the
  worktree root. A project check over test-file **content** (a style lint, a
  forbidden-spelling grep) that a build round can no longer satisfy once a file
  is frozen — `build` may not edit a frozen file, so a candidate that trips it
  makes the run unwinnable. `specify` and `challenge` run it over a candidate
  batch before committing the freeze and drop what it names; `verify` runs it
  when a project tier is red and hands the run back, unbilled, when its output
  names a frozen file that the same check passes without. Absent, nothing runs.
  It is never a verdict on the work: a check that was red at the base, or that
  could not be run at all, blocks nothing.
- **`autoMerge`** — boolean, default `false`. **The merge grant**: `land` reads
  it at the run's base sha and refuses the merge without it. An unreadable
  config refuses too, naming the read rather than pretending the project declined.
- **`budgets`** — per state, each `{turns, tokens, minutes}`, non-negative
  integers (`0` is unbounded for turns and tokens, never for minutes), merged
  **over** the shipped defaults, so naming `build` alone keeps the defaults for
  the others. A state name with no default row is **refused** — a typo'd key is
  a ceiling nobody reads.

**Shipped defaults** (`DEFAULT_BUDGETS` in `extension/src/lean/config.ts` — the
jsdoc there carries the measurements they were sized from; `test-lean-config.ts`
pins the table against literals, so changing a number is a deliberate edit):

| State | turns | tokens | minutes |
|---|---|---|---|
| `specify` | 400 | 60M | 20 |
| `build` | 400 | 60M | 45 |
| `challenge` | 400 | 60M | 15 |
| `review` | 400 | 60M | 30 |
| `ci` | 0 | 0 | 30 |

**When a budget fires.** `turns` and `tokens` abort at once at a turn boundary.
`minutes` arms the child bound (`spawn-child-bound.ts`): a **wrap-up steer at the
bound**, then a kill at **bound + grace (`PI_ENSEMBLE_CHILD_BOUND_GRACE_MS`,
10 min)**. Every lever bounds ONE CHILD, not a step's whole spend. For
`specify`, `build` and `challenge` a breach is a **verdict** the table routes:
the step returns `{kind: "budget"}` with `limit`, `value` and `used`, a
a `specify` breach ends the run (`handback`, **10**); a **`build`** breach is work a
round already paid for on entering `build`, so leaving it bills nothing, and the child
is retried in-step **while dispatched rounds remain** (`MAX_BUILD_ATTEMPTS` — which is
why a stopped child can buy a third child where an older table billed it twice) — the
stopped child's work is folded into that attempt's commit first, so
the retry starts from it and its prompt names what the driver re-ran still red —
and only the attempt the cap ends hands back; a **`challenge`** breach
**continues to `verify`** like a round that added no tests — optional
strengthening, and a non-converged round says nothing about what `verify` still
checks. **`review` is the exception**: it has no `budget` kind, so
a stopped review child THROWS `ReviewInfraError` whose message is the shared
`budgetSentence(state, fired)` and whose rows are the children the step bought;
the run hands back (**10**) with that sentence as its cause, on the step record
and in the host's `failure.message` alike. A review step therefore never carries
the `limit`/`value`/`used` trio — the prose is its channel. `PI_ENSEMBLE_DISPATCH_CAPS=0`
makes the wall clock inert, and the step says so.

**The review step's own clock.** Every lever above bounds ONE CHILD; the `review`
step also bounds ITSELF, because it buys two adversarial passes, twelve lens
children and one fixer serially and each child can sit inside its own bound while
the step runs for hours. Two numbers, both visible in the step log (an ungated
`traceWarn` at the stop) and in the host's document as `issues[].reviewBound`:

| Number | Where it comes from |
|---|---|
| the step bound | `budgets.review.minutes` — the SAME row the children are armed from. No separate knob. |
| the deadline reserve | `PI_ENSEMBLE_HANDOFF_TIMEOUT_MS` (the handoff allowance) **+ `REVIEW_DEADLINE_RESERVE_MS` = 15 min** held for publish, ci and land. |

The step asks its clock **before each dispatch**, and once more **before the single retry of an
incomplete re-review** — the reading taken before the fixer ran is not live by then: spent, it
dispatches no further reviewer or fixer. What happens next depends on what had been reviewed — a stop
before the first six-lens round completes **hands back** (nothing has been
reviewed); a stop after a complete, unblocked first round **proceeds** to `ci`;
a stop after the fixer pushed routes **`fixed`**, back through `verify`, because
origin holds a head the gate has not re-read. The step records
`outcome.reviewBound` — `{ wave: "full" | "fix", unreviewedLanes, reason }` — and, on the
forge channel, posts **one PR comment** listing the lanes it never judged (a lane list,
plus `adversarial re-review` where that pass never ran): `publish` runs *before*
`review`, so the PR body cannot carry it. On `PI_ENSEMBLE_HANDOFF_CHANNEL=host` nothing is
posted — the host owns every post, as it does for the two reporting steps — and the record
and the warn line carry the stop. `reviewDone` is set whatever the answer,
so a head whose only unjudged lanes are re-review lanes proceeds — disclosed —
since every lane was judged once in the first pass. A stop whose per-child cause
is already on the record keeps that cause line; the step-total stop is disclosed
beside it, never instead of it. Under `PI_ENSEMBLE_DISPATCH_CAPS=0` the step clock
is **inert** and carries the same "budget is inert" warning the child lever prints
— a bound the runtime has disabled is never reported as one that held.

**Bounds on a frozen test.** A kept acceptance test must be new at the base
commit, at most **150 lines** (`MAX_TEST_LINES`), at most **24 KiB**
(`MAX_TEST_BYTES`), and at most **2 per criterion** across the whole run
(`MAX_TEST_FILES_PER_CRITERION`, seeded from what earlier rounds froze so a
second round cannot double it). Two call-cost bounds sit beside them: one
`submit_tests` row names at most 8 files, one call gets at most 32 distinct
paths probed against the base, and a test the run already froze may never be
resubmitted — the adversary cannot replace the contract the builder is measured
against.

## Running it

**Interactive.** `/work-lean <issue>` — one positional issue number, nothing
else (the `--timeout` flag is the headless verb's; the interactive command takes
the deadline from the environment, exactly as the headless one does). It seeds the
run with the mainline sha, drives it to a terminal state and notifies one summary
line: `work-lean #<issue>: handed-back (exit 10) — <reason>`.

**Headless.** `pi-rukas-headless work-lean <issue> [--timeout <minutes>] [--json]`
— exactly one positional issue number; `--json` is accepted and changes nothing,
as with every other subcommand. Stderr carries only NDJSON v1 log lines; stdout
carries exactly one JSON document. The run's own code is the exit code; the verb
adds no policy of its own.

**The caller's clock.** `--timeout <minutes>`, or `PI_ENSEMBLE_CYCLE_DEADLINE` /
`PI_ENSEMBLE_CYCLE_BUDGET_MS` exported by the host, arms the same whole-cycle
deadline `work` reads — one reader, so the two engines cannot disagree about what
one environment means (`features.leanDeadline`). Step work ends at
`deadline − PI_ENSEMBLE_HANDOFF_TIMEOUT_MS`: the run starts no new step after
that and ends `handed-back` at 10 with its document, the way `work` parks. The
resolved absolute deadline is persisted on the run's state record (`deadlineMs`)
at the first boundary that resolves it, so a resume keeps the clock its first
round started and a host can tell a deadline stop from any other handback. A
step already running is bounded by its own budget (`WorkConfig.budgets`) alone:
unlike `work`, lean opens no cycle clock, so the deadline decides only when a step
may START and never shortens a child that is already up. The `review` step is the
one step that consults the deadline from *inside* itself, stopping when the time
left falls inside the handoff allowance plus `REVIEW_DEADLINE_RESERVE_MS` (see
"The review step's own clock" above). Size the step budgets
under the caller's kill, and pass the deadline so the run reports before it.

**Who delivers the report.** On `PI_ENSEMBLE_HANDOFF_CHANNEL=host`
(`features.leanHandoffHost`) neither reporting step posts to the forge: `handback`
and `decline` still run and still leave their text on the step log, and the
result publishes it as `issues[].handoff.body` with `handoff.channel: "host"` and
`handoff.labelSkipped: "host-channel"` (`labelApplied` stays `false` — lean has no
label step). On the default `forge` channel both post, as before, and a post the
forge refused is reported by the contract's own pair (`handoff.bodyError:
"not-recorded"`, no body), which is how a host tells "the forge took nothing" from
"the host owns this".

**Why it stopped.** `failure.kind` is `timeout` for a step that blew its own
budget, `verify` for a red gate, `crashed` for a handler that threw and `process`
for exhaustion or a forge refusal. `failure.cause` (`features.leanFailureCause`)
is added only where the run recorded a kill it can attribute — a `minutes` ceiling
whose child row reported `ok: false` — and it comes from the same classifier
`work` uses (`self-killed:child-bound`). A `turns` or `tokens` ceiling stops a
child at a turn boundary and is not a kill, so it gets no cause: `failure.message`
already names the lever, and a cause the run never observed would send a host's
retry ladder off a fact nobody recorded.

With `features.workLeanResultSchema` in `--capabilities` (value `5`) that
document is the **schema-5 result** — `schemaVersion` and `issues[]` with one
entry, in the same field names `work` uses (`status`, `cap`, `failedStep`,
`failure`, `branch`, `prUrl`, `usage`), so a host comparing the two engines
reads one document. The one field `work` never writes is **`prState`**:

| `prState` | When |
|---|---|
| `ready` | publish recorded `draft: false` AND the newest DECIDED `verify` is `green` with `verifiedHead` **equal** to publish's `publishedHead`, AND no DECIDED `ci` has gone against it. A run with **no `ci` step** is unjudged by the pipeline, not refused — a `ci` that ran blocks `ready` only when its newest step was not green |
| `draft` | publish recorded `draft: true`, or any half of the `ready` evidence is missing |
| `none` | no decided `publish` step left a PR URL |

Both sides of that rule are typed records (`Outcome.publishedHead` is the full
40-hex head the step pushed; `verifiedHead` is the green's subject) and neither
is read out of prose. The rule is publish's own — it will not push at all over a
green about a different commit — restated as a report. `ready` is also the only
thing that earns the `awaiting-human-merge` cap, so **`awaiting-human-merge`
means `ready`**; a draft, or a PR over a gate that did not clear its head, gets
no cap and rides `failure` alone. A build without the feature writes lean's own
pre-#1920 document (`state`, `summary`, `steps`, `prUrl`) and has no `prState`:
refuse the image rather than guess.

**Exit codes** (`EXIT_CODES` in `machine.ts`, plus the two the verb adds):

| Code | Meaning |
|---|---|
| 0 | `landed` |
| 10 | `handed-back` |
| 11 | `not-ready` — the issue's spec was refused |
| 30 | the run threw, with `error.code: "crash"` |
| 40 | bad arguments, or a live run already holds this issue's lock (`error.code: "refused"`) |

30 and 40 come from the headless runner's `EXIT` table, not from the machine;
`0`/`10`/`11` are the machine's and are re-validated against it, so a run that
reported `{code: 99, state: "landed"}` is a crash rather than a document.

**Resume.** The state file *is* the resume. `runLean` loads it, folds the
append-only step log through the table, and refuses a file whose snapshot the
fold cannot reproduce. A step recorded **without** an outcome is a crash mid-step
and is the only thing re-run — so a crash never double-bills a build or re-posts
a comment. A run carrying a terminal `result` returns verbatim provided the stamp
agrees with the log (terminal state, matching code, and a `landed` whose land
gate actually holds); a stamp the log did not earn is a `LeanStateError`.

**Lock.** `<repoRoot>/.pi/lean-state/<issue>.lock`, taken atomically with its
owner identity (`<host> <pidns> <pid> <starttime>`) written inside it. Only a
holder this process can **prove dead** is reclaimed; a live, foreign,
unjudgeable or unreadable owner all refuse rather than risk driving one issue
twice. A refusal is `LeanLockError`, which is what the
headless verb maps to exit 40.

## What you get back

**A PR** — and today a PR plus a handback comment is the normal outcome, since
nothing past `publish` is built. The body (`publish-body.ts`) is the run's own
claim about itself, generated from the step log: one row per acceptance
criterion with the frozen test that answers for it and the verdict the gate
recorded for it — `green`, `red`, `not run`, `passed (command; …)`, or
`manual — needs a human`. It also carries the gate's reason verbatim (fenced),
the base sha, the version stamp, and the `role = model` pairs the run dispatched
with, plus one line when the challenge round hit its own budget (`challenge
stopped at its minutes budget (15); no extra tests were added`). A run whose head
is not green, or whose spec has a `manual` criterion or an unrunnable `command`
criterion, opens the PR as a **draft**.

**A state file** at `.pi/lean-state/<issue>.json`, written atomically
(tmp + rename). It is WAL-shaped: `steps` is the append-only log (one entry per
visit, keyed `<issue>:<state>:<n>`, outcome stamped in when the step settles)
and `state`/`counters` are a cache that `resume.ts` re-derives rather than
trusts. Read it when you want to know what a run actually decided.

**The verified handback.** A `review` step whose fix wave pushed is the one edge in
the table that puts bytes on origin's branch that no gate has certified: the run is
then routed back through `verify`, and if anything stops it before that step runs —
the between-steps deadline, the step cap, a handler that threw, a table edge — origin
is left holding a head the shipped record cannot vouch for. The handback answers that
from the LOG, not from the stop cause: when its newest work step is `review` with kind
`fixed` and no later decided `verify` exists, it first keeps the unverified head
reachable under `refs/lean/unverified/<issue>`, then rewinds origin's branch to the
newest decided green `verify`'s head with a lease-pinned atomic push
(`--atomic --force-with-lease=<branch>:<held>` on an UNFORCED branch refspec), where `<held>` is
the head this step read off origin — so the lease guards the window between that read and
the push, and a branch that moved inside it is refused. `--atomic` is what makes the refusal
move nothing: without it git applies each ref on its own, so a refusal of the leased branch
still wrote the unleased keeping-ref. With it, a lease refusal moves neither ref. A branch that had already moved
before the step read it is read at its new value, so the lease matches and the rewind
runs, keeping the head it displaced under `refs/lean/unverified/<issue>`. The refspec
being unforced is what makes that true: `git push` does not consult the lease for a
refspec carrying a leading `+`, so a forced rewind force-updates a branch somebody else
moved whatever the lease says. A rewind is a non-fast-forward move by definition, and the
lease names the value this step just read off origin, so the lease alone authorises exactly
that move — which `test-lean-rewind-lease-binds.ts` pins three ways: a read-then-move race
refused by the lease, a moved branch refused by the transport, and a satisfied lease landing.
Before any arm may call a head
verified the step asks git that the green's `verifiedHead` is a commit OBJECT this clone
holds — shape is not existence, and that value arrives from a child's verdict through the
on-disk state file — so a record cannot certify bytes nobody can resolve. The step's outcome
then names the
facts: `shippedHead`, `shippedVerified`, and when they differ, `unshippedHead` with
`unshippedReason`. When the push is refused — by the lease, or by git failing for any
other reason before it reached the lease — nothing is moved, and the record names the
head origin holds with git's own reason beside it, so an operator can tell "someone
moved my branch" from "the clone could not read that commit". Where origin already
holds the certified head the step pushed nothing, and the record says so without
calling the shipped head unverified. Every other handback is unchanged. Behind
`PI_ENSEMBLE_LEAN_VERIFIED_HANDBACK` (default on; only `0` off), which is read at call
time; the unforced refspec and the atomic push are together behind `PI_ENSEMBLE_LEAN_REWIND_LEASE_BINDS`
(default on; only `0` puts the leading `+` back and drops `--atomic`, byte for byte,
restoring the pre-fix push argv exactly).

### The publishable-branch guard, and the mainline it refuses against

All three sites that force-push the run's branch — `publish`, the review step's fix
push, and the rewind above — ask one guard first (`assertPublishableBranch`,
`lean/publish-deps.ts`), because the branch they push is state-file data: `main` is
a legal ref name, so legality is not permission. The guard asks its rules in order:
the ref's charset, then the `lean/` prefix, then the mainline — and the pushed
branch must equal the resolved mainline EXACTLY to be refused, so a mainline that
spells `trunk`, a fork's default, or `lean/trunk` is caught by name rather than by
prefix.

The third rule is fail-CLOSED. The guard first reads the mainline locally (`origin/HEAD`,
then `gh repo view`); when neither answers it asks origin directly with `git
ls-remote --symref origin HEAD`, over the transport the push itself uses, and refuses
with the causes each probe gave when that fails too. A clone that can push can answer
that probe, so the arm that refuses is a clone that could not have pushed — and `gh`
is not required on any arm. The guard runs on the publish, review and rewind paths
alike, so one unreadable mainline no longer skips the check at the two sites that
inherited it from the third. Behind `PI_ENSEMBLE_LEAN_GUARD_FAIL_CLOSED` (default on;
only `0` off, read at call time), whose off arm restores the guard that passed a lean
branch whose mainline it could not read — the fail-open #2255 is the fix for.
Pinned by `test-lean-publish-guard-fail-closed.ts` (guard, both arms, and the
production wiring) and `test-lean-guard-fail-closed-switch.ts`.

**A handback comment** on the issue, in this order of usefulness: the newest
budget breach **that no step other than a report (`handback`, `decline`) is newer than** — a `challenge` breach the
table carried past to `verify` is not why the run ended, so a later red owns the
line — else the newest red `verify` reason, else the newest red `ci`, else the
newest green verdict, else the last error; then the frozen tests (max 20),
`Branch:` and `PR:` (or "no PR yet"). A comment that could not be posted is
recorded; it never changes the verdict.

## Limits today

- **`review` is a gate, not a grant.** It runs both gates against a commit read
  from origin and can only pass (`done`, or `fixed` after a round that pushed) or
  throw. A pass still has to clear `ci` and the `land` grant to merge — a cleared
  review is not by itself a mergeable run, and a run that never earns the merge
  leaves the PR and a handback.
- **`land` takes the merge grant from `.pi/work.json`, not from `AGENTS.md`.**
  `/work` resolves its merge authority from the project's doctrine at the cycle's
  base sha plus executed forge evidence (#380 / #407); lean's `land` asks the
  forge for its evidence but reads the grant from the config alone.
- **The old `/work` driver is a separate program.** `extension/src/work-driver.ts`
  with state at `.pi/work-state/<issue>.json`; lean is
  `extension/src/lean/` with state at `.pi/lean-state/<issue>.json`. Neither
  reads the other, and lean has no grouping, no explore, no plan step and no
  merge-authority gate.
