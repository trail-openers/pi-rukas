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
| `ready` | driver | Proves the run's base is a commit, then judges the **repository's setup** there before the issue is read or any model is called: `.pi/work.json` present and loadable **at that sha**, `verify.test` set, and a roster that can get a report. A setup fault is the `setup` outcome: the run ends `handed-back` (exit 10) with no reporting step, so nothing is posted on the issue, and the headless result carries `failure.kind: "setup"` ([headless.md → The `failure` object](headless.md#the-failure-object)). Then it fetches the issue, parses its `pi-spec v1` block and judges readiness; a failure there, or a base that is not a commit, is a `fail` outcome. |
| `specify` | adversary (a `developer` child) | Writes the acceptance tests and submits them. Before the adversary is dispatched, the step asks the project's runner one question with an empty probe file (removed again on every path): exit **0 or 5** is healthy; anything else — a runner that dies before collection, a hang, a runner that never started — is an **infrastructure hand-back** naming the command, not a verdict, and costs no dispatch. **The probe's name depends on the language it has to be readable in.** For every family but Python it is the hidden `.lean-runner-probe.test`, written outside the configured `verify.testDir` (at the worktree root when no test folder is configured or its parent is not on the tree) — hidden, so no `verify.testGlob` can mistake it for an acceptance test. For a project whose `verify.testGlob` names `.py` files it is a visible, dot-free `_lean_runner_probe.py` **inside** `verify.testDir`: a leading dot breaks pytest's default prepend import mode, so a hidden file is refused before the runner can report anything, and a Python probe has to be importable to prove the runner can run one. That name is checked against the project's own `testGlob` with the boundary's matcher, so a config that would collect the probe as a test is refused. **Exit 4 on the probe is read apart from the other failures**: it is the runner refusing the file it was handed, so the step records `the runner rejected the probe file (exit 4): <rendered command>` on the step's reason and dispatches the adversary anyway — the bench answered, and the thing that was refused is this step's own filename. **The probe's parent is containment-checked**: `realpath` must place it inside `realpath(worktree)`, or the probe goes to the root instead. The probe's name, its exit-4 reading and the containment check are governed by two switches — `PI_ENSEMBLE_LEAN_PREFLIGHT_PROBE_CONTAIN` for the containment check and, for the whole probe, `PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT` ([configuration.md](configuration.md)). Submodules the base carries are populated after every reset (`clean -fdx` de-populates them), and by default they come from the SUPERPROJECT — its module store under `.git/modules/<path>`, else its populated checkout — with the source computed by the harness and never read from the base's `.gitmodules`, so an offline host is not a reason to hand back; only the first level is seeded, a deeper one is used only where the superproject already holds it, and a submodule this host never had is not fetched but disclosed by path in the step's reason — bounded to eight paths with the rest collapsed to `(+N more)` so a long list cannot push the disclosure off the end of a clipped reason, worded as what the superproject itself holds, and marking separately the case where the state could not be read at all (an unreadable read is a failure disclosed as one, never the clean answer an empty one would be). A submodule the step was ASKED to populate and could not is the same hand-back. Each submitted file is then run against the base commit; a file that passes there is dropped. Freeze a contract with no red test and the step returns `red-test-gap` and the run is **handed back** at exit 10 (`failure.kind: "red-test-gap"`), not refused: the run failed to write a falsifiable test, and a test that passes on the base may equally mean the criterion already holds there, which the handback comment says beside the evidence. Submissions are read from the child's own `submit_tests` calls and from the ones a codemode script made inside them. The reason names which of the two happened: **`the child never submitted a test`** when the adversary ended without calling `submit_tests` at all, or **`criterion <id> has no red test`** when it submitted files that nothing proved red (each dropped file's reason following, e.g. `exited 0 on base`). That clause is the FIRST clause of every rule it appears in, so the handback comment and the step record both lead with the cause. A spec that fails readiness before any child is dispatched stays `no-red-test` and ends the run `not-ready` at exit 11; a project with no `verify.test` never reaches this step, since `ready` refuses it as a setup fault (exit 10). `PI_ENSEMBLE_LEAN_SPECIFY_GAP_HANDBACK=0` makes the child's gap `no-red-test` too, restoring the decline at exit 11 ([configuration.md](configuration.md)). The probe, the submodule initialisation, and which of those two clauses a silent child is reported under are one switch: `PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT=0` restores v0.14.71, where no probe is run, no reset populates a submodule, and a silent child is reported as `criterion <id> has no red test` ([configuration.md](configuration.md)). That switch is the gate: with it at `0` no submodule code runs at all. If the boundary dropped a submitted test, `specify` retries once with the refusal reasons in the adversary's prompt; if the adversary ended without calling `submit_tests` once while the spec has test criteria, it retries once with a fixed note telling it to submit — and that retry still fires on the never-submitted gap. Either way the second attempt is a fresh child, both are billed to the step, and the second attempt's result is final. In the first attempt, a child that called `submit_tests` for some test criteria and never for the others — with no unreadable call and no row the boundary refuses — is first asked once more, on its own session, for exactly the missing ids; the step's reason records the follow-up, and a child that still does not submit them gets the coverage gap (`PI_ENSEMBLE_LEAN_SPECIFY_REASK`, [configuration.md](configuration.md)). Before freezing, the adversary is also asked — prompt text only — for requirements the issue implies but does not state, each grounded in a `path:line` at the base commit that the adversary is asked to cite but no gate verifies, and filed as an extra test case under the criterion it refines; an implied requirement never becomes a criterion of its own. |
| `build` | builder (a `developer` child) | Makes the frozen tests pass. The frozen paths are named individually and marked untouchable. The brief also carries a `## The issue` section — the issue body the step read once for its own spec parse, its `pi-spec` block stripped and the rest fenced — between the problem and the criteria, because the criteria summarise that text and a requirement stated only in prose is otherwise invisible to the one seat that writes the code. The builder's own refusals — its lead, and a body that only restates its `problem` line — are consulted at its own call site, so the two oracle briefs render independently (`lean/issue-prose.ts`). At most 3 build rounds (`MAX_BUILD_ATTEMPTS`, `machine.ts`) — one round per **dispatched** build, billed on entering `build` and never on leaving it, so a red verify, a challenge's new tests and a child stopped by its own budget all draw from the same three. |
| `challenge` | adversary | Tries to break the builder's claim with new tests. Runs at most once. New tests earn one more build round, within the same bound of at most 3 build rounds; none — or a round stopped by its own budget — go to verify. |
| `verify` | driver | The run's own gate, no model in it: clean tree, frozen-test integrity (blobs still hash to their records), a compiler canary, every frozen test, then `verify.fast` / `verify.full`, then the spec's `command` criteria. `green` or `red`.  A tier red at HEAD re-runs once (a flake is excused on a green re-run); still red, it is re-run at the run's base commit in a throwaway checkout, and a base that is not red leaves the tier's own red standing. A base that IS red is excused by ONE rule, stated in full once and applied by both `verify` and `ci`: compare the WHOLE FAILURE LINES of both runs — every line each run printed, trimmed, with that run's own tree root stripped from the front of its path, and grade the tier `green` (the failures recorded as `preexistingFailures` and disclosed in the PR body) **only when every head line is one the base printed, verbatim** — not by colour alone, and over EVERY line the head printed, not merely the lines the classifier reads. Nothing else is folded, normalised or discounted. The refusals beside it: any line past the classifier's own scan window on either side; a tier whose re-run or a base run that observed nothing; a base red shaped like an unprovisioned tree; two trees that are one tree; an empty recognised set on either side; a record the step log's reader would refuse — every one of these keeps the `baseline red:` hand-back; the frozen acceptance tests green is a precondition of grading an excuse at all. What hands back, by design: any head line the base did not print, INCLUDING the ones the classifier cannot read — a bare `killed` or `Exit code: 1`, a jest `●` block, a `# not ok 9` TAP comment, a zero-width character inside a name — so too a PR that adds passing tests to a suite already red at base (its pass-count summary is a head-only line), renumbered TAP/bats output, a moved pass-count or duration line, and a `Command failed: <cmd>` echo that quotes a command other than the one both runs ran. Every one is a hand-back, never a green. Neither arm bills a build round. | **The project's own tests are a fourth thing the step judges** (#2428, #2439, `PI_ENSEMBLE_LEAN_PROJECT_ROSTER`): after the frozen tests and before the tiers, `verify` runs the project's pre-existing suite — every file `verify.testDir` + `verify.testGlob` names at the run's BASE commit **at any depth below it** (#2439: the listing is recursive, because a real project keeps its tests under `tests/unit/` and a package-internal directory, and the record lists at most 200 of them while `fileCount` carries the true number) — matched on the BASENAME and listed with `git ls-tree` so a file the run added is never called pre-existing, through `verify.roster`, or the command DERIVED from `verify.test` by deleting one whole-word `{file}` and appending `--junitxml={report} {dir}` (so `pytest -q {file}` becomes `pytest -q --junitxml={report} {dir}`, never a run against a path literally called `{file}`), read through its JUnit report for the per-test names. It runs once in the worktree, and once in a throwaway checkout of the base **only when the head run failed a test**: a head run the roster accepted with nothing failing has no comparison left for a base suite to make, so the base leg is skipped and the record says so (`baseSkipped`, `baseTotal` 0) rather than showing a base nobody ran. The same argument skips a **configured `verify.full` tier** whose words are exactly the roster's command minus the roster's own two additions (#2620): one accepted green head run of that command already produced the verdict, so the tier loop does not execute it again, the record says `fullSatisfied`, and the green reason leads with `verify.full was not run again — the roster's head run covered it`. The comparison is word-for-word against the roster's own argv, with one allowance (`PI_ENSEMBLE_LEAN_FULL_TIER_OPERAND`, on by default): the report pair the step appended — `--junitxml` over its report, then the tree, whether the flag is its own word or glued to its path — is the only thing the tier may leave out, and in its place the tier may name one directory of that tree — either the path the renderer itself spelled under it, or a single relative segment in the same shape `verify.testDir` admits for a configured test directory — because a project's full tier is its own runner pointed at a directory and the whole-tree run covered it. A bare word unrelated to the tree, an absolute path, a parent segment, `./tests`, a nested path or a trailing slash is a different operand and runs. Wherever that pair is the project's own writing rather than the step's addition, nothing was left out and the tier must be the command verbatim. The tier runs as today on any other difference — quoting, an extra flag, a shell chain, an env prefix — or a red roster head. Recursion is the ROSTER's boundary alone — `verify.testDir`/`verify.testGlob` still refuse a submitted acceptance test that is not directly inside `testDir`. The report is the ONLY source of those names: a bounded output tail carries a summary and elides every per-failure marker, so a roster built from one would report zero tests and read as a pass. The verdicts, in order of precedence: a name the base passed and head fails is a **red naming the test**, and the roster outranks the whole-line baseline excuse above, in `verify`'s tiers and in `ci`'s full tier alike — a line match may not excuse a regression the roster watched happen (the tier's raw failure line is compared with the roster's JUnit label, so this fires only for a runner whose failure line is its label; pytest's, cargo's and go's are not); a name that failed at the base on both sides is **not charged**; a name head fails that the base neither passed nor failed is this run's, because the base cannot vouch for it. Then the **base version of every pre-existing test file the run edited** is re-run against the head code (`git show <base>:<path>` put at the file's own path for its run and the head copy — bytes, mode and mtime — put back after, so the gate's own bytes are never reported as a tier leaving the tree dirty, and a runner that only runs a file where it lives (a cargo wrapper, pytest's conftest) sees the path it knows): a file whose base version is red there is a contract the run changed under its own tests' feet — no build round can make the old expectation pass, so it is not a red: the step records it under `projectRoster.baseVersionRed` (at most 20 files; more is a hand-back) and the run goes on to review. Every review seat — the adversarial reviewer and the lenses, on both passes — also reads the roster's summary off the newest green `verify`: the tests run at head and at the base, the base-failing names and the newly failing ones (at most 50 names each, beside the record's count, which is a floor once a list reaches the record's 200-name cap; a full base list makes the newly failing comparison `not determinable`), or `Project tests: not run` when that verify carries no roster (`lean/review-roster.ts`). Every review seat is told which files need an explicit acceptance; the adversarial reviewer grants one by ending its reply with ONE fenced block whose info string is exactly `lean-test-accept v1`, holding a JSON array of `{"path", "reason"}` — a structured record, never prose — which the step records as `review.accepted`, each entry bound to the head that pass read. Land passes only when the NEWEST decided review accepts every such file on the head the newest green `verify` certified, so an earlier review's grant, or one about bytes a later push replaced, never carries; otherwise the run hands back naming each file (`lean/review-test-accept.ts`). What hands back rather than grading: no `verify.test` and no pair to enumerate or run with, an empty enumeration, a runner that wrote no report, a report naming no test, a run with no exit status, and an edited file whose base version cannot be read — each `VerifyInfraError` at exit 10, none of them a red and none of them a green, because a gate that rests on tests nobody ran is the failure this step exists to refuse. And the land gate reads the RECORD, not the verdict: a newest green `verify` with no `projectRoster`, an empty one, or one whose `baseVersionRed` files the newest review did not accept, does not reach `landed`, and the refusal names the roster rather than saying "verify not green". The lever: [configuration.md](configuration.md); parser, the recursive listing, both runs and the comparison: `extension/src/lean/verify-roster.ts`.
| `review` | both gates, driver-routed | The run's gate. One report-only adversarial pass and one six-lens round at a resolved commit from origin — the full review. Only a blocking verdict from the adversarial gate, or a lens row at the run's resolved review threshold, buys the wave: ONE fixer, given every blocking finding at once, in a disposable worktree of its own, then ONE re-review — the whole branch when pass 1 carried a CRITICAL (a row in either tier, `reported` or the discounted `advisory`), since the layer retires that class on a complete full round only and a delta can never clear it; otherwise a delta over the fix, which answers each blocking row ADDRESSED or NOT ADDRESSED. That upgrade REPLACES the delta round. An `REVIEW_INCOMPLETE` re-review is re-bought ONCE, behind a FRESH read of the step clock (a step already past its bound routes `fixed`, disclosed, rather than throwing); a round-cap or streak verdict is another component's budget and buys nothing. There is no second wave. Both gates clean passes, on one of two kinds: `done` when no fix wave ran, which goes to `ci`, or `fixed` when the wave integrated and pushed commits, which goes back through `verify` — the green `ci` demands has to be about the head the PR stands on. Anything else throws and the run hands back, with a named cause: a blocking finding the wave did not address, a CRITICAL the fix introduced, a fix that changed nothing, a round that ran no lens, a gate with no verdict, a re-review that did not range over the fix, a fixer that rewrote the frozen contract, a child its budget stopped. **What the review children see:** all three seats — the six lenses, the adversarial reviewer and the fixer — read the issue's prose with its `pi-spec v1` block stripped and bounded like any other issue block, and the spec's acceptance criteria as their **own section, printed in full**, so a long statement can no longer cut the criteria (or the statement's own tail) by competing with the block for one bound; that section opens with the spec's **`problem`**, printed in full under its own cap beside the list under its own, each saying which of the two was cut (`…(problem truncated)` / `…(criteria truncated)`), so a statement past the prose bound still reaches every seat. A spec that parses with no criteria renders no section at all — the statement is gated on at least one row beside it, so the seat keeps today's raw bounded fallback — and on a real run that shape cannot arrive: `readiness()` (`lean/spec.ts`) refuses a spec with no acceptance criteria at the `ready` step, before any review seat is bought. An issue with no parsable block, or with an unterminated fence, gets no criteria section and the prose exactly as before. |
| `ci` | driver | Observes the pipeline: the forge's required-check verdict (`mergeStateStatus` + `gh pr checks`) read at the PR head, and the project's full tier run in the run's worktree — both about the newest decided `verify`'s `verifiedHead`, which the disk is re-read against immediately before the tier. The forge is **polled**, not read once: both reads re-issue every 60 s while any row is still running (`pending`/`queued`/`in_progress`/`waiting`, or a state this step has never seen), because a check that has not finished is not a check that failed and grading one red spends a build round on code that is not broken. `green` needs `mergeStateStatus` `CLEAN` with every row passing; `red` names the rows that actually failed or came in `skipped`/`neutral`, or reports a PR that is not `OPEN`, no rows at all, or a head that moved off the verified one — the head is re-read on every poll and the poll that sees the move settles the step. The wait is bounded by `budgets.ci.minutes` (the tier keeps its own separate bound of the same size afterwards), and a wait that expires — or reaches the run's cycle deadline — **throws** `VerifyInfraError` naming the checks that never finished, so the run hands back instead of taking a build round; a worktree that has moved off that head throws too.  A red full tier is excused by the same LINE rule `verify` applies — every WHOLE FAILURE LINE the shared classifier reads from the head run, trimmed and with its tree root stripped, printed verbatim by the base, from a tier run that observed the work: a killed, un-startable or buffer-overflowed full tier never excuses, it keeps its red. `ci` always re-probes the base in its own throwaway checkout and excuses only on that probe's output; it never replays a `verify` record, and no recorded `baseNames`-style set — not even a byte-identical command from the newest decided verify — buys it a shorter path; the newest verify's project-test roster can only refuse the excuse, for a name it saw passing (the `verify` row above says when that comparison fires). The cost is one extra tier run per red full tier. |
| `land` | driver | The one irreversible act. Refuses unless `.pi/work.json` **at the run's base** grants `autoMerge: true`, the forge's merge evidence is clean, and the PR head equals the verified head; then merges squashed through the adapter, pinned to that head, and reads the result back. `merged` or `refused`; it never throws. |
| `handback` | driver | Ships the last verified head, then posts one issue comment saying what the run still needs and ends the run. |

Three refusals sit beside the main line: `decline` posts the rules an unreadable
or unready spec failed and ends the run `not-ready` (a test `specify`'s own child
could not prove red is a handback, not one of these), a `setup` refusal at `ready`
ends it `handed-back` naming the repository's fault and posting nothing, and any
handler that throws ends the run `handed-back` with `handler error at <state>: …`.

The load-bearing rule: only `ci` + `green` enters `land`, and even then the
engine re-reads its own log — the newest decided `verify` **and** `ci` must both
be green and no `draft` marker may be standing. Green is the only verdict that
clears a draft.

Every child lean dispatches — the `developer` seats (adversary, builder, fixer),
the `code-review-specialist` lenses, and the `adversarial-developer` pass — runs
with no forge login of its own, whether or not the host holds a token: the process
that dispatches the child binds a forge-read broker for every role but `ops`
(`planChildPermissions` → `startForgeBroker`, `spawn-permission.ts`), so on a
token-less host — an offline trial, a `gh` shim on `PATH` — the child still gets
`forge_read` and still reaches its dispatcher, which runs the read with **its own**
`gh`/`glab` and answers with whatever that CLI prints (`runForgeRead` →
`detectForge` → `executeForgeRead`, `forge-read-broker.ts`). A call that exits
non-zero comes back as a refusal naming the reason; one that exits 0 is served as
the read whatever it printed — a shim's canned text or failure message included,
and `ci_run_log` answers empty when no job failed (`forge-ci-log.ts`). What the
child cannot do is call the CLI itself as a credentialed client: the five token
variables are deleted and both config roots point at a per-child empty directory,
or at nothing at all — both roots are deleted rather than inherited — when no such
directory could be made (`stripForgeCredentials`, `child-forge-env.ts`). The strip
also hands the child the harness-owned protected set — the two config roots the
parent resolved, plus both parent homes — in `PI_ENSEMBLE_FORGE_PROTECTED_PATHS`
and `PI_ENSEMBLE_FORGE_PROTECTED_HOMES`; the child judges only what it was given,
so unsetting or re-pointing its own `GH_CONFIG_DIR`/`GLAB_CONFIG_DIR` restores
nothing (`child-forge-read-roots.ts`). Reading those trees is refused a step later
than the env: a mode-independent `tool_call` guard blocks a `bash` command or a
`read` call that names a protected root, whichever spelling it uses — a heredoc
body, an interpreter's program, an option value (`--file=`, `if=`), a `<`
redirect, a `file://` URL, a case-shifted root, an ancestor directory handed to
`tar`/`cp`/`rsync`, or a `~` under a redirected scratch `HOME` — and refuses an
unjudged call rather than guessing (`child-forge-read-guard.ts`,
`child-forge-read-judge.ts`). Its refusal is one exported constant, shared with
the CLI stub so the two cannot drift (`FORGE_READ_RULE`, `forge-read-refusal.ts`).
What the guard is: a guardrail against a child's own bad judgement, not a security
boundary. It reads the command a tool reports, so classes of bypass sit outside it
by construction — a read issued inside a `codemode` script through `node:fs`, a read
by a detached grandchild, a path the child assembles at run time from pieces no
word spells, or a credential the child reaches through a descriptor it already
holds. None of those is a tool call, so no hook sees them. Four more sit inside a
tool call but outside the judge: a relative read taken while the command's own
directory was set by `cd` in an **earlier call** (the judge tracks a directory
change within one command, not across calls), a `ls`/`find`/`du`/`stat`/`tree` or
recursive `grep` of a protected root or its parent (names and structure are
visible, file contents are not, and only `tar`/`cp`/`rsync`/`scp`/`ditto`/`pax` of
an ancestor are refused), a path rooted at `$PWD` or built from another run-time
variable (only `~` and `$HOME` are expanded against the published homes), and a
`~user` form. An exposed token is therefore rotated by the operator, and that is
the remedy, not the last resort.
`PATH` is
left alone, so a child that runs the shim directly gets the shim's own
unauthenticated answer. No `PI_ENSEMBLE_*` switch governs the strip or the broker.
`PI_ENSEMBLE_FORGE=none` turns the forge off for **both** readers of it: the
**driver's** own forge reads (`resolveCycleForge`, `work-driver-forge-ctx.ts`) and
the **child's broker** — `handleLine` asks `forgeEnvIsOff` (`forge-off.ts`) once the
line has proved itself and answers
`the forge is off: PI_ENSEMBLE_FORGE=none`, so the parent runs no `gh`/`glab` and no
`git config --get remote.*` / `git remote` on a helper child's behalf (`handleLine`,
`forge-read-broker.ts`). The socket still binds and the tool still registers, so the
child reads a reason rather than finding no tool; `PI_ENSEMBLE_FORGE_READ_OFF_GUARD=0`
restores the pre-fix broker, where the read goes on to `detectForge` whatever the
environment says ([configuration.md](configuration.md)). The driver's issue read falls
back to raw `gh` in its own process when no forge resolves (`fetchIssueBody` via
`forgeFor`, `lean/io.ts`).

## What an issue needs

The issue body carries **one** fenced block whose info string is exactly
`pi-spec v1`. Its content is JSON, and it is the whole contract: the driver
does not infer scope, criteria or size from prose.

| Field | Type | Notes |
|---|---|---|
| `problem` | string, non-empty | What the run is for. The lean review seats read it as the opening block of their criteria section, so a statement past the prose bound still reaches them ([`review`](#the-steps)). |
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

**A spec that parses but carries no criteria never reaches a review seat.** The
review seats' criteria section — statement and list together — is gated on at
least one rendered criterion, so a parseable `criteria: []` renders no section and
the seat keeps the raw bounded issue block instead. `readiness()` (`lean/spec.ts`)
refuses a spec with "no acceptance criteria" at `ready`, and `ready` is the only
place a run's contract is read, so a run never reaches that seat carrying no
contract. The gate here stays so a future relaxation of that rule cannot silently
hand a reviewer a spec with no criteria in it.

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

## Spec intake

A run's contract normally comes from its issue's `pi-spec v1` block, and an issue
without one is declined. **Spec intake** is the switch that lets a prose ticket in:
`require` (the shipped default, and byte-for-byte the behaviour every run before it
had) declines; `derive` sends the ticket to one bounded read-only child that
returns a block, which the run then validates as though an author had written it.

The mode resolves in one order — **env > `.pi/work.json` `lean.specIntake` >
`require`** — through `resolveSpecIntake` (`lean/spec-intake-switch.ts`). An invalid
value on either side is a **refusal, never the default**: a `PI_ENSEMBLE_LEAN_SPEC_INTAKE=derve`
that quietly fell back to `require` would decline the very tickets the operator set
the knob to take.

What `derive` does **not** relax, because a derived contract has to be worth what
an authored one is worth:

- **The block is still the only contract.** The child replies with one fenced
  `pi-spec v1` block and a **deterministic parser** reads it — a model drafts the
  bullets, it never decides what the contract is. The bullets then go through
  `pi-spec-map.ts`, the same mapper `/plan` files from, so the two producers cannot
  bound, neutralise or size differently.
- **The result is validated on the rendered block.** `parsePiSpec(renderPiSpec(spec))`
  must deep-equal the spec and `readiness()` must pass — the same gate an authored
  block meets, including the `size: "L"` refusal. A brief therefore asks for at most
  **8** criteria, the count at which the mapper still calls the change `M`; a child
  that returns 9 anyway gets the size-`L` refusal with the rendered block quoted, and
  the list is **never silently truncated** to make the gate green. Regression guards
  (below) count toward the 8: criteria plus guards above 8 is size `L`.
- **Two shapes stay `require`'s refusal, in both modes**, because in each the
  issue is genuinely at fault and no model call should be billed for it: a body that
  is blank (a ticket with nothing in it is not prose to derive from), and a block that
  is present but **malformed** — the author took a position on the contract and wrote
  it wrong, and a model quietly writing a better one would hide the defect. A
  non-blank body with no block at all is exactly what `derive` exists for: `require`
  declines it (`no pi-spec v1 block`, headless `failure.kind: "no-spec"`), `derive`
  drafts its contract.
- **A failed derivation is a handback, not a decline.** A dead child, a fired
  budget, an empty reply or an unparsable reply all `handback` naming their own
  cause (`ready`'s `infra` verdict, exit 10) rather than posting "your ticket is not
  ready" on an issue that did nothing wrong — which is also what keeps the run
  retryable.
- **A sentence that only asks existing checks to keep passing is a guard, not a
  criterion.** It is green on the base, so a red test for it cannot exist. Derive sets
  such sentences beside the criteria (`derivedSpec.guards`), `specify` never asks a
  red test of them, and the run's full verify tier enforces them at `ci`. A ticket
  whose every sentence is a guard has nothing to build, so it declines not-ready
  (exit 11) with that reason rather than handing back. Source:
  `lean/derive-guards.ts`.
- **The child is bounded and read-only.** One `explore` child (no write tools), on
  its own `budgets.derive` row, seeing the title and body **fenced as untrusted
  data** and told so: a ticket whose own text says "ignore your instructions" is the
  shape that boundary exists to survive.

**Where the derived contract lives.** `ready` persists it on the run record
(`derivedSpec: {spec, model, at}`, plus `guards` when derive set any aside), and every step reads its contract through
`specFor` (`lean/spec-for.ts`): the body's own block wins whenever it parses, and the
record stands in **only** for the `no pi-spec v1 block` reason. So a step never
re-derives, a resume never pays a second child, and a run cannot read a contract that
changed under it mid-flight. `saveRun` re-validates the field on the way out, and the
loader validates it on the way in (`lean/state-derived-spec.ts`) — a state file
carrying a contract the engine could never have produced is refused at load.

`ready` also records the contract, and the commit it read the config at, on **its own
step** — the same two fields, written by the same save. The step's copy has no
production reader: every later step reads the run's. What it makes true is that the
step log and the run record agree about which contract the run executed, which is what
someone reading the log afterwards is entitled to. Rebuilding it is the loader's job,
and `buildOutcome` — the whitelist every loaded outcome passes through — had clauses for
every other field but these two, so the loader judged the contract, refused a record
whose copy was malformed, and then dropped it. It rebuilds both now, so a loaded ready
outcome always carries the contract and the config sha — what the loader retains no
longer depends on a knob.

**What is published.** When `ready` mints a derivation it posts it to the issue as a
fenced `pi-spec v1` block, naming the model that drafted it and the criteria count —
the author has to see the table before the run spends a build cycle on it, not after
the merge. The run's PR body carries a `spec: derived` line under the criteria table,
read off the record (so a resumed run still says it), which is how a reviewer tells
"this is what the author asked for" from "this is what a model read into the ticket"
— the second is the one worth checking against the issue. On
`PI_ENSEMBLE_HANDOFF_CHANNEL=host` neither is posted: the host owns that channel and
the body travels with the result instead, as with the two reporting steps. A comment
that cannot be posted is traced, not fatal.

**An approved spec.** When the issue's manifest names an approved spec, every step reads
it after the issue body, and with `spec.block: 1` the PR body ends in a `tehas:spec v1`
block with one `met` / `not met` line per requirement; see
[Approved spec for hosts](headless.md#approved-spec-for-hosts).

**Headless.** `pi-rukas-headless work-lean <issue> --spec-intake require|derive`
overrides both the env and the committed field for the one run; an invalid value is
an argument error. It is written to the env as late as the parser allows, because
`process.env` is process-wide and a stale value would arm the next run in the host.

## Configuration

Full field-by-field reference — including every `verify.*` rule, the
`.pi/verify-cmd` fallback, and what each refusal says:
[configuration.md](configuration.md) → the `.pi/work.json` row. Headless flags
and exit codes: [headless.md](headless.md). What follows is the shape of it.

`.pi/work.json` is read with `git show <baseSha>:.pi/work.json` — never from
the working tree — so a run is not judged by bytes it wrote itself. **Absent
is a setup refusal**: the loader still reads it as defaults, but the defaults
name no `verify.test`, so `ready` refuses the run (`failure.kind: "setup"`).
`PI_ENSEMBLE_LEAN_DETECT_VERIFY=1` (default off) detects a pytest or a
`package.json` test-script runner at the base commit for a repository with
neither `.pi/work.json` nor `.pi/verify-cmd`, and so **bypasses the setup
refusal a host may fall back to another driver on**; the loader resolves the
precedence `.pi/work.json`, then `.pi/verify-cmd`, then detection at the base
commit, and `verify` reads `.pi/verify-cmd` at the base too, so a build that
commits one cannot change the command it is judged by. The switch also reaches classic
`/work`'s command-criteria tier ([configuration.md](configuration.md) has the
detected commands).
An invalid file is *not* defaulted: it raises `LeanConfigError`, because a
typo'd budget must not silently become "no budget", and `ready` refuses it the
same way.

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
  "lean": { "protectedPaths": ["angular.json", "package*.json", "theme/"] },
  "budgets": { "build": { "turns": 100, "tokens": 5000000, "minutes": 10 } }
}
```

`bun run {file}` is not pytest, so with the project roster on (the default)
this config also needs a `verify.roster` (below) or
`PI_ENSEMBLE_LEAN_PROJECT_ROSTER=0`, or `ready` refuses the run.

- **`version`** — must be exactly `1`; anything else, including absent, is
  invalid.
- **`verify.fast` / `verify.full`** — shell strings run with `cwd` at the
  worktree root, fast before full — the first red tier ends the loop, and it is
  reported beside a red frozen contract rather than behind it, each under its own
  30-minute bound. A committed `.pi/verify-cmd` is the fallback for the full
  tier **only when `work.json` is absent** — the loader's answer, which a lean
  run never reaches, since `ready` refuses an absent `work.json`; detection
  (`PI_ENSEMBLE_LEAN_DETECT_VERIFY=1`) answers only when both are absent.
- **`verify.test`** — the per-file runner template `specify` uses to prove a
  test red on the base: argv form, never a shell, exactly one whole-word
  `{file}`. The same template answers the runner preflight before the adversary
  is dispatched (see the `specify` row above), so a runner that cannot collect a
  test at all hands the run back at exit 10 rather than declining the issue — and
  every `specify` pays one extra runner invocation for that answer, bounded at
  120 s. The probe it renders into is a hidden dotfile for every language family
  but Python, where the runner has to be able to IMPORT the file: a `.py`
  `testGlob` gets a visible `_lean_runner_probe.py` inside `verify.testDir`, and an
  exit 4 on THAT python probe is disclosed as the runner rejecting the probe rather
  than handed back — on the hidden probe an exit 4 stays the hand-back, because a
  file with no extension really is one the runner was shown and would not run
  (`PI_ENSEMBLE_LEAN_PREFLIGHT_PROBE_CONTAIN=0` puts the old
  path rules back). `PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT=0` restores v0.14.71, where
  neither is paid (its exit-11 decline also needs `PI_ENSEMBLE_LEAN_SPECIFY_GAP_HANDBACK=0`). A project that configures no `verify.test` never gets that
  far: `ready` refuses the run as a setup fault before any step reads the template.
  The template is read by **four** steps, not one, and each answers a different
  question: `specify` proves a submitted file red with it, `challenge` hands it to
  its own adversary, `verify` runs the frozen tests through it and then the spec's
  `command` criteria, and `build` re-runs a child's "these tests cannot all pass
  together" report with it — a missing template there is only traced, and the
  report is ignored. `ready` refuses a run with no template as a setup fault
  before any of the four runs, whatever the spec's criteria — the steps' own
  refusals (`specify`'s `no test runner configured (.pi/work.json verify.test)`,
  `challenge`'s infrastructure throw, the `command` tier's `no verify.test runner
  template is configured for the spec's command criteria`) answer only a record
  that reached them without one. A project with no test runner points the
  template at the file itself — `"verify": { "test": "sh {file}" }` — which
  satisfies every one of those reads without a runner. With the roster on, that
  setup also needs either a `verify.testDir` (or `verify.testDirs`) +
  `verify.testGlob` pair and a `verify.roster` that reports on it, or
  `PI_ENSEMBLE_LEAN_PROJECT_ROSTER=0`: `ready` checks only the `verify.roster`,
  and a roster with no pair to enumerate hands back at every `verify`.
  Two caveats travel with that choice. A `command` criterion is run through the
  template in **argv form**, and `command` is itself accepted only as a plain
  repo-relative file path: anything else (a command line, a metacharacter, a path
  outside the normalised repo-relative form, a file that changed since the base) is
  recorded as *not runnable* — never red, never passed — and `publish` keeps the PR
  a draft. And `sh {file}` executes the file, so a criterion's file must be a
  script `sh` can run and must exit **0** to count as held.
- **`verify.testDir` / `verify.testGlob`** — a pair or neither: where the
  adversary's acceptance tests live and what they are called, so the frozen
  tests land where your own CI runs them. A repo with several test roots (one
  `tests/` per package of a cargo workspace) sets **`verify.testDirs`** — an
  array of directories, each held to `testDir`'s rules — in place of `testDir`;
  setting both is refused. The one `testGlob` names the files in every root: a
  submitted test must sit directly inside one of them, the prompts name them
  all, the project roster lists every root at the base commit, and the runner
  preflight probes once, in (or beside) the first listed root present in the
  worktree.
  A test inside an implementation file (Rust's `#[cfg(test)]` module in
  `src/*.rs`, a doctest) cannot be frozen: a frozen test is a whole file, and
  freezing the file that holds the code would lock the code the build must
  change. Such tests reach a run only through `verify.fast` / `verify.full`.
- **`verify.roster`** — the project roster's report command, argv form like
  `verify.test`: `{dir}` is the tree it runs in, `{report}` the absolute path it
  must write **JUnit XML** to — the report is the only place the roster reads
  test names from. Unset, the command is derived pytest-style from `verify.test`
  (`--junitxml={report} {dir}`), so with the roster on (the default) `ready`
  **refuses a run** whose `verify.test` has no argv word named `pytest` or
  `py.test`: `verify.roster is unset and verify.test is not pytest …`. A set
  `verify.roster` whose `--junitxml` path is absolute or climbs out with `..` is
  refused the same way (`verify.roster writes its report to …`). The rule
  is mechanical, not a guess — a wrapper that forwards to pytest without naming
  it sets `verify.roster` to its own derived form (`scripts/test.sh
  --junitxml={report} {dir}`). Two recipes for runners that are not pytest:
  - **A shell runner** — `"roster": "sh scripts/roster.sh {report}"`, run with
    the tree as its cwd. Names must be the same at head and in the base checkout,
    so they are tree-relative:
    ```sh
    #!/bin/sh
    report=$1
    status=0
    {
      echo '<testsuite name="sh">'
      for t in tests/test-*.sh; do
        if sh "$t" >/dev/null 2>&1; then
          echo "  <testcase name=\"$t\"/>"
        else
          echo "  <testcase name=\"$t\"><failure/></testcase>"
          status=1
        fi
      done
      echo '</testsuite>'
    } > "$report"
    exit $status
    ```
  - **`cargo nextest`** — stable `cargo test` writes no JUnit, nextest does. In
    `.config/nextest.toml`, `[profile.ci.junit]` with `path = "junit.xml"` makes
    `cargo nextest run --profile ci` write `target/nextest/ci/junit.xml` under the
    workspace root; a wrapper copies it to `{report}` and keeps nextest's exit:
    `"roster": "sh scripts/roster-nextest.sh {report}"` with
    ```sh
    #!/bin/sh
    cargo nextest run --profile ci --no-fail-fast
    status=$?
    cp target/nextest/ci/junit.xml "$1" || exit 1
    exit $status
    ```
    A custom `store.dir` or `CARGO_TARGET_DIR` moves that file; the path is
    the operator's to check against their nextest version. The base leg runs in a
    fresh checkout, so it pays a cold build unless the target dir is shared.
- **`lean.protectedPaths`** — an array of repo-relative **gitignore-style globs**
  naming the paths *your* project will not let a child's edit survive. The lean
  folds already revert edits to a fixed built-in list (`.pi/`, `.github/`,
  `agents.json`, `CODEOWNERS`, `.gitmodules`) because those decide what the run is
  judged by; this field adds your own — a framework config, a lockfile, a theme
  directory — and a changed path matching one is **reverted by the reset and named
  in the step's reason** (`reverted: <path>`) exactly as a built-in one is. Read at
  the base commit like every other field, so a child cannot widen what protects it
  by editing the file.
  **The matcher** (`extension/src/lean/protected-globs.ts`, and the table test that
  reads each row off `git check-ignore`): `*` spans characters *within* one segment
  and may span none, so `package*.json` names `package.json`; `?` spans exactly one
  non-separator character; `**` spans zero or more *whole* segments, so `a/**/b`
  names `a/b` and `a/x/y/b`; an entry with no `/` is a basename matching at any depth,
  so `angular.json` also names `src/angular.json`; a trailing `/` means that
  directory *and everything under it*, so `theme/` names every file beneath it and
  never a file called `theme`. Matching is case-sensitive, as the built-in rule is.
  **Validity** — an entry is refused at load with `LeanConfigError`, which quotes
  it: absolute, a `..` or `.` segment, empty or whitespace-padded, a backslash, a
  leading `!`, a doubled slash, or any shell metacharacter or invisible / control /
  zero-width / bidi character — the invisible class is `\p{Cf}` (the format
  characters, TAGS block included) plus the controls, NEL and the line/paragraph
  separators. A pattern is a rule, not a document, so four counts are
  capped too: 256 characters, two `**` segments, four `*`/`?` wildcards in one
  segment, and **four wildcards in total** across all segments (each `**` counting
  one) — the matcher is a compiled regex whose cost grows like the depth of a
  path that does *not* match to the power of its `**` count AND like that path's
  length to the power of its total wildcard count, so past those the cost
  of a non-match is chosen by a project's own config file. Every rule a project
  actually writes sits at three wildcards or under. **A `*`/`?` beside a `**` segment with only
  literals between them is refused by shape, whatever its counts** — that wildcard is
  retried at every offset the neighbouring `**` can absorb, so its cost carries a
  length term on top of the depth term, and the counts cannot see position: entries at every ceiling
  cost ~2.8 s (ahead of the first `**`) and 0.8–2.7 s (wedged between two of them) on the longest
  legal path. The refusal names the segment; a leading `**` itself is allowed, and so is a
  wildcard after the last one, which is where `src/**/*.vue` and `**/*.lock` put
  them, and a **bare** `*` or `?` as a whole segment is allowed beside a `**` — one `[^/]*` the
  doublestar swallows whole, starting no retry of its own, which is what keeps `**/*/**/dir`
  at ~13 ms where the same rule with `*q*` in that slot costs 800 ms. `dir/**/` is refused as
  the same rule as `dir/**` written twice: the `**` already takes everything under
  `dir` and the trailing `/` then asks for one more segment below that, so the
  refusal points at `dir/**` — the spelling that says what it means. `*`, `?` and `**` are
  otherwise legal, so `verify.testGlob`'s stricter rules deliberately do not carry
  over — this field *is* a glob.
  **An entry that matches nothing is accepted**, not refused: a rule for a file the
  project has not written yet is a rule someone meant. It is *disclosed* rather than
  accepted silently — the build step's reason carries
  `protected paths matched nothing: <entries>` for the **configured** globs that
  named no changed path, because that is the one way a protection can rot without
  anyone noticing. Built-in paths are not on that list: the built-in list is the
  shipped rule rather than one the project wrote, and a built-in path the child
  touched is already named in the `reverted:` clause.
  **The residual, stated plainly:** configured globs take part in lean's `build`
  and review-fix folds *only*. `--allow-protected`, the develop protected-path gate
  and the merge protected-path gate keep the built-in list, so a configured glob is
  not a path those gates refuse — it is a path the folds undo. A project that needs
  one enforced there too still needs its own verify-tier check for it.
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
- **`verify.format`** — optional `{file}` template, run in argv form like
  `verify.test` (same rules: one whole-word `{file}`, no shell metacharacters).
  The project's formatter, e.g. `npx prettier --write {file}`. `specify` and
  `challenge` run it on each submitted test **before** proving it red and
  freezing it, so the bytes proven, committed and later re-hashed are already in
  the project's format — a frozen test can then never fail the project's own
  format check, which `build` could not fix. A non-zero exit whose output names
  the file drops that file, with the formatter's output in the reason. A
  non-zero exit that does not name it (a toolchain proxy that cannot pick a
  version), a formatter that cannot start or times out, or one that writes any
  path it was not handed, hands the run back. Use a per-file formatter that
  touches only the file it is handed: `cargo fmt` rewrites the whole crate, and
  `rustfmt <path>` follows the file's out-of-line `mod x;` declarations, failing
  on a module the test declares but nobody wrote. For Rust, point the template
  at a small script that feeds the file to `rustfmt --edition 2021 --emit stdout`
  on stdin and writes the result back. Absent, nothing runs.
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
| `derive` | 30 | 2M | 10 |

A `specify` row bounds each child the step dispatches, not the step: with `PI_ENSEMBLE_LEAN_SPECIFY_REASK` on, one step can pay the adversary, one same-session follow-up for criteria it never submitted, and one fresh retry — up to three times the row in the worst case, which a host sizing a run's budget should count.

`derive` is not a state — it is the spec-intake child's row (see **Spec intake**
below), and it exists so an operator can price and bound a drafting pass without
touching a step's ceiling. The figure is declared in `lean/derive-budget.ts`, the
leaf both `config.ts` and `spec-derive.ts` read, so the ceiling and the code that
arms the child with it cannot drift.

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

**The two steps before the first verify share a wall.** `specify` and `challenge`
are each bounded per CHILD and were never bounded together, so a cell could spend
half its budget on the pair and still be asked to open `review`, whose reserve
then fired on a head already green and published. `PI_ENSEMBLE_LEAN_PRE_VERIFY_SHARE`
(a whole percent, default **40**) is the share of the cell — the run's resolved
cycle deadline — that the pair may spend. The spend is the sum of every `specify`
and `challenge` entry in the durable step log, counted over **every visit**, so a
resumed run cannot be handed the whole share again.

Like the review clock it is asked **before each dispatch** and is **never a
kill**: a child already running is bounded only by its own per-child ceiling.
Once the share is used `specify` dispatches no further retry (the attempt it
already paid for decides the verdict, and its bytes stand), and challenge is skipped:
its step records `kind: "skipped"` with one stable
`challenge SKIPPED: …` line naming what was not bought and the seconds the pair
used, and the run goes to `verify` with the optional round marked done — no child
dispatched, no worktree reset paid for a round that never touched the tree.
The host sees the verdict as `gates.challenge` = `{kind: "skipped", reason}` and
as one `## Run` line in the PR body.

The round is skipped on a second ground too, measured at `challenge` entry: when
the time the resolved deadline still leaves is at or below the review reserve plus
**one verify** — the floor is the reserve plus one verify, spelled
`handoffAllowanceMs()` plus `REVIEW_DEADLINE_RESERVE_MS` plus a named 20-minute
figure (`ONE_VERIFY_MS`) read only by this rule, so
`verify` gains no `budgets` row and no verify child is ever armed from it. A
round that would eat the reserve or the gate buys nothing anyone can act on.

With **no resolved deadline**, or with `PI_ENSEMBLE_DISPATCH_CAPS=0`, the bound is
**inert** — it stops nothing and says so, the way the review step's clock does;
an absent deadline is never a reason to shrink work. `PI_ENSEMBLE_LEAN_PRE_VERIFY_SHARE=0`
is the only off value and takes the whole change out — the rule short-circuits at `0`
itself, rather than trusting the reader to have said so — so the pair is bounded by its
per-child ceilings alone and no step record gains a key. The review step's own
reserve rule, its two levers and its gates are unchanged. Sources:
`extension/src/lean/pre-verify-share-switch.ts` (the reader),
`extension/src/lean/pre-verify-share.ts` (the wall, the skip, the reason).

**The bound on one model request.** Every ceiling in the table above is read between
turns, so a child whose model request never answers spends no turns and emits no tokens: it
sits inside its own `minutes` bound while the cell's deadline passes under it, and the
deadline is checked only **between** steps — so the harness's outer wall takes the cell, with
no result document and the patch lost. The fourth lever of the same budget arm watches the
child's own progress stream: quiet for the derived window with **no tool call in flight** is
a hung request, and the child is aborted through the same `AbortController` the turns and
tokens levers use. The step ends as the `budget` verdict those levers already produce, with
`limit: `"stall"`, so the step record, the handback cause line and the host's
`issues[].failure` all name it rather than a wall-clock timeout.

| | |
|---|---|
| the window | **derived, never configured**: `PI_ENSEMBLE_HANDOFF_TIMEOUT_MS` + `REVIEW_DEADLINE_RESERVE_MS`, clamped to what the resolved deadline still leaves outside the handoff allowance. |
| not armed | no resolved deadline, `PI_ENSEMBLE_DISPATCH_CAPS=0`, or no room left outside the allowance — where the between-steps stop already decides. Each inert arm says which on the trace; silence is never a pass. |
| never a stall | a tool call in flight: a whole offline suite is one silent `bash` for tens of minutes (#951). |

`PI_ENSEMBLE_LEAN_REQUEST_STALL=0` is the only off value; it returns a hung request to being
bounded by the outer wall alone. Sources: `extension/src/request-stall-policy.ts` (the switch and the window),
`extension/src/lean-step-bound.ts` (the lean reserve, armed by `stepDispatchArms`), `extension/src/lean/step-budget.ts` (the arm and the verdict).

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
`review`, so the PR body cannot carry it. A pushed fix wave posts one more, naming its fix range
(`PI_ENSEMBLE_LEAN_PREFIX_HEAD`). On `PI_ENSEMBLE_HANDOFF_CHANNEL=host` nothing is
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
The bounds assume the harness lives outside the test, so both adversary prompts
name the shared non-test files the test dirs hold at the base (a `common/mod.rs`,
a `conftest.py`, the first 12, shallowest first) and tell the child to reuse them.

## Running it

**Interactive.** `/work-lean <issue>` — one positional issue number, nothing
else (the `--timeout` flag is the headless verb's; the interactive command takes
the deadline from the environment, exactly as the headless one does). It seeds the
run with the mainline sha, drives it to a terminal state and notifies one summary
line: `work-lean #<issue>: handed-back (exit 10) — <reason>`.

**From an agent.** `start_lean_driver` is the tool an orchestrating agent calls to
start the same engine `/work-lean` runs: it takes `issue`, optional `specIntake`
(`require` or `derive`) and optional `timeoutMinutes`, which mean what
`--spec-intake` and `--timeout` mean to the headless verb, and it launches the run
in the background. The outcome arrives in the calling session as one
`[ensemble:async]` steer naming the issue and one of `landed`, `handed-back`,
`not-ready` or `crashed`. `specIntake` applies to that run only and never writes
`PI_ENSEMBLE_LEAN_SPEC_INTAKE`. The run's trust mode is the session's, so it is
gated exactly as `/work-lean` from that session. The tool refuses an issue whose
lock (`.pi/lean-state/<issue>.json.lock`) is held, and says whether the holder is a run
it started or one it did not; for an issue whose state file already records a
finished run it replies with that outcome and starts nothing. It has no merge
parameter: `land` still reads `.pi/work.json` `autoMerge` at the run's base.
Killing the job with `dispatch_kill` lets the step already running finish, then
stops the run at the next step boundary the way the cycle deadline does: it ends
`handed-back` with a reason naming `job killed at <state>`, the reporting steps
still run, the job reads as killed, and the lock is released. A quit mid-step
reaches no boundary: the run resumes from its state file, and the next run takes
the lock over from the dead owner.

**Headless.** `pi-rukas-headless work-lean <issue> [--timeout <minutes>] [--json]`
— exactly one positional issue number; `--json` is accepted and changes nothing,
as with every other subcommand. Stderr carries only NDJSON v1 log lines; stdout
carries exactly one JSON document. The run's own code is the exit code; the verb
adds no policy of its own.

**The caller's clock.** `--timeout <minutes>`, or `PI_ENSEMBLE_CYCLE_DEADLINE` /
`PI_ENSEMBLE_CYCLE_BUDGET_MS` exported by the host, arms the same whole-cycle
deadline `work` reads — one reader, so the two engines cannot disagree about what
one environment means (`features.leanDeadline`). When more than one is set the
ladder is fixed: `PI_ENSEMBLE_CYCLE_DEADLINE` first — it is absolute, and whoever
set it owns the clock — then the `--timeout` flag, then the exported
`PI_ENSEMBLE_CYCLE_BUDGET_MS`. The flag beats the budget because the flag is one
caller's word about THIS run and the budget is the host's default for all of them
(`features.timeoutFlagPrecedence`); `PI_ENSEMBLE_TIMEOUT_FLAG_PRECEDENCE=0` puts
the exported budget back above the flag, which is the order this verb had before
#2362, and logs nothing at all — the switch at `"0"` writes no line for any row. A
value the reader does not honour (a typo, a non-positive budget) is unset rather than
an arm, and the disagreement that does exist costs one `WARN` line naming both values
and which won — printed once, where the run first persists its arm. Step work ends at
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

The **routed report** is the exception to "nothing runs past the line", and the one
step that therefore needs its own wall. When the clock stops a working step whose
newest work entry is a `fixed` review, the run is not stamped where it stands: it is
routed into `handback`, so the comment, the rewind and the head fields actually run.
That report is exempt from the stop test and
is not started through the step machinery, so it is unbounded by both the step
budgets and the clamp — it is bounded instead at `handoffReportBoundMs()`, the
allowance the routing spends **plus a 20 % headroom** (`REPORT_BOUND_HEADROOM_RATIO`),
raced against the reporting handler. The headroom is there because the awaits inside the
reporting step carry their own per-call `git` and forge ceilings and those sum to more than
the allowance: a bound equal to the allowance would cut a report in which nothing hung —
every call answering just inside its own ceiling — and lose the rewind. The headroom rides
on top of whatever you set `PI_ENSEMBLE_HANDOFF_TIMEOUT_MS` to, so raising the allowance
raises the bound with it. The bound is kept inside the child-bound grace
(`PI_ENSEMBLE_CHILD_BOUND_GRACE_MS`), the wrap past the deadline at which the run would be
killed: a bound at or past it would never fire, and every cut would be a kill. When that bound
fires the handler's verdict is dropped, no report entry is written, and the run takes
the plain deadline stamp with the timed-out report named in its reason and warned on
stderr — the record of a cut report is deliberately distinguishable from an ordinary
stop and from a kill.

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
reads one document. The fields `work` never writes are **`prState`**, the
`reviewBound` line and `reviewComplete`:

| `prState` | When |
|---|---|
| `ready` | publish recorded `draft: false` AND the newest DECIDED `verify` is `green` with `verifiedHead` **equal** to publish's `publishedHead`, AND no DECIDED `ci` has gone against it. A run with **no `ci` step** is unjudged by the pipeline, not refused — a `ci` that ran blocks `ready` only when its newest step was not green |
| `draft` | publish recorded `draft: true`, or any half of the `ready` evidence is missing |
| `none` | no decided `publish` step left a PR URL |

Both sides of that rule are typed records (`Outcome.publishedHead` is the full
40-hex head the step pushed; `verifiedHead` is the green's subject) and neither
is read out of prose. The rule is publish's own — it will not push at all over a
green about a different commit — restated as a report. `ready` is the only thing
that earns a handoff cap, and it does not earn it alone:
**`awaiting-human-merge` means `ready` with every review lens judged, on the head the PR now
stands on**, so a `ready` PR whose NEWEST `review` step recorded a stop at its own clock — any
lane list, empty included — or ended by a throw that recorded no verdict at all, or sits BEHIND
a `publish` that ran after it without covering the head the PR stands on (`machine.ts` re-runs
`publish` after the review on TWO routes — a `fixed` review's own `→ verify → publish`
re-attests the head its `integrate` pushed, and a CI-fix round publishes a fixer's newer one
— so the check is head IDENTITY, not position: a returned review whose record names its fix
wave's head is complete only when the newest decided `publish`'s head IS that wave's head,
and a record naming no head of its own push (a plain `done` pushed nothing, or a `fixed`
whose `waves` name nothing usable) must sit ahead of every `publish` attempt, decided or
not), or whose log holds no `review` step at all (the machine
sends `publish` → `review`, so a review the deadline stopped short of dispatching judged
nothing), or — with the project roster on — whose newest green `verify` lists an edited
pre-existing test under `baseVersionRed` that the newest review did not accept on the
verified head, reports
**`review-incomplete`** with `reviewComplete: false` instead (same exit 10, its own
`awaiting-human-merge` cap). `reviewComplete` is `true` only where
the step's own record says the review finished on the head that shipped, and `false` is
never a default: a review that died before pass 1 read no lens, a stop that named no lane is still
a stop, and a log with no `review` step is a review that never ran — none of them report a
finished review. Which reading decides — identity of the record's own wave head (behind a
judged round), or log position for a record that names no head of its own push — is stated
once in `reviewCompleteOf`'s jsdoc (`extension/src/headless/work-lean-pr.ts`). The key is written only beside the two caps above, so a merged run, a draft or
a run that never reached `publish` carries neither cap nor field. A draft, or a PR over
a gate that did not clear its head, gets no cap and rides `failure` alone. A
build without the feature writes lean's own
pre-#1920 document (`state`, `summary`, `steps`, `prUrl`) and has no `prState`:
refuse the image rather than guess.

**Exit codes** (`EXIT_CODES` in `machine.ts`, plus the two the verb adds):

| Code | Meaning |
|---|---|
| 0 | `landed` |
| 10 | `handed-back` — a setup refusal at `ready` included (`failure.kind: "setup"`), and a criterion `specify`'s own child could not prove red (`failure.kind: "red-test-gap"`) |
| 11 | `not-ready` — the issue's spec was refused, before or apart from any specify child's attempt |
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
calling the shipped head unverified. Where the rule fires and the log names no green
head at all, the step records the head origin holds as read after the step, with
`shippedVerified: false` and the rule's own `unshippedReason` — so
a consumer keys on `shippedVerified` and never on `shippedHead` alone. The third state is
where the rule never spoke about a head: `shippedHead`
is absent and `shippedVerified` is absent with it, which is how a record says "this run's
handback was not a rewind" rather than "it was one that found no head". The host's own
reading of the same facts is `issues[].gates.handback.verified`, a `boolean | null` whose
`null` means the projection has no answer (`work-lean-gates.ts`), present only when
`features.leanGates` is reported ([headless.md](headless.md)). Every other handback is
unchanged. The rule ships default-on with no switch of its own; the rewind's push is
unforced and `--atomic`, so the lease is what authorises the move.

### Republishing to the PR the run's own `publish` opened

A red `ci` routes a lean run back through `build` and `verify` into `publish` again —
and there the step finds origin holding the sha its own previous attempt wrote, with
the forge's single unsettled row for the branch being the PR that same attempt created.
The lease check read one of those two facts ("an unsettled row exists") and refused, so
every CI-fix round ended in a handback at exit 10 and a human pushed the commit by hand.

`pushLeaseTarget` (`lean/publish-republish.ts`) now compares three sources before it
calls a row somebody else's: origin's ref for the branch, the `publishedHead` and
`prUrl` the run's newest DECIDED `publish` recorded, and the forge's rows for the
branch. The push goes when all three agree the branch is this run's own — origin still
holds exactly the recorded `publishedHead`; that sha is an ANCESTOR of the head being
pushed, so the move adds commits and rewrites none (`git merge-base --is-ancestor`);
and the forge answers exactly ONE unsettled row whose url is the recorded `prUrl` and
whose `headRefName` is this branch. It is a re-push, not a re-open: the PR is reused and
its body re-attested. The push remains `--force-with-lease=<branch>:<sha read before the
forge was asked>`, so a move in that window is refused by the lease rather than
overwritten.

Each side of the comparison fails closed on its own: a record missing `publishedHead` or
`prUrl`, a forge listing two unsettled rows, a row whose url or head branch is not this
run's, and a head that does not descend from origin's all keep the old refusal. So does
an ancestry read that cannot answer — a `PublishInfraError` naming the branch and what
git said, never a silent "no" and never a silent "yes". **The reading of PR state is not
this rule's**: `isSettled` stays fail-closed, so a row whose state the forge did not
answer is unsettled and blocks the push.

The rule ships default-on with no switch of its own. Pinned by
`test-lean-publish-republish-own-pr.ts`, which drives the exemption and every refusal
beside it against a real origin.

### The publishable-branch guard, and the mainline it refuses against

All three sites that force-push the run's branch — `publish`, the review step's fix
push, and the rewind above — ask one guard first (`assertPublishableBranch`,
`lean/publish-deps.ts`), because the branch they push is state-file data: `main` is
a legal ref name, so legality is not permission. The guard asks its rules in order:
the ref's charset, then the `lean/` prefix, then the mainline — and the pushed
branch must equal the resolved mainline EXACTLY to be refused, so a mainline that
spells `trunk`, a fork's default, or `lean/trunk` is caught by name rather than by
prefix (that last case was already correct before the fix — the probe strips only
`origin/` and the comparison is exact — and is pinned, not claimed as new).

The third rule is fail-CLOSED. The guard first reads the mainline locally (`origin/HEAD`,
then `gh repo view`); when neither answers it asks origin directly with `git
ls-remote --symref origin HEAD`, over the transport the push itself uses, and refuses
with the causes each probe gave when that fails too. A clone that can push can answer
that probe, so the arm that refuses is a clone that could not have pushed — and `gh`
is not required on any arm. The guard runs on the publish, review and rewind paths
alike, so one unreadable mainline no longer skips the check at the two sites that
inherited it from the third. The guard fails closed: when neither the clone nor
origin will name the mainline, the push is refused rather than guessed at — the fail-open
#2255 is the fix for. Pinned by `test-lean-publish-guard-fail-closed.ts`, including the
production wiring.

The guard path itself resolves the forge through no probe: its mainline rules are
`resolveMainline` (`mainline.ts`) and `originHeadBranch`, and the adapter a lean run uses
comes from `resolveCycleForge` with `allowProbe: false` (`lean/io.ts` `forgeFor`), so a
lean run issues no HTTPS probe at all. The probing callers sit outside lean, where
`detectForge` is called with no `allowProbe` — `detectForge(ctx.repoRoot, {})` in
`work-driver-handoff-consolidate.ts` is one — and each then asks a host the known-host
table does not name at `/api/v4/version`, `/` and `/api/v1/version` unless `CI` is truthy
— not `0`, `false` or empty — or `PI_ENSEMBLE_FORGE_PROBE=0` (`shouldProbe`,
`forge-probe.ts`; the switch's own semantics are in [configuration.md](configuration.md)).

What an offline consumer does have to expect on this path is network git, not an HTTPS
probe: when neither `git symbolic-ref` nor `gh repo view` names the mainline, the guard
still runs `git ls-remote --symref origin HEAD` (`originHeadBranch`) before it fails
closed. All three carry the same 30 s `MAINLINE_PROBE_TIMEOUT_MS`, and the network probe
keeps it — the `runNetGit` ceiling that would otherwise apply is 300 s, so the shorter
request wins — which is what makes an unreadable mainline a bounded round of calls and a
refusal rather than a publish step that never answers.

**A handback comment** on the issue, in this order of usefulness: the newest
budget breach **that no step other than a report (`handback`, `decline`) is newer than** — a `challenge` breach the
table carried past to `verify` is not why the run ended, so a later red owns the
line — else the newest red `verify` reason, else the newest red `ci`, else the
newest green verdict, else the last error; then the review fix wave's
`Pre-fix head:` and range when one was recorded, the frozen tests (max 20),
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
