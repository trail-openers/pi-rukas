# Headless runner

`pi-rukas-headless` runs `/work` cycles without an interactive Pi session. It is invoked as:

```
pi-rukas-headless work <issue> [more issues] [--restart] [--timeout <minutes>] [--json]
pi-rukas-headless --capabilities
```

- **`work`** — runs one or more work cycles, writes NDJSON v1 progress to stderr, and exits with a code derived from the state file.
- **`--capabilities`** — prints one versioned JSON object describing what *this* build supports and exits 0. It starts no cycle, reads no project repository, and makes no network call.

A caller (e.g. orchard) calls `--capabilities` once per image build and once before each cycle. An unknown name in the object means "not supported"; the caller fails closed on it.

## The four contracts

The headless runner's contract with its caller is four independent surfaces, each versioned:

| Contract | Version constant | Module | Description |
|---|---|---|---|
| Exit codes | `EXIT` object (`exit-code.ts`) | `extension/src/headless/exit-code.ts` | The process exit code. 7 named values: `merged` (0), `handoff` (10), `clarification` (11), `aborted` (20), `interrupted` (21), `crash` (30), `refused` (40). |
| `--json` result schema | `RESULT_SCHEMA_VERSION` (3) | `extension/src/headless/result.ts` | The JSON document on stdout when `--json` is used. See below. Its `cap` values come from a published vocabulary (`extension/src/headless/caps.ts`). |
| NDJSON progress | `NDJSON_VERSION` (1); stable subset `NDJSON_STABLE_VERSION` (1) | `extension/src/headless/ndjson.ts` | One JSON object per line on stderr. Every line carries `v` (1), `kind`, `at` (ISO-8601). Driver event lines additionally carry `issue` and `key` (idempotency key `<issue>:<index>:<at>`). Only a declared subset of kinds is stable; every other line is marked `unstable: true`. |
| Capabilities | `CAPABILITIES_VERSION` (2) | `extension/src/headless/capabilities.ts` | The JSON object `--capabilities` prints. See below. |

### Exit codes

| Code | Name | Meaning |
|---|---|---|
| 0 | `merged` | Merged, or completed with nothing to merge |
| 10 | `handoff` | Handoff for any cap other than the clarification caps, or awaiting-human-merge |
| 11 | `clarification` | Handoff whose cap is `intent-park` or `explore-needs-clarification` |
| 20 | `aborted` | Aborted |
| 21 | `interrupted` | Interrupted by a signal (SIGINT/SIGTERM) |
| 30 | `crash` | The driver threw, or interrupted by the runner's own `--timeout`, or a cycle left running after the driver returned |
| 40 | `refused` | Refused to start (claimed by a live cycle, `needs-human-attention` without `--restart`, bad arguments, unknown flag) |

A grouped run exits 21 if any issue was interrupted, otherwise the highest per-issue code. The `--json` result carries every issue regardless.

### `--json` result schema (v3)

With `--json`, stdout carries exactly one JSON document:

```json
{
  "schemaVersion": 3,
  "buildCommit": "d39f8731f34d…",
  "buildVersion": "0.12.79",
  "exitCode": 10,
  "issues": [
    {
      "issue": 42,
      "status": "handoff",
      "cap": "verify-failed:develop",
      "failedStep": "develop",
      "branch": "feature/issue-42-foo",
      "prNumber": 99,
      "prUrl": "https://github.com/owner/repo/pull/99",
      "usage": { "input": 812000, "output": 41000, "cacheRead": 2900000, "cacheWrite": 0, "cost": 3.12, "turns": 214, "dispatches": 9 },
      "resumable": false,
      "stateFile": "/path/to/.pi/work-state/42.json",
      "durationMs": 42000,
      "steps": [
        { "step": "explore", "startedAt": "…", "endedAt": "…" },
        { "step": "plan",    "startedAt": "…", "endedAt": "…" }
      ],
      "handoff": {
        "channel": "forge",
        "marker": "<!-- pi-rukas:handoff issue=42 cap=verify-failed:develop -->",
        "body": "<!-- pi-rukas:handoff issue=42 cap=verify-failed:develop -->\n## …",
        "bodyFile": "/path/to/handoff-comment.md",
        "commentUrl": "https://github.com/owner/repo/issues/42#issuecomment-1",
        "labelApplied": true
      },
      "exitCode": 10
    }
  ],
  "resources": { "host": { … }, "budget": { … }, "limits": { … } }
}
```

| Field | Present | Meaning |
|---|---|---|
| `schemaVersion` | always | `RESULT_SCHEMA_VERSION`. Version 2 (#1326) added `schemaVersion`, `buildCommit`, `buildVersion`, `failedStep`, `prUrl`, `usage` and `resumable`. Version 3 (#1327) added `parkReason` and `handoff`. |
| `buildCommit` | always | The full 40-hex commit the running build was made from (the image's baked `.pi/pi-rukas-commit`, else the HEAD of the pi-rukas checkout), or `null` when nothing records it. Never anything else, so a host can safely run `git merge-base --is-ancestor <fix> <buildCommit>` when it is non-null. |
| `buildVersion` | always | The release version of the running build (`extension/package.json`). |
| `issues[].status` | always | `merged`, `handoff`, `aborted`, `interrupted`, `running` (the driver returned without a terminal state) or `not-started`. |
| `issues[].cap` | when a cap was hit | The last cap the cycle hit, from the published vocabulary (below). It can be set on a `merged` result too (a cap the cycle recovered from), so a host reads `status` and `exitCode` for the outcome and `cap` for the reason. |
| `issues[].parkReason` | when `cap` is `intent-park` | Why the cycle parked: `underspecified`, `contradicted-by-code`, `already-implemented`, `too-large`, `premise-unsound` or `security-open-point`. |
| `issues[].handoff` | once the cycle emitted a handoff | `channel` (`forge` or `host`, see [Handoff channel](#handoff-channel)); `marker`, the machine marker that is the first line of the body; `body`, the full handoff markdown, taken from the driver's record of this cycle (never re-read from the file); `bodyError` (`not-recorded`) in place of `body` when the cycle recorded none; `bodyFile`, a path for a person; `commentUrl`, the comment pi-rukas posted (forge channel); `labelApplied`, whether `needs-human-attention` was verified on the issue (and PR). |
| `issues[].failedStep` | when the cycle did not merge and started a step | The step it stopped in: the step a `<template>:<step>` cap names (`verify-failed:`, `verify-timeout:`, `verify-env:`, `verify-baseline-red:`, `pr-not-open:`, `step-failed:`, `driver-crash:`), else the last step started before the cap, else the last step started. It names where the cycle stopped, not necessarily a failure: for `awaiting-human-merge` it is the last step the cycle ran (e.g. `ci`). |
| `issues[].branch`, `prNumber`, `prUrl` | when known | `prUrl` is present only when unambiguous: the PR URL the driver recorded (its handoff comment on the PR), else one built from the project's git remote when there is exactly one remote, the forge is GitHub or GitLab, and the web address is certain (an `http(s)` remote, or ssh to github.com / gitlab.com; GitLab subgroups and explicit https ports are kept). Otherwise only `prNumber` is set. |
| `issues[].usage` | when a state existed | Tokens, cost and turns summed over every dispatch the cycle recorded (`dispatch-completed`, `dispatch-failed` and `dispatch-failed-provider` events), and the dispatch count. It covers the current cycle only: `--restart` discards the state, so earlier cycles' cost is not included. |
| `issues[].resumable` | always | `true` when running `work <issue>` again **without** `--restart` continues this cycle (it was interrupted, or stopped while running). Always `false` on a refusal (exit 40: another live process owns the cycle, so a re-run is refused again until it ends) and when `PI_ENSEMBLE_RESUME=0`. A terminal cycle needs `--restart` for a fresh one. |
| `issues[].stateFile` | always | A path for a person to inspect. Not a host contract: see below. |
| `issues[].questions` | exit 11 only | The clarification questions, numbered `q1`, `q2`, … |
| `issues[].diverged` | on divergence | The in-memory and on-disk states disagreed; the exit code is 30. |
| `resources` | always | The host budget and the parallelism limits the run chose (#1325, added in this release). See [Resource report](#resource-report). |

An optional top-level `error` (`{ code, message }`) is present when the runner detected a divergence (e.g. `state-diverged`) or another runner-level failure.

`resources` (#1325, added in this release; an additive field, so no schema bump) is the host budget and the parallelism limits the run chose — see [Resource report](#resource-report).

### Resource report

The same object appears in the `--json` result and in `--capabilities` (`extension/src/resource-budget.ts`):

```
{
  "host": {
    "cpus": 4, "cpuSource": "cgroup-v2",          // os | cgroup-v2 | cgroup-v1
    "memoryBytes": 8589934592, "memorySource": "cgroup-v2",
    "cgroup": "v2"                                 // v2 | v1 | none
  },
  "budget": { "workstreamSlots": 8, "verifyConcurrency": 2 },
  "limits": {
    "parallelGroups":    { "value": 1, "source": "budget" },  // env | budget | default
    "maxWorkstreams":    { "value": 6, "source": "default" },
    "verifyConcurrency": { "value": 2, "source": "budget" }   // 0 = unbounded
  }
}
```

`host` is what the machine allows: `os.availableParallelism()` and `os.totalmem()`, each lowered by a cgroup CPU quota or memory limit when one is set. `budget` is derived from it: `workstreamSlots` is two per CPU or one per GiB, whichever is lower; `verifyConcurrency` is one per two CPUs or per 2 GiB, at least 1. `limits` are what a cycle runs with. `source: "env"` means an explicit setting decided the value, `"budget"` that the host budget lowered the default, `"default"` that the static default applied. The budget never raises a default. The group and workstream defaults hold from about 9 CPUs and 18 GiB up.

### The `cap` vocabulary

`--capabilities` publishes every value `cap` can take under `contracts.resultSchema.caps`:

- `fixed` — literal caps such as `round-cap`, `intent-park`, `awaiting-human-merge`, `deadline` (the cycle deadline was reached; parked at a step boundary), `fence-violation:develop`, `fix-pass-park` (the adversarial fix pass parked on its own check).
- `templates` — a prefix plus one parameter: `verify-failed:<step>` (the gate ran and judged the code), `verify-timeout:<step>` (the verify command hit its time bound), `verify-env:<step>` (the system refused to start a process, so the gate never ran), `verify-baseline-red:<step>` (the verify command already fails at the cycle's base commit, on the same assertion as the change or by timing out on both), `pr-not-open:<step>` (the cycle's PR was merged or closed when the step started), `step-failed:<step>`, `driver-crash:<step>` (with the step list in `values`), and `branch-ahead:<count>`.

**`verify-failed:<step>` was narrowed in result schema v2.** It now means only that the gate ran and judged the change. A gate that hit its bound, could not start a process, or was red at the base commit, and the PR-not-open and fix-pass parks, used to share it and now have the caps above (see [troubleshooting](troubleshooting.md#what-verify-failedstep-means-and-the-caps-that-split-from-it-1349)). This changes what an existing cap means, and the narrowing is deliberate. It is covered by the tolerate-the-unknown rule below: a host that meets one of the new caps treats it as a generic handoff. It ships in the same release as schema v2, so no released v2 build used the old meaning and the version is not bumped again. A host that read `verify-failed:` as "the gate parked" should also match the new caps, or treat them as unknown caps (below).

A host switches on these values instead of strings found in pi-rukas source. The list is checked against the driver's cap type at compile time, so the build cannot record a cap the vocabulary omits. Exit code 11 is reserved for `intent-park` and `explore-needs-clarification`.

### Versioning rule

Additions do not bump a version: a new cap, a new input or file, a new stable NDJSON kind or field, or a new optional result field. Removing or renaming one, or changing its meaning, does bump the version of the contract it belongs to. A host must therefore tolerate the unknown:

- An unknown `cap` is a generic handoff: act on `status` and `exitCode`, and show the cap to a person.
- Unknown fields are ignored.
- An unknown NDJSON kind is treated as unstable.

### The state file is not a host contract

`.pi/work-state/<issue>.json` is the driver's private persistence. Its shape changes without a version bump, and the result's `stateFile` path is there for a person to inspect. A host reads the `--json` result, the NDJSON stream and the exit code, and nothing else. If a host needs a fact that only the state file has, that is a gap in this contract: file an issue rather than parse the file. The same applies to the `.worktrees/` layout and to pi-rukas source.

### NDJSON progress (v1)

One JSON object per line on stderr. Fields:

| Field | Type | Present | Description |
|---|---|---|---|
| `v` | `number` | always | Always `1` |
| `kind` | `string` | always | One of the `WorkEvent` kinds, or `log`, or `pi-resolved` |
| `unstable` | `true` | on kinds outside the stable subset | The line passes an internal event through; its kind and fields may change in any release |
| `at` | `string` | always | ISO-8601 timestamp |
| `issue` | `number` | when the line belongs to one issue | The issue number |
| `key` | `string` | on driver event lines | Idempotency key `<issue>:<index>:<at>` — a resumed cycle re-emits its prior event log, so a consumer dedupes on `key` |
| `event` | `object` | on driver event lines | The WorkEvent itself (its own `kind` would collide with the envelope's) |
| `message` | `string` | on `log` lines | The log message |

The full set of valid `kind` values is exported as `NDJSON_KINDS` (= `KNOWN_EVENT_KINDS` + `log` + `pi-resolved`).

#### The stable subset

Only these kinds are a host contract, versioned by `NDJSON_STABLE_VERSION` (1) and published under `contracts.ndjson.stable` in `--capabilities`. Within a version, the listed `event` fields keep their names and meanings; optional ones may be absent.

| Kind | Stable `event` fields |
|---|---|
| `step-started` | `step`, `at`, `round` |
| `dispatch-started` | `step`, `role`, `jobId`, `at` |
| `dispatch-completed` | `step`, `role`, `jobId`, `ok`, `ms`, `at`, `usage` |
| `cap-hit` | `cap`, `at`, `nextStep` |
| `handoff-emitted` | `at`, `commentUrl`, `labelApplied` |
| `ci-status` | `at`, `status`, `runUrl` |
| `merged` | `at`, `prNumber`, `mergeCommit` |
| `interrupted` | `at`, `reason` |
| `log` | `message` (on the line, not under `event`) |

Every other line carries `unstable: true`. A host may display it, but must not branch on it. The field lists are typed against the driver's event union, so renaming a stable field fails the build.

## Handoff channel

When a cycle stops short of a merge, it hands off: it renders a handoff body (why it stopped, where the work is, what to do next). `PI_ENSEMBLE_HANDOFF_CHANNEL` decides who delivers it.

| Value | pi-rukas does | The host does |
|---|---|---|
| `forge` (default) | Posts the body as a comment (on the PR when one exists, else the issue) and applies `needs-human-attention` to the issue and the PR. | Nothing; it may read `issues[].handoff.commentUrl` and extend that comment. |
| `host` | Posts no handoff comment and applies no `needs-human-attention` label (and runs no ops handoff dispatch). The cycle still ends in `handoff` with the same exit code. | Delivers `issues[].handoff.body`, using `cap` and `parkReason` to choose how. |

The `host` channel covers only the handoff. Other forge writes a cycle makes still happen:

- the six-pass review's residual-findings comment on the PR (with its `<!-- pi-rukas:lens-residuals … -->` marker), which the merge guard depends on;
- the same residual findings posted to the issue when the PR was merged or closed under the cycle, or posting to it failed;
- marking a draft PR ready for review when the review concluded (`PI_ENSEMBLE_DRAFT_PR`).

The body is recorded on the cycle's `handoff-emitted` event, and the result reads it from there, not from `bodyFile`. A failed write of that file therefore loses nothing, and a later cycle's file never shows up as this cycle's body. If the handoff step itself throws on the `host` channel, the cycle ends `aborted`, but a handoff is still recorded: its body is rendered from the state as it stood, with the crash named at the top. A handoff recorded by a build without the body has `bodyError: "not-recorded"` instead of `body`.

Either way, the body's first line is a machine marker, invisible when rendered:

```
<!-- pi-rukas:handoff issue=42 cap=verify-failed:develop -->
```

`cap` is the result's typed `cap` (`none` when the cycle recorded none). A host that finds this marker in a comment on the issue or PR knows pi-rukas already posted the handoff, and edits or replies to that comment instead of posting a second one. A host on the `host` channel should keep the marker in what it posts, so a later `forge` run, or another reader, can find it the same way.

On the `host` channel the attention gate still reads `needs-human-attention`, but pi-rukas never applies it. A host that wants a handed-off issue to refuse plain re-runs applies the label itself; [`--restart`](#--restart-for-hosts) is then how it runs the issue again.

## `--restart` for hosts

`work <issue> --restart` is the supported way to run an issue again after a handoff that a person has dealt with. A host passes it; it never removes labels itself.

What `--restart` does:

- **Starts a fresh cycle.** The driver ignores the issue's state file and overwrites it. The previous cycle's event log is lost, so copy the state file first if you need it. Without `--restart`, a terminal cycle (`merged`, `handoff`, `aborted`) is refused with exit 40, and a `running` or `interrupted` one resumes (`issues[].resumable`).
- **Overrides the attention gate (#408).** Without `--restart`, an issue labelled `needs-human-attention` is refused with exit 40 before any dispatch. With it, the gate does not refuse.
- **Clears `needs-human-attention`** from every issue in the cycle that carries it, whoever applied it, including a host on the `host` channel. The restart is the answer the label asked for, and the next `forge` handoff applies it again. If the restarted cycle is interrupted, a plain re-run resumes it without hitting the gate. Clearing is best-effort and never stops the restart. A PR's copy of the label stays in place: the gate does not read it.

What `--restart` does not reset or check:

- **The forge.** An open PR for the issue is found and reused (`PI_ENSEMBLE_PR_PREFLIGHT`), not duplicated.
- **Worktrees and branches.** A leftover worktree with no uncommitted or unpushed work is recreated, and one that holds work is refused (see [troubleshooting.md](troubleshooting.md)).
- **The intent-park record.** A restart that parks again for the same reason, on the same issue text and commit, links the earlier park comment instead of posting a new one.
- **Nothing about a live cycle.** `--restart` skips the check for another live process that owns the issue (that check is part of resuming). A host must never restart an issue it is still running; wait for the first run to exit.

Use `--restart` only when a person, or the host acting on a person's answer, has dealt with the handoff. Passing it on every run turns the gate off entirely, and the same handoff repeats.

## `--capabilities` answer

`pi-rukas-headless --capabilities` prints one JSON object to stdout and exits 0. The object describes what **this specific build** of pi-rukas-headless supports.

### Schema

```
{
  "schemaVersion": 2,          // the version of the capabilities object itself
  "version": "0.12.79",        // the pi-rukas build version (extension/package.json)
  "commit": "abc1234…" | null, // the commit the build was made from; null when nothing records it
  "contracts": {
    "exitCodes": {
      "version": 1,             // the exit-code contract version
      "values": { "merged": 0, "handoff": 10, … }  // the full EXIT object
    },
    "resultSchema": {
      "version": 3,
      "caps": { "fixed": ["adversarial-infra-failure", …], "templates": [{ "prefix": "verify-failed:", "parameter": "step", "values": ["explore", …] }, …] }
    },
    "ndjson": {
      "version": 1,
      "stable": { "version": 1, "kinds": { "step-started": ["step", "at", "round"], … } }
    }
  },
  "verbs": {
    "work": { "flags": ["--restart", "--json", "--timeout"] }
  },
  "inputs": [                  // every PI_ENSEMBLE_* input this build reads
    { "name": "PI_ENSEMBLE_MAX_WORKSTREAMS", "type": "integer", "default": 6, "scope": "cycle" },
    { "name": "PI_ENSEMBLE_VERIFY_TIMEOUT_MS", "type": "duration-ms", "default": 600000, "scope": "cycle" },
    { "name": "PI_ENSEMBLE_MODEL_<ROLE>", "type": "string", "default": null, "scope": "cycle" },
    { "name": "PI_ENSEMBLE_ISSUE_IMAGES", "type": "boolean", "default": true, "scope": "cycle", "manifestVersion": 1 },
    …
  ],
  "files": [                   // the .pi/* project files a cycle reads
    { "path": ".pi/verify-cmd", "kind": "command", "whenAbsent": "verify command derived from the repo" },
    …
  ],
  "features": {
    "resultFromMemory": true,   // #1189 — result from in-memory state, not the state file
    "cycleDeadline": true,      // #1238 — a cycle deadline that parks with a handoff
    "handoffChannel": true,     // #1327 — PI_ENSEMBLE_HANDOFF_CHANNEL=host
    "restartClearsAttention": true // #1327 — --restart clears needs-human-attention
  },
  "resources": { … }            // #1325 — the host budget and limits; see Resource report
}
```

### Field descriptions

| Field | Source | Meaning |
|---|---|---|
| `schemaVersion` | `CAPABILITIES_VERSION` constant | Version of the capabilities object shape. Bump when the shape changes. Version 2 (#1326) gave each `inputs[]` entry a `type`, `default` and `scope`, dropped `readBy`, and added `files`. |
| `version` | `extension/package.json` `version` | The pi-rukas version of the build. |
| `commit` | `.pi/pi-rukas-commit` (baked by the image), else the pi-rukas checkout's HEAD | The git commit the build was made from. `null` when neither exists (e.g. an install copied without `.git`). |
| `contracts.exitCodes.version` | Named constant in `exit-code.ts` | Version of the exit-code contract. The 7 named values are stable within a version. |
| `contracts.exitCodes.values` | The `EXIT` object | The complete mapping of exit-code names to values. A caller can check for the presence of a named code. |
| `contracts.resultSchema.version` | Named constant in `result.ts` | Version of the `--json` result schema. |
| `contracts.resultSchema.caps` | `caps.ts` | Every value the result's `cap` can take (see "The `cap` vocabulary"). |
| `contracts.ndjson.version` | `NDJSON_VERSION` | Version of the NDJSON progress schema. |
| `contracts.ndjson.stable` | `NDJSON_STABLE_VERSION`, `NDJSON_STABLE_FIELDS` | The stable kinds and their guaranteed `event` fields (see "The stable subset"). |
| `verbs.work.flags` | `WORK_FLAGS` array | The flags the `work` verb accepts, in the order the parser accepts them. An unknown flag in a caller's argv means "not supported" and is refused with exit 40. |
| `inputs[].name` | `HEADLESS_INPUTS` (`inputs.ts`) | An environment variable the build reads. A name with `<ROLE>` or `<SEAM>` is a family: `<ROLE>` is a role name and `<SEAM>` a decision-seam id, upper-cased with `-` → `_` (e.g. `PI_ENSEMBLE_MODEL_DEVELOPER`). |
| `inputs[].type` | Hardcoded | `boolean` (`1` on, `0` off), `integer`, `number` (see `unit`), `duration-ms`, `string`, `path`, `list` (joined by `separator`) or `enum` (one of `values`). |
| `inputs[].default` | Hardcoded; about 50 of them are checked against their live reader functions | The behaviour when the variable is unset. `null` means unset by default, with the fallback described in [configuration.md](configuration.md#environment-variables). |
| `inputs[].scope` | Hardcoded | Who sets it: `cycle` (changes what a cycle does), `sandbox` (the sandbox wrapper), `interactive` (the Pi UI only), `install` (path overrides), `internal` (pi-rukas sets it on its own children; a host must not), `test` (smoke tests only). |
| `inputs[].manifestVersion` | Hardcoded | Present on the two issue-image inputs: the manifest format version the build understands. |
| `files[]` | `HEADLESS_FILES` (`inputs.ts`) | The `.pi/*` files a cycle reads from the project (`path`, `kind`: `command` / `hook` / `config`, and what happens `whenAbsent`). Files the driver writes, such as `.pi/work-state/`, are state, not input, and are not listed. |
| `features.resultFromMemory` | Constant `true` | `true` when the result is taken from the driver's in-memory state rather than re-reading the state file (#1189). |
| `features.cycleDeadline` | Constant `true` | `true` when a cycle that hits its deadline parks with a handoff rather than being killed (#1238). |
| `features.handoffChannel` | Constant `true` | `true` when the build honours `PI_ENSEMBLE_HANDOFF_CHANNEL` and carries the handoff in the result (#1327). |
| `features.restartClearsAttention` | Constant `true` | `true` when `--restart` overrides the attention gate and clears `needs-human-attention` (#1327). See [`--restart` for hosts](#--restart-for-hosts). |
| `resources` | `resourceReport()` (`resource-budget.ts`) | The host budget and the limits a cycle started now would run with, read when the answer is built. See [Resource report](#resource-report). |

### How a caller uses this

```bash
# Check before starting a cycle:
caps=$(pi-rukas-headless --capabilities)
for name in PI_ENSEMBLE_MAX_WORKSTREAMS PI_ENSEMBLE_VERIFY_TIMEOUT_MS; do
  echo "$caps" | jq -e --arg n "$name" 'any(.inputs[]; .name == $n)' >/dev/null \
    || { echo "This build does not read $name"; exit 1; }
done
echo "$caps" | jq -e '.features.cycleDeadline == true' \
  || { echo "This build has no cycle deadline"; exit 1; }
```

An unknown name (no matching key in `features`, `inputs`, `files`, or `verbs.work.flags`) means the build does not support it. The caller fails closed — it does not guess or fall back.

### Baking the commit

The image publish workflow passes `GITHUB_SHA` as a build arg, and the Dockerfile bakes it into `.pi/pi-rukas-commit` under the install root, but only when it is a full 40-hex SHA. Without the marker, a pi-rukas git checkout reports its own HEAD (a root that only sits inside another repository does not). With neither, `commit` and the result's `buildCommit` are `null`; the version is always in `version` / `buildVersion`.

## Relationship to `docs/configuration.md`

`inputs` is the machine-readable list of every `PI_ENSEMBLE_*` variable read under `extension/src/`; [configuration.md](configuration.md#environment-variables) is the human-readable description. `test-headless-inputs.ts` scans `src/` for env reads (property, index, destructuring and name-literal forms) and fails when a read is missing from `inputs` or an entry is no longer read. A key built at runtime (`` `PI_ENSEMBLE_MODEL_${role}` ``) must be on the test's explicit allowlist, which maps it to its family entry. The test also checks about 50 listed defaults (numeric, list and boolean) against their live reader functions; the others are checked only in review. A new input therefore has to be listed in `inputs.ts` and described in configuration.md in the same change.

Variables read only by the shell wrappers in `bin/` (e.g. `PI_ENSEMBLE_HOST_ALIASES`, `PI_ENSEMBLE_IMAGE_DIRS`) configure the sandbox launch, not the runner, and are not listed.
