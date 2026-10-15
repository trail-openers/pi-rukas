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
| `--json` result schema | `RESULT_SCHEMA_VERSION` (2) | `extension/src/headless/result.ts` | The JSON document on stdout when `--json` is used. See below. Its `cap` values come from a published vocabulary (`extension/src/headless/caps.ts`). |
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

### `--json` result schema (v2)

With `--json`, stdout carries exactly one JSON document:

```json
{
  "schemaVersion": 2,
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
      "exitCode": 10
    }
  ]
}
```

| Field | Present | Meaning |
|---|---|---|
| `schemaVersion` | always | `RESULT_SCHEMA_VERSION`. Version 2 (#1326) added `schemaVersion`, `buildCommit`, `buildVersion`, `failedStep`, `prUrl`, `usage` and `resumable`. |
| `buildCommit` | always | The full 40-hex commit the running build was made from (the image's baked `.pi/pi-rukas-commit`, else the HEAD of the pi-rukas checkout), or `null` when nothing records it. Never anything else, so a host can safely run `git merge-base --is-ancestor <fix> <buildCommit>` when it is non-null. |
| `buildVersion` | always | The release version of the running build (`extension/package.json`). |
| `issues[].status` | always | `merged`, `handoff`, `aborted`, `interrupted`, `running` (the driver returned without a terminal state) or `not-started`. |
| `issues[].cap` | when a cap was hit | The last cap the cycle hit, from the published vocabulary (below). It can be set on a `merged` result too (a cap the cycle recovered from), so a host reads `status` and `exitCode` for the outcome and `cap` for the reason. |
| `issues[].failedStep` | when the cycle did not merge and started a step | The step it stopped in: the step a `verify-failed:` / `verify-timeout:` / `step-failed:` / `driver-crash:` cap names, else the last step started before the cap, else the last step started. It names where the cycle stopped, not necessarily a failure: for `awaiting-human-merge` it is the last step the cycle ran (e.g. `ci`). |
| `issues[].branch`, `prNumber`, `prUrl` | when known | `prUrl` is present only when unambiguous: the PR URL the driver recorded (its handoff comment on the PR), else one built from the project's git remote when there is exactly one remote, the forge is GitHub or GitLab, and the web address is certain (an `http(s)` remote, or ssh to github.com / gitlab.com; GitLab subgroups and explicit https ports are kept). Otherwise only `prNumber` is set. |
| `issues[].usage` | when a state existed | Tokens, cost and turns summed over every dispatch the cycle recorded (`dispatch-completed`, `dispatch-failed` and `dispatch-failed-provider` events), and the dispatch count. It covers the current cycle only: `--restart` discards the state, so earlier cycles' cost is not included. |
| `issues[].resumable` | always | `true` when running `work <issue>` again **without** `--restart` continues this cycle (it was interrupted, or stopped while running). Always `false` on a refusal (exit 40: another live process owns the cycle, so a re-run is refused again until it ends) and when `PI_ENSEMBLE_RESUME=0`. A terminal cycle needs `--restart` for a fresh one. |
| `issues[].stateFile` | always | A path for a person to inspect. Not a host contract: see below. |
| `issues[].questions` | exit 11 only | The clarification questions, numbered `q1`, `q2`, … |
| `issues[].diverged` | on divergence | The in-memory and on-disk states disagreed; the exit code is 30. |

An optional top-level `error` (`{ code, message }`) is present when the runner detected a divergence (e.g. `state-diverged`) or another runner-level failure.

### The `cap` vocabulary

`--capabilities` publishes every value `cap` can take under `contracts.resultSchema.caps`:

- `fixed` — literal caps such as `round-cap`, `intent-park`, `awaiting-human-merge`, `deadline` (the cycle deadline was reached; parked at a step boundary), `fence-violation:develop`.
- `templates` — a prefix plus one parameter: `verify-failed:<step>`, `verify-timeout:<step>` (the verify command hit its time bound, not a code failure), `step-failed:<step>`, `driver-crash:<step>` (with the step list in `values`), and `branch-ahead:<count>`.

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
      "version": 2,
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
    "cycleDeadline": true       // #1238 — a cycle deadline that parks with a handoff
  }
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
