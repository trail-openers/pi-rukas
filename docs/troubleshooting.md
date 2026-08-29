# pi-ensemble troubleshooting

Symptoms → causes → fixes. Most issues here come from running an older sandbox image; the first move on anything weird is usually `./install.sh` from the pi-ensemble repo to rebuild + refresh.

## Platform support

### `./install.sh` fails on Windows — bash parse errors, or a half-finished install

**Symptom:** you read the platform line ("Tested on macOS; should work on Linux"), run `./install.sh` from a Windows terminal, and get either a bash parse error (`command not found`, `/usr/bin/env: 'bash'` not found) or a partially completed install — a symlink or two landed, then the script died — with no indication of what went wrong or what would actually work.

**Cause:** native Windows is not supported. Every entrypoint is a bash script, the install works by symlinking skills / the extension / the CLI, and the sandbox bind-mounts the project at its host **absolute** path (Pi buckets sessions by absolute `cwd`) — a `C:\` path cannot satisfy that inside a Linux container. This is a structural mismatch, not a missing flag, so no Windows setting fixes it. (`install.sh` now refuses to proceed early on a non-Linux/non-Darwin kernel and points at WSL2 instead of proceeding to a partial install — see the fix below if you are on a newer checkout.)

**Fix:**

- **Use WSL2.** WSL2 (Windows Subsystem for Linux 2) is **expected to work but untested** — do not treat it as supported until someone has verified it end to end. The one real condition: **sandbox mode needs a Docker daemon reachable from WSL2** (Docker Desktop with WSL2 integration enabled, or an equivalent Docker Engine) to pull the published image. Without a Docker daemon you can still run **host mode** (`pi`) inside WSL2, which does not need the sandbox image.
- **Do not attempt a native-Windows install.** There is no supported path.

**Verification (the "expected to work" bar).** WSL2 is upgraded from "expected to work" to "supported" only once someone records a clean run: `./install.sh` completes, one sandbox image pull succeeds, one subagent dispatch runs, and `/mcp` shows the `codebase_memory` server. Record the configuration — repo location (`/home/...` vs `/mnt/c/...`, which interacts with the absolute-path mount premise) and the Docker variant.

**Note on the prerequisites:** several tools have no native-Windows install path, which is part of why the platform is unsupported — `codebase-memory-mcp` installs by curl-to-bash, `parallel-cli` by a Homebrew tap, and `vipune` / `oo` by cargo from source. Under WSL2 (a Linux kernel running inside a Windows VM) all of these install normally.

### `docker` / the sandbox image is unreachable from inside WSL2

**Symptom:** on a WSL2 host, `./install.sh` gets past OS detection but the sandbox image pull fails, or `pi-ensemble` launches and the container can't start — `docker` commands report the daemon is unreachable.

**Cause:** WSL2 is a separate Linux VM; the Docker daemon you want it to talk to lives on the Windows host (Docker Desktop) or must be its own Engine. A bare WSL2 distro has no Docker daemon, so the sandbox — which is a Docker container — has nothing to run in.

**Fix:** enable Docker Desktop's **WSL2 integration** (Settings → Resources → Integrations → enable your distro), or run a Docker Engine inside the distro and start its daemon. Verify from inside WSL2: `docker version` shows both client and server, then `./install.sh` again so the image pull succeeds.

## Subagent silently "finished" but the worktree wasn't touched

### Symptom

PM dispatches a subagent (developer / explore / ops); the `[ensemble:async]` report comes back looking normal — "Subagent finished — N turns, Tm Ts" with what reads like a final assistant message (e.g. *"Step 1: Read sweep_stats.rs"*). PM proceeds as if work was done. You arrive at the desk and find `git status` clean, no commits, no PR — the agent never actually wrote anything.

### Cause

The provider HTTP request hung mid-stream. pi-ai turned the timeout into a synthetic assistant message with `stopReason: "error"` and empty content. Pre-#236 the dispatch report treated that as a normal completion and displayed the agent's last successful thinking block as if it were the final reply. Pi's default HTTP timeout is ~10 minutes (provider SDK default), so a degraded provider could burn 4 retry attempts × 10 min = 40 min before failing — and the failure looked like a success.

This is **independent of the LLM backend**: across recent runs, Anthropic Claude Sonnet 4.6 and Cerebras `zai-glm-4.7` produced this failure roughly equally.

### Fix

```bash
cd ~/.config/opencode/pi-ensemble && git pull && ./install.sh
```

Post-#236 (retuned by #295), `install.sh` writes `retry.provider` defaults into `~/.pi/agent/settings.json` (10 min per request, 3 retries with backoff). If you have non-default settings you want to keep, they're preserved — install.sh only writes the retry block when it's missing, with one exception: the old #236 value of exactly `180000` (3 min) is recognized as our own footprint and repaired to the new default.

The dispatch report also now distinguishes the failure mode visually:

- Header: `Subagent \`developer\` (job X) FAILED-PROVIDER-ERROR — N turns, Tm Ts`
- Body prefix: *"Provider request error: \<errorMessage\>. Last text below is the agent's pre-failure activity — VERIFY DIRECTLY before assuming progress."*
- Scrollback line: `▸ ensemble: ⚠ developer terminated mid-stream — provider request error, see report`

PM treats `FAILED-PROVIDER-ERROR` as a failed dispatch per existing doctrine (routes through the cap-hit handoff from #233), so you'll see the `needs-human-attention` label and PR comment when you check.

### Tuning

Do NOT set this below the longest single turn your subagent models legitimately produce. A thinking-heavy model (e.g. `xhigh` thinking level) routinely streams a single turn for 10-17 minutes; with a too-tight timeout, pi's client burns two stacked retry layers (~10-17 min of total silence) and then reports `"Request timed out."` / `"terminated"` **on a perfectly healthy endpoint** — the signature of the #295 regression (constant "endpoint sporadically failing" reports across endpoints that check out fine). Edit `~/.pi/agent/settings.json` directly:

```json
{
  "retry": {
    "provider": {
      "timeoutMs": 600000,    // 10 min per request (the #295 default)
      "maxRetries": 3,
      "maxRetryDelayMs": 60000
    }
  }
}
```

Keep `maxRetries * timeoutMs` comfortably below the per-role wall-clock caps in `spawn.ts` (`ROLE_TIMEOUT_DEFAULTS_MS`); otherwise retries get truncated.

**Do not lower `maxRetryDelayMs`.** It is a *ceiling* on a provider's `retry-after`, not a delay we add. Pi's own backoff is `min(0.5 * 2 ** i, 8) * 1000`, capped at 8s, so raising the ceiling costs no wall-clock unless a provider explicitly asks us to wait longer. Its only effect is deciding which provider instructions to discard — and when it discards one, **nothing waits at all**: the throw happens inside `getRetryDelayMs` while computing the next delay, before any sleep, so the `maxRetries` budget is never even consumed.

pi-ensemble shipped `10000` here for several releases on the mistaken reasoning that it "added 3 x 60s of backoff". Providers routinely ask for 59-60s, so every real throttle became a hard failure. Measured on one run: three parallel `/research` children and two `/work` developers all died on `Server requested 59s retry delay (max: 10s). 429 status code`, having gathered ~305k characters of research between them, all discarded. `install.sh` now repairs a value of exactly `10000` on sight — including on hosts where `timeoutMs` was already set, which previously skipped the whole block and so were never fixed.

If you have deliberately chosen a value below 60s, it is preserved; the extension traces a warning at startup instead, visible in `/ensemble-debug`.

PRs: [#236](https://github.com/randomm/pi-ensemble/pull/236), [#295](https://github.com/randomm/pi-ensemble/issues/295)

## Dispatch reports

### A parallel child reports `fail (exit 0) · 1 turns · (no output)`

**Symptom:** `dispatch_parallel` returns a batch report in which one or more children show no output and no reason, while a sibling completed normally. The obvious reading — "the dispatch never got going, or the brief was bad" — is usually wrong.

**Cause:** the batch report rendered `text || "(no output)"` and never looked at the child's `errorStop`. The single-job report had handled it all along, so the two paths disagreed. A child killed mid-flight has no final assistant text, and `collapseEvents` counts turns from `agent_end.messages`, which on an error carries only the last turn — hence `1 turns` for a child that had actually made 41 tool calls across 105 transcript turns.

The real cause was almost always a provider 429 (see [Tuning](#tuning) above). Measured on one `/research` run, three of four children died this way after gathering ~305k characters between them; the PM read the report, concluded "a dispatch failure, not a research failure", and re-dispatched with tighter briefs — treating a rate limit as a prompting problem.

**Fix:** both report shapes now share one `describeOutcome`, so a killed child names its cause. A 429 is classified with the same `classifyFailureCause` the driver uses, which distinguishes a burst (*"provider asked for a 59s wait"* — waiting is the remedy) from a quota window (*"a ~24h quota window, so retrying now cannot help"*). `(no output)` now means what it says: the child really produced nothing, and did not fail.

### A child reports far fewer turns than it took

**Symptom:** a dispatch reports `29 turns` when the transcript on disk has 57 assistant messages; a killed child reports `1 turns`. Not confined to failures — healthy children were under-reported too.

**Cause:** `agent_end.messages` is not the session. It carries the messages produced *since the previous* `agent_end`, and Pi emits one per in-process retry boundary. `spawn.ts` kept only the last one (a deliberate memory bound — unbounded event accumulation had caused a ~3.7GB parent OOM), so the reported counts were the last segment. Measured: `rust-slack` recovered from five 429s and its final segment was exactly 29 messages, against 57 on disk. A child that *dies* ends on the error, so its segment is the lone error stub — hence `1 turns`.

**Fix:** `reconcileObservedCounts` restores the counts from the live `runningState`, which `ingestEvent` accumulates across every segment. It only ever revises upward: a lower live count would mean missed events, and the replay is then the better source. A failed child that did work now also shows `· 41 tool calls before it died`.

### `/runs` shows `tool calls: 0` for a run that clearly used tools

**Cause:** the transcript parser matched Anthropic's `tool_use` / `tool_result` block names and expected tool results as blocks inside a `user` message. Pi emits `toolCall` blocks with an `arguments` string, and gives tool results their own `toolResult` role — the local type did not even permit that role, so the branch could never run. `/runs` therefore reported zero tool calls for **every** transcript.

**Fix:** the parser accepts both spellings. Turn counts were always correct; only the tool call/result lists were empty.

Check the raw transcript under `~/.pi/agent/ensemble-runs/<date>/` before concluding a child did no work.

## Review gates

### `commit-pr-incomplete-consolidation` — check the plan's `paths:` first

Before assuming a workstream's work is genuinely missing, look at how the plan declared its paths. A qualified declaration — `src/config/data.rs (lines 21-44, function body only)` — used to be split on the inner comma into two fragments with unbalanced parentheses, which nothing downstream could normalise back into a path.

That broke two gates in opposite directions: the plan-time overlap check compared the mangled strings, saw no collision and allowed a fan-out where every workstream edited one file; then the consolidation gate looked for those same mangled strings in the committed diff, never found them, and reported every such workstream MISSING *even after a correct integration*. Two of nine measured nessie cycles halted there. Commas inside parentheses are no longer separators.

If the cap fires for real, the recovery commands now match what the driver itself does — stage inside the worktree first (`git diff HEAD` omits untracked new files), capture with `--binary`, apply with `--3way`. The old advice used `git diff HEAD | git apply --index`, which dropped new files and rejected any second workstream touching the same file.

### A subagent was refused a `git checkout` / `reset --hard` / `clean -f`

Deliberate, and it holds regardless of trust level. A validation subagent once "cleaned up scratch commits" with `git checkout`, wiped an uncommitted deliverable, and then "restored" it by re-applying an older patch — silently reverting two reviewed defect fixes. It was caught only because a diffstat line count looked wrong.

Nothing stopped it at any layer: trust mode (the default on an interactive host) and sandbox mode (the default in a container) both bypass gating entirely, and under strict opt-in the `oo git *` catch-all in `agents.json` allowed it explicitly. So the refusal sits ahead of all three.

The distinction: the permission layers answer *"may this role run git?"* — yes. This answers *"may anything destroy work nobody has captured yet?"* — no. The container fence and the operator's trust both protect the **host**; neither protects the developer's own diff.

**Still allowed**, because they lose nothing: `git checkout <branch>` (git refuses to clobber local edits), `git reset` without `--hard`, `git restore --staged`, `git stash push` (recoverable via `git stash list`), and `git clean -n`.

Opt out with `PI_ENSEMBLE_ALLOW_DESTRUCTIVE_GIT=1`.
### The queue says a group "did not start"

Not a failure, and not a halt. The driver declined to run that group — usually because a live cycle already owns the issue, but also for a terminal status, a `needs-human-attention` label, or state-file inconsistencies. All five of those return in about a millisecond.

Previously the queue could not distinguish them from a cycle that ran and parked, so it read whatever state file was on disk — which in the interesting cases belongs to the cycle that is *actually running* — took its most recent `cap-hit` as this group's park reason, and recommended `--restart`. Restarting a live cycle wipes its state file and starts a second driver on the same issue, which is the interleaving the claim check exists to prevent. The field report was *"finished — 0 merged, 2 parked"* while both explores were still alive, with `updatedAt` only 1.3 s after `startedAt`.

Two independent guards now: the queue refuses to interpret a state file at all when the driver reports it never started, and `parkReason` separately refuses to call a `running` cycle with a live owner "parked".
### An inactivity kill — read `line(s)` before touching the budget

A kill now reports the shape of the silence, not just the budget:

```
[pi-ensemble] killed after 1500000ms inactivity (override: PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS)
  · last output: toolCall 1500s before the kill, after 412 line(s)
```

That number separates two failures a bare cause could not:

- **`0 line(s)`** — the child never spoke at all. A provider stall, an auth failure, or a bad model id. Nothing was produced, nothing is recoverable, and the problem is upstream of the agent. Raising the watchdog changes nothing.
- **a large count** — the child worked and then went quiet. A genuine hang, with real output on disk in its worktree worth recovering before you re-run.

The 25-minute budget is deliberately unchanged. Raising a wall-clock number to cover a cause you have not identified is exactly the mistake the six per-role timers were deleted for — each was raised twice, and each time the finding was that the number was too small for a *healthy* child.

### Reading a handoff

Every handoff carries three things it previously withheld.

**The review's own findings**, severity-ordered worst-first, with lens, path and line. These used to be replaced by a pointer — *"Review the JSON findings in the state file"* — in the GitHub body, and omitted entirely from the in-chat message. Four nessie cycles handed off with CRITICAL findings that nobody read, and the same defects were later rediscovered by hand from the diff. If a round reports issues but records nothing readable, the handoff says *that* rather than staying silent.

**Whether we killed the subagent.** A `timeout` or `inactivity` kill is now named as ours, with its cause. Previously `killCause` and `errorTail` were written to the event and rendered nowhere, so a wall-clock kill was indistinguishable from a crash, a 429, or a provider error — and two perfectly good issues were described to their operator as ambiguous because of it.

**Recovery commands that match reality.** A cycle halting before the branch step has no branch, no worktree and no PR, and no longer receives `git status` / `git push -u origin <branch>`. The predicate is the absence of a branch name, not a list of caps — so a newly added pre-branch cap cannot fall through to the wrong text again.

### The six-pass review said APPROVED but nothing looks reviewed

A lens that exits 0 without calling `report_finding` used to be indistinguishable from one that reviewed carefully and found nothing, so a silent review reported APPROVED. It now reports `REVIEW_INCOMPLETE` unless every lens produced either findings or a closing summary. If you see REVIEW_INCOMPLETE with no obvious failure, check the lens transcripts under `~/.pi/agent/ensemble-runs/<date>/` — a lens that returned only thinking content is the usual cause.

### `/work` parks at explore saying the spec is underspecified

Two new checks can park here, both because explore did not produce a decision the driver can act on:

- **No deliverables.** `INTENT-VERDICT: proceed` with an empty `### Deliverables` section now parks rather than planning against nothing. Acceptance criteria are *not* required — `proceed-with-assumptions` is the supported path for a defensible gap.
- **No signal at all.** A reply with neither a `## Spec` block nor a legacy `EXPLORE-VERDICT` token parks instead of advancing. On a single-issue cycle the prompt does not ask for the legacy token, so a missing `## Spec` block means the driver has nothing to read.

Revise the issue body (`/plan`) and re-run with `--restart`.

### The develop gate fails on missing dependencies, not on the diff

Development happens in a `git worktree`, which contains tracked files only — no `node_modules`, no virtualenv, no vendor tree. If your verify command needs them, it fails for a reason that has nothing to do with the change.

pi-ensemble now provisions the worktree: it runs **`.pi/worktree-setup`** if you provide one (the reliable option — put `bun install`, `uv sync`, whatever your project needs, in it), and otherwise symlinks `node_modules`, `.venv` and `vendor` when they exist and are gitignored. Discovery is not limited to the repo root: any depth-1 subdirectory that contains a manifest or lockfile (`package.json`, `bun.lock`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `Gemfile`, …) is scanned for a nested `node_modules` — so a nested-package monorepo provisions without a hook (#481). An **empty** candidate directory is never linked or reported as a useful link, and a project with a lockfile but no findable tree gets a `problem` the branch step traces rather than a silent bare worktree. Build output (`target/`, `build/`, `dist/`) is never shared: concurrent workstreams writing one directory would serialise the fan-out.

A verify failure that looks dependency-caused now says so in the handoff rather than implying the diff is at fault. If you see that, add `.pi/worktree-setup`.

### The `.pi/worktree-setup` hook — contract

The hook is the escape hatch for the inexpressible: anything the symlink allowlist cannot describe (multi-step installs, generated files, environment-specific paths) goes here. The contract the driver makes when invoking it:

- **No arguments, no environment.** The hook is invoked as `sh <repoRoot>/.pi/worktree-setup` and must locate `repoRoot` itself — e.g. `git rev-parse --path-format=absolute --git-common-dir` (git ≥ 2.31), whose parent directory is the main checkout.
- **`cwd` = the new worktree root.** `git worktree add --detach` has just run, so the hook sees a tree of tracked files only.
- **The hook path skips the symlink loop entirely**, including the `.git/info/exclude` write that loop performs. If your hook creates a symlink (say, `ln -s $repo_root/extension/node_modules extension/node_modules`), it must write its own exclude entry to `$GIT_COMMON_DIR/info/exclude`, or the link surfaces as untracked in `git status --porcelain` and `stagePorcelainPaths` stages it into the PR.
- **A non-zero exit is reported as `ProvisionResult.problem`** and traced at the branch step; the cycle continues (a bare worktree is the status quo, not a regression). A hook that cannot provision should exit 0 with a diagnostic to stderr, not fail the cycle.

### The plan step re-dispatches saying two workstreams claim the same file

Each workstream gets its own worktree and its own developer, running in parallel, so a file in two `paths` lists means two developers editing it at once — which used to surface much later as a `git apply` conflict at commit-pr. The plan step now catches it and re-plans once. If it persists, the issue probably needs those workstreams merged.

### `/work` parks my issue as "underspecified" but the resolver said it was fine

The handoff quotes its own resolver saying "the intent is clear, no contradictions" and then says the issue does not say enough to build from. Fixed in v0.12.41 — two causes, both in the gate rather than your issue:

- A **blocking open question** used to park a `proceed`. It no longer does; `proceed-with-assumptions` is the supported path for a spec with a defensible gap.
- A **numbered** deliverables list (`1. …`) was invisible to the parser, which read only `-`/`*` bullets. It emptied four spec fields at once.

**Do not reformat your issues.** The theory that deliverables need a `D{N}:` prefix is wrong — ids are assigned automatically, and 0 of 40 real issue bodies were affected by the numbered-list gap.

### A cycle parked at explore right after a timeout

A timed-out explore produced an empty reply, and the driver read that as "explore found nothing to say" — emitting a needs-clarification cap over the dispatch failure. Fixed: a failed dispatch is now classified as the infrastructure fault it is.

### Cycles run one at a time now

`PI_ENSEMBLE_PARALLEL_GROUPS` defaults to 1. Measured across 69 cycles, every autonomous merge ran alone, and concurrent cycles ran ~2.4× slower per role — enough to trip the watchdogs — as well as corrupting each other through the shared repo root. Set the env var if you want the old behaviour.

### A cycle merged even though the full verification failed

**Symptom:** `.pi/verify-cmd-full` fails (typecheck, lint, or a fixture suite) and the cycle still reports MERGED.

**Cause (fixed):** `runCi` emitted `verify-full-status: failure` without a `ci-status`, and `nextStep` had no branch for it, so the cycle fell through the linear `ci → merged`. `ci-status: failure` was always routed correctly to `develop`; its sibling was not. Since the full-verify check is opt-out (`PI_ENSEMBLE_VERIFY_FULL=0` disables it) and this repo ships the command file, it applied to every cycle here.

**Now:** both failure signals route identically — back to `develop` within the retry budget, then to handoff at the cap.

### `/work` refuses a PR number at commit-pr

The gate now requires the PR to be **open** and to have this cycle's branch as its head. Previously it only checked that `gh pr view <N>` did not error, which proved a PR with that number exists — not that it belongs to this cycle. If you see this, the ops reply's `pr:` marker named a PR from a different branch, or one that is already closed or merged. Check `gh pr list --head <branch>`.

### `/work` halts at the branch step naming the mainline

The branch step recorded whatever branch `repoRoot` was on, and that value becomes the branch the cycle force-pushes to. If an ops child creates the branch and then returns `repoRoot` to `main`, the cycle would have adopted `main`. It now halts. Re-run with `--restart` after checking `git -C <repo> branch --show-current`.

### A merged PR reported a failed cycle

**Symptom:** `gh` shows the PR merged, the driver shows `step-failed:merged` and hands off; the worktree is not torn down and the checkout is not restored.

**Cause (fixed):** after a successful mechanized merge the driver dispatched role `driver`, which is not a spawnable role, so `spawn.ts` threw `Unknown role: driver`. Work the driver performs itself is now recorded directly via `work-driver-events.ts` rather than dispatched.

### `/work` hit the adversarial cap and handed off with no PR

**Symptom:** the cycle reaches step 5, the adversarial loop runs its three rounds, and the run parks with *"could not reach APPROVED"* — no commit, no branch pushed, nothing on GitHub. The diff is left unstaged in `.worktrees/issue-<n>-*/`, often with green tests.

**Cause (fixed):** the loop exited only on `APPROVED`, so `ISSUES_FOUND` — which `agents-base/adversarial-developer.md` explicitly defines as *"Should address, **not blocking**"* — halted the cycle exactly as hard as `CRITICAL_ISSUES_FOUND`. Measured across 253 loops, 41 of 49 rejections (83.7%) ended on that non-blocking verdict. `MINOR_OBSERVATIONS` was worse: absent from the code's enum entirely, so a reviewer that used it fell through to the `ISSUES_FOUND` default and was reported as having produced no readable verdict.

**Now:** every unresolved verdict still earns a fix round, but at the last round only `CRITICAL_ISSUES_FOUND` blocks. A pass that left findings behind reports `PASSED WITH FINDINGS` rather than `APPROVED`, and those findings appear in the PR body under *"Adversarial review — non-blocking findings"* and in the six-lens review's context. If your cycle still parks here, the reviewer returned `CRITICAL_ISSUES_FOUND` — read the *"What the reviewer objected to"* section of the handoff comment, which now quotes it.

### The handoff says `Rounds: 0 of 3` but the loop clearly ran

`reviewRound` is the **lens-review** counter and is legitimately 0 when a cycle dies at step 5 without reaching step 7. It used to be printed under an adversarial cap too, so a loop that ran three full rounds reported zero. Fixed: an adversarial cap now reports its own round count, and the handoff quotes the blocking finding instead of the generic *"the diff still has issues the adversarial-developer flagged"*.

### A restarted cycle erased its own history

`/work <n> --restart` overwrites `.pi/work-state/<n>.json`, including the event log of the run you are trying to diagnose. Copy the state file before restarting. The subagent transcripts under `~/.pi/agent/ensemble-runs/<date>/` survive longer but are pruned to the last 20 batches (`runs.ts`); the durable record is `~/.pi/agent/sessions/`, which is not pruned.

## Permissions

### Host-mode pi-ensemble is asking me to approve every command

**Symptom:** Running `pi` (host mode, no sandbox) in an interactive terminal: every novel bash / tool call prompts "Allow once / Allow always / Deny once / Deny always". Within a few minutes, dozens of prompts. Unusable.

**Cause:** You have `PI_ENSEMBLE_STRICT_PERMISSIONS=1` set in your shell rc. Trust-mode (no per-call prompts in interactive host) is the default; strict-mode is opt-in.

**Fix:** Unset the var.

```bash
# Check
env | grep PI_ENSEMBLE_STRICT_PERMISSIONS

# Remove from your shell rc (~/.zshrc, ~/.bashrc, etc.) then:
unset PI_ENSEMBLE_STRICT_PERMISSIONS
exec $SHELL -l   # re-source rc
```

Relaunch `pi` — no more prompts. The agent runs as your UID with your credentials; that's the deal in interactive host mode. Use `pi-ensemble` (sandbox) if you want confined execution.

PR: [#215](https://github.com/randomm/pi-ensemble/pull/215)

### Headless `pi -p` hard-denies all novel commands

**Symptom:** `pi -p "do something"` in a script / CI returns immediately with "Tool 'bash' requires approval (no UI available)" for any command not in the role's allowlist.

**Cause:** Headless mode (no TTY) preserves the legacy strict ask-flow with no human to consent → hard-deny. This is deliberate safety: silent rubber-stamping in automation contexts would be worse than failing closed.

**Fix:** Either (a) widen the allowlist in `.pi/permissions.json` for that project, (b) run inside the sandbox where there's no per-call gating, or (c) if you genuinely need an unrestricted automated run, prepend `PI_ENSEMBLE_SANDBOX_MODE=1 pi -p ...` — but understand this disables ALL guard layers and should ONLY be used in a context already sandboxed by other means (Docker, VM).

PR: [#215](https://github.com/randomm/pi-ensemble/pull/215)

## Image acquisition

### `./install.sh` takes 10+ minutes (cold local build)

**Symptom:** Running `./install.sh` on a fresh host (or after `docker system prune`) takes 10-30 minutes. Output shows `cargo install vipune`, `cargo install double-o`, `npm install -g ...`, the Rust toolchain compiling.

**Cause:** You're on an `install.sh` from before #219 — pre-#219 the script always built the image locally. Post-#219 it pulls a pre-built multi-arch image from `ghcr.io/randomm/pi-ensemble:latest` (built + published on every merge to main).

**Fix:** Pull the latest pi-ensemble repo + rerun install.

```bash
cd ~/.config/opencode/pi-ensemble && git pull && ./install.sh
```

The pull should finish in ~10-20s on broadband. If it falls back to a local build, see the next entry.

PR: [#219](https://github.com/randomm/pi-ensemble/pull/219)

### `docker pull ghcr.io/randomm/pi-ensemble:latest` returns `denied`

**Symptom:** `./install.sh` reports `Pull failed; building locally from this checkout instead.` Inside that pull attempt: `Error response from daemon: denied`.

**Cause:** The GHCR package is private. By default, GHCR packages start private until the repo owner flips them to public.

**Fix (if you own the repo):** GitHub → Profile → Packages → `pi-ensemble` → Package settings → Change visibility → Public.

**Fix (if you don't own the repo, but have a GitHub account):** Authenticate to GHCR with a personal access token that has `read:packages`.

```bash
gh auth token | docker login ghcr.io -u USERNAME --password-stdin
./install.sh
```

PR: [#219](https://github.com/randomm/pi-ensemble/pull/219)

### Forcing a local build (Dockerfile development)

**When:** You're iterating on `.devcontainer/Dockerfile` and want to test changes before they're merged + republished.

**How:** Pass `--build` to install.sh.

```bash
./install.sh --build
```

Skips the registry pull, builds directly from your checkout. Takes 10-30 minutes cold; uses Docker layer cache on subsequent runs.

## Sandbox launch

### `MCP: 0/N servers` — codebase_memory not connected

**Symptom:** Inside `pi-ensemble`, the bottom status line shows `MCP: 0/1 servers` (or 0/N). `/mcp` reports no servers connected. Subagents fail any `codebase_memory_*` tool call.

**Cause:** pi-mcp-adapter reads `~/.config/mcp/mcp.json` (Tier 1). `install.sh` writes this file with the codebase_memory entry, but if you never ran `./install.sh` (or ran it before pi-ensemble shipped this wiring), the file is missing or empty.

**Fix:** `cd ~/.config/opencode/pi-ensemble && ./install.sh`. Validate with `jq '.mcpServers | keys' ~/.config/mcp/mcp.json` — should list `codebase_memory`. Restart the sandbox.

PR: [#196](https://github.com/randomm/pi-ensemble/pull/196)

### `gh issue list` returns "HTTP 401: Requires authentication" inside container

**Symptom:** Inside `pi-ensemble`, `gh` commands that hit the GitHub API return 401. Outside the container on the host, the same commands work fine.

**Cause:** macOS `gh auth login` stores the token in Keychain, not in `~/.config/gh/hosts.yml`. The container's bind-mount of `~/.config/gh/` brings the config dir but not the keychain-stored token.

**Fix:** The wrapper extracts the token via `gh auth token` on the host and forwards it as `GH_TOKEN` env into the container. If you're seeing 401, check the host: `gh auth status` should report you authenticated. If you're using a personal access token directly, export it as `GH_TOKEN` in your shell so the wrapper forwards it explicitly.

PR: [#203](https://github.com/randomm/pi-ensemble/pull/203)

### Custom LLM endpoint (e.g. `halo`) returns "connection refused" or "no such host"

**Symptom:** A custom provider (configured in `~/.pi/agent/models.json` with `baseUrl: "http://halo:8080/v1"`) works from host-mode `pi` but fails inside `pi-ensemble`.

**Cause:** The container's resolver doesn't see your `/etc/hosts`, Tailscale MagicDNS, or your home network. The hostname `halo` doesn't resolve.

**Fix:** Set `PI_ENSEMBLE_HOST_ALIASES` before launching:

```bash
PI_ENSEMBLE_HOST_ALIASES="halo:192.168.8.249,llm-box:10.0.0.7" pi-ensemble
```

Comma-separated `name:ip` pairs. The IP must be reachable from the host (the container's network rides the host's stack via Docker bridge).

Default already includes `halo:192.168.8.249` — set the var if your halo is elsewhere or you need additional hosts.

PR: [#204](https://github.com/randomm/pi-ensemble/pull/204)

### Custom provider missing from `/ensemble-model` picker

**Symptom:** `/ensemble-model` inside sandbox shows fewer providers than `/ensemble-model` outside. Your `trailopeners-h100`, `halo`, or other custom provider is missing.

**Cause:** Wrapper bind-mounts `~/.pi/agent/models.json:ro` (post-#205). If you're on an older wrapper version, custom providers aren't visible inside the container.

**Fix:** `./install.sh` from pi-ensemble repo to refresh the wrapper. If after that the provider's API requests fail with `401`, check that the api key env var is exported in your shell rc — post-#228 the wrapper forwards the full host shell env, so any exported var (regardless of name) reaches the container.

PR: [#205](https://github.com/randomm/pi-ensemble/pull/205), [#228](https://github.com/randomm/pi-ensemble/pull/228)

### `MCP error -32000: Connection closed` for env-driven docker MCPs

**Symptom:** `.pi/mcp.json` defines an MCP server like `docker run -i --rm -e DATABASE_URI crystaldba/postgres-mcp` with `"env": { "DATABASE_URI": "${SOME_DB_URI}" }`. Works on host-mode `pi`; fails in `pi-ensemble` with `MCP error -32000: Connection closed`. The MCP server process exits within milliseconds.

**Diagnose (inside the sandbox):**

```bash
env | grep SOME_DB_URI   # is the var even visible inside?
```

If empty: the var isn't reaching the sandbox.

**Cause:** Pre-#228 the wrapper only forwarded a curated env subset (`*_API_KEY` / `*_LLM_KEY` patterns + explicit list). Vars referenced in `.pi/mcp.json` env-refs (`${VAR}` / `{env:VAR}`) had to be explicitly listed in `PI_ENSEMBLE_EXTRA_ENV`. pi-mcp-adapter interpolated them against the sandbox's env, got empty strings, spawned `docker run -e DATABASE_URI=""`, and the postgres-mcp container exited on invalid URI.

**Fix:** Refresh.

```bash
cd ~/.config/opencode/pi-ensemble && git pull && ./install.sh
```

Post-#228 the wrapper forwards the entire host shell env (less a small conflict-blocklist — see README env-vars table). Any var you `export` in your shell rc reaches the sandbox. Verify post-refresh: `pi-ensemble shell` → `echo "$SOME_DB_URI"` prints the URI.

PR: [#228](https://github.com/randomm/pi-ensemble/pull/228)

### `vipune search` returns "Failed to download embedding model … 404"

**Symptom:** Inside `pi-ensemble`, `vipune search` errors with `Configuration error: Failed to download embedding model 'BAAI/bge-small-en-v1.5': request error: http status: 404`. Suggests `huggingface-cli download …`.

**Cause:** vipune downloads the embedding model on first semantic-search call. Its HTTP client 404s on the pinned revision (URLs work via `curl` — likely a redirect/User-Agent quirk).

**Fix:** The image pre-fetches the model into `/opt/hf-cache-seed/` and the entrypoint seeds the named cache volume from there on first start. If you're seeing the 404, your image is stale: `./install.sh` to rebuild. Verify the seed is present:

```bash
docker run --rm randomm/pi-ensemble:latest ls /opt/hf-cache-seed/hub/models--BAAI--bge-small-en-v1.5/snapshots
```

Should list the pinned revision SHA.

PR: [#205](https://github.com/randomm/pi-ensemble/pull/205)

### "fd not found. Downloading..." / "ripgrep not found. Downloading..." at startup

**Symptom:** First few lines after `pi-ensemble` boot show Pi auto-downloading `fd` and `rg` into `~/.pi/agent/bin/`. Adds ~10s of boot time + requires network.

**Cause:** Image is stale (pre-#203). Modern image bakes both binaries in via apt.

**Fix:** `./install.sh` to rebuild. Verify: `docker run --rm randomm/pi-ensemble:latest which fd rg` → `/usr/local/bin/fd` + `/usr/bin/rg`.

PR: [#203](https://github.com/randomm/pi-ensemble/pull/203)

## Docker-based MCP servers

### `MCP: Failed to connect to <name>: spawn docker ENOENT` or `MCP error -32000: Connection closed`

**Symptom:** Project-level MCP servers configured in `.pi/mcp.json` with `command: "docker"` fail to connect inside the sandbox. Host-mode `pi` works fine. Pre-#216 the error was `spawn docker ENOENT` (docker CLI missing); pre-#220 it was `MCP error -32000: Connection closed` (CLI present, no socket mounted by default).

**Cause:** Stale wrapper / image. Post-#220 the docker socket is bind-mounted by default — no env-var flag needed.

**Fix:** Refresh.

```bash
cd ~/.config/opencode/pi-ensemble && git pull && ./install.sh
```

Then relaunch `pi-ensemble` (no env vars) and `/mcp` should show the docker-based MCP servers connected. Spawned MCP containers are siblings on the host's daemon — visible in the host's `docker ps`.

PR: [#220](https://github.com/randomm/pi-ensemble/pull/220)

### `docker: permission denied while trying to connect to the Docker daemon socket`

**Symptom:** Docker socket is mounted but `docker ps` inside the sandbox returns "permission denied".

**Cause:** The entrypoint's `chmod 666 /var/run/docker.sock` didn't fire — likely an outdated image (pre-#216 entrypoint runs as `vscode`, can't chmod a root-owned socket).

**Fix:** Rebuild the image.

```bash
cd ~/.config/opencode/pi-ensemble && ./install.sh
```

Verify post-rebuild: `pi-ensemble shell` → `ls -la /var/run/docker.sock` shows `srw-rw-rw-`.

PR: [#216](https://github.com/randomm/pi-ensemble/pull/216)

### I want a tighter sandbox — disable docker socket access

**Symptom:** You want the pre-#220 isolation where the sandbox can't talk to the host docker daemon.

**Cause:** Docker socket grants root-equivalent host access from inside the sandbox (any process can mount host paths, launch privileged containers, etc.). The default-on behavior accepts this trade-off; the opt-out is for users who don't.

**Fix:**

```bash
export PI_ENSEMBLE_NO_DOCKER_SOCKET=1
```

Note: docker-based MCPs in `.pi/mcp.json` will stop working under this opt-out.

PR: [#220](https://github.com/randomm/pi-ensemble/pull/220)

## SSH from inside the sandbox

### `ssh remote-host` fails with "Permission denied (publickey)" or "Error connecting to agent"

**Symptom:** Agents inside the sandbox can't `ssh` to remote hosts that work on the host. `ssh-add -l` returns one of:
- *"Could not open a connection to your authentication agent"* — no agent at all
- *"Error connecting to agent: Permission denied"* — the forwarded agent socket exists but isn't usable

Outbound `ssh` then fails with `Permission denied (publickey,...)` even though you have working keys on the host.

**Cause:** Two sub-cases:

1. **Stale wrapper (pre-#220).** The wrapper didn't bind-mount `~/.ssh/` or forward `$SSH_AUTH_SOCK`. Fix: `cd ~/.config/opencode/pi-ensemble && git pull && ./install.sh`.
2. **Broken agent forward (pre-#227).** Wrapper attempted the forward but Docker created an empty **directory** at `/run/host-ssh-auth.sock` instead of a usable socket — common on macOS Docker Desktop where the host's `$SSH_AUTH_SOCK` is a launchd-managed path Docker can't bind-mount cleanly. SSH then loops on "Error connecting to agent" even though on-disk keys at `~/.ssh/` would work. **Post-#227 the entrypoint detects this and unsets `SSH_AUTH_SOCK`** so SSH falls back to your on-disk keys cleanly. Refresh with `./install.sh`.

**Diagnose your case (inside the sandbox):**

```bash
echo "SSH_AUTH_SOCK=${SSH_AUTH_SOCK:-<unset>}"
ls -la "${SSH_AUTH_SOCK:-/dev/null}" 2>&1   # should show `srw-` (socket); `drwx` = broken bind-mount
ls -la ~/.ssh/                              # on-disk keys + known_hosts + config
```

**Fix:**

```bash
cd ~/.config/opencode/pi-ensemble && git pull && ./install.sh
```

Then relaunch `pi-ensemble`. Inside, `ssh-add -l` either lists your forwarded identities (working forward) or reports "Could not open a connection to your authentication agent" CLEANLY (broken forward → fell back to disk keys). `ssh remote-host` should succeed via one path or the other.

**If you have no SSH agent running on the host:** start one before launching pi-ensemble so a forwardable agent socket exists:

```bash
eval "$(ssh-agent -s)"
ssh-add ~/.ssh/id_ed25519   # or whichever key
pi-ensemble
```

**On-disk keys + UID mismatch (macOS edge case):** the wrapper mounts `~/.ssh/` RO so keys are visible inside, BUT SSH's `StrictModes` may refuse keys whose host UID (501 on macOS) doesn't match the container's vscode UID (1000). Workaround: use ssh-agent (above) — the agent socket bypasses file-perm checks.

**Last-resort manual recipe (pre-refresh or weird host env):** explicit key, bypass any broken agent.

```bash
ssh -o IdentityAgent=none -i ~/.ssh/<your-key> user@host
```

PRs: [#220](https://github.com/randomm/pi-ensemble/pull/220), [#227](https://github.com/randomm/pi-ensemble/pull/227)

### I want a tighter sandbox — disable SSH credentials access

**Symptom:** You want the sandbox to have no SSH identities — neither `~/.ssh/` keys nor agent forwarding.

**Cause:** SSH agent forwarding lets the sandboxed agent impersonate any identity loaded in your host agent (push to remotes, ssh into prod boxes, etc.). The default-on behavior accepts this trade-off; opt out if you don't.

**Fix:**

```bash
export PI_ENSEMBLE_NO_SSH=1
```

Note: outbound SSH from inside the sandbox will stop working — including agent operations that ssh to remotes (e.g. `git push` over ssh, deploy scripts).

PR: [#220](https://github.com/randomm/pi-ensemble/pull/220)

## Web research

### @explore agents are `curl`-scraping web pages instead of using `parallel-cli`

**Symptom:** `dispatch_peek` on a running @explore agent shows it `curl`-ing random pricing/blog pages. Long turn counts (30+) burning hundreds of thousands of tokens. Often returns hallucinated or stale data because pages dynamically render.

**Cause:** The image is stale — pre-#218 the sandbox didn't install `parallel-cli`. Without it, @explore's `parallel-cli search` returns `command not found` and the agent falls back to bare `curl` page-scraping (slow, bot-blocked, often wrong).

**Fix:** Rebuild the image.

```bash
cd ~/.config/opencode/pi-ensemble && ./install.sh
```

Verify post-rebuild: `pi-ensemble shell` → `which parallel-cli` returns a path; `parallel-cli --version` prints; `parallel-cli search "test"` returns structured results (requires `PARALLEL_API_KEY` exported on host — auto-forwarded by the wrapper).

If you don't have a parallel.ai account, @explore degrades to telling you to set up one. There's no other web-search path baked into the role — webfetch / Context7 are documented as unreliable for real-time data.

PR: [#218](https://github.com/randomm/pi-ensemble/pull/218)

## Vision / images

> **Reminder:** Pi attaches a file as multimodal input only when its path is prefixed with `@` (e.g. `@/Users/you/Downloads/foo.png describe this`). Dragging an image into the terminal pastes the path but does NOT add the `@` — you have to type it yourself. Without it, Pi treats the path as plain text and never sends image bytes.

### Image dropped but model never mentions it / treats it as text

**Symptom:** Pasted path appears in the prompt, no error, model's reply ignores the image entirely or describes the path string instead of the image.

**Cause:** Missing `@` prefix. Pi only triggers multimodal attachment for `@<path>` tokens; a bare absolute path is just a string.

**Fix:** Re-send with `@` prefixed. Use `Home` / `Ctrl-A` after the drop to jump to the start of the pasted path, type `@`, submit.

### Dropped image rejected by sandbox-fs-guard

**Symptom:** After dragging an image into the `pi-ensemble` session and prefixing `@`, Pi's `read` tool errors with `"Path '/Users/.../Downloads/foo.png' resolves outside the sandbox workspace"`.

**Cause:** The image lives outside the project workspace and outside the wrapper's default image-dir list (`$HOME/Downloads`, `$HOME/Desktop`, `$HOME/Pictures`).

**Fix:** Add the dir to `PI_ENSEMBLE_EXTRA_IMAGE_DIRS` before launching, OR move/copy the image into your project workspace.

```bash
PI_ENSEMBLE_EXTRA_IMAGE_DIRS="$HOME/Documents/screenshots" pi-ensemble
```

The wrapper bind-mounts each listed dir RO and tells `sandbox-fs-guard` to permit reads under those roots.

PR: [#213](https://github.com/randomm/pi-ensemble/pull/213)

### Image attached but model says "I can't see images"

**Symptom:** `@image.png` is included in the prompt, the file exists, but the model response says it can't see / process images.

**Cause:** Pi only routes image bytes to providers whose model entry declares `"input": ["text", "image"]` in `~/.pi/agent/models.json`. Custom OpenAI-compatible providers default to text-only.

**Fix:** Edit `~/.pi/agent/models.json` — add `"input": ["text", "image"]` to the model entry. Built-in providers (Anthropic Claude, OpenAI GPT-4o, Google Gemini) know vision capabilities natively; custom providers need the hint.

```jsonc
{
  "id": "qwen3.6-35b",
  "input": ["text", "image"],   // ← add this
  // ... rest of entry
}
```

PR: [#213](https://github.com/randomm/pi-ensemble/pull/213)

## Session resume

### `pi-ensemble -r` opens the picker but selecting a session does nothing

**Symptom:** `pi-ensemble -r` shows the resume picker with sessions listed. Selecting one returns "No session selected" or fails silently. Or: the picker shows sessions from many projects and your specific one is hard to find.

**Cause (pre-#207):** Pi keys sessions by absolute `cwd`. The old wrapper mounted projects at `/workspace`, so sandbox sessions for ALL projects co-mingled in a single `~/.pi/agent/sessions/--workspace--/` bucket. Selecting a session whose original `cwd` was a host path (`/Users/…/projects/foo`) failed to load because that path didn't exist inside the container.

**Fix:** `./install.sh` to refresh the wrapper. Post-#207, the wrapper mounts your project at its host absolute path inside the container — same `cwd` as host mode, so session buckets align. `pi-ensemble -r` from any project shows sessions for that project only, and host-mode `pi -r` sessions are visible too (and vice versa).

**Pre-fix sessions:** anything written to `~/.pi/agent/sessions/--workspace--/` before #207 is orphaned in that bucket. To resume one you specifically need, `pi --session <uuid>` from inside the container (it will search across scopes).

PR: [#207](https://github.com/randomm/pi-ensemble/pull/207)

### Container hostnames change between sandbox runs

**Symptom:** Container names like `pi-ensemble-nessie--8cbaf2dccfbd-a1b2c3d4` appear in `docker ps`. New name each launch.

**Cause:** Wrapper composes the container name as `pi-ensemble-<project>-<project-hash>-<run-suffix>`. The project-hash disambiguates DIFFERENT projects (avoiding collisions in `docker ps`). The 8-hex run-suffix disambiguates concurrent sessions in the SAME project. Not a bug.

**Not a fix:** The name doesn't affect functionality — only how containers show up in `docker ps`. `pi-ensemble stop` enumerates all containers matching the project's `<base>-*` prefix and stops them. `pi-ensemble status` lists all of them.

### `docker: Error response from daemon: Conflict. The container name "/pi-ensemble-..." is already in use`

**Symptom:** Trying to start a second `pi-ensemble` in the same project errors with a name-conflict from docker.

**Cause:** Pre-#217 the container name was deterministic per project, so two concurrent sessions in the same project collided on `docker run --name`.

**Fix:** Pull + rebuild — `cd ~/.config/opencode/pi-ensemble && git pull && ./install.sh`. Post-#217 each `pi-ensemble` invocation gets a unique 8-hex run-suffix; concurrent sessions in the same project Just Work.

PR: [#217](https://github.com/randomm/pi-ensemble/pull/217)

## State + caches

### `pi-ensemble prune` warning about volumes "in use"

**Symptom:** Running `pi-ensemble prune` errors with `volume is in use` for `pi-ensemble-cache` etc.

**Cause:** Another `pi-ensemble` session is currently running and holding the named volume.

**Fix:** Exit running `pi-ensemble` sessions (the wrapper uses `docker run --rm` so they're gone on exit) then re-run `prune`. Use `docker ps` to find still-running containers.

### Bind-mounted host state showing up in container as `root`-owned

**Symptom:** Files written by `pi-ensemble` end up on the host owned by `root` instead of your user.

**Cause:** This shouldn't happen — the image's `vscode` user has UID 1000, the wrapper does NOT use `--user root`. If you see this, you're likely running an old image (pre-#200) or a custom Dockerfile derivative that switched users.

**Fix:** `./install.sh` to rebuild the official image. Verify: `docker run --rm randomm/pi-ensemble:latest id` → `uid=1000(vscode)`.

## Diagnostics

### Confirm a bind-mount is reaching the container

```bash
docker run --rm \
  -v "$HOME/.pi/agent/models.json:/home/vscode/.pi/agent/models.json:ro" \
  randomm/pi-ensemble:latest \
  jq '.providers | keys' /home/vscode/.pi/agent/models.json
```

Should print your provider keys. If it prints `null` or the file is missing, the bind-mount didn't take.

### Confirm an env var was forwarded

```bash
docker run --rm \
  -e "TRAIL_OPENERS_LLM_KEY=$TRAIL_OPENERS_LLM_KEY" \
  randomm/pi-ensemble:latest \
  bash -c 'env | grep -E "(API|LLM)_KEY" | head -5'
```

Inside the wrapper-spawned container, the same env vars are auto-forwarded by pattern match (`*_API_KEY` / `*_LLM_KEY`).

### See what the wrapper actually does

`pi-ensemble shell` drops you into bash inside the container with all the same mounts + env. From there:

```bash
env | sort                       # what env was forwarded
mount | grep -v 'cgroup\|proc'   # what was bind-mounted
ls ~/.pi/agent/                   # what state is visible
cat ~/.config/mcp/mcp.json        # MCP server config
```

## When in doubt

`./install.sh` is the right first move for almost everything. It:

- Rebuilds the image (cache-fast unless prereqs changed)
- Refreshes the `~/.local/bin/pi-ensemble` symlink
- Re-writes `~/.config/mcp/mcp.json` with the current codebase-memory-mcp wiring
- Validates that codebase-memory-mcp is reachable on PATH

If after `./install.sh` something still doesn't work, capture:

1. `pi-ensemble --version` (or the wrapper file path: `which pi-ensemble`)
2. `docker images randomm/pi-ensemble --format '{{.Repository}}:{{.Tag}} {{.CreatedSince}} {{.Size}}'`
3. The exact failing command + error message
4. Open an issue at <https://github.com/randomm/pi-ensemble/issues>.

## `/work` driver state recovery

### Symptom

`/work N` says it can't start, or halts immediately with a message like:

```
pi-ensemble /work driver halted on issue #N: state-file inconsistencies detected.
  - pipelineState.inFlightJobIds includes <jobId> but log has no record of it
Inspect <project>/.pi/work-state/N.json or rm to start fresh (your git work is unaffected; only the workflow tracker state is removed).
```

Or you get a loud schema-version error when re-invoking `/work` after upgrading pi-ensemble:

```
work-state: <path> has schemaVersion=2 but this build expects 1. This /work cycle was started under a different driver version. …
```

### Cause

Since this PR, `/work` runs through a compiled state-machine driver (`extension/src/work-driver.ts`). Workflow state persists at `<project>/.pi/work-state/<issue>.json` so the user can intervene surgically when subagent providers degrade and the driver can resume cleanly after restart.

The state file is the durable contract that lets the driver know which step is current, what dispatches have completed, and which caps have already fired. Two situations can leave it in a state the driver refuses to run against:

1. **Mid-flight crash**: Pi got killed (process exit, machine reboot, OOM) while a dispatch was in flight. The eventLog has a `dispatch-started` without a matching `dispatch-completed`. The driver detects the orphan jobId on resume and halts rather than fabricating a result.
2. **Schema version mismatch**: you upgraded pi-ensemble between `/work` invocations, and the saved state-file's `schemaVersion` no longer matches what the new driver expects. We never auto-migrate state silently.

### Fix

Pick the option that matches your context:

**A. Resume manually (preferred for valuable in-flight work).** Open `<project>/.pi/work-state/<issue>.json` in your editor. The `eventLog` array shows every step the driver completed and every dispatch's outcome. Worktree path, branch name, PR number (if any), and last review round are all in `pipelineState`. Use that to decide what to do next yourself: finish the work in the worktree manually, or push the PR if the branch is ready, or rm the state file and start fresh.

**B. Start fresh.** `rm <project>/.pi/work-state/<issue>.json` — only the workflow-tracker state goes; your git work (worktree, branch, commits, PR) is unaffected. Then re-run `/work N` to begin a new cycle. The driver will detect that no PR / branch / worktree exists yet for this issue and run Steps 1-3 from scratch — for issues where the developer already pushed a PR, you may want to skip that path and resume manually instead.

**C. Work the issue outside the driver.** There is no longer a prose `/work` fallback — #393 deleted it, because a flow with no state file and none of the verification gates is the failure class the driver exists to remove. If the driver itself is the problem, use `/do "<what you want done>"`: same subagent toolkit, no compiled cycle, no GitHub issue required. The driver's state file is left untouched.

### Inspecting the state file directly

The state file shape (schema v1) is:

```jsonc
{
  "schemaVersion": 1,
  "resumable": false,          // v1 is observational; user intervenes, no auto-replay
  "issue": 547,                    // primary issue (state-file path + branch anchor)
  "issues": [547, 548, 549],       // PR10 — all issues passed to /work; absent for single-issue cycles
  "startedAt": <epoch-ms>,
  "updatedAt": <epoch-ms>,
  "pipelineState": {
    "currentStep": "lens-review",   // explore | plan | branch | develop | adversarial | commit-pr | lens-review | lens-fix | step-back | handoff | ci | merged
    "lastCompletedStep": "commit-pr",
    "inFlightJobIds": [],
    "branchName": "feature/issue-547-fix-thing",
    "worktrees": { "task-a": "/abs/path/.worktrees/task-a", ... },  // populated for N>1 fanout
    "workstreams": { "task-a": { id, scope, paths, outOfScope }, ... },  // PR3 decomposition
    "reviewRound": 2,
    "reviewCapStartedAt": <epoch-ms>,
    "ciRetryCount": 0,        // PR2 — outer ci → develop retry counter, capped at MAX_CI_RETRIES
    "retryAttempts": { "adversarial": 1 },  // PR5 — per-step RETRY_ONCE budget tracking
    "exploreVerdict": "NEEDS_WORK",  // PR6 — explore's parsed verdict (NEEDS_WORK | ALREADY_COMPLETE | NEEDS_CLARIFICATION)
    "activeIssues": [561, 563],      // PR10 — NEEDS_WORK subset for multi-issue cycles; fallback [issue] when absent
    "droppedIssues": [               // PR10 — ALREADY_COMPLETE / NEEDS_CLARIFICATION issues filtered out
      { "issue": 562, "verdict": "ALREADY_COMPLETE", "reason": "satisfied by PR #534" }
    ],
    "handoffSnapshot": {       // PR5 — captured by runHandoff for renderer surfaces
      "modifiedFiles": ["src/foo.ts"], "unstagedCount": 1, "stagedCount": 0,
      "branchExists": true, "branchPushed": true, "headSha": "abc1234",
      "capturedAt": <epoch-ms>
    },
    "plumbReports": [],
    "status": "running"             // running | merged | handoff | aborted
  },
  "eventLog": [
    { "kind": "step-started", "step": "explore", "at": <epoch-ms> },
    { "kind": "dispatch-completed", "step": "explore", "role": "explore", "ok": true, ... },
    { "kind": "branches-fanned-out", "step": "develop", "workstreams": ["task-a", "task-b"], "at": ... },  // PR3
    { "kind": "branch-completed", "step": "develop", "workstreamId": "task-a", "ok": true, ... },         // PR3
    { "kind": "branches-converged", "step": "develop", "verdicts": [{ "id": "task-a", "ok": true }, ...] },// PR3
    { "kind": "lens-skipped-empty-diff", "round": 1, "at": ... },  // PR6 — guard fired (no diff to review)
    { "kind": "adversarial-skipped-empty-diff", "workstreamId": "default", "at": ... },  // #286 — guard fired (empty diff, no adversarial spawn)
    { "kind": "cap-hit", "cap": "developer-timeout", "nextStep": "handoff", ... },  // PR5 cap shapes (below)
    ...
  ]
}
```

The `eventLog` is append-only and authoritative; `pipelineState` is a derived snapshot for O(1) "where are we" reads. Large subagent outputs go to claim-check artifacts under `.pi/work-state/<issue>/<jobId>.txt` and are referenced from the corresponding `dispatch-completed` event's `artifactPath`.

### Cap-hit shapes and what to do about each

When the driver halts intentionally on a load-bearing failure (rather than crashing), it appends a `cap-hit` event with a named `cap` shape, sets `currentStep="handoff"`, and runs `runHandoff` which posts a rich operator comment to the GitHub issue / PR (or surfaces it in chat if the GitHub post fails). The cap shape determines the operator-readable explanation and the recovery commands the renderer suggests.

| `cap` value | What it means | Most-common operator action |
|---|---|---|
| `developer-timeout` | Developer subagent SIGTERM'd at its wall-clock spawn cap (default 90 min via `PI_ENSEMBLE_SPAWN_TIMEOUT_MS_DEVELOPER`). Files-modified-but-uncommitted count appears in the message. | Inspect with `git status`; retry with a longer cap (`PI_ENSEMBLE_SPAWN_TIMEOUT_MS_DEVELOPER=5400000 && rm .pi/work-state/N.json && pi`) or split the issue. |
| `step-failed:<step>` | A HALT-class step's dispatch failed (network / provider error / non-zero exit). For multi-workstream steps (`develop`, `lens-review`), explainCap surfaces an `(N/M workstream branches failed)` parenthetical. Retry exhausted on RETRY_ONCE-class steps (`adversarial`, `lens-review`) also lands here. PR10: `step-failed:merged` fires when ops can't actually merge (auth / branch protection / conflicts / missing required review) — recovery is to run `gh pr merge <PR-N> --squash --delete-branch` manually. | Read the failing dispatch's transcript via `/runs` (path in the handoff comment); retry, or take over manually. |
| `explore-already-complete` | Explore concluded the issue is already done (e.g., satisfied by a prior PR). Driver halts before any branch/develop. No code was written. | `gh issue close N --comment "Verified complete by /work — see prior PR"` if you agree; or `gh issue comment N --body "Additional context: …"` + `rm .pi/work-state/N.json && pi` if you disagree. |
| `explore-needs-clarification` | Explore couldn't determine concrete work (issue ambiguous / missing acceptance criteria). PR13 fixed a false-positive variant where multi-issue cycles produced NEEDS_CLARIFICATION even when bodies existed (the agent's verdict raced the parallel `gh issue view` fetch — pre-PR13 the body was never inlined in the prompt). Re-running on v0.12.13+ resolves recurrences if you saw this before. | Edit issue body via `gh issue edit N`, then `/work N --restart`. |
| `explore-bodies-empty` | PR11 — `gh issue view <N>` returned empty or errored for one or more issues. Pre-condition failure; the driver cannot reliably classify work it can't read. Common causes: gh version with projectCards GraphQL deprecation, gh extension hijacking stdout, expired auth, network. | `gh auth status && gh --version` to confirm gh setup. `gh api repos/<owner>/<repo>/issues/<N> --jq .body` works when `gh issue view` is broken — use it to verify the issue body fetches via REST. `gh extension list` if a misbehaving extension is suspected. Once fixed, `rm .pi/work-state/N.json && pi`. |
| `step-back-revise-spec` | PR12 — `runStepBack` fired (lens-review fix loop kept flagging the same shape across rounds — spec-level problem fingerprint). The @explore SDD analysis identified which of the six SDD elements (outcomes / scope / constraints / prior decisions / task breakdown / verification) is underspecified, and produced a proposed revision. | Read the proposed revision (surfaced in the handoff body): `cat tmp/issue-N/handoff-comment.md`. Apply the revision via `/plan N` (or `gh issue edit N`). Restart the cycle: `/work N --restart`. The `--restart` flag wipes the prior state file so the fresh cycle reads the revised spec. |
| `commit-pr-incomplete-consolidation` | PR14 — multi-workstream cycles run N developers in N worktrees with uncommitted changes; ops's commit-pr step is supposed to consolidate ALL of them onto the integration branch. The post-dispatch gate found files from one or more workstreams missing from the committed diff — ops drifted and committed a partial slice. Pre-PR14 the partial diff shipped silently (v0.12.13 /work 577 closed an issue with 1 of 3 workstreams' changes — root fix lost from main). | Each missing workstream's work is still uncommitted in its worktree: `git -C .worktrees/issue-N-<id> status --porcelain`. Apply each missing diff to the integration tree: `git -C .worktrees/issue-N-<id> diff HEAD \| git apply --index`. Verify (`git diff --name-only --cached`), commit, push. Or restart: `rm .pi/work-state/N.json && /work N --restart`. The handoff comment quotes paste-and-run-ready commands for each missing workstream. |
| `adversarial-loop` | `adversarial_loop` ran its 3-round internal fix loop and could not reach APPROVED. For N>1 multi-workstream cycles, the aggregate-rejected case (any per-workstream adversarial REJECTED) also fires this cap, with per-workstream findings tagged `[workstream <id>]`. | Read the rejection findings; if phantom, merge manually; if real, take over the worktree to fix or split the work. |
| `round-cap` | Lens-review hit its 3-round cap with findings still open — review loop didn't converge. Reaching handoff means the verdict was `CRITICAL_ISSUES_FOUND`, the adversarial gate had not approved, or the findings could not be posted to the PR; otherwise the cap routes to `ci` instead (see "A `round-cap` cycle reached CI instead of parking"). | Inspect the latest `lens-issues-found` event in `eventLog`; if findings cluster around a theme, that's a spec-level problem (consider revising the issue body before re-running). |
| `wall-clock` | Lens-review fix loop exceeded the 90-minute wall-clock cap. | Same as `round-cap` — inspect findings, decide whether to retry or take over. |
| `ci-retry` | CI failed `MAX_CI_RETRIES` times in a row (default 2 → 3 attempts total). Either CI is permanently broken for this branch, or develop keeps producing the same failure. | Read CI logs (URL in the handoff `ci-status` event); fix manually, or `rm .pi/work-state/N.json && pi` to re-run from scratch. |

The handoff comment quotes 4 concrete recovery shell commands keyed to the cap shape — paste-and-run-ready. The `/work-status` command renders the same postmortem layout from the state file if you'd rather inspect locally.

### Restarting a /work cycle after revising the issue (PR12)

When `/work N` terminates (handoff / aborted / merged) and you've since revised the issue body — typically via `/plan N` after a `step-back-revise-spec` handoff — re-running `/work N` would silently no-op pre-PR12 (the existing state file still showed `status=handoff`, and the loop never re-entered).

Fix: pass `--restart` to wipe the prior state file and start a fresh cycle.

```bash
/work N --restart            # restart the cycle against the (now-revised) spec
/work --restart N             # order-independent — flag can lead or trail
/work N M --restart           # multi-issue + restart also works
```

Without `--restart`, re-invoking `/work N` on a terminal-state file now emits a clear notify pointing at the recovery: *"`/work` for issue #N already terminated as <status>. To start a fresh cycle (e.g., after revising the issue via /plan), re-run with `--restart`..."*.

`--restart` only wipes the driver's state file (`.pi/work-state/N.json`). Worktrees and feature branches from the prior cycle are NOT removed — the branch step reuses them at runtime: a leftover at the same path with no uncommitted work and no unpushed commits is removed and recreated (the common path, unchanged), but a leftover that HOLDS work is refused instead (see `worktree-dirty-preremove` below). If you want a fully clean slate, salvage any work first, then `git worktree remove --force -- .worktrees/issue-N-*` and `git branch -D feature/issue-N-*` before re-running.

### `worktree-dirty-preremove` — the branch step refuses a worktree that holds uncommitted work (#475)

**Symptom:** `/work N --restart` (or a fresh `/work N` over a surviving worktree directory) halts at step 3 (branch) with cap `step-failed:branch` and a plumb report reading *“refusing to force-remove existing worktree <path> — it holds unrecoverable work: …”*. No subagent ran; nothing was pushed.

**Why:** the branch step pre-removes a same-named worktree before recreating it, so a resumed cycle is not wedged by its own leftover. But developers are instructed not to commit — a cycle that died mid-develop leaves its diff uncommitted in the worktree, not in the object database. The old `git worktree remove --force` destroyed that with no warning, and deleting unrecoverable work must never be the silent default. The check now runs before the remove: uncommitted files (`git status --porcelain` in the worktree) plus local commits ahead of the base (`git rev-list --count <base>..HEAD`).

**Fix:** the work is still on disk — the path in the plumb report is the worktree itself.

```bash
git -C .worktrees/issue-N-<id> status        # what is uncommitted
git -C .worktrees/issue-N-<id> diff          # the diff
```

- **Salvage it** — `git -C .worktrees/issue-N-<id> diff > /tmp/patch` (and review the diff before deciding), then remove the worktree and re-run: `git worktree remove --force -- .worktrees/issue-N-<id>` and `/work N --restart`.
- **Commit it to a branch** instead, if the work is the branch itself: `git -C .worktrees/issue-N-<id> add -p && git commit`, then push from the worktree.
- **Discard it deliberately** — `git worktree remove --force -- .worktrees/issue-N-<id>`, then re-run. (This is the one place `--force` is safe: you just read what it would destroy.)

A leftover with no uncommitted work and no unpushed commits is still removed automatically — no action needed. The refusal only fires when something unrecoverable is present.

### Stale worktrees from terminal cycles — bulk cleanup

**Symptom:** `git worktree list` shows many `.worktrees/issue-N-*` directories from cycles that parked, aborted or handed off. Each one the next cycle for the same issue refuses (the pre-remove guard above), and `git worktree add` / `remove` operations slow down in the presence of the clutter — 30+ leftover worktrees were measured to cause this on one host before they were swept.

**Why they accumulate.** A worktree is only torn down when a cycle merges cleanly (the `merged` step runs `git worktree remove --force` + `git worktree prune` under the integration lock). Every other terminal outcome — `handoff`, `aborted`, a crash mid-dispatch — keeps its worktree on purpose, because the diff is the only copy of a developer's uncommitted work. That is the right default for one; it becomes clutter for a dozen.

**Which ones are safe to remove.** A worktree is safe to bulk-remove when its cycle is **terminal AND the work inside is gone or committed**: the state file at `.pi/work-state/<issue>.json` has `pipelineState.status` of `handoff` or `aborted` (not `running`), and the worktree itself is clean (no uncommitted files, no local commits ahead of its base). A `running` state file with a live owner pid is a cycle that is still in flight — do not touch it. A terminal state file whose worktree holds uncommitted work is a refusal case, not a cleanup case: salvage first (see above).

**The recipe** (run from the repo root, one issue at a time):

```bash
# 1. What exists, and what each holds
git worktree list

# 2. Is the cycle terminal? (status: handoff | aborted is safe; running is not)
cat .pi/work-state/540.json

# 3. Is the worktree clean? (empty output = safe to remove)
git -C .worktrees/issue-540-task-a status --porcelain
git -C .worktrees/issue-540-task-a rev-list --count origin/main..HEAD

# 4. Salvage anything worth keeping (the diff, if any)
git -C .worktrees/issue-540-task-a diff > /tmp/issue-540-task-a.patch

# 5. Remove the worktree and prune its administrative record
git worktree remove --force -- .worktrees/issue-540-task-a
git worktree prune
```

Repeat per issue. The `--force` in step 5 is safe *only after* step 3 confirmed the tree is clean — the same rule as the single-worktree case above. `git worktree prune` (step 5, second command) drops the administrative record for any whose directory is already gone.

**What is NOT safe to bulk-remove:**

- A worktree whose state file says `status: running` and whose `owner.pid` is alive (the cycle is in flight).
- A worktree that holds uncommitted work, even if its cycle is terminal — that is the `worktree-dirty-preremove` case; salvage or commit it first.
- A worktree for an issue whose state file is missing — the state file may have been `rm`'d by an operator without removing the worktree, so the terminal-status check above cannot be applied. Inspect the worktree directly (`git -C .worktrees/issue-N-<id> status` and `git -C .worktrees/issue-N-<id> log --oneline -5`) before deciding.

There is no built-in bulk-cleanup command. The recipe above is the documented path; a one-liner is tempting but the per-worktree check is what makes it safe, and skipping it is how a clean sweep becomes a data loss.

### `lens-fix-not-integrated` — the fix never reached the branch

A lens-fix round ran but its output did not land: either the integration failed (a dirty repo root, an apply conflict, a git error) or the fixer wrote nothing in any worktree. The cycle now halts here.

It used to continue. The failure was recorded in `plumbReports` rather than the event log *specifically* so the log tail would stay `adversarial-approved` and routing would carry on — which meant the one consumer that could have acted on it never saw it. The next round then re-read `origin/<base>..origin/<branch>`, which had not moved, and re-reported the identical findings at escalating severity until the round cap fired. Measured on nessie #686: two full review rounds after the driver had already logged that it refused to integrate, with the whole review budget spent on a defect that was already solved on disk. Same shape on #673 and #677.

**The fix may still be on disk.** Check `git -C .worktrees/issue-<N>-<id> status` before re-running — the developer's work is usually there, uncommitted.

### `integration-verify-failed` — the consolidated tree does not build

`commit-pr` runs the project's `.pi/verify-cmd` against the **integrated** tree, between the commit and the push. Everything upstream saw one workstream in isolation: the develop gate ran inside a single worktree and adversarial reviewed a single worktree's diff. Two workstreams that each pass alone can still fail together — one renames or deletes what another still refers to — and that defect is *created* by integration, so integration is the only place it can be caught.

When it fires, **nothing was pushed and no PR exists**. The failing output is in the plumb-report on the handoff. Typical cause: one workstream moved or removed a symbol another still calls. Fix the interaction and re-run.

Unlike other `commit-pr` failures this does **not** fall back to the LLM ops dispatch. That fallback exists to absorb environment variance (an apply conflict, a rejected push); "this does not build" is a verdict, and letting ops push the identical tree would make the gate one that cannot fail.

Projects with no `.pi/verify-cmd` skip the check entirely and are unaffected.

### How a subagent's life is bounded

Two mechanisms, and only one of them is meant to fire in normal operation.

| Mechanism | Default | Env var | What it is for |
|---|---|---|---|
| Inactivity watchdog | 25 min of **zero stdout** | `PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS` (`0` disables) | The real hang detector. A healthy child emits an event at every turn/tool boundary, so silence — not slowness — is the signal. |
| Runaway backstop | 2 h wall-clock | `PI_ENSEMBLE_SPAWN_TIMEOUT_MS` | Catches a child looping forever while still emitting events, which liveness cannot see. Nothing else should reach it. |

This replaced a table of six per-role wall-clock caps. Those were raised twice — [#296](https://github.com/randomm/pi-ensemble/issues/296) and [#553](https://github.com/randomm/pi-ensemble/issues/553) — and both times the finding was the same: the number was too small for a *healthy* child. Provider speed varies by an order of magnitude, so a wall-clock number never means the same thing on two models, and the per-role table had already drifted out of sync with this documentation.

**If a child hits the backstop**, treat it as a decomposition problem, not a budget one: two hours of continuous output without finishing means the workstream is too large or the child is looping. Split the issue, or take over manually.

### `ci` step timeout — CI runs > 10 min (PR15)

The `ci` step dispatches `ops` to run `gh run watch <id>`, which blocks until CI completes. Pre-PR15 this inherited ops' 10-min default, so any CI run exceeding 10 min SIGTERM'd mid-watch and routed through `step-failed:ci` handoff (3× this session on nessie's ~15-min pipeline).

PR15 gives `ci` its own 30-min cap (30 × 60000 ms). Override via `PI_ENSEMBLE_CI_WATCH_TIMEOUT_MS` (milliseconds). The per-role ops default this sentence used to name no longer exists — every other `ops` dispatch is bounded only by the two mechanisms in the table above, except `handoff`, which has its own bound (next entry).

If your project's CI genuinely takes longer than 30 min, either raise `PI_ENSEMBLE_CI_WATCH_TIMEOUT_MS` or accept the handoff — inspect the CI run in the browser, then either fix + push or manually merge as appropriate.

The `inlineCiPrompt` also carries a bounded poll-fallback recipe (`gh run view --json status`) so ops has something to reach for if `gh run watch` fails outright.

### A cycle died on `explore-bodies-empty` seconds after starting

**Symptom.** The cycle ends within a second of `step-started`, with `cap-hit{cap:"explore-bodies-empty", nextStep:"handoff"}` and no dispatch of any kind. The issue reads fine in the browser, and `gh issue view <N>` works when you run it by hand. Recovering it costs a `--restart` plus clearing the `needs-human-attention` label.

**Cause.** One `gh issue view` hit a transient network failure — a connection reset, a severed response — and the body fetch had no retry. The handoff text even listed "network" among the likely causes; the failure mode was anticipated and never retried. The cap-hit is terminal by construction: the step router's retry branches key off `dispatch-failed` events, and a `cap-hit` tail gets zero.

**Fix (shipped).** Each issue-body fetch now gets **3 attempts** with the standard transient backoff, and each attempt carries a **45-second deadline** — Node's `exec` has no default timeout, so before this a stalled call could block the cycle indefinitely rather than fail fast. Empty stdout is retried like a rejection, because a truncated response is indistinguishable from a genuinely empty issue until you ask again.

The cap is unchanged and still fails closed: a body that is *still* empty (or still failing) after the last attempt parks the cycle exactly as before, and the recorded reason now says "on every attempt" so it is clear the retries happened. If you see this cap now, the problem is real — check `gh auth status && gh --version`, and see the `explore-bodies-empty` row in the cap table above.

`PI_ENSEMBLE_TRANSIENT_RETRY=0` (the existing escape hatch) restores single-attempt behaviour; `PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS` tunes the wait between attempts.
### The handoff took half an hour to post one comment

**Symptom.** `/work-status` (or `.pi/work-state/<issue>.json`) shows a handoff dispatch with a huge `ms` — e.g. `dispatch-completed handoff ops:handoff ms=1547126`, 25.8 minutes — at the very end of a cycle that produced no code. The comment eventually landed; the run just spent the time.

**Why.** The handoff is the last step and pure reporting: the markdown body is written to `tmp/issue-<N>/handoff-comment.md` before the dispatch, so the ops child only runs `gh <pr|issue> comment --body-file` and `gh <pr|issue> edit --add-label`. Nothing bounded that child. The inactivity watchdog kills on *silence*, and a child that keeps thinking is never silent; the 2 h runaway backstop is far past caring.

**Fix (shipped).** The driver waits 8 minutes for that dispatch and then stops waiting, records `dispatch-failed` on `ops:handoff` with an `errorTail` naming the bound, and posts the same body file plus the same label itself via in-process `gh`. The bound is safe precisely because it destroys nothing — the fallback produces the same artefact, minus the parsed comment URL. Override with `PI_ENSEMBLE_HANDOFF_TIMEOUT_MS` (milliseconds).

That event deliberately carries **no `killCause`**: nothing was killed, the driver simply stopped waiting, and the child may still be running. Tagging it as a kill would also make it the newest kill in the log, so `killDetail()` would report the handoff's own bound instead of the kill that actually ended the cycle — burying the cause under the report of it.

**If the fallback also fails** (no `gh`, unauthenticated, network down), the handoff record is still written: `handoff-emitted` carries `handoffBodyPath`, and the in-chat `HANDOFF DISPATCH INCOMPLETE` banner prints the verbatim `gh ... comment --body-file <path>` command to run by hand.
### A `round-cap` cycle reached CI instead of parking

**Symptom.** `.pi/work-state/<issue>.json` shows `cap-hit{cap:"round-cap", nextStep:"ci"}` and the cycle carried on to Step 8 rather than stopping at handoff. The PR carries a comment headed *"Six-pass review — findings still open at the round cap"*.

**This is intended.** The round cap used to park every capped review. Measured on one overnight run, two of six outcomes died that way (`.pi/work-state/457.json` and `680.json`); a human then judged #457 merge-as-is and #680's PR merged unchanged. Each park cost a re-run plus operator time for a diff that was fine.

A round cap now routes to `ci` only when all of the following hold, and parks at handoff otherwise:

- the verdict is `ISSUES_FOUND` — a `CRITICAL_ISSUES_FOUND` tail always parks;
- the adversarial gate's latest verdict was an approval;
- the residual findings were successfully posted to the PR. If `gh pr comment` fails, or no PR number was captured, the cycle parks and a `plumb-report` says which — a PR that silently swallows three rounds of unresolved findings is worse than a park.

The **wall-clock** cap (90 min) is unchanged and still parks: a review that ran out of time says nothing about how small the remaining findings are.

**It still will not merge for you.** The cycle reaches `runMerged`'s gate as usual — default-deny, needing both an operator grant and executed `gh` evidence — and then a round cap that routed to `ci` holds the merge *on top of that*, however permissively the grant is worded. So the cycle parks as `awaiting-human-merge` with `mergeHold.unresolvedReviewFindings`, PR open, CI run, findings posted.

That hold is deliberate and not redundant with the grant. Every grant this gate honours is conditioned on the quality gates having been met — this repo's own reads *"If all project quality gates have been met (code reviews, CI, linters, type checks etc)"* — and a review loop that exhausted its rounds with findings outstanding is precisely the gate that was not met. Deciding it on the event rather than on the wording keeps behaviour uniform: a project cannot opt into merging unreviewed work by phrasing its doctrine more loosely than it meant to.

**What to do.** Read the PR comment. The findings are severity-ordered, worst first, and none has been fixed. Decide them, then merge by hand or push a fix to the branch.

## Multi-issue `/work` — how grouping is decided (PR16+)

### Behavior

`/work 561 562 563` runs a **deterministic grouping analysis** first, then iterates the resulting groups sequentially:

1. Fetches each issue's body via `gh issue view` (in parallel).
2. Runs `groupIssues()` (pure code, no LLM) which partitions the N issues into K groups.
3. Iterates groups: each group runs as one cycle producing one PR. Multi-issue groups use the PR10 bundled driver-level API (all issues in the group's PR body via `Fixes #X #Y`).
4. Halt-on-non-merged between groups: if a cycle handoffs / aborts, remaining groups are NOT started.

### Grouping rules (first-match-wins, union-find)

**R1 — Explicit link markers** merge issues into the same group. Regex on each body: `depends-on: #N`, `companion-to: #N`, `blocks #N`, `blocked-by: #N` (case-insensitive, hyphen or space).

**R2 — Path overlap ≥ 50% (Jaccard)** merges issues that touch the same files. Extract path-shaped tokens (`src/foo/bar.ts` etc.) from each body's prose + code blocks; compute Jaccard between issue pairs.

**R3 — SPLIT markers** force an issue into its own singleton group even if R1/R2 would have merged it. Regex on the body: `split`, `separate PRs`, `independent`.

**R4 — Subsystem tag prefix** in the issue title merges same-prefix issues (`[frontend]`, `[docs]`, `[ci]`, `[extension]`, ...).

**R5 — Default** is separate groups. Absent R1-R4 evidence, two issues do NOT merge.

### Guardrails

- **`MAX_ISSUES_PER_GROUP` = 3**: a component with more than 3 issues splits into per-issue singletons. Empirical convergence ceiling from vipune `37219c9a` — bigger groups approach the adversarial fix-loop wall.
- **Fanout policy**: today groups run sequentially regardless of `fanout.mode`. Future PR may add per-group parallel worktrees; the `groupIssues()` return already carries the intended mode (`parallel` for K ≤ 2, `sequential` for K > 2), overridable via `PI_ENSEMBLE_PARALLEL_GROUPS`.

### Cycle shape per group

Each group's cycle runs end-to-end (explore → plan → branch → develop → adversarial → commit-pr → lens-review → ci → merged) with the group's issues in `ctx.issues`. Single-issue groups follow today's shape exactly. Multi-issue groups use the PR10 bundled shape — safe *because the grouping rules said the issues belong together*.

Each cycle produces **its own PR** and its own state file (`.pi/work-state/<primary>.json`).

### Pre-PR16 behavior (v0.12.6–v0.12.15)

- **PR10 (v0.12.6–v0.12.9)**: bundled ALL N issues into ONE PR unconditionally. Empirically failed 3× (vipune `37219c9a`: convergence-drop, phantom-bundle, oversized-diff cap).
- **PR15 (v0.12.15)**: retreated to strictly sequential one-PR-per-issue. Safe but ignored the "these issues genuinely belong together" signal.
- **PR16 (v0.12.16+)**: deterministic grouping decides the middle path.

### Verify-full tier: "fast green, full unrun"

The `ci` step runs two tiers. The fast one (`.pi/verify-cmd`) already gated `develop`. The full one is opt-in: create `.pi/verify-cmd-full` whose first non-empty, non-comment line is the command that exercises real dependencies, e.g.

```
cargo test --workspace
```

It runs at the start of `ci`, **before** the CI watch, and its result is a separate `verify-full-status` event so the handoff shows fast and full outcomes independently. That separation is the point: in vipune the fast suite stayed green for ~2.5 months while the real-embedder tests sat behind `#[ignore]`, and nothing in the pipeline could express the difference.

| Outcome | Behaviour |
|---|---|
| file absent | `verify-full-status: skipped` — **visible**, never silent |
| exits 0 | `verify-full-status: success`, CI watch proceeds |
| exits non-zero | `verify-full-status: failure`, `ciRetryCount` bumped, ops dispatch **skipped** this round; the existing ci-retry cap governs the loop |

There is deliberately **no derivation fallback**. An inferred "full suite" recreates exactly the ambiguity the tier exists to remove.

The command runs in the group's worktree, never the repo root — under parallel groups the repo root may be checked out on a different group's branch by the time `ci` runs, so testing there would test the wrong code.

Escape hatches: `PI_ENSEMBLE_VERIFY_FULL=0`, `PI_ENSEMBLE_VERIFY_FULL_TIMEOUT_MS`.

### Type-widening scan

Before each lens review the integrated diff is scanned for removed compiler-enforced invariants: `T` → `Option<T>` (Rust), `T` → `T | null` / `| undefined` and added `?:` (TS), removed `readonly`/`final`/`const`, narrowing to `any`/`unknown`, removed `assert`/`debug_assert!`, removed `pub`/`mut`.

Findings are appended to the lens context with an explicit mandate — *what invariant did this widening remove, and what now guarantees it?* — and emitted as a `widening-scan` event for audit.

**Route-only.** The scan never fails a cycle; it attaches context. It exists because constraint removal was not an event: in vipune, `EmbeddingEngine` → `Option<EmbeddingEngine>` removed an invariant, and a later change read the `Option` as an invitation to write a mock-fallback `None` branch in production.

The "removed X" classes only fire when the token is genuinely absent from the hunk's added lines — otherwise every touched `const` declaration would produce a finding, and a route-only signal that cries wolf gets ignored.

Escape hatch: `PI_ENSEMBLE_WIDENING_SCAN=0`.

### Intent resolution: why a cycle refused to write code

Before planning, `/work` resolves what the issue is actually asking for — from whatever body it was given — and checks whether that is *true* against the code and against the world. It then decides one of three things:

| Verdict | Meaning |
|---|---|
| `proceed` | Intent clear and grounded |
| `proceed-with-assumptions` | Gaps existed, each filled with a defensible default. **Every assumption appears in the PR body** so review sees exactly what was assumed |
| `park` | No code written. The cycle halts at `intent-park` before plan or branch runs |

Park reasons, each with its own operator action:

| Reason | What it means |
|---|---|
| `underspecified` | The issue does not say enough to build from |
| `contradicted-by-code` | Its central claim disagrees with the code as it actually is — usually a stale issue, or one already fixed |
| `already-implemented` | The work appears done |
| `too-large` | Not executable as one cycle; split it |
| `premise-unsound` | It rests on an API or behaviour that could not be substantiated |

**A missing or unreadable verdict parks.** Before this, an absent token defaulted to "build it" — silence was treated as permission. Parking early is cheap: it costs one explore dispatch rather than a whole cycle ending in a bad PR.

The resolver runs in the `explore` role, which is structurally denied `write`/`edit`/`multiedit`. That is deliberate — an agent holding edit tools rationalises ambiguity away, because building is cheaper than asking.

Grouping markers (`Split:`, `Depends-on:`, subsystem tags) remain a **fast path**, never a requirement. Hand-written and imported issues resolve the same way.

Escape hatch: `PI_ENSEMBLE_INTENT=0`.

### Why the queue halted when only one group failed

A multi-issue `/work` parks a failed group and continues (#368). It halts everything only for a **systemic** failure — a provider spend cap or a quota window — because only those make the next group's attempt pointless.

Before #386 that check read the last `dispatch-failed*` event in the log with no regard for whether it had been **retried and recovered**. The driver retries transient faults, so a cycle could hit a quota window at `explore`, recover, run for another twenty minutes, and park for a completely unrelated reason — and the queue would still stop, citing a failure that had resolved itself twenty minutes earlier.

The check now scans back only as far as the last successful `dispatch-completed`. A failure followed by a success was recovered and does not count.

### Why a cycle halted at `lens-diff-unreadable`

The six-pass review approves when the diff is empty — a cycle that genuinely changed nothing has nothing to review. The hazard, removed in #384, was that "empty" and "I could not find out" were the same value: the diff read swallowed every git error and returned `""`, so a stale `origin/<branch>` ref, a transient git failure, or a `maxBuffer` overrun on a large diff all read as *approved*, and the code merged unreviewed.

Empty is now established **positively**. `git rev-list --count origin/<base>..origin/<branch>` must return 0; only then does the review skip. Anything else — the branch ref missing, git failing, or commits existing while the diff comes back empty — halts with `lens-diff-unreadable` and the git error recorded verbatim.

```bash
git fetch origin --prune          # the usual cause: a stale remote-tracking ref
git rev-list --count origin/main..origin/<branch>
```

Two pre-existing tests (`test-work-driver-pr6.ts`, `test-work-driver-pr11-lens-diff.ts`) claimed to cover the genuine no-work cycle but never created `origin/<branch>`, so they were exercising a git *failure* and passing for the wrong reason. Both fixtures now create the ref.

**If you are wondering whether the six-pass review has been skipping:** check the event log rather than guessing. A skip is recorded, and so is every real run.

```bash
# every cycle, and whether lens-review actually ran
grep -l 'lens-skipped-empty-diff' .pi/work-state/*.json
grep -o 'lens-review×6 ([^)]*)' .pi/work-state/<issue>.json
```

A cycle that aborts or hands off before `commit-pr` never reaches `lens-review` at all — which looks like a skip in the scrollback but is not one.

### Resume — what happens when Pi dies mid-cycle

Before #382 a crash lost the cycle *and* hid the fact. State was persisted only at step boundaries while a single dispatch can run for thirty minutes, so a death inside that window left the file at the *previous* boundary still saying `status: "running"`. A dead cycle and a live one looked identical, forever. (This repo still carries the evidence: `.pi/work-state/547.json` and `551.json` are stuck at `running` with empty event logs.)

Every step now **writes ahead**: before awaiting a dispatch it persists a `dispatch-started` event, the in-flight job id, and the owning process id. All nine steps do this, not just the five that share `runSingleDispatch` — `develop` is the longest-running step in the cycle and has its own fan-out, so covering only the shared helper would have left the biggest window uncovered.

Re-invoking `/work N` on a state file that says `running` now resolves to one of three things:

| Situation | What happens |
|---|---|
| The recorded owner process is **alive** and is not us | **Refused.** Two drivers on one branch interleave commits and produce a PR nobody can review |
| The owner is **gone** and a dispatch was in flight | **Resumed** at the step that was in flight. Completed steps are not re-dispatched |
| Nothing in flight | Continues from the step boundary, as before |

Resume granularity is the **step**, not the dispatch: the child process died and its work with it, so the step starts over rather than continuing mid-flight. That is sound because every step is dispatch-then-verify and the verify gates catch partial work; `commit-pr` and `merged` additionally carry their own idempotency (#362's PR pre-flight, already-merged tolerance).

An in-flight job id with **no** matching `dispatch-started` event is not a crash — it cannot have come from the write-ahead. That is corrupt state, and the existing inconsistency halt still fires on it rather than being silently cleared.

Orphaned `dispatch-started` events are deliberately kept in the log. They are the only record that a dispatch was paid for and lost.

Escape hatch: `PI_ENSEMBLE_RESUME=0`.

### Memory (vipune) — what the flags actually do

Two facts about vipune's scoring drive every retrieval rule here, and neither is guessable from its docs. Both were measured against the binary.

**`--hybrid` scores are Reciprocal Rank Fusion reciprocals (k=25), not relevance.** A perfect identifier match scores `2/26 = 0.0769` — on a 5-row corpus and on a 35-row corpus alike, because both times it was rank 1 in both retrievers. A nonsense query still returns a top row, at `1/26 = 0.0385`. **A hybrid score cannot be thresholded, sorted by, averaged, or compared to a semantic score.** It carries exactly one usable bit: *both retrievers ranked this first*.

**`--recency` mixes time into the score rather than re-ranking.** The composite is `(1-r)*cosine + r*2^(-ageDays/8)`. At `r=0.4` a perfect but 90-day-old match falls out of a `--limit 5` window entirely. So every compiled read uses `--recency 0.0` and sorts on the `created_at` field the JSON already returns.

Retrieval that injects a guard into an agent's prompt therefore requires **both** a semantic floor (0.65) **and** the hybrid agreement bit. Neither alone is sufficient:

| Rule | true positives | false positives |
|---|---|---|
| floor alone | 5/5 | **1/5** — injects a guard about an unrelated file |
| agreement alone | 5/5 | 0/5 |
| **both (AND)** | **5/5** | **0/5** |

The floor cannot separate these by itself for a structural reason: every guard in this store is *about a pi-ensemble filename*, so any plausible basename is semantically near all of them. Cosine cannot tell "about THIS file" from "about SOME file here"; BM25 can, because it only ranks a row first on a literal token match.

Three upstream issues are worked around rather than fixed here — [vipune#177](https://github.com/randomm/vipune/issues/177) (exit code 2 means both "conflict detected" and "you typed the flags wrong"; only stdout separates them), [#178](https://github.com/randomm/vipune/issues/178) (`memory_type` and `status` are settable and filterable but returned by no command, so a supersede cannot read back the type it must preserve), and [#179](https://github.com/randomm/vipune/issues/179) (retrieval telemetry is maintained but unreadable, so candidate promotion has no measured signal).

### Getting told when something needs you

`/work` over several issues is meant to be fire-and-forget, but until #388 nothing it produced reached you outside the Pi session — the scrollback and a JSON file both require you to already be looking. Fire over eight issues, go to lunch, come back to a queue that stopped after twenty minutes.

Set `PI_ENSEMBLE_NOTIFY_CMD` to any command. The message arrives on **stdin** and as `$PI_ENSEMBLE_NOTIFY_MESSAGE`:

```bash
# macOS desktop notification
export PI_ENSEMBLE_NOTIFY_CMD='terminal-notifier -title "pi-ensemble" -message "$PI_ENSEMBLE_NOTIFY_MESSAGE"'

# macOS, no extra install
export PI_ENSEMBLE_NOTIFY_CMD='osascript -e "display notification \"$PI_ENSEMBLE_NOTIFY_MESSAGE\""'

# Linux
export PI_ENSEMBLE_NOTIFY_CMD='notify-send "pi-ensemble" "$PI_ENSEMBLE_NOTIFY_MESSAGE"'

# Anything that reads stdin — Slack, ntfy.sh, a log
export PI_ENSEMBLE_NOTIFY_CMD='curl -sS -d @- https://ntfy.sh/your-topic'
```

It fires on the four states that need a human — parked, queue halted, `awaiting-human-merge`, driver crash — **once per group**, never on a clean merge. The second line is always the action, taken from the same `humanActionFor` the queue summary uses: *"add acceptance criteria to #287"*, not *"issue #287 parked"*.

**It cannot hurt the run.** A missing binary, a non-zero exit, or a hook that never returns is timed out after 5s and swallowed; the queue's outcome is byte-identical with a completely broken hook. The message is never interpolated into the command string — issue titles and provider errors are untrusted text, so they travel on stdin.

### Queue state after you walk away

A multi-issue `/work` run writes its outcome to `.pi/work-state/queue-summary.json`: which groups merged, which parked and why, the human action for each, and — the part nothing else records — the groups that **never started**. Those leave no state file at all, so before #382 the run that parked them was the only place they were ever named, and it died with the session.

`/work-status` with no issue argument now shows the multi-cycle index when more than one cycle exists, including that never-started list. Pass an explicit issue number for the single-cycle detail view.

`/start` reads both files at session open (#390) and leads its readiness line with anything parked — that is usually why you opened the session, and it is the one part you cannot find from `gh pr list` or `gh issue list`. A repo that has never run `/work` sees no change.

### Why a cycle parked as `intent-park:underspecified`

**First, check whether the driver actually read that reason or invented it.** `.pi/work-state/<issue>/spec.txt` now records `parkReasonSource` and `verdictSource`: `"parsed"` means the resolver said it, `"default"` means the parser synthesised it because the token did not match.

That distinction is load-bearing. `underspecified` is both the null value and a real diagnosis, and the driver may override the diagnosis when a complete spec refutes it. Before #404, a resolver that wrote its reason as a markdown heading —

```
### PARK-REASON
already-implemented
```

— missed the colon-anchored regex, got `underspecified` substituted, and then had that override fire: the driver **built work the resolver had said was already done**, and attached an assumption to the PR explaining why it was right to. Both token forms now parse, and more importantly a synthesised reason can no longer license an override.

The rule, in full:

| `INTENT-VERDICT` | `PARK-REASON` | complete spec overrides the park? |
|---|---|---|
| absent | absent | **yes** — the resolver declared nothing |
| `park` | `underspecified` | **yes** — it contradicts itself; the spec wins |
| `park` | unparseable | **no** — it did say park |
| any | any other reason | **no** — never in scope |


Check the spec before believing the label. If `.pi/work-state/<issue>/spec.txt` shows deliverables and acceptance criteria, the park was wrong and you have hit the #397 bug — fixed, but worth knowing the shape.

Two independent causes, both now closed:

**The prompt asked for two verdicts.** The explore prompt carried the legacy `## Verdict` block *and* the `INTENT-VERDICT:` block, each labelled LOAD-BEARING. A resolver answering the legacy one emitted `VERDICT: NEEDS_WORK` — meaning *proceed* — and no `INTENT-VERDICT:`. The driver read only the token it was not given, defaulted to `park`, then defaulted the reason to `underspecified`. Each prompt now asks for exactly one protocol: `INTENT-VERDICT` for a single issue with intent resolution on, the legacy block for multi-issue or with `PI_ENSEMBLE_INTENT=0`.

**Bolded evidence verdicts were discarded.** `parseEvidence` required a bare `confirmed`; resolvers write `— **confirmed**`. On the run that surfaced this, all seven executed-evidence confirmations parsed as `unverifiable`, so the handoff shipped its boilerplate with no evidence attached. The match now tolerates bold and trailing parentheticals, while staying anchored so prose like *"I could not confirm this"* is still `unverifiable`.

**A complete spec now refutes `underspecified`.** `reconcileVerdict` overrides that one park reason when the spec names an intent, at least one deliverable, at least one acceptance criterion, at least one confirmed evidence row, no contradicted row, and no blocking open question (`- **None blocking** — …` does not count as blocking). The verdict becomes `proceed-with-assumptions`, never a plain `proceed` — the resolver did not say proceed, the driver inferred it — and the override is recorded as an assumption so it appears in the PR body rather than only in a trace line.

The override is deliberately narrow. `already-implemented`, `too-large`, `premise-unsound` and `contradicted-by-code` are all compatible with a complete spec and still park. And requiring a *confirmed* evidence row is what keeps "silence is not permission" true: a resolver that fills in the template without checking anything against the code has no confirmed row, so it still parks.

### Handoff recovery commands

A handoff's numbered options are keyed on which cap fired. Caps that halt **before** the branch step — `intent-park`, `existing-pr-detected`, `explore-*` — get a block that says so: nothing was written, no branch exists, nothing timed out. They point at `.pi/work-state/<issue>/spec.txt` and the specific human action, not at `git push`.

Before #398, `intent-park` had no branch in either renderer and inherited a block written for `developer-timeout` — so a cycle that never created a branch was told to run `git push -u origin (branch not captured)`, with the display placeholder inside a copy-pasteable command.

Recovery commands are also **never chained**. They arrive in the Pi chat, and per `modules/core/oo-command-runner.md` the permission matcher cannot wildcard a chained shape, so every unique `a && b` re-prompts you. One command per line.

### Merge authority — why `/work` opened a PR and stopped

**`/work` will not merge unless something explicitly permitted it to.** That is the default, and the absence of a prohibition is not permission.

Two independent gates run at the `merged` step, and both default to "no":

**1. Authority — did anyone allow this?** In order:

| Source | How |
|---|---|
| `operator` | You passed `/work <issue> --merge` for this run |
| `doctrine` | The project's `AGENTS.md` or `CLAUDE.md` explicitly grants it, **and** the judge could quote the granting sentence verbatim |
| `citation-failed` | The judge answered "permitted" but cited a sentence that is not in the file — denied, and flagged |
| `none` | Anything else, including no doctrine files at all |

**Write the grant however you like, in any language (#407).** Until #407 this was three English regexes, and they were wrong in both directions on real files: *"Agents may squash-merge **a** PR to main once CI is green"* — a deliberate grant — matched nothing because the pattern wanted `PRs` immediately after `merge`; and *"does **NOT** merge to main without explicit human approval"* escaped the deny matcher, which wanted `do not`. Now a short-lived read-only judge child reads the documents and answers one question through a schema-validated tool call.

**The judge is not trusted.** It must quote the sentence that grants the permission, and the driver checks that sentence actually appears in the file the judge named before honouring anything. A fabricated quote is denied *and reported as a citation failure*, because a judge inventing policy is something you should hear about rather than see silently swallowed. The judge never sees the developer's argument for why the merge should be allowed — only the documents and the question — so it cannot be talked into a yes.

Prose grants the *exception*; it can never grant the *rule*. Default-deny, the `--merge` operator grant and `PI_ENSEMBLE_MERGE_AUTHORITY=0` live in code and cannot be changed by anything in the repository. If you are unsure whether your wording reads as a grant, say it plainly in one sentence — *"Agents may merge a PR to main once CI is green"* — and check the merged event's `authorityQuote`, which records the exact sentence relied upon.

**2. Evidence — did CI actually pass?** The driver asks `gh`, not the agent that just claimed success. It reads `mergeStateStatus` and `gh pr checks`, and it **fails closed**: an unreadable answer blocks the merge. Unlike every other gate in the driver, "no signal" here means stop, because the next act is irreversible.

Required checks reporting **`skipped` or `neutral` do not count as passing**, even though [GitHub counts them as success](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches). A required workflow that gains a `paths-ignore:` silently becomes a gate that can never fail; this driver refuses to merge on one.

When either gate refuses, the cycle parks as `awaiting-human-merge`. **The work is done and pushed** — only the merge is held. Do not `--restart`: that wipes the state file but not the open PR, so the re-run halts immediately on the `existing-pr-detected` pre-flight. Either merge it yourself, or grant authority and re-run:

```bash
gh pr checks <pr>        # what the checks actually say
gh pr view <pr> --web    # review and merge it yourself
/work <issue> --merge    # or grant authority for a re-run
```

At the `ci` step a weaker version of gate 2 applies: **narration cannot promote a status, but executed evidence can demote one.** An ops agent claiming `ci-status: success` gets checked against `gh`; if `gh` disagrees, it becomes a failure. An unreadable `gh` there leaves the claim standing — burning the retry budget on a run that genuinely passed is worse, and the merge gate is the one that has to be right.

Escape hatch: `PI_ENSEMBLE_MERGE_AUTHORITY=0` restores the previous behaviour, where the driver merged whenever an ops child's reply contained the substring `ci-status: success`.

### Memory searches return the wrong thing (or nothing)

**vipune blends recency into every score by default.** Its config sets `recency_weight = 0.3`, and it returns `(1-w)*raw + w*exp(-1e-6*age)` unless you pass `--recency 0`. The recency term spans 0.3; a whole hybrid top-5 spans about 0.044. So at the default, the ranking is age, not relevance.

Measured on the real store: one memory answering the query, five irrelevant ones. Under `--hybrid --recency 0.3` the correct answer was **not in the top 5**. Under `--recency 0` it was rank 1 by a 2× margin. It degrades with age — rank 1 at one day old, gone from the top 5 by two. This project's corpus spans months.

Three things now prevent it:

- **`searchArgv` is the only place the argv is built**, and it always passes an explicit `--recency 0.0`.
- **Every specialist child is spawned with `VIPUNE_RECENCY_WEIGHT=0`.** This is the one mitigation that is not prompt-shaped: most documented search lines pass no `--recency` at all, and an agent composing its own query would inherit 0.3 regardless of what any prompt says.
- **`test-vipune-argv.ts`** is an offline gate over `modules/`, `agents-base/`, `pi-prompts/`, `skill/`, `docs/`, `README.md` and `AGENTS.md`. It fails if any documented line pairs `--hybrid` with a non-zero recency, or applies a similarity band to a recency-blended score.

**Recency is not banned.** `--recency 0.9 --memory-type observation`, to pull back what a sibling agent stored minutes ago, is a correct use — age-ordering *is* the intent there. What is banned is the combination that measured as broken, and the incoherent one: a hybrid score is an RRF reciprocal (a perfect match reads 0.0769), so a cosine-calibrated band like "0.80+ act" cannot be read against it, and a blended score is not a similarity at all.

**Score bands apply to semantic mode only** — `--no-hybrid --recency 0.0`.

### A dispatch died and the work is gone

Three distinct causes, and they are told apart by *when* the child died.

**The child was about to retry and we hung up on it.** Pi retries transient provider failures itself — 3 attempts, 2s/4s/8s backoff — and stamps `willRetry` on `agent_end`. The harness used to close the child's stdin on any `agent_end`, and rpc mode exits when stdin ends, so the retry never ran. Fixed: stdin stays open while `willRetry` is set. The child's retry is the one worth having — it is in-process, so it resumes with its context intact, where a driver-level retry starts over.

**A fan-out step hit a 429 and halted instead of waiting.** The taxonomy honours a provider's `retry-after` — that is why single dispatches recover from throttling. It never ran for fan-out children, because the router classified only the last event and `runDevelop` ends on `branches-converged`. Fixed. Note the deliberate limit: if *any* workstream succeeded, the step is not retried, because re-running it would re-dispatch work that already landed.

**The machine went to sleep.** This is the most common one on a laptop and it looks exactly like a provider failure — `Provider request error: terminated`. That string is undici's mid-stream body abort, raised when a socket dies; the real cause is discarded upstream. Signs it was a suspend:

- the gap before death is 15–25 minutes with no output
- a long shell command shows huge wall clock and tiny CPU (`real 15m37s / user 0m28s`)
- the same error appears on unrelated providers

Check with `pmset -g log | grep -E 'Sleep|DarkWake'`. Note that `pmset -g custom` showing `sleep 1` is *not* disabled sleep — if the only assertion holding it off is powerd's "Prevent sleep while display is on", the machine sleeps a minute after your screen switches off, in DarkWake cycles you never see.

The fix is not in the harness:

```bash
caffeinate -dimsu          # for the session
sudo pmset -a sleep 0      # permanent
```

### The developer prompt now carries prior memory

At the develop step the driver searches for memories about the files the workstream will touch, and injects what it finds above the task. Rows are framed as **hypotheses** and carry `[vipune:<id>]` so the developer can cite one back if the code disagrees with it.

If the brief is empty, that is recorded (`memory-inject` with `emptyBrief: true`) rather than passing silently — a retrieval leg that returns nothing forever is a failure this project has already shipped once, invisible for the life of the feature because nothing counted it.

**Why the rule differs from the seam's own defaults**, all measured:

| Choice | Why |
|---|---|
| Unfiltered, not `--memory-type guard` | Filtered, `permission-guard.ts` scores 0.0385 and is missed; unfiltered it scores 0.076923 and is found. Guards are 5 of 111 rows — the filter discards 95% of the corpus. |
| Agreement bit only, no `SIM_FLOOR` | Re-adding the floor drops files-hit from 22/24 to 8/24 and removes **zero** false positives. |
| One query per basename, plus the stem | Concatenating names scored the target guard 0.6301 — below any usable floor — where the basename alone scored 0.6513. |

The threshold stays at 0.075 rather than the measured-clean 0.04 separator: 0.075 gives precision 1.00 against 0.04's 0.85, and a memory injected into a developer's prompt is adopted at first exposure.

Escape: nothing to disable here — if vipune is missing, slow or broken, the brief is simply empty and the cycle is unaffected.

### An agent tried to edit a memory and was refused

`vipune update <id> --text "…"` is denied to every role, and the refusal is enforced in
`bash-command-parser.ts` ahead of the permission allowlist so it holds even if the allowlist changes.

The reason is that `update --text` **replaces content in place**: one row before, one row after, no
new row, no `superseded_by` lineage, no undo. The id survives, so any prior citation of that memory
now points at different text — which makes it quieter than `delete`, and worse.

Repairs go through `add --supersedes`, which keeps the original row (six already exist in this
project's store) and leaves the correction auditable and reversible.

If you want to edit a memory yourself, do it outside the harness — this restriction is on agents,
not on you.

### Two contradictory memories — which one comes back?

Recency matters here, but not as a score. vipune can blend age into the ranking (`--recency`), and that is precisely what broke retrieval: the recency term spans `w` while a hybrid top-5 spans ~0.044, so blending replaces the ranking rather than weighting it.

Staleness is resolved in three places instead, none of them the score:

| Where | Mechanism |
|---|---|
| Write time | A conflict at ≥0.85 cosine should `--supersedes` the older row. This is the durable fix — the older memory becomes `superseded` and stops being returned at all. |
| The data model | `MemoryHit.created_at` — always returned by `search --json`, previously discarded by the seam. |
| After retrieval | `preferNewest` collapses near-duplicates to the newest, **per memory type**. |

Type matters because volatility does. A `preference` is the operator's current wish and a `fact` about the codebase decays with every commit, so for those the newest statement wins. A `guard` is a hazard learned once and stays true until the code it describes changes — two guards about one file are usually two *distinct* hazards, so they are never collapsed.

Near-duplicate is judged on content overlap, not on score: two rows that say opposite things about the same subject retrieve at *similar* scores, which is exactly why the score cannot separate them.

### Agents can no longer delete your memories

`agents.json` granted `"vipune *": "allow"` to all six roles. `vipune delete <ID>` takes no confirmation flag, and the wildcard also reached `vipune mcp`. The allowlist is explicit: `search`, `add`, `get`, `list`, `validate`, `doctor`, `version`. `delete`, `update`, `mcp`, `reindex` and `project` are granted to no role — an operator runs those. (`update` was allowed until it was measured to replace content in place with no lineage; see below.)

### False claims in a diff — and why there is no seventh lens

A `/work` cycle shipped a PR with two defects the six-pass review missed entirely, returning one cosmetic LOW finding: a documentation paragraph describing the **bug** as the intended behaviour (contradicting the same file 70 lines below), and invented hardware specifications with no source anywhere in the repo.

The obvious remedy was a seventh "documentation truth" lens. It was researched and rejected:

- **No shipping reviewer has that lane.** Graphite alone publishes a "Documentation issue" category, and its own docs demote it to a bullet under Logic bugs. Codacy's and DeepSource's "Documentation" categories mean *presence*, not truth. Where it exists at all (CodeRabbit) it is a separate pre-merge pass, not a lens.
- **Consistency detection is not truth detection.** Kang, Milliken & Yoo ([arXiv:2406.14836](https://arxiv.org/abs/2406.14836)) measured that existing code-comment consistency detectors have *no statistically significant relationship* with comment accuracy.
- **The lane already existed.** `skill/code-review-simplicity/SKILL.md` lists *"Confusing or contradictory documentation"*. SIMPLICITY was chartered for the first defect and said nothing.

**What actually caused the miss** is worth knowing if you write reviewers of your own. The reviewed diff is built from `origin/<base>..origin/<branch>`, but lens children run with `cwd` set to a **worktree that stays detached at `baseSha`**. They keep read/grep/bash — only write/edit/multiedit are stripped — so a reviewer *can* open a file, and gets the version from before the change. The contradicting line was outside the diff and stale on disk. A seventh lens would have inherited that blind spot exactly.

Two mechanisms replace it, one per defect:

| Defect | Mechanism |
|---|---|
| A claim contradicting something outside the diff | **Evidence supply** — the post-change content of changed prose files, read via `git show origin/<branch>:<path>`, is included in every lens prompt, along with a standing warning that the working tree is at the base commit. The existing lane can finally see what it was chartered to judge. |
| An invented specification with no referent | **`claim-scan`** — deterministic and model-free. It extracts checkable particulars from lines the diff adds to prose files and greps the branch for each one. |

**The grounding rule matters in both directions.** A token counts as grounded when it occurs *outside the prose file asserting it* — in code, config or tests, **including lines this same diff added**. Same-diff code must count, or this project's own rule that documentation ships with the change it documents would make the scan fire on nearly every honest PR. And prose must not ground prose, or an invented specification would validate itself.

If `claim-scan` flags something legitimate, the fix is usually to point the prose at something real. A URL or a product name that genuinely has no repo referent is the case the escape hatch exists for:

```bash
PI_ENSEMBLE_CLAIM_SCAN=0 /work <issue>
```

### How severe is "blocking"? Your project decides

A lens assigns a finding's severity — that is its judgment. Which severity is serious enough to **stop a merge** is your project's call, stated in your `AGENTS.md`:

> Six-pass review findings are blocking at MEDIUM severity and above.

That is pi-ensemble's own sentence, and since this change it is read rather than merely written down. Say something equivalent in your own `AGENTS.md` to move the bar. Rules:

- **No `AGENTS.md`, or one that never mentions review severity, is the normal case** — you get the default, `MEDIUM`. This deliberately differs from merge authority, which fails closed and denies when doctrine is silent. Configuration falls back to a default; authority does not.
- **Loosening requires a verified citation.** The judge must quote the sentence, and the driver checks that sentence exists in the file — the #407 mechanism, reused unchanged. A fabricated sentence cannot raise your bar.
- **Doctrine is read at the cycle's base commit**, so a cycle cannot lower its own bar mid-run.
- **`CRITICAL` always blocks.** A project may decide MEDIUM findings are advisory; none gets to wave through a CRITICAL.
- `PI_ENSEMBLE_REVIEW_THRESHOLD=<severity>` overrides everything for one run.

### Structured markers in subagent replies (#408)

Steps ask their child to end with a marker (`VERDICT: APPROVED`, `ci-status: success`, `#561: NEEDS_WORK`). One shared reader (`extension/src/reply-markers.ts`) accepts every shape agents actually emit — `**VERDICT:** APPROVED`, `verdict: approved`, and the heading form:

```
### VERDICT
APPROVED
```

It also reports **absence** distinctly from a parsed value. That distinction is the point: before #408 each site collapsed "no marker" into some default, and the defaults were wrong in the dangerous direction.

| Site | A miss used to mean | Now |
|---|---|---|
| `parsePerIssueVerdicts` | **build the issue** — nothing in the reply said so | `NEEDS_CLARIFICATION`; the issue is dropped and the operator is told the verdict was unreadable |
| adversarial `VERDICT` | `ISSUES_FOUND`, with the whole approval message handed to the fix-developer as "findings" | still another round, but the reply is labelled as unparsed prose rather than presented as defects |
| `ci-status` | CI failure — burning a retry and possibly parking a green cycle | only an explicit `failure`, or a genuinely absent marker, counts as failure |
| handoff `needs-human-attention` label | *applied* — the matcher also matched *"I could not apply the label needs-human-attention"* | not parsed at all; the driver runs `gh --add-label` itself and records what happened |

If you see a cycle drop an issue with *"the verdict for this issue could not be read"*, the explore child did not emit a per-issue marker. Re-run; if it recurs, the issue body is likely confusing the resolver.

### A cycle cannot grant itself authority (#406)

Gate 1 above reads `AGENTS.md`. The `merged` step runs **after** `commit-pr` has integrated the developer subagents' patches into the repo — so until #406, a developer that wrote *"LLMs are allowed to squash merge PRs"* into `AGENTS.md` had that sentence integrated by the driver's own consolidation and then read back as permission. The cycle authorised itself.

Two different mechanisms close this, because there are two different threats:

| What changed | Mechanism | Why this one |
|---|---|---|
| `AGENTS.md`, `CLAUDE.md` | **Neutralised** — doctrine is read at the cycle's `baseSha` via `git show`, never from the working tree | A grant written during the cycle is invisible to the gate, but an *honest* docs change still ships in the PR. Blanket-halting would break the rule that documentation ships alongside the behaviour it describes. |
| `.github/`, `.pi/`, `CODEOWNERS`, `agents.json` | **Halted** — the develop gate fails with `protected path` and the cycle parks | These define what *verified*, *reviewed* and *green* mean, and they take effect within the same cycle: a workflow edited at develop is the workflow the `ci` step then reads. Reading them at base does not help, because the running system uses the working-tree copy. |

If the develop gate halts on a protected path, the message names each path. Either make that change yourself, or — if editing those files genuinely *is* the work you asked for — re-run with the gate off:

```bash
PI_ENSEMBLE_PROTECTED_PATHS=0 /work <issue>
```

A doctrine-prose edit is not a failure; it appears in the verify notes as *"allowed, and inert for this cycle"*. If merge authority is unexpectedly denied on a repo whose `AGENTS.md` clearly grants it, check that the grant is **committed at or before the cycle's base** — an uncommitted grant in your working tree is exactly what this gate ignores.

### Parallel group execution

`/work N M P …` runs up to `PI_ENSEMBLE_PARALLEL_GROUPS` (default **3**) groups concurrently. Each group develops in its own `.worktrees/` tree, so the only shared resource is the repo root, and every operation that touches it — branch creation, patch integration, commit, push, `gh pr create`, the verify gates, lens-fix re-integration, `restoreCheckout`, worktree teardown — runs under a single integration lock. That lock is an in-process promise chain plus an `O_EXCL` lockfile under `.git/`, so a second `/work` invocation or a second Pi process on the same clone is also serialised.

Child-process load is bounded by `PI_ENSEMBLE_SPAWN_CAP` (default 64), **not** by the group count: excess spawns queue FIFO. Each workstream's develop step spends one child — the developer; the speculative explore that used to accompany it is opt-in (`PI_ENSEMBLE_SPECULATIVE_EXPLORE=1`), so develop's default fanout is M, not 2M.

Set `PI_ENSEMBLE_PARALLEL_WORK=0` for strictly sequential execution.

### Park-and-continue (was: halt-on-non-merged)

If a group's cycle terminates as anything other than `merged`, the queue **parks that group and carries on**. At the end you get one report:

```
pi-ensemble: /work queue finished — 4 merged, 1 parked
  ✓ group-a (#561) — merged
  ⏸ group-b (#562, #563) — cap round-cap at lens-review
      → review the findings on #562's PR — the fix loop did not converge
  ✓ group-c (#564) — merged
```

Each parked entry carries the cap that fired, the step it died on, and the action *you* have to take.

**Only a systemic failure halts the whole queue**, because only those make the next group's attempt pointless:

| Failure | Queue |
|---|---|
| Review cap, adversarial rejection, verify-gate rejection, dirty tree, exhausted transient retries | **parks**, continues |
| `rate-limited:quota-window` — nothing will succeed until the reset | **halts** |
| `rate-limited:quota-terminal` — provider spend cap | **halts** |
| Driver throw (unknown shape; unsafe to continue past) | **halts** |

Escape hatch: `PI_ENSEMBLE_QUEUE_HALT_ON_FAILURE=1` restores the old halt-on-first-failure behaviour.

**Why this reversed (#368).** The old rationale was that an intermediate handoff signals something the operator wants to review before the next group starts. In practice the halt *buried* that signal: one reviewable handoff arrived underneath N unstarted issues that then had to be re-driven by hand. Measured on this repo, `/work` over 13 issues died on #279 and left **11 unrelated groups unstarted** — and 69% of the failures that trigger a halt are provider infrastructure (#366), i.e. they say nothing at all about the remaining work. The parked entry preserves the review signal; halting the queue only added work.

### `--restart` semantics with a multi-issue queue

`/work 561 562 --restart` applies `--restart` to **every** cycle — each group's state file is wiped before its cycle starts. For groups that have no prior state file, `--restart` is a no-op.

### Why deterministic grouping rather than PM-narrated?

The compiled driver's PR10 shortcut (v0.12.5–v0.12.14) bundled ALL issues into ONE PR without any judgment — that empirically failed 3× (vipune `37219c9a`). PR15's retreat to strictly-sequential was safe but ignored real relatedness signal. PR16's grouping rules encode explicit heuristics (link markers, path overlap, subsystem tags) that produce reproducible partitions — same input → same groups, testable, no LLM budget, no drift between runs.

### `develop` no longer spawns a second `explore:speculative` child

**Symptom**: you expected an `explore:speculative` dispatch alongside each developer and see only `developer` in the scrollback and event log; or `PI_ENSEMBLE_SKIP_SPECULATIVE_EXPLORE=1` appears to do nothing.

**Fix**: nothing to fix — that is the default now. The speculative explore hands its findings over through a scratch file the developer prompt names, and measured across a full day of live cycles the hand-off never completed: the developer reads that path 3-7 seconds in, the file landed 14-130 seconds later, and every access returned `ENOENT`. It also was not free — `develop` resolves at `max(developer, speculative)` and the explore finished last on 6 of 23 measured branches, 1425s in total. It cost 397k-956k tokens per child for output nobody read.

Set `PI_ENSEMBLE_SPECULATIVE_EXPLORE=1` to turn it back on; `PI_ENSEMBLE_SKIP_SPECULATIVE_EXPLORE` is gone and setting it does nothing. If you want the context without the race, the version worth building is one that awaits the explore and inlines its findings into the developer prompt — no file, no race.

## Outcome-verification gates — `verify-failed:<step>` cap-hits (PR17+)

### What they are

After the `develop` step (when every branch claims success) and after the `commit-pr` step (when the consolidation gate passes), the driver checks **executed evidence** instead of trusting the subagent's "done" claim. No LLM judges this — the driver runs the checks itself:

**develop:**
- At least one worktree has a real diff — uncommitted porcelain entries, or commits ahead of the `baseSha` recorded at the branch step. All worktrees empty = the claim was hollow.
- The project's **verify command** exits 0 in each changed worktree.

#### Scope fan-out: the developer changed too many files

**Symptom:** The develop step ends with `verify-failed:develop` even though the developer reported success. The handoff evidence names an out-of-scope path, or says that the workstream changed more files than its plan declared.

**Cause:** The gate compares the changed-file set in each workstream's worktree with the plan's `paths` and `outOfScope` entries. It reads both porcelain changes (including untracked files) and committed changes ahead of the branch-step `baseSha`, so a developer cannot avoid the check by committing locally. An `outOfScope` path is a hard violation: exact paths and descendants of an `outOfScope` directory prefix fail immediately. Otherwise, a workstream with declared paths is allowed up to:

```
max(declared path count × 3, 6)
```

For example, one declared path permits at most six changed files; eleven files in that workstream fails with a scope-fanout message. The factor and minimum are tunable with `PI_ENSEMBLE_SCOPE_FANOUT_FACTOR` and `PI_ENSEMBLE_SCOPE_FANOUT_MIN`. A file below a declared directory path counts as being under that path, so adding a new file in that directory does not create a false alarm. A workstream with an empty `paths` list skips this check and records a note; legacy/default workstreams must not be treated as if they declared one path.

This is a deterministic post-develop check, not an LLM judgment. It catches an over-broad decomposition before adversarial review spends time on the work. A failure uses the existing `verify-failed:develop` cap and records the offending paths and counts in `pipelineState.verifyEvidence`.

**Fix:** Read the evidence in the handoff or `.pi/work-state/<issue>.json`, then inspect the workstream that failed:

```bash
git -C .worktrees/issue-<N>-<workstream> status --porcelain
git -C .worktrees/issue-<N>-<workstream> diff --name-only
git -C .worktrees/issue-<N>-<workstream> diff --name-only <base-sha>..HEAD
```

Remove or move changes that violate the workstream's `outOfScope` fence. If the work is genuinely broader than the plan, split the workstream or revise the plan before restarting `/work <N>`. The gate is enabled by default; for a one-off, reviewed recovery you can restore the pre-gate behavior with `PI_ENSEMBLE_SCOPE_GATE=0`. Disabling it does not make an out-of-scope change safe — it only skips the deterministic check.

**commit-pr:**
- Commits exist on the branch: `git rev-list --count origin/<base>..HEAD` > 0.
- The parsed PR number resolves via `gh pr view`. If ops forgot the `pr: <N>` marker, the gate tries `gh pr list --head <branch>` and **adopts** the found number (bonus repair — pre-PR17 a missing marker silently degraded handoff/CI targeting).

On failure the driver emits cap `verify-failed:<step>` → handoff, with the per-check evidence in `pipelineState.verifyEvidence` (rendered into the handoff body).

#### Skip-ratchet check (PR277)

The develop gate also counts net additions of **skip-markers** in the diff (`#[ignore]`, `it.skip(`, `describe.skip(`, `test.skip(`, `@Disabled`, `pytest.mark.skip`, `t.Skip(`). A net increase means you're **disabling a test gate** that existed before — the ratchet only moves one direction.

If the diff adds skip-markers, the gate fails with an evidence line naming the count. The filter excludes comments (but NOT Rust attributes like `#[ignore]`) and string literals to avoid false positives in documentation or quoted code. Word-boundary matching prevents false positives like `pytest.mark.skipif` or `@DisabledOnOs` matching their shorter counterparts.

**Known limitations (single-line analysis):** `git diff -U0` yields per-line fragments, so cross-line state cannot be reconstructed:

- **Unterminated strings on a diff line** (e.g. `+"it.skip(` from a multi-line template literal): the rest of the line is parsed as inside a string, so markers after the quote are **not counted** (false negative).
- **Markers on continuation lines inside multi-line strings** (e.g. `  it.skip("x")` as the second line of a template literal): the line looks balanced in isolation, so the marker **is counted** (false positive).
- **Mid-line block comments** (e.g. `+code() /* it.skip("x") */`): the marker IS counted. Only line-leading `/*` and `*` are filtered.

These are documented limits, not bugs — fixing them requires real parser state across diff lines, which is undecidable from `git diff -U0` fragments.

**Why this exists:** vipune's core embedder was broken for ~2.5 months while its test suite stayed green — 22 `#[ignore]` sites kept the real-embedder tests out of the fast suite, and nothing ever executed the product. The ratchet catches skip-marker additions before they accumulate.

**Escape hatch:** `PI_ENSEMBLE_SKIP_RATCHET=0` disables the check (use sparingly).

#### Product smoke command (PR277)

The develop gate runs an optional **smoke test** configured in `.pi/smoke-cmd` at the repo root. Format mirrors `.pi/verify-cmd`: first non-empty, non-comment line is the command verbatim, executed with the same 10-minute timeout as the verify command (`PI_ENSEMBLE_VERIFY_TIMEOUT_MS`; shared for simplicity).

If the smoke command exits non-zero, the gate fails with a `smoke:`-prefixed failure message carrying the output tail (~1500 chars). If `.pi/smoke-cmd` is absent, the gate notes the omission explicitly (never silent) — per the "never silently downgrade a six-pass review to a five-pass" doctrine.

**Security note:** The smoke command is executed via shell (`/bin/sh` on Unix), which allows pipes, command substitution, and chaining operators. This is intentional flexibility (e.g., `bun run smoke && curl localhost:8080/health`), but it means `.pi/smoke-cmd` is a privileged execution surface. If `.pi/smoke-cmd` is added to your repo (via a supply chain attack or malicious PR), it can execute arbitrary commands as your user. Treat write access to `.pi/smoke-cmd` as equivalent to shell access. The same surface exists for `.pi/verify-cmd` (pre-PR277).

**Why this exists:** A test suite passing in isolation doesn't prove the product works. vipune's failure mode was tests passing while the broken feature never executed; a smoke command forces a basic end-to-end path through the real artifact.

**Escape hatches:** `PI_ENSEMBLE_SMOKE=0` disables the smoke gate; remove `.pi/smoke-cmd` to omit the smoke test from verification.

### Verify command discovery

Precedence (PR18 shape):

1. **`.pi/verify-cmd`** at the target repo root — first non-empty, non-comment line is the command verbatim. Use this when the derived command is wrong or you want tests instead of typecheck.
2. **`package.json` `typecheck` script** — an intentional project-level signal; wins even next to a `Cargo.toml`. Runner detected from the lockfile (`bun.lock`/`bun.lockb` → `bun run`, `pnpm-lock.yaml` → `pnpm run`, `yarn.lock` → `yarn`, else `npm run`).
3. **`Cargo.toml`** → `cargo check --quiet`. Beats a bare `package.json` `test` script — a Rust repo with a tooling package.json (docs build, hooks) must not run `npm run test` as its gate. (Pre-PR18 package.json won unconditionally, producing spurious verify-failures on Rust projects.)
4. **`package.json` `test` script** (non-Rust repos only).
5. Nothing found → the gate checks diff/commit/PR evidence only and notes the absence.

The command is capped at 10 minutes (`PI_ENSEMBLE_VERIFY_TIMEOUT_MS` to override).

### If the gate keeps failing

- **Verify command fails on code the developer didn't touch** — the project was already broken before the cycle started. Fix the baseline first, or point `.pi/verify-cmd` at a narrower command (e.g., `cargo check -p <crate>`).
- **Verify command too slow / needs services** — put a cheaper command in `.pi/verify-cmd` (typecheck-only is the intent; full test suites belong to CI).
- **False alarm you need to bypass right now** — `PI_ENSEMBLE_VERIFY=0` disables the gate entirely (not recommended as a steady state; it re-opens the phantom-handoff class the gate exists to catch).

### Why this exists

Pre-PR17, every quality gate (adversarial, six lenses) was LLM judgment reading diffs and transcripts — nothing driver-side ever *executed* anything until post-PR CI. The #245/#253 silent-merge incidents were exactly this failure class: agents claimed success, the driver trusted the claim. The gate costs zero LLM tokens and catches hollow claims pre-commit instead of after a full adversarial → lens → CI round-trip.

## Mechanized commit-pr — driver-executed consolidation (PR19+)

### What changed

The `commit-pr` step's consolidation + commit + push + PR creation now run as **driver code** (`mechanizedCommitPr` in `work-driver.ts`), not as an LLM ops dispatch. The recipe is the same one the PR14 prompt narrated to ops — per-worktree stage → `git diff --cached` → `git apply --index` at the repo root → templated commit (`Fixes #N` per active issue, `Companion to` per dropped issue) → push → `gh pr create --body-file` — with one improvement: worktree slices are staged before capture, so **untracked new files are included** (`git diff HEAD` alone silently missed them).

### Fallback semantics

Any mechanized-path failure (apply conflict, push rejection, unexpected repo state, clean worktree) emits a `plumb-report` naming the reason and falls back to the LLM ops dispatch — whose behavior is unchanged from PR14. The LLM absorbs environment variance the deterministic recipe can't (auth quirks, odd remotes); the driver handles the 95% enumerable case. Both paths share the same downstream gates (`parsePrNumber`, `verifyConsolidation`, `verifyStepOutcome`), so a bad consolidation is caught identically either way.

If you see repeated fallbacks in the plumb-reports, the reason string says why; the most common legitimate one is a `git apply` conflict between workstreams (overlapping edits) — that's genuinely judgmental and the LLM path is the right tool.

### Escape hatch

There is no way to force the LLM ops dispatch. #393 deleted `PI_ENSEMBLE_MECHANIZE_OPS=0`, because every worst-class incident in this harness's history — #245/#253 silent merges, v0.12.13 shipping 1 of 3 workstreams — was LLM ops improvising exactly the operations mechanization now executes. The LLM path still runs as a **fallback when mechanization fails**, which is recovery from environment variance rather than an opt-out; a plumb-report records every such fallback so you can see it happened.

## Invariant-removal guard memories (#280 C)

### What it does

When the widening scan (invariant-scan.ts) fires during lens-review, the driver writes ONE vipune guard memory per (file, symbol) for each type-widening finding. The guard memory reads:

```
[invariant-removal] <basename>: constraint <before> → <after> removed in issue #N; verify what now guarantees the old invariant before writing code that exploits the widened type.
```

The memory is typed `guard`, stored as `candidate` (invisible to default reads), and a plumb-report is emitted so the handoff renderers can name the structural decision.

### Why it exists

When a compiler-enforced invariant dies (e.g. `T` → `Option<T>`, removed `readonly`, widened to `any`), the fact that it was load-bearing vanishes with it. The memory substrate (vipune) now records what invariant died so future cycles know what to verify before writing code that exploits the widened type.

### What it looks like in the log

- `widening-scan` event carrying the raw findings
- `memory-write` event per finding (outcome: written / error)
- `plumb-report` event per successful write

### Escape hatches

- `PI_ENSEMBLE_INVARIANT_MEMORY=0` — restores today's behaviour (no guard writes)
- `PI_ENSEMBLE_WIDENING_SCAN=0` — disables the widening scan entirely, which also prevents guard writes

### Troubleshooting

- **No guard memories written** — check that `PI_ENSEMBLE_INVARIANT_MEMORY` is not set to `0`, and that the widening scan found findings (check the `widening-scan` event). If vipune is not installed, `defaultVipuneWrite` returns empty silently — the guard write is additive value, not structural.
- **Duplicate guard memories across cycles** — dedup is per-cycle, not cross-cycle. If the same widening fires across multiple cycles, each writes its own guard. A future improvement could add cross-cycle dedup.
