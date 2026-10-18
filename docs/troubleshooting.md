# pi-rukas troubleshooting

Symptoms → causes → fixes. Most issues here come from running an older sandbox image; the first move on anything weird is usually `./install.sh` from the pi-rukas repo to rebuild + refresh.

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

**Symptom:** on a WSL2 host, `./install.sh` gets past OS detection but the sandbox image pull fails, or `pi-rukas` launches and the container can't start — `docker` commands report the daemon is unreachable.

**Cause:** WSL2 is a separate Linux VM; the Docker daemon you want it to talk to lives on the Windows host (Docker Desktop) or must be its own Engine. A bare WSL2 distro has no Docker daemon, so the sandbox — which is a Docker container — has nothing to run in.

**Fix:** enable Docker Desktop's **WSL2 integration** (Settings → Resources → Integrations → enable your distro), or run a Docker Engine inside the distro and start its daemon. Verify from inside WSL2: `docker version` shows both client and server, then `./install.sh` again so the image pull succeeds.

## Subagents fail to start after updating pi-rukas

### Symptom

After updating pi-rukas (the 1.0.0-upgrade line, #959), every `dispatch_specialist` fails immediately — children exit at once instead of running.

### Cause

Your global `pi` is below 1.0.0: the new subagent spawn path passes `-e builtin:mcp` (and, unless `PI_ENSEMBLE_CHILD_CODEMODE=0`, `-e builtin:codemode`, issue #1030 — re-enabling the MCP built-in that `--no-extensions` also disables under Pi 1.0.0), and pi < 1.0.0 does not know those flags. `./install.sh`'s preflight refuses the install on old pi and prints the exact upgrade command (`npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.0.0`).

### Fix

Upgrade pi first, then re-run `./install.sh`:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.0.0
./install.sh
```

PR: [#959](https://github.com/trail-openers/pi-rukas/issues/959)

## Subagent silently "finished" but the worktree wasn't touched

### Symptom

PM dispatches a subagent (developer / explore / ops); the `[ensemble:async]` report comes back looking normal — "Subagent finished — N turns, Tm Ts" with what reads like a final assistant message (e.g. *"Step 1: Read sweep_stats.rs"*). PM proceeds as if work was done. You arrive at the desk and find `git status` clean, no commits, no PR — the agent never actually wrote anything.

### Cause

The provider HTTP request hung mid-stream. pi-ai turned the timeout into a synthetic assistant message with `stopReason: "error"` and empty content. Pre-#236 the dispatch report treated that as a normal completion and displayed the agent's last successful thinking block as if it were the final reply. Pi's default HTTP timeout is ~10 minutes (provider SDK default), so a degraded provider could burn 4 retry attempts × 10 min = 40 min before failing — and the failure looked like a success.

This is **independent of the LLM backend**: across recent runs, Anthropic Claude Sonnet 4.6 and Cerebras `zai-glm-4.7` produced this failure roughly equally.

### Fix

```bash
cd ~/.config/opencode/pi-rukas && git pull && ./install.sh
```

Post-#236 (retuned by #295), `install.sh` writes `retry.provider` defaults into `~/.pi/agent/settings.json` (10 min per request, 3 retries with backoff), plus the top-level `httpIdleTimeoutMs` (300000). If you have non-default settings you want to keep, they're preserved — install.sh only writes the retry block when it's missing, with these exceptions, all our own footprints: the old #236 value of exactly `180000` (3 min) is repaired to the new default, a `maxRetryDelayMs` of exactly `10000` is repaired to `60000`, and a `retry.provider.httpIdleTimeoutMs` (a key Pi never reads, #1347) is removed, its value moved to the top level unless it is our old `120000`.

The dispatch report also now distinguishes the failure mode visually:

- Header: `Subagent \`developer\` (job X) FAILED-PROVIDER-ERROR — N turns, Tm Ts`
- Body prefix: *"Provider request error: \<errorMessage\>. Last text below is the agent's pre-failure activity — VERIFY DIRECTLY before assuming progress."*
- Scrollback line: `▸ ensemble: ⚠ developer terminated mid-stream — provider request error, see report`

PM treats `FAILED-PROVIDER-ERROR` as a failed dispatch per existing doctrine (routes through the cap-hit handoff from #233), so you'll see the `needs-human-attention` label and PR comment when you check.

### Tuning

Do NOT set this below the longest single turn your subagent models legitimately produce. A thinking-heavy model (e.g. `xhigh` thinking level) routinely streams a single turn for 10-17 minutes; with a too-tight timeout, pi's client burns two stacked retry layers (~10-17 min of total silence) and then reports `"Request timed out."` / `"terminated"` **on a perfectly healthy endpoint** — the signature of the #295 regression (constant "endpoint sporadically failing" reports across endpoints that check out fine). Edit `~/.pi/agent/settings.json` directly:

```json
{
  "httpIdleTimeoutMs": 300000,  // top level: Pi does not read it under retry.provider
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

pi-rukas shipped `10000` here for several releases on the mistaken reasoning that it "added 3 x 60s of backoff". Providers routinely ask for 59-60s, so every real throttle became a hard failure. Measured on one run: three parallel `/research` children and two `/work` developers all died on `Server requested 59s retry delay (max: 10s). 429 status code`, having gathered ~305k characters of research between them, all discarded. `install.sh` now repairs a value of exactly `10000` on sight — including on hosts where `timeoutMs` was already set, which previously skipped the whole block and so were never fixed.

If you have deliberately chosen a value below 60s, it is preserved; the extension traces a warning at startup instead, visible in `/ensemble-debug`.

PRs: [#236](https://github.com/trail-openers/pi-rukas/pull/236), [#295](https://github.com/trail-openers/pi-rukas/issues/295)

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

### A merge was refused: review ledger

**Symptom:** An agent (PM, ops, or a subagent) runs `gh pr merge N` or `glab mr merge N` and the command is refused with a message like *"no passing adversarial review on file for branch …"* or *"no passing lens review on file for branch …"*. The same guard also holds commands that are not merges at all — see "A read-only command was refused with merge text" below.

**Cause (by design):** The mode-independent merge guard (issue #912) checks the per-clone review ledger before allowing any agent-run PR/MR merge. The ledger lives under the git common dir (`git rev-parse --git-common-dir` + `review-ledger.json`) and is written by `adversarial_loop` and `dispatch_lens_review` at completion. The guard requires:

> **Ledger path override:** `PI_ENSEMBLE_REVIEW_LEDGER_FILE` (an absolute path) makes `ledgerPathFor` return that path verbatim without any git call. The override is re-read from the Pi process environment on every ledger access (it is not cached at startup); a command's own env (`FOO=… gh …`, `export` inside a bash call) never reaches the Pi process, so setting it inside a command still has no effect. Tests set it to a private temp file so their fixture writes never touch the real per-clone ledger (concurrent test runs across worktrees would otherwise race on it and clobber it); operators normally do not set it.

1. The **latest** adversarial entry for the branch to be `passed: true` **and** its `patchId` to match the branch's current merge-base patch-id (a change to the branch since the review refuses; main moving does not — see "The patchId base" below).
2. The **latest** lens entry for the branch to be `passed: true` (any `patchId` — a passing lens entry may predate a later commit; a later **failing** lens run is what the latest-ness protects against). The lens `passed` boolean follows the project's review threshold (the same bar the driver's verdict used — see `lensBlockedByThreshold` / `lensPassed` in review-ledger.ts).

This is the structural floor for the incident where a PM merged two PRs on a developer's self-report plus CI, skipping both reviews. The prompt doctrine demanded both; the prompt layer is what failed. The guard cannot be bypassed by trust mode, sandbox mode, or `agents.json` overrides — it fires in every mode, for every role, before any short-circuit — and it reaches subagents too: every spawned child is loaded with the child-guards companion extension (`extension/src/child-guards.ts`), which registers the guard in trust mode (where the full pi-rukas extension is not forwarded) and no-ops in strict mode (where the full extension already registers it), so a trust-mode child's `gh pr merge` gets this refusal, never gh's not-found error.

**What this guard is — and is not.** This is a **safeguard** against an agent that *forgets* the gates — a PM who merges on a developer's self-report plus CI without running the reviews. It is **not** a security boundary: anything with shell access to this clone can write or delete the ledger file (it is a plain JSON file under the git common dir), and the head check (the fetched head must equal the PR's `headOid`) is a **freshness gate**, not atomic with the merge — a concurrent push between the check and the merge is not detectable here. The threat model is the honest-but-forgetful agent, not an adversary: an agent with credentials can always merge by other means (a direct `git push` to the base branch, a merge spelled entirely from shell expansions). Those paths are **consciously out of scope**: branch protection is the git-level control for pushes. The guard's job is to catch the case where the reviews simply weren't run — which the ledger detects.

**The patchId base.** The writers (adversarial-ledger.ts, lens-ledger.ts) store their entries against the **merge-base** of HEAD and `<remote>/<mainline>` (resolved via `detectMainline` + the forge remote, never a hardcoded `origin/main`), over the working tree (so uncommitted fixes the adversarial loop made are covered). When those fixes are committed unchanged, the id the guard recomputes at merge time matches the stored one. The guard (and the #973 residual-marker poster) compute the same construction over committed content (#1305): the patch-id of `git merge-base <remote>/<head> <remote>/<mainline>`..`<remote>/<head>`, after fetching both refs. Main moving after the review therefore does **not** make the review stale — only a change to the branch's own content does. (Merging main *into* the branch does move the merge-base, so that does need a re-review.) A residual marker whose `patch=` differs from the guard's identity — including one posted by a pre-#1305 build — is treated as absent until the lens review re-posts it. A PR whose base branch is **not** the mainline has no recorded identity to match: the guard refuses it by name (*"the PR's base … is not the mainline …"*) and the poster posts nothing — fail closed; merge such a PR by hand. Any failure to compute the identity (mainline unresolved, no merge-base, a git error) likewise refuses, naming the cause. The git remote is resolved the same way forge detection does (`origin` → `upstream` → first remote; no remote → refuse), so a repo whose remote is not named `origin` still resolves the same ref on both sides.

**Carve-outs (not agent merges):** release-please branches (`release-please--*` head or `autorelease: pending` label) and dependabot PRs (`dependabot/*` head or `dependabot[bot]` / `app/dependabot` author) pass through without a ledger check. The `autorelease: pending` label leg is settable by any collaborator, which is accepted under the forget-the-gates threat model: the carve-out exists for release-please, and the threat model is the honest-but-forgetful agent, not an adversary.

**The driver's mechanized merge is exempt by construction.** The `/work` driver's `mechanizedMerge` (work-driver-merged-mechanized.ts) is an in-process `execp` call, not a `tool_call` — it does not pass through the guard's hook. The driver's own adversarial and lens reviews are recorded in the ledger (the driver passes the cycle's branch name to the writer), so a driver cycle that reaches `merged` has its entries on file.

**Grouped multi-workstream cycles.** A grouped `/work` cycle (N>1) records its adversarial entries per workstream tree, not against the integrated branch. A hand/ops fallback merge of the **integrated** branch (e.g. after a handoff) may therefore be refused — the ledger holds no entry under the integration branch's name — until the reviews are re-run on that branch. The driver's own mechanized merge is unaffected (it is exempt by construction and its entries were written against the cycle's branch).

**Escape hatch (operator-set only):** `PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1` disables the guard for the whole session. Use only when you have reviewed by other means and want to merge by hand. It is read once when Pi starts; setting it inside a command (`env …`, `export` in a subshell) has no effect. **It is never the answer to a blocked read** — see "A read-only command was refused with merge text": widening merge protection buys nothing when nothing was being merged.

**Which commands the guard checks (#962).** The guard accepts exactly one form of merge, run as a command of its own:

```
gh   [-R OWNER/REPO | --repo OWNER/REPO | --repo=OWNER/REPO] pr merge [N] [flags]
glab [-R GROUP/REPO | --repo GROUP/REPO]                     mr merge [N] [flags]
```

`N` is a plain positive integer right after `merge`; without it the guard checks the current branch's PR. One repo selector at most. The accepted flags are the ordinary merge flags (squash/merge/rebase, delete-branch, subject/body/body-file and the like; never `--admin`, and never a deferred merge — gh `--auto`, glab `--when-pipeline-succeeds` / `--auto-merge`, which runs later against whatever head the PR has then). A glab merge is accepted **only** with the explicit opt-out `--auto-merge=false` (the spaced `--auto-merge false` is refused); a bare `glab mr merge <N>` is refused with that accepted form named, because recent glab queues an auto-merge by default. The list is `GH` / `GLAB` in `extension/src/merge-allowlist.ts`. Words may be quoted.

**What is refused, and why.** A command that names a forge or HTTP client (`gh`, `glab`, `hub`, `curl`, `wget`, `http(s)`, `api.github.com`, `gitlab`) *and* the word `merge` (or `mergePullRequest` / `enablePullRequestAutoMerge`), or that says `pr merge` / `mr merge` / `mr accept` (glab's alias, always refused) at all, must be that form, or it is refused with *"merge refused: the merge guard checks only one plain merge command"*. That covers chains and pipes (`cd x && gh pr merge 17`, `echo … | sh`, `xargs`), substitutions, variables, globs and braces, redirections, heredocs, newlines, comments, `bash -c` / `eval` / `alias`, wrappers (`env`, `command`, `nice`, `time`, `timeout`, `sudo`, `exec`, `oo`), `--admin`, unknown flags, a branch or URL instead of a number, two repo selectors, and every REST or GraphQL merge (`gh api …/merge`, `curl … /merge`, `hub merge`) whatever its method. Outside single quotes the guard refuses every shell metacharacter, expansion, comment, control character and non-ASCII character. The guard used to parse arbitrary shell to find a merge wherever it hid. Every review round found a shape it read differently from bash, so it now checks only a form whose words it reads exactly as bash does.

**GraphQL merges are refused too, under both forges' names.** `gh api graphql` / `glab api graphql` with a `mutation` naming a merge (`mergePullRequest`, `enablePullRequestAutoMerge`, `mergeRequestAccept`, `acceptMergeRequest`, and the other GitLab merge names) is refused like any other merge, whatever the HTTP method. A GraphQL call whose query is read from a file, stdin or a variable (`-F query=@q.graphql`, `--input q.json`, `-f query=$Q`, `curl -d @body.json …/graphql`) is refused outright, because the merge is not in the command text. An inline read-only query (`gh api graphql -f query='{ viewer { login } }'`) is allowed.

**Interpreters are forge clients too.** A command naming `python`, `python3`, `node`, `bun`, `deno`, `ruby`, `perl` or `octokit` together with the word `merge` is refused, so a script that calls the forge API is held to the same form. This over-refuses: `bun run smoke-tests/test-merge-guard.ts` and `python3 scripts/merge.py` are refused because of the word `merge` in a file name. Rename the file, or use the escape hatch. `gh run list --workflow merge.yml` is refused too: `run` and `workflow` are not exempt, because dispatching or re-running a workflow is not a read. Run `gh run list` without the merge word, or use the escape hatch.

**Every refusal names a reason code.** A merge refusal ends with `[reason: <code> — <what to change>]` (composed in `mergeFormRefusal`, and nowhere else) so you know what to change; a HOLD refusal has no bracket — `renderHold` renders `command held (not a merge): …` prose instead, and the bare code goes to the trace line as `reason=<code>` — so a hold never reads as a merge verdict. The codes: `unknown-flag` (the flag is not in the accepted list; the refusal names the offending word, e.g. `the offending word is `--auto``), `repo-count` / `repo-value` / `repo-repeated` (the `-R` selector), `not-a-number` (the PR argument is not a positive integer), `extra-command` (a positional word the form does not take), `flag-missing-value`, `forbidden-char` (a shell character outside single quotes; the code carries the character, e.g. `forbidden-char:!`), `control-or-non-ascii`, `quote-unbalanced`, `expansion-command-word` (the command word is `$…` or quoted), `body-indirect` (a forge API or HTTP call whose body is read from a file, stdin or a shell expansion, e.g. `-f query="$(cat q)"`, `-d @body`, `-T file`), `brace-expansion` (a `{a,b}` or `{a..b}` pattern in a forge command), `not-pr-merge`, `not-a-forge-command`, `too-large` (the command is past the 8000-char size bound, so nothing in it was analysed — split it into shorter commands; note the bound holds only a command that names a forge word AND spells a merge shape, so a long read is never held for length), and `glab-auto-merge` (which has its own message). A command that needs anything beyond the accepted form cannot run as a merge through the guard; use the escape hatch or the forge UI.

**This over-refuses on purpose.** Prose that names a merge next to a non-forge command is refused too: `git commit -m "explain gh pr merge"`, `echo "gh pr merge 12"`. A gh command is exempt from the merge-word trigger only when it is a genuine read or a creation, and the whole command is one simple command (no chain, pipe, substitution or redirection): `gh pr view|list|checks|diff|status|create`, `gh issue view|list|create`, `gh release list|view`, `gh search …`, `gh label list` and `gh repo view`. So `gh pr list --search "merge conflict"` and `gh pr create --title "refuse merge shapes" --body-file x.md` run. Everything else falls through to the trigger, so it is refused only when it carries a merge word: `gh pr comment|edit|review|ready|close|reopen`, `gh issue edit|comment|close`, `gh release create|upload|delete`, `gh label create|edit`, `gh workflow …` and `gh run …`. So `gh pr ready 17` and `gh pr review 17 --approve` run, but `gh pr comment 5 --body "please merge"`, `gh pr edit 17 --add-label automerge` and `gh workflow run merge-release.yml` are refused. Remedy: put the prose in a file (`gh pr comment 5 --body-file x.md`) or drop the merge word. `gh api`, `gh pr merge`, `gh alias` and `gh extension` are never exempt, and glab has no exemption. Put a PR or comment body in a file (`--body-file <file>`) and a commit message in `git commit -F <file>`. A subject containing a shell character can be single-quoted (`--subject 'fix(review): x'`). Commands that mention neither are untouched: `gh pr view 17 --json mergeable,mergeStateStatus`, `gh pr list --state merged`, `gh pr checks 17`, `git merge --ff-only origin/main`.

**Residuals the trigger cannot name.** A merge assembled entirely from expansions with no literal `merge` word (`gh pr m$X 17`, `$G pr m$X 17`, `gh pr m?rge 17`), a merge built by concatenating quoted pieces that never spell the word (`node -e "x['mer'+'ge'](…)"` spells no merge word, so it is not read), and a script file the command runs (`bash x.sh`, `python3 x.py`) are not recognised. A client library the trigger does not name (anything other than the forge, HTTP and interpreter words above) is not recognised either. The review that added the body and brace checks named three more, which stay open: a script whose *file name* contains `merge` (`bash scripts/merge-pr.sh`), whose body is not read; an interpreter not on the list (`php`, `lua`, `go run`, a compiled client) that calls the API; and a percent-encoded path in an API call (`gh api repos/o/r/pulls/17/%6derge`), which spells no merge word.

**Outside the command guard entirely.** The guard reads the commands an agent types. It does not see anything a forge does on its own. Label-, comment- and review-driven merge bots (bors, Mergify, an auto-merge label, a `/merge` comment) and dispatched workflows can merge a PR without any command the guard reads. A pre-existing auto-merge enabled outside the guard can fire when a review is approved or the PR is marked ready, so `gh pr review --approve` and `gh pr ready` can satisfy it. These are the same class as a direct push to the base branch. Disable such automation where the guard is the gate, or accept that it is not.

**A chain is refused — run each command on its own.** `git merge --ff-only origin/main && gh pr view 17` is refused, because `&&` is a shell metacharacter the guard will not read through, even though the `gh` part on its own is an ordinary read. A command that never triggers (it spells no merge word) runs whatever it chains — but a read should be one command anyway.

**What the guard treats as a read.** Two things make a command inert, and both are narrow — see "A read-only command was refused with merge text" below for what to do when one of them is the reason a read ran, or the reason it did not.

1. **The read allowlist** (`READ_ONLY_GH` in `merge-allowlist.ts`) exempts `gh` only, and only for `pr view|list|checks|diff|status|create`, `issue view|list|create`, `release list|view`, `search <anything>`, `label list` and `repo view` — genuine reads and creations. When it fires, a merge word in the arguments is prose: `gh pr list --search "merge conflict"` runs. It is judged on the whole command, so the command must also be one the strict lexer can read (no chain, pipe or redirection carrying a shell metacharacter outside single quotes).
2. **No trigger at all.** A command that spells neither a merge word nor the `pr merge` / `mr merge` / `mr accept` verb pair is inert however forge-shaped it looks. That is what lets an issue read through: `gh api repos/o/r/issues/250 --jq '{number,title,state,closed_at}'`, `gh api "repos/o/r/issues/248/labels?per_page=100" --jq '.[].name'`, a `timeline` or `events` read with a `--jq` filter, and `curl` of a forge URL — none of them names a merge, so the guard never reads them. The `--jq` filter is the point: the trigger looks for literal words, and a read carries none.

The shapes that defeat them, and what to do:

- **A merge word plus a shell metacharacter is held whole.** `gh pr view 17 --json body | grep merge` is refused with `forbidden-char:<c>`: once the merge word triggers, the command must be the one plain merge form, and outside single quotes the lexer refuses every metacharacter — so it is never read as a gh read. The same read with no merge word in it (`gh pr view 17 --json body | head -20`) runs. When a read is held this way, run it on its own and do the filtering or logging in a second call.
- **A merge word in a non-exempt gh verb is prose the guard cannot tell from a merge.** `gh pr comment 5 --body "please merge"`, `gh pr edit 17 --add-label automerge`, `gh workflow run merge-release.yml`, `gh run list --workflow merge.yml` are refused. Put the prose in `--body-file` or drop the word; name the workflow without `merge`.
- **A `glab` read has no allowlist** — only `gh` has one. `glab api "projects/1/issues/250/notes" --jq '.[].body'` is inert because it spells no whole merge word (`merge_requests` is one token, not the word `merge`), but a bare `merge` anywhere in a glab command is held whatever follows it, and there is no exemption to fall back on. Drop the word.
- **A forge API path that spells the verb is a merge door, not a read:** `gh api repos/o/r/pulls/17/merge` is refused whatever its method. Read the PR with `gh pr view 17 --json mergeable,mergeStateStatus` instead.

**The documented residual.** The guard reads the command text only, so a merge whose words never appear there is not recognised. That covers a merge assembled from shell expansions (`$G pr m$X 17`, `gh pr m$(echo e)rge 17`, `gh pr m?rge 17`) and a merge written to a script file and run (`bash x.sh`). It also covers a gh/glab alias the operator configured beforehand (`gh m 17`) and a direct `git push` to the base branch. These are outside the threat model: an honest-but-forgetful agent does not hide a merge from itself, and branch protection is the control for pushes. Recent glab versions queue an auto-merge by default when the pipeline is still running, so the guard requires `--auto-merge=false` on every glab merge (see above); `--sha <reviewed head>` pins the head but does not make the merge immediate. A merge aimed at the other forge (`glab mr merge 12` in a GitHub clone) is refused, because the guard reads the PR on this repo's forge. Each forge-detection git call is bounded at 30s (a few run in sequence); a stall resolves no remote, so the guard refuses with *"could not determine the forge"*.

**To satisfy the guard:** run `adversarial_loop` (the `adversarial_loop` tool) and `dispatch_lens_review` (the `dispatch_lens_review` tool) on the branch, let them complete, then merge. The ledger entries are written automatically at completion.

**Binding refusals on an `adversarial_loop` row (#1360).** A tool-path adversarial row now records `passed: false` when the review it claims to attest did not actually cover the branch. The row's `detail` (quoted verbatim in the guard's refusal) starts with one of five prefixes. Each means the same thing underneath — the range the reviewer read is not the range the merge would ship — and the fix is the same for all five: re-run `adversarial_loop` with `base` = the branch's merge-base (`git merge-base origin/<mainline> HEAD`) and `head` = the branch tip, and make no edits while the round is running.

| Prefix | What happened | What to change |
|---|---|---|
| `range-not-branch` | The `base` you passed is not the branch's merge-base — typically `base=HEAD~1` (only the last commit reviewed) or a base on a side branch. | Pass `base` = `git merge-base origin/<mainline> HEAD`. |
| `range-unverifiable` | A check could not run: a ref that does not resolve, no merge-base, a git error, or the round's capture never completed. Fail-closed by design — a check that cannot run is never a pass. | Fix the ref (typo, deleted branch, unpushed tip) and re-run; a capture failure names its own cause in the same detail. |
| `head-not-current` | The head under review was never the checkout's tip: you named an older commit explicitly, or the ref the round captured no longer resolves to the commit the row is written against (the branch moved elsewhere while the round ran). | Pass `head` = the branch tip (or omit it for `HEAD`) and re-run against the current tip. |
| `head-moved` | The reviewer approved, then the branch was committed to before the row was written. | Re-run the round after the last commit — review, then merge, with no commits in between. |
| `tree-changed` | The reviewer approved, then the working tree was edited (an uncommitted fix) before the row was written. | Commit or revert the edits, then re-run — or run the loop last, after the fixes land. |

The cleanest shape, and the one the `/work` driver uses: run the reviews **after** the code is final, with `base` at the merge-base and `head` at the tip, and touch nothing until the row is on file. The lens half of the gate has no equivalent binding yet (known residual — see `adversarial-ledger-binding.ts`), so a lens row still passes on the whole-branch identity regardless of the range it was given.

PR: [#912](https://github.com/trail-openers/pi-rukas/issues/912) · PR: [#1360](https://github.com/trail-openers/pi-rukas/issues/1360)

### A read-only command was refused with merge text

**Symptom:** An agent reading an issue's labels, timeline or comment history — to work out, say, why a cycle was parked — is refused. The command contains no merge, and the refusal talks only about merging and offers the merge override as the remedy:

> merge refused: the merge guard checks only one plain merge command — … Operator override: `PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1`

The three reports are janit/tehas #244 and #253 (twelve refusals of plain reads between them — issue `view`/`list` reads with `--json`/`--jq` filters, plus `labels` / `timeline` / `events` API reads) and #261 (an installer script held the same way). The guard was active even though the session logged `permission-guard: PI_ENSEMBLE_SANDBOX_MODE=1 — bypassing all tool gating` — it is registered before that short-circuit, so neither sandbox nor trust mode silences it.

**Cause:** the guard is a **trigger**, not a merge parser: a command naming a forge, HTTP client or interpreter **and** a merge word is held to the plain-merge form whether or not it merges anything (see the two exemptions above). A read trips it when a merge word appears anywhere in its text — in a `--jq` filter, in an argument, in a log-file name — because once the trigger fires the command must be the one plain merge form, and a read never is. The refusal text made it worse a second way: it read as a merge refusal whatever had actually been held, and the only remedy it offered was widening the merge safety switch. **An operator who follows that advice to unblock a read weakens merge protection to fix something that was never about merging** — that is the failure this entry exists to stop.

**Now:** the reads in those reports are inert, and a refusal says what it held:

- **Reads are reads.** Each command in the three reports classifies as not-a-merge through one of the two exemptions above, and never reaches the ledger path: `gh api … --jq '{number,title,state,closed_at}'` runs as plainly as `gh issue view 250 --json number,title,state` always did. **Length is not a reason to hold a read either:** the size bound that refuses an unreadably long merge command (`too-large`, #955) applies only to a command that spells a merge word, so a 9 kB `--jq` filter or a changelog pasted into `gh pr create --body` runs. It is not a sandboxing limit — the guard reads no files — and a read whose length does get held is reported as a false hold rather than widened by hand.
- **A refusal names the hold, not a merge.** A classifier refusal ends with `[reason: <code> — <detail>]` naming the shape that was held; a hold rendered by `renderHold` carries that shape as prose (`command held (not a merge): …`) and logs the bare code to the trace line, not a bracket. Only a command that could actually have merged — one the grammar read as a merge and rejected on its flags — is told the accepted merge form. When the held thing is not a merge (`body-indirect`, `brace-expansion`, `not-a-forge-command`, `too-large`), the text names that shape instead and does **not** name `PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE`: a held non-merge never offers the merge override.

**If a read is still refused:** read the reason code first — it names a shape, not a permission. Then, in order: run the read as its own command, with no chain, pipe or redirection; drop the merge word from the argument, or move the argument to a file; and for a gh verb outside the read allowlist, use the read verb (`gh pr view`, `gh issue view`) rather than the mutating one. **Do not set `PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE`** — for a read there is nothing to override. If none of that helps, the command is genuinely forge-shaped: the held text names the word the guard stopped on, and the shape it does check is a plain `gh api` GET with no merge word in the filter.

PR: [#1417](https://github.com/trail-openers/pi-rukas/issues/1417)

### A merge was refused: latest lens passed=false / REVIEW_INCOMPLETE although the review reported APPROVED

**Symptom:** `gh pr merge` is refused because the branch's latest lens entry says `passed: false, detail: "REVIEW_INCOMPLETE", round: 1` — but the hand-run `dispatch_lens_review` you just completed reported `APPROVED`. Inspecting `.git/review-ledger.json` shows the genuine entry is missing or shadowed by a `REVIEW_INCOMPLETE` row written at a nearly-identical timestamp (12–17 ms apart, same `patchId` / `headSha`).

**Cause (#1069):** Two independent writers could race on the same ledger file. The primary one was the offline smoke suite itself: tests that drive `runLensReview` / `runAdversarialLoop` with `process.cwd()` (the real worktree, not a temp repo) write their fixture rows through the same `appendLedgerEntry` path the tool uses. Because `review-ledger-path.ts` maps every worktree of the clone to the MAIN clone's `.git`, the fixture rows land in the real per-clone ledger — a `REVIEW_INCOMPLETE` row for the branch under test that shadows the genuine entry a few ms later. The secondary one was the `appendLedgerEntry` rename-race fallback: when a concurrent writer won the rename, the loser's fallback re-read the file (now containing the winner's row) and — pre-#1069 — deduped BEFORE pushing the new entry, so both rows survived for the same `(branch, kind)` and the round counter duplicated.

**Fix (shipped):**

1. Every smoke test that can reach `appendLedgerEntry` (directly or via `runLensReview` / `finishLensReview` / `writeLensLedgerEntry` / `runAdversarialLoop` / the lens tool) now self-isolates the ledger via `PI_ENSEMBLE_REVIEW_LEDGER_FILE` (a per-test temp file), a temp git-repo cwd, or a mocked `appendLedgerEntry`. `test-ledger-isolation.ts` enforces this statically and names any non-isolated file as a failure.
2. The race-fallback merge step is extracted into a pure, fs-free helper (`mergeAfterRace` in `review-ledger-merge.ts`) — push the bumped entry first, then dedupe — and is unit-tested directly without mocking `node:fs`.

**Recovery for an existing corrupted ledger:** re-run the lens review on the branch (`dispatch_lens_review` with `base origin/main` + `head <branch>`). The new entry (with a fresh `at`) becomes the latest and the stale `REVIEW_INCOMPLETE` row is shadowed. If you also see duplicate rows for the same `(branch, kind)` (the pre-fix race-fallback symptom), delete the older row from `.git/review-ledger.json` by hand, then re-run the review.

PR: [#1069](https://github.com/trail-openers/pi-rukas/issues/1069)

### A review reported APPROVED and the merge guard still says "no lens review on file"

**Symptom:** `dispatch_lens_review` (or `adversarial_loop`) completed and reported `APPROVED`, its summary showed the expected verdict, and `gh pr merge` is then refused with `no lens review on file for branch \`<branch>\` (latest: none)`. `.git/review-ledger.json` contains no row for the branch — and no one can say whether the review ran.

**Cause (#1449):** `PI_ENSEMBLE_REVIEW_LEDGER_FILE` relocates the ledger, and `ledgerPathFor` honours it *before* any git call. The var is read on every ledger access and inherited through the process tree, so one stale value makes the writer and the #912 guard agree on the same redirected file — and neither side can notice. Nothing was wrong with the review; the row was simply in a file the guard would never open. The leak that produced it was in the test helpers: `isolateLedger` used to honour an already-set value as its own isolation target instead of minting a fresh private one, so a caller adopted an inherited path, never restored it, and `rmSync`'d a directory it did not own on exit. A hand-run review in a process whose environment inherited such a value wrote its rows to a `/tmp` file while the real ledger sat untouched.

**Fix (shipped):** the misdirection is now *reported*, because it cannot be *detected* from the guard. Both writers (`lens-ledger.ts`, `adversarial-ledger.ts`) compare their resolved path against `cloneLedgerPathFor` — the override-BLIND resolver that always reports the clone's own ledger — and when the override is what moved the path they (a) stamp `writtenTo` on the row they did write and (b) add a `⚠ LEDGER WRITE MISDIRECTED` line to the tool summary naming the file and the var. The write still counts as `recorded: true` — it genuinely succeeded — and the round-cap still spends the round, so a redirect never hands the same round to the next run. The guard's refusal gained the matching distinction: a row carrying `writtenTo` produces `a lens review DID run and recorded its entry at the overridden path \`…\` … unset PI_ENSEMBLE_REVIEW_LEDGER_FILE in the reviewing process and re-run` instead of the plain never-reviewed text. With no write-side provenance it says nothing about a redirect — it does not guess.

`isolateLedger()` now always points at a fresh private temp file, saves and restores the env around its own use, and removes only the directory it created. Honouring an operator's scratch ledger is a separate, explicit call — `adoptLedgerOverride()` — which creates nothing and registers no cleanup. `test-ledger-isolation.ts` asserts a second call cannot inherit the first one's path and that the process's env is what it was before.

**What is NOT this bug:** the four legitimate no-write outcomes (`noReview`, carry, no branch, no patch id) write nothing at all and are worded differently on purpose — none of them mention a path. If the summary has no misdirection line and the ledger has no `writtenTo` row, the review really did not record, and the refusal's own reason (`no branch to key the ledger entry on` / `no patch id for the working tree`) says which.

**Recovery:** unset `PI_ENSEMBLE_REVIEW_LEDGER_FILE` in the reviewing process (`env | grep PI_ENSEMBLE_REVIEW_LEDGER_FILE` to find it; check the parent shell and any test helper that exported it), then re-run the review so the round is recorded where the guard reads. The redirected file is the record that the review happened — read it to confirm the verdict before re-running. Do not hand-copy a `writtenTo` row into the real ledger: it stamps a path the guard did not write and would be refused as an unbound row.

PR: [#1449](https://github.com/trail-openers/pi-rukas/issues/1449)

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
[pi-rukas] killed after 1800000ms inactivity (override: PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS)
  · last output: toolCall 1500s before the kill, after 412 line(s)
```

That number separates two failures a bare cause could not:

- **`0 line(s)`** — the child never spoke at all. A provider stall, an auth failure, or a bad model id. Nothing was produced, nothing is recoverable, and the problem is upstream of the agent. Raising the watchdog changes nothing.
- **a large count** — the child worked and then went quiet. A genuine hang, with real output on disk in its worktree worth recovering before you re-run.

**A `tool-inactivity` kill** is the same watchdog with its in-flight-awareness on: `last output: toolCall in flight: <tool>` means the silence happened *while a tool call was running* — a long bash (a full offline gate, a CI watch) or a tool that genuinely wedged. Its bound is `PI_ENSEMBLE_TOOL_INACTIVITY_TIMEOUT_MS` (default 60 min), separate from the model-silence budget below; the two knobs disable independently (`0` on one does not touch the other).

**A child hung inside one tool call** shows in `dispatch_peek` as `no new turn for <duration>` next to its wall-clock age. A steer cannot reach it — a steer lands only when the current tool call returns — so the action is `dispatch_kill <id>` with the id the peek row or the `[ensemble:slow]` notice printed; that works for adversarial round and lens children (`<run>/<label>`) too, and the waiting step then sees a failed dispatch. Steers no longer postpone the tool-inactivity kill: Pi acknowledges each one on stdout, and those acknowledgements used to count as output, so a child steered at every slow-run level outlived the 60-minute bound.

**`dispatch_kill` answered `Refused`** — the job belongs to a running `/work` driver cycle, which `dispatch_status`, `dispatch_peek` and the `[ensemble:slow]` notice now mark as `owned by the /work driver, not you`. The PM tool kills such a child only with `force: true` (for a hung one; the driver then sees a failed dispatch), and never kills the cycle's own `work-driver` job, whose abort stops nothing. The agent-list `x` is not gated. A PM `dispatch_specialist` / `dispatch_parallel` of `developer` or `ops` with a `cwd` inside `.worktrees/issue-<N>-*` is refused while the cycle for #N is live in that session; `explore` and the reviewer roles are let through, and so is everything once the cycle has ended.

The 30-minute model-silence budget (and the 60-minute tool-inactivity bound) are deliberately sized for the silence shape each owns: model turns at the model-silence budget, long tool executions at the tool-inactivity bound. Raising a wall-clock number to cover a cause you have not identified is exactly the mistake the six per-role timers were deleted for — each was raised twice, and each time the finding was that the number was too small for a *healthy* child.

### Reading a handoff

Every handoff carries three things it previously withheld.

**The review's own findings**, severity-ordered worst-first, with lens, path and line. These used to be replaced by a pointer — *"Review the JSON findings in the state file"* — in the GitHub body, and omitted entirely from the in-chat message. Four nessie cycles handed off with CRITICAL findings that nobody read, and the same defects were later rediscovered by hand from the diff. If a round reports issues but records nothing readable, the handoff says *that* rather than staying silent.

**Whether we killed the subagent.** A `timeout` or `inactivity` kill is now named as ours, with its cause. Previously `killCause` and `errorTail` were written to the event and rendered nowhere, so a wall-clock kill was indistinguishable from a crash, a 429, or a provider error — and two perfectly good issues were described to their operator as ambiguous because of it.

**Recovery commands that match reality.** A cycle halting before the branch step has no branch, no worktree and no PR, and no longer receives `git status` / `git push -u origin <branch>`. The predicate is the absence of a branch name, not a list of caps — so a newly added pre-branch cap cannot fall through to the wrong text again.

### The six-pass review said APPROVED but nothing looks reviewed

A lens that exits 0 without calling `report_finding` used to be indistinguishable from one that reviewed carefully and found nothing, so a silent review reported APPROVED. It now reports `REVIEW_INCOMPLETE` unless every lens produced either findings or a closing summary. If you see REVIEW_INCOMPLETE with no obvious failure, check the lens transcripts under `~/.pi/agent/ensemble-runs/<date>/` — a lens that returned only thinking content is the usual cause.

### A lens line says `N malformed report_finding call(s) skipped`

Pi validates `report_finding` arguments against the tool's schema and rejects a call missing `severity`, `path` or `title` with `Validation failed for tool "report_finding"` — that text is Pi's, and it names one missing key per rejection. A rejected call records nothing; the lens normally repeats it, so the count beside the lens's findings usually means wasted turns, not a lost finding. To check, compare the lens's `N findings` with what its closing summary lists: a finding in the prose with no matching entry was rejected and never re-sent. The lens's line `Skill Load Status: SUCCESS` reports that its skill loaded, not its verdict.

### `/work` parks at explore saying the spec is underspecified

Two new checks can park here, both because explore did not produce a decision the driver can act on:

- **No deliverables.** `INTENT-VERDICT: proceed` with an empty `### Deliverables` section now parks rather than planning against nothing. Acceptance criteria are *not* required — `proceed-with-assumptions` is the supported path for a defensible gap.
- **No signal at all.** A reply with neither a `## Spec` block nor a legacy `EXPLORE-VERDICT` token parks instead of advancing. On a single-issue cycle the prompt does not ask for the legacy token, so a missing `## Spec` block means the driver has nothing to read.

Revise the issue body (`/plan`) and re-run with `--restart`.

### The develop gate fails on missing dependencies, not on the diff

Development happens in a `git worktree`, which contains tracked files only — no `node_modules`, no virtualenv, no vendor tree. If your verify command needs them, it fails for a reason that has nothing to do with the change.

pi-rukas now provisions the worktree: it runs **`.pi/worktree-setup`** if you provide one (the reliable option — put `bun install`, `uv sync`, whatever your project needs, in it), and otherwise symlinks `node_modules`, `.venv` and `vendor` when they exist and are gitignored. Discovery is not limited to the repo root: any depth-1 subdirectory that contains a manifest or lockfile (`package.json`, `bun.lock`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `Gemfile`, …) is scanned for a nested `node_modules` — so a nested-package monorepo provisions without a hook (#481). An **empty** candidate directory is never linked or reported as a useful link, and a project with a lockfile but no findable tree gets a `problem` the branch step traces rather than a silent bare worktree. Build output (`target/`, `build/`, `dist/`) is never shared: concurrent workstreams writing one directory would serialise the fan-out.

A verify failure that looks dependency-caused now says so in the handoff rather than implying the diff is at fault. If you see that, add `.pi/worktree-setup`.

### The `.pi/worktree-setup` hook — contract

The hook is the escape hatch for the inexpressible: anything the symlink allowlist cannot describe (multi-step installs, generated files, environment-specific paths) goes here. The contract the driver makes when invoking it:

- **No arguments, no environment.** The hook is invoked as `sh <repoRoot>/.pi/worktree-setup` and must locate `repoRoot` itself — e.g. `git rev-parse --path-format=absolute --git-common-dir` (git ≥ 2.31), whose parent directory is the main checkout.
- **`cwd` = the new worktree root.** `git worktree add --detach` has just run, so the hook sees a tree of tracked files only.
- **The hook path skips the symlink loop entirely**, including the `.git/info/exclude` write that loop performs. If your hook creates a symlink (say, `ln -s $repo_root/extension/node_modules extension/node_modules`), it must write its own exclude entry to `$GIT_COMMON_DIR/info/exclude`, or the link surfaces as untracked in `git status --porcelain` and `stagePorcelainPaths` stages it into the PR.
- **A non-zero exit is reported as `ProvisionResult.problem`** and traced at the branch step; the cycle continues (a bare worktree is the status quo, not a regression). A hook that cannot provision should exit 0 with a diagnostic to stderr, not fail the cycle. That guidance is about a hook that *cannot* provision (nothing to link, fresh clone), not about a check that *could not answer*: when `git check-ignore` itself fails (exit ≥ 2 — corrupt index, unsafe-directory rejection, git older than 2.31), the hook dies with git's own text rather than reading a git error as "not ignored" and exiting 0 over an un-provisioned tree (#1394). Provisioning still never fails the branch step — the failure is recorded, the cycle continues.
- **`hook-failed` in a `worktree-provisioned` event means the hook exited non-zero, nothing else.** A hook that exited 0 is recorded `hook-ran`; it carries a `problem` when any non-empty, gitignored dependency location the project expects (`node_modules` / `.venv` at the root or in a depth-1 package dir) does not resolve to a non-empty directory in the worktree. A project with no such location and no manifest/lockfile expects nothing, so it carries none. A project whose toolchain keeps dependencies outside the tree (Cargo, Go, Bundler) expects nothing here, so a `Cargo.toml` alone never raises one.

### Every `/work` cycle on pi-rukas parks at `verify-failed:develop` with a verify timeout (#1146)

**Symptom:** the branch step records `worktree-provisioned` with `outcome: hook-failed` and *"node_modules in the worktree is absent, stale, or empty (source: <repo>/node_modules)"*, and develop parks with *"exceeded its 10-min timeout"* and no specific assertion.

**Cause (fixed):** pi-rukas has two non-empty gitignored `node_modules` — the real tree at `extension/node_modules` and a jiti compile cache at the root. The hook linked only `extension/node_modules`; the post-hook check verified only the first non-empty `node_modules` it found (the root one), so the two disagreed — and a missing nested tree was never checked at all.

**Now:** this repo's hook links both trees (`node_modules` and `extension/node_modules`), the hookless symlink loop links **every** non-empty gitignored `node_modules` at the root and in depth-1 package dirs, and the post-hook check verifies each of those locations. Before running the verify command in a worktree, the develop gate checks the same locations and, if one is missing, fails at once with `<path> missing in <worktree>` instead of running the command into the timeout. The root `node_modules` linked here is Pi's jiti compile cache. **Accepted risk:** processes running in a worktree can now write into the main checkout's jiti cache, and the main Pi process later loads from that cache. Before this fix a worktree had no path to it. Trust mode (same UID, same filesystem access) means a child could already write there by path, so the link widens the reach of a path that was already open rather than granting new access; a worktree child that writes a bad cache entry can affect the next main-checkout run. A worktree provisioned before this fix: run `sh .pi/worktree-setup` in it.

### The plan step re-dispatches saying two workstreams claim the same file

Each workstream gets its own worktree and its own developer, running in parallel, so a file in two `paths` lists means two developers editing it at once — which used to surface much later as a `git apply` conflict at commit-pr. The plan step now catches it and re-plans once. If it persists, the issue probably needs those workstreams merged.

### A parallel plan parks at `verify-failed:develop` with a type error no workstream caused alone

**Symptom:** every developer reports success, yet develop parks with a type error such as *"Property 'x' does not exist"* or *"Module has no exported member 'y'"*, and the consolidated tree fails with the same error.

**Cause:** the plan split one change that threads a new value through several files (a new field on a shared type, a new export, and the code that uses them) into parallel workstreams. Each workstream starts from the same base commit and cannot see its siblings' commits, so the half that uses the new symbol does not compile alone, and the halves guessed different shapes for it. The plan-time coupling merge only sees edges that exist at the base commit (shared files, a declared `depends-on`, a file name referenced in the other's files), so it cannot see a symbol the change itself creates.

**Now:** the plan step defaults to one workstream and asks for the change's contract. Each workstream may declare `introduces:` (symbols it creates) and `consumes:` (not-yet-existing symbols it uses); a consumed symbol that a sibling introduces becomes a `depends-on` edge, and the coupling merge folds the two into one workstream. An issue that names an existing commit or PR as the fix (*"fixed in owner/repo#N"*, *"cherry-pick <sha>"*, *"port PR #N"*) is planned as one workstream that applies that change and resolves the conflicts. A plan that declares no symbols is handled as before. `PI_ENSEMBLE_PLAN_CONTRACT=0` turns the derived edges and the port fold off.

If a coupled split still reaches develop, the develop step recovers once: when one workstream's verify fails on a symbol that a sibling adds (by its `introduces:` line, or by an export or field in its own diff), the driver folds the two workstreams into one, rebuilds the consumer on the producer's commit, and re-runs develop. The event log shows a `fence-recovery-started` line naming both workstreams and the symbol. If the merged workstream still fails, the cycle parks and the handoff says the split was already merged. `PI_ENSEMBLE_SYMBOL_MERGE_RETRY=0` turns this off.

**Recovery:** the work is committed in the detached worktrees the handoff lists. If a known-good single commit exists, cherry-pick it onto a fresh branch from the mainline. Otherwise apply the workstream diffs in dependency order (the one that introduces the symbol first), fix the mismatch in one place, and run the full gate once on the combined tree. To avoid the split on a re-run, set `PI_ENSEMBLE_MAX_WORKSTREAMS=1`.

### `/work` parks my issue as "underspecified" but the resolver said it was fine

The handoff quotes its own resolver saying "the intent is clear, no contradictions" and then says the issue does not say enough to build from. Fixed in v0.12.41 — two causes, both in the gate rather than your issue:

- A **blocking open question** used to park a `proceed`. It no longer does; `proceed-with-assumptions` is the supported path for a spec with a defensible gap.
- A **numbered** deliverables list (`1. …`) was invisible to the parser, which read only `-`/`*` bullets. It emptied four spec fields at once.

**Do not reformat your issues.** The theory that deliverables need a `D{N}:` prefix is wrong — ids are assigned automatically, and 0 of 40 real issue bodies were affected by the numbered-list gap.

### A cycle parked at explore right after a timeout

A timed-out explore produced an empty reply, and the driver read that as "explore found nothing to say" — emitting a needs-clarification cap over the dispatch failure. Fixed: a failed dispatch is now classified as the infrastructure fault it is.

### Cycles run one at a time now

`PI_ENSEMBLE_PARALLEL_GROUPS` defaults to 1. Measured across 69 cycles, every autonomous merge ran alone, and concurrent cycles ran ~2.4× slower per role — enough to trip the watchdogs — as well as corrupting each other through the shared repo root. Set the env var if you want the old behaviour. *Superseded:* the default went back to 3 once every workstream got its own worktree and integration a single lock (see "Parallel groups" below), and a small host now lowers it ([configuration](configuration.md) → `PI_ENSEMBLE_PARALLEL_GROUPS`).

### A cycle merged even though the full verification failed

**Symptom:** `.pi/verify-cmd-full` fails (typecheck, lint, or a fixture suite) and the cycle still reports MERGED.

**Cause (fixed):** `runCi` emitted `verify-full-status: failure` without a `ci-status`, and `nextStep` had no branch for it, so the cycle fell through the linear `ci → merged`. `ci-status: failure` was always routed correctly to `develop`; its sibling was not. Since the full-verify check is opt-out (`PI_ENSEMBLE_VERIFY_FULL=0` disables it) and this repo ships the command file, it applied to every cycle here.

**Now:** both failure signals route identically — back to `develop` within the retry budget, then to handoff at the cap.

### `/work` refuses a PR number at commit-pr

The gate now requires the PR to be **open** and to have this cycle's branch as its head. Previously it only checked that `gh pr view <N>` did not error, which proved a PR with that number exists — not that it belongs to this cycle. If you see this, the ops reply's `pr:` marker named a PR from a different branch, or one that is already closed or merged. Check `gh pr list --head <branch>`.

### The PR was merged or closed while `/work` was still reviewing it

The driver reads the cycle's PR before lens-review, lens-fix, ci, and before it pushes a lens fix. **Merged** by a person: the cycle ends `merged`, and the terminal line says *merged by someone else during <step>* — the driver merged nothing and pushes nothing further; unpushed work stays in the cycle's worktree(s). **Closed** without a merge: it parks as `pr-not-open:<step>` with a `[pr-not-open]` failure (`verify-failed:<step>` before #1349). If the PR's state cannot be read, the step runs as before. The review's residual findings are posted to the recorded PR number (a merged PR still takes comments); if that fails they go to the issue, and `/work-status` shows a `lens-residuals-post-failed` event saying where they went.

### `/work` halts at the branch step naming the mainline

The branch step recorded whatever branch `repoRoot` was on, and that value becomes the branch the cycle force-pushes to. If an ops child creates the branch and then returns `repoRoot` to `main`, the cycle would have adopted `main`. It now halts. Re-run with `--restart` after checking `git -C <repo> branch --show-current`.

### A merged PR reported a failed cycle

**Symptom:** `gh` shows the PR merged, the driver shows `step-failed:merged` and hands off; the worktree is not torn down and the checkout is not restored.

**Cause (fixed):** after a successful mechanized merge the driver dispatched role `driver`, which is not a spawnable role, so `spawn.ts` threw `Unknown role: driver`. Work the driver performs itself is now recorded directly via `work-driver-events.ts` rather than dispatched.

### `/work` hit the adversarial cap and handed off with no PR

**Symptom:** the cycle reaches step 5, the adversarial loop runs its three rounds, and the run parks with *"could not reach APPROVED"* — no commit, no branch pushed, nothing on GitHub. The diff is left unstaged in `.worktrees/issue-<n>-*/`, often with green tests.

**Cause (fixed):** the loop exited only on `APPROVED`, so `ISSUES_FOUND` — which `agents-base/adversarial-developer.md` explicitly defines as *"Should address, **not blocking**"* — halted the cycle exactly as hard as `CRITICAL_ISSUES_FOUND`. Measured across 253 loops, 41 of 49 rejections (83.7%) ended on that non-blocking verdict. `MINOR_OBSERVATIONS` was worse: absent from the code's enum entirely, so a reviewer that used it fell through to the `ISSUES_FOUND` default and was reported as having produced no readable verdict.

**Now:** every unresolved verdict still earns a fix round, but at the last round only `CRITICAL_ISSUES_FOUND` blocks. A pass that left findings behind reports `PASSED WITH FINDINGS` rather than `APPROVED`, and those findings appear in the PR body under *"Adversarial review — non-blocking findings"* and in the six-lens review's context. If your cycle still parks here, the reviewer returned `CRITICAL_ISSUES_FOUND` — read the *"What the reviewer objected to"* section of the handoff comment, which now quotes it.

### The adversarial step aborted with "reviewer unavailable: …"

**Symptom:** the handoff reads *"the adversarial gate produced no verdict — reviewer unavailable: provider/transport error: Request timed out. (×2 in a row — not re-dispatched) [cause=provider-severed]"* (or `provider-model-unavailable`, `rate-limited:quota-window`), and the cycle ends with no PR.

**Cause:** the provider, not the change. Every reviewer child died on the same provider error. The loop now stops after two identical failures in a row, does not retry a 404 model or a quota-window 429 at all, and waits out a burst 429's stated delay. Neither the fan-out nor the step router re-dispatches a fault the taxonomy calls final. Before #79 the same outage spawned up to 16 reviewer children and the handoff only said *"dispatch failed twice (retry exhausted)"*. Fix the endpoint or the model id, then re-run `/work`. The develop work is still in the worktree.

### The handoff says `Rounds: 0 of 3` but the loop clearly ran

`reviewRound` is the **lens-review** counter and is legitimately 0 when a cycle dies at step 5 without reaching step 7. It used to be printed under an adversarial cap too, so a loop that ran three full rounds reported zero. Fixed: an adversarial cap now reports its own round count, and the handoff quotes the blocking finding instead of the generic *"the diff still has issues the adversarial-developer flagged"*. Under every other cap the line now names its counter — `0 of 3 review rounds (six-lens review; the adversarial gate ran 1 round(s), last: ISSUES_FOUND)` — so a cycle parked at develop after an adversarial round and its fix pass no longer reads as unreviewed.

### The handoff shows the branch at the base commit, or `0 file(s) modified`, beside "the branch holds the work"

The handoff used to print the **repo root's** `HEAD` on the branch line. A successful pre-handoff consolidation puts the commits on the feature branch and then restores your checkout, so that `HEAD` was the base commit and the branch looked empty. The line now carries the branch's own tip and its distance from the base (`· tip 37d1118a, 1 commit(s) ahead of base`), the comment labels the other value `repo-root HEAD`, and beside committed work the file count reads `N uncommitted file(s)` — it only ever counted uncommitted files. A handoff snapshot written before the `headSha` → `repoRootHeadSha` rename shows no repo-root HEAD line at all; re-run the cycle to refresh it, or ignore the missing line — the branch state itself is unaffected.

### A restarted cycle erased its own history

`/work <n> --restart` overwrites `.pi/work-state/<n>.json`, including the event log of the run you are trying to diagnose. Copy the state file before restarting. The subagent transcripts under `~/.pi/agent/ensemble-runs/<date>/` survive longer but are pruned to the last 20 batches (`runs.ts`); the durable record is `~/.pi/agent/sessions/`, which is not pruned.

## Permissions

### Host-mode pi-rukas is asking me to approve every command

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

Relaunch `pi` — no more prompts. The agent runs as your UID with your credentials; that's the deal in interactive host mode. Use `pi-rukas` (sandbox) if you want confined execution.

PR: [#215](https://github.com/trail-openers/pi-rukas/pull/215)

### Headless `pi -p` hard-denies all novel commands

**Symptom:** `pi -p "do something"` in a script / CI returns immediately with "Tool 'bash' requires approval (no UI available)" for any command not in the role's allowlist.

**Cause:** Headless mode (no TTY) preserves the legacy strict ask-flow with no human to consent → hard-deny. This is deliberate safety: silent rubber-stamping in automation contexts would be worse than failing closed.

**Fix:** Either (a) widen the allowlist in `.pi/permissions.json` for that project, (b) run inside the sandbox where there's no per-call gating, or (c) if you genuinely need an unrestricted automated run, prepend `PI_ENSEMBLE_SANDBOX_MODE=1 pi -p ...` — but understand this disables ALL guard layers and should ONLY be used in a context already sandboxed by other means (Docker, VM).

PR: [#215](https://github.com/trail-openers/pi-rukas/pull/215)

### `pi-rukas-headless` refuses `--merge` or `--sandboxed`

**Symptom:** `pi-rukas-headless work 42 --merge` (or `--sandboxed`) exits 40 with `unknown argument "--merge"`, and the cycle never starts.

**Cause:** deliberate (#1025). Both flags name an escalation a caller must not be able to request. `--merge` is the one authority source that bypasses the policy judge, so a host that could pass it could grant its own cycle permission to merge; `--sandboxed` would claim the container's trust mode from outside the container. Trust is an environment fact the image bakes (`PI_ENSEMBLE_SANDBOX_MODE=1` in `.devcontainer/Dockerfile`), not a request.

**Fix:** nothing to pass. Merge authority comes from the project's `AGENTS.md` read at the cycle's base commit and needs `gh` merge evidence alongside it, so a cycle with neither parks as `awaiting-human-merge` (exit 10) with the PR open — which is the outcome, not a failure to work around. For sandbox behaviour, run the binary inside the image. See [headless.md](headless.md#what-the-runner-refuses-to-accept).

Related: a child of a headless run outside the image denies every `ask`-class tool with `no broker socket — headless deny`. That is the same design one layer down — with no sandbox and no human, fail closed rather than guess — and the mode-independent guards (merge, issue-creation) still run ahead of it.

## Image acquisition

### `./install.sh` takes 10+ minutes (cold local build)

**Symptom:** Running `./install.sh` on a fresh host (or after `docker system prune`) takes 10-30 minutes. Output shows `cargo install vipune`, `cargo install double-o`, `npm install -g ...`, the Rust toolchain compiling.

**Cause:** You're on an `install.sh` from before #219 — pre-#219 the script always built the image locally. Post-#219 it pulls a pre-built multi-arch image from `ghcr.io/trail-openers/pi-rukas:latest` (built + published on every merge to main).

**Fix:** Pull the latest pi-rukas repo + rerun install.

```bash
cd ~/.config/opencode/pi-rukas && git pull && ./install.sh
```

The pull should finish in ~10-20s on broadband. If it falls back to a local build, see the next entry.

PR: [#219](https://github.com/trail-openers/pi-rukas/pull/219)

### `docker pull ghcr.io/trail-openers/pi-rukas:latest` returns `denied`

**Symptom:** `./install.sh` reports `Pull failed; building locally from this checkout instead.` Inside that pull attempt: `Error response from daemon: denied` — or `unauthorized`, the daemon's other error string for the same private-package cause.

**Cause:** The GHCR package is private. GHCR container packages default to private regardless of repo visibility — a public GitHub repo does **not** make its package public.

**Fix (if you own the repo):** GitHub → Profile → Packages → `pi-rukas` (owner `trail-openers`) → Package settings → Change visibility → Public.

**Fix (if you don't own the repo, but have a GitHub account):** Authenticate to GHCR with a personal access token that has `read:packages`.

```bash
gh auth token | docker login ghcr.io -u USERNAME --password-stdin
./install.sh
```

PR: [#219](https://github.com/trail-openers/pi-rukas/pull/219)

### Forcing a local build (Dockerfile development)

**When:** You're iterating on `.devcontainer/Dockerfile` and want to test changes before they're merged + republished.

**How:** Pass `--build` to install.sh.

```bash
./install.sh --build
```

Skips the registry pull, builds directly from your checkout. Takes 10-30 minutes cold; uses Docker layer cache on subsequent runs.

## Sandbox launch

### `pi-rukas --help` (or any subcommand) fails: `line N: <dir>/lib-pi-rukas-shell.sh: No such file or directory`

**Symptom:** Invoking `pi-rukas` through a symlink — e.g. the `~/.local/bin/pi-rukas` link that `install.sh` creates, or any other link to `bin/pi-rukas` — fails immediately for **every** subcommand including `--help`:

```
line 36: /Users/you/.local/bin/lib-pi-rukas-shell.sh: No such file or directory
```

**Cause:** `install.sh` symlinks only `bin/pi-rukas` into `~/.local/bin` — the helper `bin/lib-pi-rukas-shell.sh` (a real file in this repo's `bin/` directory, sourced by `bin/pi-rukas`) is not linked. The pre-fix source line (`source "${BASH_SOURCE[0]%/*}/lib-pi-rukas-shell.sh"`) resolved the helper relative to the **unresolved** `BASH_SOURCE[0]`, so via a symlink it looked for the helper next to the link (e.g. `~/.local/bin/`) instead of next to the real script. Under `set -euo pipefail` the failed `source` aborts the script on line 36 before any command runs.

**Fix:** Pull the latest pi-rukas and re-run `./install.sh`. The script now resolves its own real directory once near the top — following any chain of symlinks (absolute or relative targets, builtins + `readlink` + `cd -P`, macOS-portable) — and sources the helper from that resolved directory; `ensure_image` / `rebuild` reuse the same resolution instead of ad-hoc `readlink -f` blocks. Covered by the offline smoke test `extension/smoke-tests/test-pi-rukas-symlink.ts` — absolute symlink, two-level relative chain, direct invocation, and a canary proving the pre-fix line still fails.

```bash
cd ~/projects/pi-rukas && git pull && ./install.sh
pi-rukas --help   # exits 0, no "No such file or directory"
```

**Stopgap note:** if you added a workaround symlink in your home directory at `~/.local/bin/lib-pi-rukas-shell.sh` (a link to the repo's `bin/lib-pi-rukas-shell.sh`) to mask this failure, it can be deleted once the fix is installed — the script no longer needs the helper next to the link:

```bash
rm ~/.local/bin/lib-pi-rukas-shell.sh
```

Issue: [#978](https://github.com/trail-openers/pi-rukas/issues/978)

### `MCP: 0/N servers` — codebase_memory not connected

**Symptom:** Inside `pi-rukas`, the bottom status line shows `MCP: 0/1 servers` (or 0/N). `/mcp` reports no servers connected. Subagents fail any `mcp__codebase_memory__*` tool call.

**Cause:** Pi 1.0.0's built-in MCP reads `~/.pi/agent/mcp.json` (user-level) and `.pi/mcp.json` (project-level, after trust). `install.sh` writes the `codebase_memory` entry into `~/.pi/agent/mcp.json` with `exposure: "direct"` (the seven read-side tools are declared to the model) and `autoEnableCodemode: false` (so the MCP extension does not auto-activate the codemode built-in when a server with codemode exposure connects). If you never ran `./install.sh` (or ran it before pi-rukas shipped the native-MCP wiring in issue #959), the file is missing or empty.

**Fix:** `cd ~/projects/pi-rukas && ./install.sh`. Validate with `jq '.mcpServers | keys' ~/.pi/agent/mcp.json` — should list `codebase_memory`. Also confirm no installed extension registers the `/mcp` command (a lingering pi-mcp-adapter would replace the built-in MCP and silently disable it — `install.sh` now removes the adapter from both `~/.pi/agent/npm/node_modules/` and `~/.pi/agent/extensions/` on re-run). Restart Pi.

PR: [#196](https://github.com/trail-openers/pi-rukas/pull/196)

### `gh issue list` returns "HTTP 401: Requires authentication" inside container

**Symptom:** Inside `pi-rukas`, `gh` commands that hit the GitHub API return 401. Outside the container on the host, the same commands work fine.

**Cause:** macOS `gh auth login` stores the token in Keychain, not in `~/.config/gh/hosts.yml`. The container's bind-mount of `~/.config/gh/` brings the config dir but not the keychain-stored token.

**Fix:** The wrapper extracts the token via `gh auth token` on the host and forwards it as `GH_TOKEN` env into the container. If you're seeing 401, check the host: `gh auth status` should report you authenticated. If you're using a personal access token directly, export it as `GH_TOKEN` in your shell so the wrapper forwards it explicitly.

PR: [#203](https://github.com/trail-openers/pi-rukas/pull/203)

### Custom LLM endpoint (e.g. `halo`) returns "connection refused" or "no such host"

**Symptom:** A custom provider (configured in `~/.pi/agent/models.json` with `baseUrl: "http://halo:8080/v1"`) works from host-mode `pi` but fails inside `pi-rukas`.

**Cause:** The container's resolver doesn't see your `/etc/hosts`, Tailscale MagicDNS, or your home network. The hostname `halo` doesn't resolve.

**Fix:** Set `PI_ENSEMBLE_HOST_ALIASES` before launching:

```bash
PI_ENSEMBLE_HOST_ALIASES="halo:192.168.8.249,llm-box:10.0.0.7" pi-rukas
```

Comma-separated `name:ip` pairs. The IP must be reachable from the host (the container's network rides the host's stack via Docker bridge).

Default already includes `halo:192.168.8.249` — set the var if your halo is elsewhere or you need additional hosts.

PR: [#204](https://github.com/trail-openers/pi-rukas/pull/204)

### Custom provider missing from `/ensemble-model` picker

**Symptom:** `/ensemble-model` inside sandbox shows fewer providers than `/ensemble-model` outside. Your `trailopeners-h100`, `halo`, or other custom provider is missing.

**Cause:** Wrapper bind-mounts `~/.pi/agent/models.json:ro` (post-#205). If you're on an older wrapper version, custom providers aren't visible inside the container.

**Fix:** `./install.sh` from pi-rukas repo to refresh the wrapper. If after that the provider's API requests fail with `401`, check that the api key env var is exported in your shell rc — post-#228 the wrapper forwards the full host shell env, so any exported var (regardless of name) reaches the container.

PR: [#205](https://github.com/trail-openers/pi-rukas/pull/205), [#228](https://github.com/trail-openers/pi-rukas/pull/228)

### `MCP error -32000: Connection closed` for env-driven docker MCPs

**Symptom:** `.pi/mcp.json` defines an MCP server like `docker run -i --rm -e DATABASE_URI crystaldba/postgres-mcp` with `"env": { "DATABASE_URI": "${SOME_DB_URI}" }`. Works on host-mode `pi`; fails in `pi-rukas` with `MCP error -32000: Connection closed`. The MCP server process exits within milliseconds.

**Diagnose (inside the sandbox):**

```bash
env | grep SOME_DB_URI   # is the var even visible inside?
```

If empty: the var isn't reaching the sandbox.

**Cause:** Pre-#228 the wrapper only forwarded a curated env subset (`*_API_KEY` / `*_LLM_KEY` patterns + explicit list). Vars referenced in `.pi/mcp.json` env-refs (`${VAR}` / `{env:VAR}`) had to be explicitly listed in `PI_ENSEMBLE_EXTRA_ENV`. Pi's native MCP (or the pi-mcp-adapter on pre-1.0 hosts) interpolated them against the sandbox's env, got empty strings, spawned `docker run -e DATABASE_URI=""`, and the postgres-mcp container exited on invalid URI.

**Fix:** Refresh.

```bash
cd ~/.config/opencode/pi-rukas && git pull && ./install.sh
```

Post-#228 the wrapper forwards the entire host shell env (less a small conflict-blocklist — see [docs/configuration.md](configuration.md), env-vars table). Any var you `export` in your shell rc reaches the sandbox. Verify post-refresh: `pi-rukas shell` → `echo "$SOME_DB_URI"` prints the URI.

PR: [#228](https://github.com/trail-openers/pi-rukas/pull/228)

### `vipune search` returns "Failed to download embedding model … 404"

**Symptom:** Inside `pi-rukas`, `vipune search` errors with `Configuration error: Failed to download embedding model 'BAAI/bge-small-en-v1.5': request error: http status: 404`. Suggests `huggingface-cli download …`.

**Cause:** vipune downloads the embedding model on first semantic-search call. Its HTTP client 404s on the pinned revision (URLs work via `curl` — likely a redirect/User-Agent quirk).

**Fix:** The image pre-fetches the model into `/opt/hf-cache-seed/` and the entrypoint seeds the named cache volume from there on first start. If you're seeing the 404, your image is stale: `./install.sh` to rebuild. Verify the seed is present:

```bash
docker run --rm trail-openers/pi-rukas:latest ls /opt/hf-cache-seed/hub/models--BAAI--bge-small-en-v1.5/snapshots
```

Should list the pinned revision SHA.

PR: [#205](https://github.com/trail-openers/pi-rukas/pull/205)

### "fd not found. Downloading..." / "ripgrep not found. Downloading..." at startup

**Symptom:** First few lines after `pi-rukas` boot show Pi auto-downloading `fd` and `rg` into `~/.pi/agent/bin/`. Adds ~10s of boot time + requires network.

**Cause:** Image is stale (pre-#203). Modern image bakes both binaries in via apt.

**Fix:** `./install.sh` to rebuild. Verify: `docker run --rm trail-openers/pi-rukas:latest which fd rg` → `/usr/local/bin/fd` + `/usr/bin/rg`.

PR: [#203](https://github.com/trail-openers/pi-rukas/pull/203)

## Docker-based MCP servers

### `MCP: Failed to connect to <name>: spawn docker ENOENT` or `MCP error -32000: Connection closed`

**Symptom:** Project-level MCP servers configured in `.pi/mcp.json` with `command: "docker"` fail to connect inside the sandbox. Host-mode `pi` works fine. Pre-#216 the error was `spawn docker ENOENT` (docker CLI missing); pre-#220 it was `MCP error -32000: Connection closed` (CLI present, no socket mounted by default).

**Cause:** Stale wrapper / image. Post-#220 the docker socket is bind-mounted by default — no env-var flag needed.

**Fix:** Refresh.

```bash
cd ~/.config/opencode/pi-rukas && git pull && ./install.sh
```

Then relaunch `pi-rukas` (no env vars) and `/mcp` should show the docker-based MCP servers connected. Spawned MCP containers are siblings on the host's daemon — visible in the host's `docker ps`.

PR: [#220](https://github.com/trail-openers/pi-rukas/pull/220)

### `docker: permission denied while trying to connect to the Docker daemon socket`

**Symptom:** Docker socket is mounted but `docker ps` inside the sandbox returns "permission denied".

**Cause:** The entrypoint's `chmod 666 /var/run/docker.sock` didn't fire — likely an outdated image (pre-#216 entrypoint runs as `vscode`, can't chmod a root-owned socket).

**Fix:** Rebuild the image.

```bash
cd ~/.config/opencode/pi-rukas && ./install.sh
```

Verify post-rebuild: `pi-rukas shell` → `ls -la /var/run/docker.sock` shows `srw-rw-rw-`.

PR: [#216](https://github.com/trail-openers/pi-rukas/pull/216)

### I want a tighter sandbox — disable docker socket access

**Symptom:** You want the pre-#220 isolation where the sandbox can't talk to the host docker daemon.

**Cause:** Docker socket grants root-equivalent host access from inside the sandbox (any process can mount host paths, launch privileged containers, etc.). The default-on behavior accepts this trade-off; the opt-out is for users who don't.

**Fix:**

```bash
export PI_ENSEMBLE_NO_DOCKER_SOCKET=1
```

Note: docker-based MCPs in `.pi/mcp.json` will stop working under this opt-out.

PR: [#220](https://github.com/trail-openers/pi-rukas/pull/220)

## SSH from inside the sandbox

### `ssh remote-host` fails with "Permission denied (publickey)" or "Error connecting to agent"

**Symptom:** Agents inside the sandbox can't `ssh` to remote hosts that work on the host. `ssh-add -l` returns one of:
- *"Could not open a connection to your authentication agent"* — no agent at all
- *"Error connecting to agent: Permission denied"* — the forwarded agent socket exists but isn't usable

Outbound `ssh` then fails with `Permission denied (publickey,...)` even though you have working keys on the host.

**Cause:** Two sub-cases:

1. **Stale wrapper (pre-#220).** The wrapper didn't bind-mount `~/.ssh/` or forward `$SSH_AUTH_SOCK`. Fix: `cd ~/.config/opencode/pi-rukas && git pull && ./install.sh`.
2. **Broken agent forward (pre-#227).** Wrapper attempted the forward but Docker created an empty **directory** at `/run/host-ssh-auth.sock` instead of a usable socket — common on macOS Docker Desktop where the host's `$SSH_AUTH_SOCK` is a launchd-managed path Docker can't bind-mount cleanly. SSH then loops on "Error connecting to agent" even though on-disk keys at `~/.ssh/` would work. **Post-#227 the entrypoint detects this and unsets `SSH_AUTH_SOCK`** so SSH falls back to your on-disk keys cleanly. Refresh with `./install.sh`.

**Diagnose your case (inside the sandbox):**

```bash
echo "SSH_AUTH_SOCK=${SSH_AUTH_SOCK:-<unset>}"
ls -la "${SSH_AUTH_SOCK:-/dev/null}" 2>&1   # should show `srw-` (socket); `drwx` = broken bind-mount
ls -la ~/.ssh/                              # on-disk keys + known_hosts + config
```

**Fix:**

```bash
cd ~/.config/opencode/pi-rukas && git pull && ./install.sh
```

Then relaunch `pi-rukas`. Inside, `ssh-add -l` either lists your forwarded identities (working forward) or reports "Could not open a connection to your authentication agent" CLEANLY (broken forward → fell back to disk keys). `ssh remote-host` should succeed via one path or the other.

**If you have no SSH agent running on the host:** start one before launching pi-rukas so a forwardable agent socket exists:

```bash
eval "$(ssh-agent -s)"
ssh-add ~/.ssh/id_ed25519   # or whichever key
pi-rukas
```

**On-disk keys + UID mismatch (macOS edge case):** the wrapper mounts `~/.ssh/` RO so keys are visible inside, BUT SSH's `StrictModes` may refuse keys whose host UID (501 on macOS) doesn't match the container's vscode UID (1000). Workaround: use ssh-agent (above) — the agent socket bypasses file-perm checks.

**Last-resort manual recipe (pre-refresh or weird host env):** explicit key, bypass any broken agent.

```bash
ssh -o IdentityAgent=none -i ~/.ssh/<your-key> user@host
```

PRs: [#220](https://github.com/trail-openers/pi-rukas/pull/220), [#227](https://github.com/trail-openers/pi-rukas/pull/227)

### I want a tighter sandbox — disable SSH credentials access

**Symptom:** You want the sandbox to have no SSH identities — neither `~/.ssh/` keys nor agent forwarding.

**Cause:** SSH agent forwarding lets the sandboxed agent impersonate any identity loaded in your host agent (push to remotes, ssh into prod boxes, etc.). The default-on behavior accepts this trade-off; opt out if you don't.

**Fix:**

```bash
export PI_ENSEMBLE_NO_SSH=1
```

Note: outbound SSH from inside the sandbox will stop working — including agent operations that ssh to remotes (e.g. `git push` over ssh, deploy scripts).

PR: [#220](https://github.com/trail-openers/pi-rukas/pull/220)

## Web research

### @explore agents are `curl`-scraping web pages instead of using `parallel-cli`

**Symptom:** `dispatch_peek` on a running @explore agent shows it `curl`-ing random pricing/blog pages. Long turn counts (30+) burning hundreds of thousands of tokens. Often returns hallucinated or stale data because pages dynamically render.

**Cause:** The image is stale — pre-#218 the sandbox didn't install `parallel-cli`. Without it, @explore's `parallel-cli search` returns `command not found` and the agent falls back to bare `curl` page-scraping (slow, bot-blocked, often wrong).

**Fix:** Rebuild the image.

```bash
cd ~/.config/opencode/pi-rukas && ./install.sh
```

Verify post-rebuild: `pi-rukas shell` → `which parallel-cli` returns a path; `parallel-cli --version` prints; `parallel-cli search "test"` returns structured results (requires `PARALLEL_API_KEY` exported on host — auto-forwarded by the wrapper).

If you don't have a parallel.ai account, @explore degrades to telling you to set up one. There's no other web-search path baked into the role — webfetch / Context7 are documented as unreliable for real-time data.

PR: [#218](https://github.com/trail-openers/pi-rukas/pull/218)

## Vision / images

> **Reminder:** Pi attaches a file as multimodal input only when its path is prefixed with `@` (e.g. `@/Users/you/Downloads/foo.png describe this`). Dragging an image into the terminal pastes the path but does NOT add the `@` — you have to type it yourself. Without it, Pi treats the path as plain text and never sends image bytes.

### Image dropped but model never mentions it / treats it as text

**Symptom:** Pasted path appears in the prompt, no error, model's reply ignores the image entirely or describes the path string instead of the image.

**Cause:** Missing `@` prefix. Pi only triggers multimodal attachment for `@<path>` tokens; a bare absolute path is just a string.

**Fix:** Re-send with `@` prefixed. Use `Home` / `Ctrl-A` after the drop to jump to the start of the pasted path, type `@`, submit.

### Dropped image rejected by sandbox-fs-guard

**Symptom:** After dragging an image into the `pi-rukas` session and prefixing `@`, Pi's `read` tool errors with `"Path '/Users/.../Downloads/foo.png' resolves outside the sandbox workspace"`.

**Cause:** The image lives outside the project workspace and outside the wrapper's default image-dir list (`$HOME/Downloads`, `$HOME/Desktop`, `$HOME/Pictures`).

**Fix:** Add the dir to `PI_ENSEMBLE_EXTRA_IMAGE_DIRS` before launching, OR move/copy the image into your project workspace.

```bash
PI_ENSEMBLE_EXTRA_IMAGE_DIRS="$HOME/Documents/screenshots" pi-rukas
```

The wrapper bind-mounts each listed dir RO and tells `sandbox-fs-guard` to permit reads under those roots.

PR: [#213](https://github.com/trail-openers/pi-rukas/pull/213)

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

PR: [#213](https://github.com/trail-openers/pi-rukas/pull/213)

## Session resume

### `pi-rukas -r` opens the picker but selecting a session does nothing

**Symptom:** `pi-rukas -r` shows the resume picker with sessions listed. Selecting one returns "No session selected" or fails silently. Or: the picker shows sessions from many projects and your specific one is hard to find.

**Cause (pre-#207):** Pi keys sessions by absolute `cwd`. The old wrapper mounted projects at `/workspace`, so sandbox sessions for ALL projects co-mingled in a single `~/.pi/agent/sessions/--workspace--/` bucket. Selecting a session whose original `cwd` was a host path (`/Users/…/projects/foo`) failed to load because that path didn't exist inside the container.

**Fix:** `./install.sh` to refresh the wrapper. Post-#207, the wrapper mounts your project at its host absolute path inside the container — same `cwd` as host mode, so session buckets align. `pi-rukas -r` from any project shows sessions for that project only, and host-mode `pi -r` sessions are visible too (and vice versa).

**Pre-fix sessions:** anything written to `~/.pi/agent/sessions/--workspace--/` before #207 is orphaned in that bucket. To resume one you specifically need, `pi --session <uuid>` from inside the container (it will search across scopes).

PR: [#207](https://github.com/trail-openers/pi-rukas/pull/207)

### Container hostnames change between sandbox runs

**Symptom:** Container names like `pi-rukas-nessie-8cbaf2dccfbd-a1b2c3d4` appear in `docker ps`. New name each launch.

**Cause:** Wrapper composes the container name as `pi-rukas-<project>-<project-hash>-<run-suffix>`, where the project-hash is a 12-hex `sha256` prefix of the project's absolute path and the 8-hex run-suffix is random per invocation. The project-hash disambiguates DIFFERENT projects (avoiding collisions in `docker ps`). The 8-hex run-suffix disambiguates concurrent sessions in the SAME project. Not a bug.

**Not a fix:** The name doesn't affect functionality — only how containers show up in `docker ps`. `pi-rukas stop` enumerates all containers matching the project's `<base>-*` prefix and stops them. `pi-rukas status` lists all of them.

### `docker: Error response from daemon: Conflict. The container name "/pi-rukas-..." is already in use`

**Symptom:** Trying to start a second `pi-rukas` in the same project errors with a name-conflict from docker.

**Cause:** Pre-#217 the container name was deterministic per project, so two concurrent sessions in the same project collided on `docker run --name`.

**Fix:** Pull + rebuild — `cd ~/.config/opencode/pi-rukas && git pull && ./install.sh`. Post-#217 each `pi-rukas` invocation gets a unique 8-hex run-suffix; concurrent sessions in the same project Just Work.

PR: [#217](https://github.com/trail-openers/pi-rukas/pull/217)

## State + caches

### `pi-rukas prune` warning about volumes "in use"

**Symptom:** Running `pi-rukas prune` errors with `volume is in use` for `pi-ensemble-cache` etc. (volume names keep the historical `pi-ensemble-` prefix for backwards compatibility).

**Cause:** Another `pi-rukas` session is currently running and holding the named `pi-ensemble-*` volume.

**Fix:** Exit running `pi-rukas` sessions (the wrapper uses `docker run --rm` so they're gone on exit) then re-run `prune`. Use `docker ps` to find still-running containers.

### Bind-mounted host state showing up in container as `root`-owned

**Symptom:** Files written by `pi-rukas` end up on the host owned by `root` instead of your user.

**Cause:** This shouldn't happen — the image's `vscode` user has UID 1000, the wrapper does NOT use `--user root`. If you see this, you're likely running an old image (pre-#200) or a custom Dockerfile derivative that switched users.

**Fix:** `./install.sh` to rebuild the official image. Verify: `docker run --rm trail-openers/pi-rukas:latest id` → `uid=1000(vscode)`.

### First sandbox run crashes with `EACCES: permission denied, mkdir '.../.pi/agent/sessions/...'`

**Symptom:** On a fresh host (no `~/.pi/agent/sessions`, `~/.pi/agent/ensemble-runs` or `~/.vipune`), `pi-rukas` crashes at startup with `EACCES: permission denied, mkdir '<mount>/sessions/--<project>--'` (issue #933).

**Cause:** When a host directory is missing, the launcher (`bin/pi-rukas` `build_mounts()`) falls back to a named volume (`pi-ensemble-sessions`, `pi-ensemble-runs`, `pi-ensemble-vipune`). If the image doesn't contain the mount point, Docker creates the new volume owned by `root:root` (mode 755); the entrypoint then drops privileges to `vscode` (UID 1000), which can't write into it. Same class hits the always-on cache volumes (`~/.cache`, `~/.bun`, `~/.cargo`, `/commandhistory`) when the mount point is absent.

**Fix:** `./install.sh` to pull the rebuilt image (v0.12.68+). The image now bakes the mount points in as `vscode`-owned, and the entrypoint repairs an existing root-owned named volume (`chown vscode:vscode`) at boot — but only for targets the launcher passes via `PI_ENSEMBLE_VOLUME_MOUNTS`, so a bind-mounted host directory is never touched. One-time manual repair if you can't upgrade: `docker volume rm pi-ensemble-sessions pi-ensemble-runs pi-ensemble-vipune` (destroys only container-scoped state) and/or `mkdir -p ~/.pi/agent/sessions ~/.pi/agent/ensemble-runs ~/.vipune` on the host so the launcher uses bind mounts instead.

## Diagnostics

### Confirm a bind-mount is reaching the container

```bash
docker run --rm \
  -v "$HOME/.pi/agent/models.json:/home/vscode/.pi/agent/models.json:ro" \
  trail-openers/pi-rukas:latest \
  jq '.providers | keys' /home/vscode/.pi/agent/models.json
```

Should print your provider keys. If it prints `null` or the file is missing, the bind-mount didn't take.

### Confirm an env var was forwarded

```bash
docker run --rm \
  -e "TRAIL_OPENERS_LLM_KEY=$TRAIL_OPENERS_LLM_KEY" \
  trail-openers/pi-rukas:latest \
  bash -c 'env | grep -E "(API|LLM)_KEY" | head -5'
```

Inside the wrapper-spawned container, the same env vars are auto-forwarded by pattern match (`*_API_KEY` / `*_LLM_KEY`).

### See what the wrapper actually does

`pi-rukas shell` drops you into bash inside the container with all the same mounts + env. From there:

```bash
env | sort                       # what env was forwarded
mount | grep -v 'cgroup\|proc'   # what was bind-mounted
ls ~/.pi/agent/                   # what state is visible
cat ~/.pi/agent/mcp.json          # native MCP server config
```

## When in doubt

`./install.sh` is the right first move for almost everything. It:

- Rebuilds the image (cache-fast unless prereqs changed)
- Refreshes the `~/.local/bin/pi-rukas` symlink
- Re-writes `~/.pi/agent/mcp.json` with the current codebase-memory-mcp native-MCP wiring (issue #959: key-level replace of `.mcpServers.codebase_memory`, `exposure: "direct"` for the seven read-side tools, `autoEnableCodemode: false`); also removes any lingering `codebase_memory` key from `~/.config/mcp/mcp.json` and removes any lingering pi-mcp-adapter install
- Validates that codebase-memory-mcp is reachable on PATH

If after `./install.sh` something still doesn't work, capture:

1. `pi-rukas --version` (or the wrapper file path: `which pi-rukas`)
2. `docker images trail-openers/pi-rukas --format '{{.Repository}}:{{.Tag}} {{.CreatedSince}} {{.Size}}'`
3. The exact failing command + error message
4. Open an issue at <https://github.com/trail-openers/pi-rukas/issues>.

## `/work` driver state recovery

### Symptom

`/work N` says it can't start, or halts immediately with a message like:

```
pi-rukas /work driver halted on issue #N: state-file inconsistencies detected.
  - pipelineState.inFlightJobIds includes <jobId> but log has no record of it
Inspect <project>/.pi/work-state/N.json or rm to start fresh (your git work is unaffected; only the workflow tracker state is removed).
```

Or you get a loud schema-version error when re-invoking `/work` after upgrading pi-rukas:

```
work-state: <path> has schemaVersion=2 but this build expects 1. This /work cycle was started under a different driver version. …
```

### Cause

Since this PR, `/work` runs through a compiled state-machine driver (`extension/src/work-driver.ts`). Workflow state persists at `<project>/.pi/work-state/<issue>.json` so the user can intervene surgically when subagent providers degrade and the driver can resume cleanly after restart.

The state file is the durable contract that lets the driver know which step is current, what dispatches have completed, and which caps have already fired. Two situations can leave it in a state the driver refuses to run against:

1. **Mid-flight crash**: Pi got killed (process exit, machine reboot, OOM) while a dispatch was in flight. The eventLog has a `dispatch-started` without a matching `dispatch-completed`. The driver detects the orphan jobId on resume and halts rather than fabricating a result.
2. **Schema version mismatch**: you upgraded pi-rukas between `/work` invocations, and the saved state-file's `schemaVersion` no longer matches what the new driver expects. We never auto-migrate state silently.

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

Every cap id the driver can record has exactly one row in this table (`extension/smoke-tests/test-troubleshooting-cap-entries.ts` fails the gate when a cap is missing or listed twice). Each time bound has its own id — `lens-review-timeout`, `plan-timeout`, `developer-timeout`, `verify-timeout:<step>`, `deadline` — so a cap never points at the wrong clock.

| `cap` value | What it means | Most-common operator action |
|---|---|---|
| `developer-timeout` | A developer child hit the spawn backstop (`PI_ENSEMBLE_SPAWN_TIMEOUT_MS`, default 2 h), which only catches runaway loops. Files-modified-but-uncommitted count appears in the message. Also recorded when the develop step went on to a verdict of its own (a fence or verify park) on the tree the killed child left: the backstop kill is then the cycle's cap, and `evidence` quotes the verdict it replaces ([#1593](https://github.com/trail-openers/pi-rukas/issues/1593)). | Inspect with `git status` in the worktree; split the issue into smaller workstreams, or take over. |
| `step-failed:<step>` | A HALT-class step's dispatch failed (network / provider error / non-zero exit). For multi-workstream steps (`develop`, `lens-review`), explainCap surfaces an `(N/M workstream branches failed)` parenthetical. Retry exhausted on RETRY_ONCE-class steps (`adversarial`, `lens-review`) also lands here. PR10: `step-failed:merged` fires when ops can't actually merge (auth / branch protection / conflicts / missing required review) — the merge ATTEMPT itself failed (authority and the evidence gate already passed, so this is not `awaiting-human-merge`); recovery is to remove the blocking cause and run `gh pr merge <PR-N> --squash --delete-branch` once by hand (the driver does not retry the merge step). | Read the failing dispatch's transcript via `/runs` (path in the handoff comment); retry, or take over manually. |
| `provider-unavailable` | A dispatch the model ENDPOINT caused ended a HALT-class step after its transient retries were spent, or a RETRY_ONCE step's single retry was exhausted: a severed stream (`Request timed out.` / `terminated`) or a 429 whose stated delay was short enough to wait out. Chosen from the dispatch that ENDED the step, not from anything provider-shaped earlier in the window — a step that met a blip, recovered, then died of a crash parks as `step-failed:<step>` with `failure.kind` `process`. A quota window or a spend cap does NOT get this cap (waiting does not clear it). Quota windows are systemic (see `runWorkQueue`) and halt the queue. | Nothing in the cycle's code was judged, so there is no defect to inspect. Re-run `/work N` once the endpoint answers — the step resumes where it stopped; do NOT `--restart` (it wipes the state file and rebuilds finished steps). A headless caller may re-queue on `failure.kind === "provider"` itself. To lengthen the ladder: `PI_ENSEMBLE_PROVIDER_RETRY_FLOOR_MS` / `PI_ENSEMBLE_PROVIDER_RETRY_MAX_WAIT_MS`. |
| `explore-already-complete` | Explore concluded the issue is already done (e.g., satisfied by a prior PR). Driver halts before any branch/develop. No code was written. | `gh issue close N --comment "Verified complete by /work — see prior PR"` if you agree; or `gh issue comment N --body "Additional context: …"` + `rm .pi/work-state/N.json && pi` if you disagree. |
| `explore-needs-clarification` | Explore couldn't determine concrete work (issue ambiguous / missing acceptance criteria). PR13 fixed a false-positive variant where multi-issue cycles produced NEEDS_CLARIFICATION even when bodies existed (the agent's verdict raced the parallel `gh issue view` fetch — pre-PR13 the body was never inlined in the prompt). Re-running on v0.12.13+ resolves recurrences if you saw this before. | Edit issue body via `gh issue edit N`, then `/work N --restart`. |
| `explore-bodies-empty` | PR11 — `gh issue view <N>` returned empty or errored for one or more issues. Pre-condition failure; the driver cannot reliably classify work it can't read. Common causes: gh version with projectCards GraphQL deprecation, gh extension hijacking stdout, expired auth, network. | `gh auth status && gh --version` to confirm gh setup. `gh api repos/<owner>/<repo>/issues/<N> --jq .body` works when `gh issue view` is broken — use it to verify the issue body fetches via REST. `gh extension list` if a misbehaving extension is suspected. Once fixed, `rm .pi/work-state/N.json && pi`. |
| `step-back-revise-spec` | PR12 — `runStepBack` fired (lens-review fix loop kept flagging the same shape across rounds — spec-level problem fingerprint). The @explore SDD analysis identified which of the six SDD elements (outcomes / scope / constraints / prior decisions / task breakdown / verification) is underspecified, and produced a proposed revision. | Read the proposed revision (surfaced in the handoff body): `cat tmp/issue-N/handoff-comment.md`. Apply the revision via `/plan N` (or `gh issue edit N`). Restart the cycle: `/work N --restart`. The `--restart` flag wipes the prior state file so the fresh cycle reads the revised spec. |
| `commit-pr-incomplete-consolidation` | PR14 — multi-workstream cycles run N developers in N worktrees with uncommitted changes; ops's commit-pr step is supposed to consolidate ALL of them onto the integration branch. The post-dispatch gate found files from one or more workstreams missing from the committed diff — ops drifted and committed a partial slice. Pre-PR14 the partial diff shipped silently (v0.12.13 /work 577 closed an issue with 1 of 3 workstreams' changes — root fix lost from main). | Each missing workstream's work is still uncommitted in its worktree: `git -C .worktrees/issue-N-<id> status --porcelain`. Apply each missing diff to the integration tree: `git -C .worktrees/issue-N-<id> diff HEAD \| git apply --index`. Verify (`git diff --name-only --cached`), commit, push. Or restart: `rm .pi/work-state/N.json && /work N --restart`. The handoff comment quotes paste-and-run-ready commands for each missing workstream. |
| `adversarial-loop` | `adversarial_loop` ran its 3-round internal fix loop and could not reach APPROVED. For N>1 multi-workstream cycles, the aggregate-rejected case (any per-workstream adversarial REJECTED) also fires this cap, with per-workstream findings tagged `[workstream <id>]`. Only `CRITICAL_ISSUES_FOUND` blocks at the last round, so this is a CRITICAL verdict; when the cycle had no PR yet, the handoff pushes the consolidated branch and opens a **draft** PR carrying the findings (#1402; `PI_ENSEMBLE_HANDOFF_DRAFT_PR=0` keeps it local). | Read the rejection findings; if phantom, re-run with `--merge` (the driver performs the merge once its gate passes — it is not a human step); if real, take over the worktree to fix or split the work. |
| `round-cap` | Lens-review hit its 3-round cap with findings still open — review loop didn't converge. Reaching handoff means the verdict was `CRITICAL_ISSUES_FOUND`, the adversarial gate had not approved, or the findings could not be posted to the PR; otherwise the cap routes to `ci` instead (see "A `round-cap` cycle reached CI instead of parking"). | Inspect the latest `lens-issues-found` event in `eventLog`; if findings cluster around a theme, that's a spec-level problem (consider revising the issue body before re-running). |
| `lens-review-timeout` | The lens-review fix loop (lens-review → lens-fix → adversarial → re-review) outlived its **own** budget, `PI_ENSEMBLE_REVIEW_WALL_CLOCK_MS` (90 min by default). It is not the cycle's time limit and not a host's kill — a cycle stopped by its caller's clock carries `deadline` (pi-rukas parked first) or the host's own cap. Named `wall-clock` before result schema v4 ([#1384](https://github.com/trail-openers/pi-rukas/issues/1384)): a host that ends cycles on its own limit read that id as its own clock, and its operator raised the wrong number. The cap-hit's `evidence` (and so the headless `failure.message`) names the elapsed time, the round and the budget. Since [#1416](https://github.com/trail-openers/pi-rukas/issues/1416) the budget is enforced at the fix dispatch, not only at the next verdict: a fixer started while budget remains is bound to what remains and killed at the bound; a fixer the budget has already outlived is never dispatched. | Same as `round-cap` — inspect findings, decide whether to retry or take over. If the review genuinely needs longer, raise `PI_ENSEMBLE_REVIEW_WALL_CLOCK_MS`; raising a host's cycle limit does nothing for this cap. If the fixer never started, `evidence` says so. Escape hatch: `PI_ENSEMBLE_REVIEW_ENFORCE=0`. A state file from an older build that recorded `wall-clock` is refused on re-entry as an unknown cap — `/work N --restart`. |
| `ci-retry` | CI failed `MAX_CI_RETRIES` times in a row (default 2 → 3 attempts total). Either CI is permanently broken for this branch, or develop keeps producing the same failure. | Read CI logs (URL in the handoff `ci-status` event); fix manually, or `rm .pi/work-state/N.json && pi` to re-run from scratch. |
| `adversarial-infra-failure` | A workstream's adversarial loop failed on infrastructure every attempt. No verdict exists for it; this is not a rejection. | Re-run `/work N`: it re-enters adversarial and re-runs only the workstreams that never produced a verdict. |
| `awaiting-human-merge` | The PR is open and green, but nothing granted the driver merge authority, or the `gh` evidence refused. See "Merge authority". | Merge by hand, or grant authority in `AGENTS.md` / `/work N --merge`. |
| `branch-ahead:<count>` | The branch step found a local branch of the cycle's name `<count>` commits ahead of `origin/<mainline>`. Nothing was reset. | `git log origin/<mainline>..<branch>`; push the commits if live, delete the branch if stale, re-run. |
| `consolidated-verify-conflict` | Develop-time consolidation hit a file-level conflict: two workstreams edited the same lines. The decomposition is incoherent. | Re-split the work into disjoint file sets (or resolve the overlap by hand), then `/work N --restart`. |
| `consolidated-verify-consolidation-created` | The consolidated tree fails an assertion neither workstream trips alone: the combination created the defect. | Fix the interaction named in the evidence, then re-run. |
| `consolidation-incomplete` | Consolidation dropped files: the branch is missing paths that a workstream's committed diff contains. The dropped paths are in `evidence`. | Apply the missing workstream diffs to the integration tree by hand, or `/work N --restart`. |
| `continue-pr-ambiguous` | `--continue-pr` found two or more open PRs for the issue; `evidence` lists them. It stopped before the branch step and wrote nothing. | Close all but one, then re-run with `--continue-pr`. |
| `continue-pr-fork` | `--continue-pr` found the issue's PR, but its head is in a fork, which the driver cannot push to. Stopped before the branch step. | Continue that PR by hand. |
| `continue-pr-head-moved` | During a `--continue-pr` run the PR head changed: someone else pushed to it, deleted it or rewound it. The driver never force-pushes, so it stopped. | Wait for the other push to settle, then re-run with `--continue-pr`. |
| `continue-pr-not-found` | `--continue-pr` could not prove exactly one open PR for the issue: none matched, `gh` failed, its output was unreadable, the 500-row page was full, or the forge is not GitHub. `evidence` says which. Stopped before the branch step. | Check that the PR is open and `gh pr list` works, then re-run with `--continue-pr`. |
| `continue-pr-unresolved` | At commit-pr the merge of the mainline into the PR head was not finished: a conflict, a leftover conflict marker, or a history without the PR head as first parent. Nothing was pushed; the worktree is kept. | Finish the merge in the kept worktree, or `--restart --continue-pr`. A bare `--restart` stops on `existing-pr-detected`. |
| `continue-pr-unsafe-head` | The PR's head is not safe to continue: an unsafe branch name, the mainline itself, a base other than the mainline, a local branch ahead of or diverged from the PR head, or another worktree holding it at another commit. Stopped before the branch step. | Fix the branch by hand, then re-run with `--continue-pr`. |
| `cross-group-conflict` | Another cycle holds a claim on paths this plan declares; two cycles cannot edit the same files at once. Also the cap of a queue claim wait that timed out. | Let the other cycle finish, or re-plan with disjoint files. |
| `deadline` | The caller's whole-cycle deadline (`PI_ENSEMBLE_CYCLE_DEADLINE` / `PI_ENSEMBLE_CYCLE_BUDGET_MS`) ended the cycle. Either it was within the handoff grace at a step boundary, so pi-rukas started no new step and parked; or a step was running when it arrived — that step's children were stopped at the deadline, and the cap is recorded after the step's own verdict, which `evidence` quotes ("passed while step … ran") ([#1593](https://github.com/trail-openers/pi-rukas/issues/1593)). The headless `failedStep` is the step in flight. | Re-run with the deadline raised or cleared; the handoff names the branch, the PR and the round reached. The quoted verdict judged unfinished work — do not act on it as if the step had completed. |
| `deferred-creation:develop` | A dependent workstream's deferred worktree creation was refused (a dirty same-issue leftover at the path) or failed. | Inspect and salvage the leftover worktree, then re-run. |
| `dependency-cycle` | Queue-level: the group sits inside an ordering loop (`Depends-on:` edges that form a cycle). It never dispatched. | Break the loop in the issue bodies, then re-run the queue. |
| `dependency-parked` | Queue-level: a group this one depends on settled on something other than `merged`. It never dispatched. | Resolve the dependency's handoff first, then re-run this issue. |
| `dependency-timeout` | Queue-level: the group waited on a sibling past its bound and never dispatched. | Re-run once the dependency has merged. |
| `develop-child-crash` | A develop child's engine died mid-pass and left uncommitted work in its worktree. | `git -C <worktree> status` before re-running: the dead pass's work is uncommitted and the driver never commits it for you. |
| `develop-incomplete-deliverables` | The converge gate found plan deliverables absent from the end-of-develop diff, even after the corrective re-dispatch. The code builds. | Implement the missing deliverables on the branch, or re-run `/work N` for a fresh corrective budget. |
| `draft-rearm-failed` | The review had to run again after the PR was marked ready, and the driver could not make the PR a draft again. | Make the PR a draft (`gh pr ready <N> --undo`) and re-run, or merge it deliberately. |
| `driver-crash:<step>` | A driver step handler threw: the driver crashed, not a subagent. The message and stack are the last event in the state file. | Fix the underlying error, then re-run `/work N`. |
| `existing-pr-detected` | An open PR already closes this issue. The driver halted at the branch step before any dispatch. | Resume, close or retarget that PR; `--restart` does not clear it. A headless host can pass `--continue-pr` to continue the PR instead (see [headless.md](headless.md#--continue-pr-for-hosts)). |
| `fence-violation:develop` | The develop scope fence's recovery round did not converge (a second violation, a violator↔owner cycle, or a git failure). | Split the plan so each file is declared by one workstream, then re-run. |
| `fix-pass-park` | The adversarial fix pass parked on its own checks (scope fence, no-op pass, comment retention, a read that failed closed). See "What `verify-failed:<step>` means, and the caps that split from it". | Read the evidence; fix or take over. |
| `integration-verify-failed` | The consolidated tree does not build. See "`integration-verify-failed` — the consolidated tree does not build". | As that section says. |
| `integration-worktree-violation` | The commit-pr fallback left the integration branch held by the wrong worktree. See "A second `commit-pr` after `lens-fix`, then `integration-worktree-violation` …". | As that section says. |
| `intent-park` | The intent resolver would not build: `parkReason` says why (`underspecified`, `already-implemented`, …). Exit code 11 headless. See "Why a cycle parked as `intent-park:underspecified`". | Revise the issue, then `/work N --restart`. |
| `issue-closed:<step>` | An issue in the cycle's group was CLOSED when the step started, so the cycle ended at that step boundary instead of dispatching more work. Every CLOSED counts, whatever the reason; nothing was merged or pushed further. | Reopen the issue (`gh issue reopen <N>`) if the work is still wanted, then re-run `/work N`; `--restart` does not override a closed issue. |
| `lens-diff-unreadable` | Lens review could not read the diff it is meant to review. See "Why a cycle halted at `lens-diff-unreadable`". | Fix the git error in `evidence`, then re-run. |
| `lens-fix-not-integrated` | The lens-fix developer's change never reached the branch. See "`lens-fix-not-integrated` — the fix never reached the branch". | As that section says. |
| `lens-fix-reposition` | The round-2 lens-fix guard could not establish the right base: the fix worktree is dirty, round-1 work never landed, or it diverged from the branch tip. | Commit or clean the worktree, land the missing commit or restore from the backup ref in `evidence`, then re-run. |
| `loop-detected` | A subagent repeated the same tool call and the harness killed it. The killed role is in `role`. | Change the approach or tighten the prompt; a plain retry loops again. |
| `no-review-outcome` | The lens review returned no review (nothing changed since the last lens run). A no-review is not an approval. | Re-run the review after a new commit lands. |
| `ops-merge-base-mismatch` | The ops-fallback branch does not sit on the freshly fetched base (built from a stale local ref). | Reset the branch to the right base, then re-run. |
| `plan-spec-mismatch` | The plan-to-spec gate refused the plan before the branch step. See "The plan-to-spec gate halted the cycle". | As that section says. |
| `plan-timeout` | The plan step's own bound (`PI_ENSEMBLE_PLAN_TIMEOUT_MS`, 30 min) expired and the corrective re-plan did not recover. | `/work N --restart`, or raise `PI_ENSEMBLE_PLAN_TIMEOUT_MS` if planning genuinely needs longer. |
| `pr-not-open:<step>` | The cycle's PR was merged or closed when the step started. See "What `verify-failed:<step>` means, and the caps that split from it". | Check the PR's state; re-run with `--restart` for a new PR. |
| `queue-stranded` | Queue-level: the group was still in the wait list when a halt released every worker. It never dispatched. | Re-run the issue once the halt's cause is fixed. |
| `repeat-finding-seam` | Round 1 of the lens review found the same finding shape across several files: a missing seam, so the driver ran a step-back analysis. | Read the analysis, revise the issue, then `/work N --restart`. |
| `repo-root-residue` | The branch step found uncommitted work at the repo root before any develop dispatch. Nothing was deleted. | `git status` at the root; commit, move or ignore the paths, then re-run. |
| `review-incomplete` | At least one lens failed every retry, so the six-pass review is incomplete: the diff was not fully reviewed, which is not a rejection. | Re-run `/work N`; read the failed lens dispatch via `/runs` if it recurs. |
| `token-budget` | A subagent crossed its cumulative token budget (`PI_ENSEMBLE_TOKEN_BUDGET_<ROLE>`). A cost cap, not a provider fault. | Raise the budget only if the work needs the context, or re-dispatch with a tighter prompt. |
| `verify-baseline-red:<step>` | The verify command already fails at the cycle's base commit, in the same way. See "`verify-baseline-red:<step>`: the gate was already red at the base commit". | Fix the base first. |
| `verify-env:<step>` | The system refused to start a process, so the gate never ran. See "What `verify-failed:<step>` means, and the caps that split from it". | Free the host's resources, then re-run. |
| `verify-failed:<step>` | The verify gate ran and judged the change red. See "Outcome-verification gates — `verify-failed:<step>` cap-hits". | Read the per-check evidence in the handoff and fix the code. |
| `verify-timeout:<step>` | The verify command hit its time bound and reached no verdict. See "`verify-timeout:<step>`: the gate did not finish". | As that section says. |
| `worktree-listing-unreadable` | The branch step could not read `git worktree list` (bounded; git hung or failed), so it could not tell whether a same-issue worktree holds work. | Clear what blocks git (a stale `.git/worktrees` lock), then re-run. |

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

`--restart` also clears `needs-human-attention` from every issue in the cycle (the restart is the answer to the question the label asks; the next handoff applies it again), so you never have to remove it by hand before restarting.

`--restart` only wipes the driver's state file (`.pi/work-state/N.json`) and that label. Worktrees and feature branches from the prior cycle are NOT removed — the branch step reuses them at runtime: a leftover at the same path with no uncommitted work and no unpushed commits is removed and recreated (the common path, unchanged), but a leftover that HOLDS work is refused instead (see `worktree-dirty-preremove` below). If you want a fully clean slate, salvage any work first, then `git worktree remove --force -- .worktrees/issue-N-*` and `git branch -D feature/issue-N-*` before re-running.

### `/work N --restart` parked again and posted no new comment

**Symptom:** a restarted cycle ends as `intent-park` again, explore ran, but the issue has no second "Cap hit" comment. The handoff reads *"REPEAT of the park reported N min ago (<comment link>) …"*.

**Why:** `--restart` re-resolves the issue from scratch every time. When that fresh resolution parks for the same reason, against the same issue text and the same checked-out commit as the park already reported, a second comment would say nothing new — so the handoff links the earlier one instead (the `needs-human-attention` label is still verified and re-applied). The earlier park is remembered in `.pi/work-state/N/intent-park.txt`, which `--restart` does not wipe. Any difference — another park reason, an edited issue, a moved `HEAD`, a missing or unreadable record — posts a new comment as before.

**Fix:** none needed; act on the linked comment. Delete the record file if you want the next park reported in full regardless.

### An adversarial fix pass parked on "removed N origin/main comment line(s)"

**Symptom:** the handoff reads *"adversarial fix pass (<workstream> round N) parked: the fix pass removed N origin/main comment line(s) in <workstream> and wrote no comment in their place (<file>: <line> | …)"*.

**Why:** a fix pass is told to answer review findings, so it parks when it deletes a comment outright while the code stays. It does not park for a reworded or replaced comment (the same diff hunk adds a comment) or for a comment an earlier develop pass already removed: those are listed for the reviewers under "Comments removed by this change", who judge them. Before this, any comment line the whole workstream diff did not keep verbatim parked the pass, and the cap text read *"(evidence detail missing from state)"*.

The park has its own cap, `fix-pass-park` (it reused `verify-failed:develop` before #1349). It is not a rejection by the outcome-verification gate, so do not set `PI_ENSEMBLE_VERIFY=0` for it; the cap text opens *"the adversarial fix pass did not clear"*.

**Fix:** restore the named lines in the workstream's worktree, or reword them in place, and re-run. `PI_ENSEMBLE_COMMENT_RETENTION=0` disables the check.

### An adversarial fix pass parked on "changed <file> — outside its declared paths"

**Symptom:** the `fix-pass-park` reason reads *"<workstream> changed <file> — outside its declared paths and the files the findings name (declared paths: …; finding-named files it admits: …). No finding names <file>. …"* (or *"A finding names <file>, but it does not widen the fence"*).

**Why:** a fix pass may change only the workstream's declared paths (or, undeclared, the files it already changed) plus finding-named files that widen the fence — tracked at base, unprotected, and in the directory of a declared or already-changed non-root path. The check runs after the pass, so the edit is not refused up front (#1522); the park names both sets it checked and the worktree that holds the change. Before #1522 it was the bare clause, with neither set nor a recovery.

**Fix:** if a finding's fix genuinely needs the file, the declared scope is wrong: name the file in the issue's scope and re-run `/work <issue> --restart`. Otherwise the pass overreached: revert the file in the named worktree and land the rest by hand, or re-run `/work <issue> --restart`. The findings the pass answered are in the handoff's plumb report.

### "repoRoot was NOT restored: the discarded state could not be saved"

**Symptom:** a failed consolidation, integration, lens-fix integration or handoff consolidation ends with *"repoRoot was NOT restored: the discarded state could not be saved (`git diff` failed: …), so nothing was reset or checked out — the tree at <path> is left exactly as it was"*. The next `/work` then stops at the branch step with `repo-root-residue`.

**Why:** before a restore resets the repo root it saves what it would discard to `restored-state-*.diff` in the cycle's scratch dir. When that save fails, the root is the only copy of the change, so the restore no longer resets it. Previously a failed save was treated like "nothing to save" and the tree was reset anyway.

**Fix:** the error in the message names the git command that failed and its stderr; fix that first. Then recover the change at the named path by hand (`git status`, `git diff`, `git diff --cached`, and `git cherry-pick --abort` if one is in progress), and clear the root before re-running.

### Build output in the repo root declined the gate (`[build-residue]`, #1421)

**Symptom:** a complete, reviewed, committed change parks as `verify-env:develop` (`verify-failed:develop` before #1421) and the first evidence line starts with `[build-residue]`, naming paths like `target/.rustc_info.json`, `target/CACHEDIR.TAG`, `target/debug/.cargo-lock`, or a `dist/` the bundler wrote. The handoff says the change was never judged. An older build reported the same condition as `verify-failed:develop` with "consolidated verify was refused — repoRoot is dirty (…)", plus a handoff line claiming "consolidation infeasible (work remains on its worktree detached HEADs)" while the commits sat intact in a worktree.

**Why:** every dirty-root gate reads `git status` at the repo root and refuses to mutate a root carrying anything it cannot identify. Build output is untracked and unignored whenever the project's `.gitignore` does not cover where the build actually lands — a cargo workspace whose root is the checkout ignores `console/target/` but not `target/`, so a gate that builds at the root produces the residue that blocks the next gate. Before #1421 that environment refusal carried the code-failure cap, so a finished change was filed alongside diffs the gate had actually rejected.

**Fix:** the named paths are git-ignored, so they are a tool's output — do not inspect the diff first. Keep build output out of the checkout the gate runs in:

- point the build at a directory outside the tree (`CARGO_TARGET_DIR=/tmp/<project>-target`, a persistent target volume, `--out-dir` outside the root);
- or gitignore the output where it lands (`/target/`, `dist/`) so the classifier's `git status --ignored` read can see it is not source.

Clear what is already there, then re-run. The gate does **not** delete anything — build output is preserved like any other file, because a driver that cleans a tree it does not own is the failure class the dirty-root gate exists to prevent.

**What the classifier exempts, and what it never does:** only untracked paths, and only ones git itself declares ignored (`git status --ignored=matching`, so `.gitignore`, `core.excludesFile` and `.git/info/exclude` all count), plus the driver's own scratch (`tmp/issue-<N>/`, `.worktrees/`, `.pi/work-state/`). A **tracked** modification, staged entry, deletion or rename is dirt whatever `.gitignore` says about the path — a file that became ignored after it was tracked still holds uncommitted source. An ignored read that fails classifies every path as dirt, which is the pre-#1421 behaviour: the narrowing can only ever loosen a refusal it has proven wrong, never weaken a gate that could not answer.

### `/work` refuses on a dirty repo root caused by a tool's own local files (#1362)

**Symptom:** `/work N` halts at step 3 (branch) with cap `repo-root-residue` and a plumb report naming a file you never wrote — `.claude/settings.local.json`, an editor's workspace file, an agent's local config. The same file also trips the consolidated-verify and integrate dirty-root gates, so clearing it once by hand only moves the refusal to the next cycle.

**Why:** a repo-root read of `git status --porcelain` cannot tell "the operator's in-progress work, which is a correctness hazard for integration" from "some tool's local settings". Both are dirt, and the branch step hard-blocks on any of it before paying for a develop dispatch. The built-in exemptions are the driver's own scaffolding (`.worktrees/`, `.pi/`, `tmp/`) and no more; nothing about a third-party tool's files is assumed.

**Fix:** opt in, per project, by committing a list of repo-relative prefixes the dirty-root checks and repo-root staging should ignore:

```
# .pi/dirty-root-exempt — one repo-relative prefix per line
.claude/
.vscode/
```

Rules, and **who enforces each** — the exemption has two different answers depending on the question, and reading one where the other belongs is the trap:

| Question | Who answers | Decided by |
| --- | --- | --- |
| Is this dirt? | The four dirty-root gates: the branch step, the preflight, consolidated verify, integrate | **Prefix** — an untracked path under a listed prefix is not dirt, whatever wrote it |
| Is this the cycle's work? | The restore **claim** | **Provenance** — was the path already untracked at cycle start? |
| Should it be stashed? | The abort path's stash pathspec | Nothing — it is unfiltered, because an unstashed path is one the checkout can lose |

- **Untracked paths only.** A modified, staged or deleted *tracked* file under an exempt prefix is still dirt, and a rename always is — so the list cannot hide real uncommitted source.
- **Prefix + `/` boundary.** `.claude` exempts `.claude/settings.local.json`, never `.claudefoo/x`. A path that still contains a `..` segment after normalisation is never exempt, so `docs` does not bless `docs/../.github/x`.
- **Protected paths cannot be exempted.** An entry naming `.github/`, `.pi/`, `CODEOWNERS` or `agents.json` is rejected with a trace and contributes nothing, at any depth; you cannot list away the files that define how your own cycle is judged.
- **Repo root only.** A workstream worktree stages its output exactly as before, so a deliverable inside an exempt prefix is still committed.
- **Rejected with a trace:** absolute paths, any `..` segment, glob characters, anything that normalises to empty, `~`-, drive-letter- (`C:\`) and `$VAR`/`%VAR%`-prefixed entries (none of which this matcher would ever expand), and protected paths. A rejected line is skipped — the good lines beside it still apply.
- **The file is read once per cycle**, before the branch step, from the working tree; `.pi/` is a protected path, so a develop patch cannot widen the exemption mid-cycle. An absent file is an empty list (behaviour unchanged); an unreadable file is an empty list **plus a trace and a handoff record** — a broken config never blocks a cycle that is otherwise clean, and never fails silently. If the cycle then blocks on repo-root residue, the handoff says `the exemption file could not be read: EACCES …` beside the paths: every one of them was judged against an empty list, so a file you legitimately exempted reads exactly like residue.

```bash
cat .pi/dirty-root-exempt            # what this project exempts
# rejected entries and read failures are traced as:
# [pi-rukas] WARN work-driver: .pi/dirty-root-exempt (<repoRoot>) — entry "…" rejected (glob)
```

**A file the cycle itself wrote under an exempt prefix is still yours to see.**
The list decides what counts as *dirt*; it does not decide what counts as *the
cycle's work*, because by the time the restore builds its claim it is too late to
ask git — the abort path's mixed reset has already turned the cycle's staged-new
files into `??`, the same code a tool's stray carries. So the branch step records
the exempt paths that were **already untracked when the cycle started**, as
`dirtyRootExemptBaseline` in the cycle's state file, and the claim spares an
untracked file under an exempt prefix only when it appears there. A file the cycle
wrote under that same prefix — a deliverable in a directory you exempted, a
regenerated cache — is named, and is still moved into a recoverable `git stash`
entry rather than left behind for the next cycle to trip over. Your pre-existing
`settings.local.json` is named by neither: not stashed, not saved, not restored.
Two things follow from the field being a snapshot. It is written once, in the
branch step, and never recomputed — a snapshot taken later would bless the cycle's
own output as pre-existing. And if the state file has no baseline (a cycle started
before this existed, or one whose exempt tree was too large to record — over 500
paths), then **nothing is claim-exempt** and the claim names every untracked path
it finds. That is deliberate: a claim that over-names is a false alarm you can
dismiss, and a claim that says "verified restored" over the cycle's own work is
the failure the field exists to prevent.

```bash
jq .pipelineState.dirtyRootExemptBaseline .pi/work-state/<issue>.json   # what the claim will spare
```

**Do not** use this to work around a genuinely dirty root. If the named file is source you or another workstream wrote, commit or move it — that is what the gate is for.

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

**A committed fix that could not be integrated is named.** When the fixer committed and the pick onto the branch failed, the handoff gives the fix's sha, the worktree holding it and the conflicting paths — the PR does not contain that commit, so land it by hand before merging. On an older build the second lens-fix round parked this way on its own: integration re-picked a commit that was already on the branch behind the tip (`Committing is not possible because you have unmerged files` in the evidence), stranding the round's real fix one commit ahead in the worktree. Fixed: a commit already in the branch's history is skipped.

### A second `commit-pr` after `lens-fix`, then `integration-worktree-violation` and a non-fast-forward push

Symptom: after `lens-fix` and a long re-review the driver ran `commit-pr` again instead of `lens-review`, logged `integrate worktree creation failed … refusing to force-remove existing worktree …/issue-<N>-default — it holds unrecoverable work: (unpushed commits: N)` and `! [rejected] … (non-fast-forward)`, and parked. Two causes, both fixed: a `dispatch-slow` event (any dispatch past the slow-run threshold) was appended after the step's verdict, and the driver routes on the last event — so the approval was shadowed and the cycle fell through to `commit-pr` (#1235); and the fallback's integrate worktree treated the cycle's own workstream tree as a foreign leftover (#1185). On an older build the work is intact in `.worktrees/issue-<N>-<id>` (detached HEAD) — cherry-pick it onto the branch.

### The ops fallback committed, nothing was pushed, and the next `commit-pr` refused `issue-<N>-integrate`

Symptom: a `commit-pr` that fell back to the ops dispatch committed in `.worktrees/issue-<N>-integrate` but no new commit reached the PR. A later `commit-pr` (a resume or a CI-fix round) then halted with `integration-worktree-violation`: `refusing to force-remove existing worktree …/issue-<N>-integrate — it holds unrecoverable work: (unpushed commits: N)`. On some builds the tree was removed silently instead, and the commit was lost.

Cause (#1173, #1100): the driver created the integrate tree on a **detached HEAD**, because it passed the branch's SHA to `git worktree add`, not the branch name. The prompt said the tree was on the branch. So the ops child's commit never moved the branch, and `git push -u origin <branch>` pushed nothing. Fixed: the tree is now created on the branch (a missing branch is created at the base). The fallback prompt also forbids creating or switching to any other branch.

A stale integrate tree whose only loss is commits, and which is detached or on the cycle's own branch, no longer refuses. Its commits are kept on `refs/pi-rukas/integrate-backup/issue-<N>` and the tree is recreated. The commit-pr plumb report names the ref: `The stale integrate tree's unpushed commits were kept on …`. A tree with uncommitted or non-regenerable ignored files, or one on a different branch, still refuses. Recover a kept commit with `git log refs/pi-rukas/integrate-backup/issue-<N>` / `git cherry-pick refs/pi-rukas/integrate-backup/issue-<N>`.

**One ref per issue (#1396).** The namespace holds at most `refs/pi-rukas/integrate-backup/issue-<N>` — one ref per issue, replaced in place on every re-entry — so a cycle that re-enters `commit-pr` twenty times leaves one ref, not twenty (`git for-each-ref refs/pi-rukas/integrate-backup` counted refs growing one per SHA before the fix). It therefore names the **last** kept HEAD only, and an older re-entry's backup is replaced. That is not a new loss channel: the driver force-removes the tree that held the older HEAD immediately after writing the ref, and every removal decision refuses first whenever a tree holds uncommitted or non-regenerable work — so nothing the ref protected had survived anyway. To drop the ref when you are done with it: `git update-ref -d refs/pi-rukas/integrate-backup/issue-<N>`.

**The replaced sha is named (#1396).** When a re-entry overwrites a ref that pointed at a *different* commit, the commit-pr plumb report and the handoff name it: `It replaces an older backup of \`<sha>\`, which no ref now names`. After that write nothing in the ref namespace points at the older commit.

**Recover it promptly — `git reflog` is not a route (#1396 adversarial round).** The tree that held the older HEAD is force-removed immediately after the ref is written, and `git worktree remove --force` deletes `.git/worktrees/<name>` — **its reflogs included**. So the reflog of the integrate worktree does not exist by the time the halt is read, and "check the reflog there" is a dead instruction. What still works, in this order:

1. `git fsck --unreachable` at the repo root, and look for a commit carrying the consolidation message.
2. Pin it the moment you have the sha: `git branch rescue-<sha> <sha>` — any ref makes it reachable, and gc skips it thereafter.

Both race **auto-gc**: an unreachable commit is pruned once it ages out of the reflog-expiry window (`gc.reflogExpire`, 90 days by default but immediate for objects that were never in a reflog), so "later" is not a plan. A re-entry that writes the same sha again names nothing superseded: nothing was lost.

A kept ref is **not** re-applied automatically: the next commit-pr regenerates the consolidation from the develop patches, so the ref exists only for manual recovery.

**A `git worktree list` that cannot be read refuses the whole creation (#1396).** The registration check that decides whether a stale `issue-<N>-integrate` tree is driver residue used to read an unreadable listing as "not registered" — which skipped the commit-keeping path entirely and let the driver force-remove a tree it had never proved was residue. It now uses the strict listing: one retry at 250 ms, then a `WorktreeScanError` naming the git error, **nothing removed** — the tree stays on disk and stays registered, exactly as in the sibling-scan refusal above. The halt surfaces as `integration-worktree-violation`; read its plumb report for the underlying git error (a stale lock, a permissions problem) rather than re-running blind.

### CI failed, the driver "fixed" it, and CI failed on the same commit again

Symptom: after `ci-status: failure` the cycle ran `develop → adversarial → commit-pr`, logged `commit-pr re-entry — open PR #<N> already heads <branch>; integrate/prCreate skipped`, and `ci` then watched the unchanged head until the retry cap. The re-entry guard treated every open PR as a finished `commit-pr` and never pushed the fix. Fixed: a second `commit-pr` now measures the worktrees against the branch, and work the branch lacks is integrated onto the branch's own head and pushed fast-forward to the PR that is already open (`commit-pr second round` in the trace). On an older build the fix is intact in `.worktrees/issue-<N>-<id>` — cherry-pick it onto the branch and push.

If the cycle's PR was **merged or closed** in the meantime, the second `commit-pr` parks (`pr-not-open:commit-pr`, "PR #<N> is MERGED, not OPEN"; `verify-failed:commit-pr` before #1349) without touching the branch — it used to rebuild the branch from base and push over the remote (the non-fast-forward rejection). The new work is in the worktree; open a new issue or PR for it.

### `integration-verify-failed` — the consolidated tree does not build

`commit-pr` runs the project's `.pi/verify-cmd` against the **integrated** tree, between the commit and the push. Everything upstream saw one workstream in isolation: the develop gate ran inside a single worktree and adversarial reviewed a single worktree's diff. Two workstreams that each pass alone can still fail together — one renames or deletes what another still refers to — and that defect is *created* by integration, so integration is the only place it can be caught.

When it fires, **nothing was pushed and no PR exists**. The failing output is in the plumb-report on the handoff. Typical cause: one workstream moved or removed a symbol another still calls. Fix the interaction and re-run.

Unlike other `commit-pr` failures this does **not** fall back to the LLM ops dispatch. That fallback exists to absorb environment variance (an apply conflict, a rejected push); "this does not build" is a verdict, and letting ops push the identical tree would make the gate one that cannot fail.

Projects with no `.pi/verify-cmd` skip the check entirely and are unaffected.

A run killed at its bound (`PI_ENSEMBLE_INTEGRATION_VERIFY_TIMEOUT_MS`, 15 min by default) is not a verdict that the tree does not build. It parks as `verify-timeout:commit-pr` instead, and nothing is pushed.

**A gate that was already red at your base commit no longer parks the cycle (#1404).** When the consolidated verify fails, the driver runs the SAME command once more against the cycle's original base commit in a throwaway worktree, and compares the failing test names — parsed from the loop's `FAILED:` markers, from the raw stream rather than the bounded tail, which elides all but the summary. Names that fail at base too are **pre-existing**: the gate owns them, not your diff. If every failure is pre-existing the cycle continues, pushes, and opens the PR, with the names listed in the PR body and carried on the plumb-report so the handoff says which red tests the gate had been blaming unfairly. Anything else still parks, and the park reason names **only** the tests that pass at base — an operator told to "fix the consolidated tree" for five red tests, three of which the base already had, wastes three inspections on gate rot.

Three things the probe cannot do, all deliberate:

- **It cannot turn a red gate into a pass.** The continue decision hangs off the caller, and the gate's `ok: false` verdict is what licenses it; a probe that established nothing never sets the flag.
- **It cannot excuse a failure it cannot name.** No `FAILED:` marker (a `tsc` or biome error prints none), a collapsed `… and N more` summary, a base run killed at its bound, or a base run that exited non-zero while its own tally said `F: 0` — every one of those is `unattributable`, and absence of evidence is never read as evidence of innocence.
- **It must be given the cycle's ORIGINAL base.** `pipelineState.baseSha`, not a followup round's `followupBase` — the latter already carries this cycle's own commits, which would excuse every failure as pre-existing.

A green gate pays nothing: the probe runs only after a failure, so healthy cycles are untouched. Fix the gate itself at some point — the names in the PR body are the list, and until you do, every cycle on this project carries a red baseline the driver has to work around.

### How a subagent's life is bounded

Two mechanisms, and only one of them is meant to fire in normal operation.

| Mechanism | Default | Env var | What it is for |
|---|---|---|---|
| Inactivity watchdog (model silence) | 30 min of **zero stdout** while no tool call is in flight | `PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS` (`0` disables only this watch) | The real hang detector for a stalled model turn. A healthy child emits an event at every turn boundary, so silence — not slowness — is the signal. |
| Tool-inactivity watchdog | 60 min of **zero stdout** while a tool call is in flight | `PI_ENSEMBLE_TOOL_INACTIVITY_TIMEOUT_MS` (`0` disables only this watch) | The bound for a silent *tool* — a long bash (the full offline gate, a CI watch) is the normal shape, a wedged tool the bad one. One poll, two budgets: while the in-flight set is non-empty this bound applies, otherwise the model-silence bound. |
| Runaway backstop | 2 h wall-clock | `PI_ENSEMBLE_SPAWN_TIMEOUT_MS` | Catches a child looping forever while still emitting events, which liveness cannot see. Nothing else should reach it. |

This replaced a table of six per-role wall-clock caps. Those were raised twice — [#296](https://github.com/trail-openers/pi-rukas/issues/296) and [#553](https://github.com/trail-openers/pi-rukas/issues/553) — and both times the finding was the same: the number was too small for a *healthy* child. Provider speed varies by an order of magnitude, so a wall-clock number never means the same thing on two models, and the per-role table had already drifted out of sync with this documentation.

**If a child hits the backstop**, treat it as a decomposition problem, not a budget one: two hours of continuous output without finishing means the workstream is too large or the child is looping. Split the issue, or take over manually.

### `ci` step timeout — CI runs > 10 min (PR15)

The `ci` step dispatches `ops` to run `gh run watch <id>`, which blocks until CI completes. Pre-PR15 this inherited ops' 10-min default, so any CI run exceeding 10 min SIGTERM'd mid-watch and routed through `step-failed:ci` handoff (3× this session on nessie's ~15-min pipeline).

PR15 gives `ci` its own 30-min cap (30 × 60000 ms). Override via `PI_ENSEMBLE_CI_WATCH_TIMEOUT_MS` (milliseconds). The per-role ops default this sentence used to name no longer exists — every other `ops` dispatch is bounded only by the two mechanisms in the table above, except `handoff`, which has its own bound (next entry).

If your project's CI genuinely takes longer than 30 min, either raise `PI_ENSEMBLE_CI_WATCH_TIMEOUT_MS` or accept the handoff — inspect the CI run in the browser, then fix the branch and push, or (once CI is green) re-run with `--merge` so the driver performs the merge — merging is the driver's step, not a human one.

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
### A host-killed cycle's record names a fence or verify park, or its handoff landed seconds before the kill

**Symptom.** A cycle run under a host wall clock ends with a step verdict as its cap — e.g. `"cap": "verify-failed:develop"` with fence evidence — while the same step's log holds a `dispatch-failed … killed after 7200000ms timeout` with the same timestamp. Or the handoff is written seconds before the host stops the container (janit/tehas cycles 175 and 329).

**Why.** The cycle deadline was checked only before a step started. A step already running when it arrived ran to its own backstop (2 h for a developer), into the host's kill, so the handoff got whatever time was left. And the last cap-hit is the cycle's cap, so the verdict the step reached on the tree its killed child left stood as the terminal reason.

**Fix (shipped, [#1593](https://github.com/trail-openers/pi-rukas/issues/1593)).** Every child a cycle spawns is bounded by what `PI_ENSEMBLE_CYCLE_DEADLINE` leaves, and the handoff's by the allowance after it (`PI_ENSEMBLE_HANDOFF_TIMEOUT_MS`, less up to a minute for the in-process `gh` fallback). At the handoff boundary, a step that ended past the deadline records `deadline` after its verdict; without a passed deadline, a step whose child was killed at its time bound and never re-run records `developer-timeout` (develop) or `step-failed:<step>`. The cap's `evidence` quotes the verdict it replaces, which stays in the log. The host contract: deadline = hard kill − handoff allowance, and the allowance passed as `PI_ENSEMBLE_HANDOFF_TIMEOUT_MS`. A host that sets the deadline equal to its kill leaves the handoff no time at all.
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

**What to do.** Read the PR comment. The findings are severity-ordered, worst first, and none has been fixed. Decide them, then push a fix to the branch so the gate can pass on a re-run.

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

### A dependent issue started before the issue it depends on (#1101)

**Symptom:** `/work 12 13` where #13's body says `Depends-on: #12`. Both cycles
start. One of them parks at `plan` with `cross-group-conflict` — after an
explore and a plan dispatch have already been paid for — and nothing in the
handoff names the other group as the cause. Re-running the parked issue with
`--restart` usually reproduces it, in the other direction this time.

**Cause:** grouping and ordering were never connected. `groupIssues()` R1
merges issues that declare a link, but three of its own exit paths split them
apart anyway — an `R3 Split: true` marker, a component over
`MAX_ISSUES_PER_GROUP` (3) broken into singletons, or R1 not matching the
phrasing at all. Once they are two groups, the queue had no ordering notion
whatsoever: its only pre-dispatch gate is a path-overlap check that keys on
extracted file tokens, so a pair whose bodies name no path runs side by side and
the reactive plan-time claim check parks the loser later. The queue could see
that two groups collided, and could not see that one was meant to wait.

**What changed:** ordering statements are read from the bodies at grouping time
and carried on the grouping result (`depsByIssue`), independently of R1's union
decisions — so an R3 split cannot make the obligation invisible. Before a group
dispatches, the queue requires every group it waits on to have reached `merged`.

**The three things to check when an issue does not wait for its dependency:**

1. **Is the statement one the scanner recognises?** The ordering set is
   `depends on` / `depends-on` / `blocked by` / `blocked-by` / `blocked on` /
   `requires` / `predecessor(s)`, each followed by `#N`. It is deliberately
   narrower than R1's link regex: `closes #12`, `fixes #12`, `related to #12`
   and `part of #12` merge, they do not order. An unnumbered "this depends on
   the API being stable" declares nothing — guessing a group to wait for is how
   a queue serialises work nobody asked it to order.
2. **Are they actually two groups?** If R1 merged them, the edge is intra-group
   and there is nothing for the queue to enforce; the whole issue runs as one
   cycle. Check the grouping notes in the state file for `R1 link:`.
3. **Is the dependency in this invocation?** `Depends-on: #44` where #44 was not
   passed to `/work` is ignored and noted — it cannot block, because nothing in
   this run will ever merge it. It does not park the dependent either.

**What you see when the wait does what it should:**

| Situation | Queue outcome |
|---|---|
| dependency merges | dependent dispatches immediately — the wait costs no timer, the queue wakes it |
| dependency parks, fails, or refuses to start | dependent parks `cap dependency-parked:#N`, **`runGroup` never invoked**, no dispatch spent |
| two issues depend on each other | every group in the loop parks `cap dependency-cycle`, naming its edge, before any dispatch |
| the wait outlasts `PI_ENSEMBLE_QUEUE_DEFER_CAP_MS` | dependent parks with the reason naming the group that never released — it does **not** proceed |
| the queue halts (a driver throw, a systemic failure) while a group was waiting | the waiting group parks `cap queue-stranded:<blocker>`, with an action naming the halt to resolve first — it never leaves a group with no reason and no action |

The last row is a deliberate reversal of the old behaviour. A wait that gave up
and proceeded was the pre-#1101 shape, and for an ordering edge it is the
irreversible direction: the thing that was supposed to land first does not land
at all, and the dependent is already built on top of it.

**The 30-minute cap is a bound, not an interval.** Do not lower it to make the
queue "poll faster" — waiters park on an event and are woken the instant
anything they wait on settles, so the cap only ever fires when a dependency
genuinely never reaches a terminal state. A healthy cycle really can take that
long. It is injectable for tests (`deferCapMs`) and overridable via
`PI_ENSEMBLE_QUEUE_DEFER_CAP_MS`.

**Reading the report:** a queue-level park renders with a distinct mark and
**names no step**, because nothing ran — there is no diff, no branch, no
findings. `⏸ … at lens-review` means a cycle ran and died somewhere, and has
work to salvage; `◌ … cap dependency-parked:#12` means the group produced
nothing and the action to take is on #12, not on this group. The headline counts
them separately (`2 parked (1 never dispatched)`) for the same reason. All four
queue-raised reasons — `dependency-parked`, `dependency-timeout`,
`dependency-cycle`, `queue-stranded` — get that treatment, and `isQueueLevelPark`
is the one test for it. (`cross-group-conflict` is classified by its detail,
not its name: the queue's own carries `in-flight sibling(s)`, a plan-time one
does not and keeps its step.)

Escape hatch: `PI_ENSEMBLE_QUEUE_ORDERING=0` turns the whole gate off — no
edges are computed and the cycle park goes with them, so groups dispatch under
the #676 overlap rule alone. That is the pre-#1101 behaviour, and it is the
right tool when the gate itself is the problem, not when one pair should not be
ordered. For a single pair, per-pair opt-out is simpler: delete the ordering
statement from the dependent's body and the queue has nothing to act on. Both
leave the queue unable to order the work, so reach for the per-pair edit first.

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

### The develop gate ran the verify command twice on the same tree (#1240)

**Symptom:** `develop` completes many minutes after its developer child finished, with nothing between them but the driver's consolidated verify. On a project whose gate is slow (the tehas factory: `scripts/test.sh`, ~18 min of serial shell tests) an N=1 cycle pays that twice per gate pass — once in the develop worktree and once again at repoRoot for the consolidated probe — and the second run checks content the first already judged. Four gate passes per cycle meant eight runs where four sufficed.

**Cause:** with one workstream, the consolidated probe cherry-picks that workstream's *own* commits onto the cycle's base. The result is the same tree, so the second run is duplicate work, not a second opinion. It was never redundant at N>1, where the combination genuinely is a tree no worktree held.

**Fix:** the probe now establishes identity positively, from git's own tree object ids, and skips the command only when it can prove the probe tree is the tree that just passed. Both sides include staged content and exclude untracked files, and neither is trusted when the working tree holds content no tree object describes (unstaged edits, untracked sources) — there the run happens. Any read failure, any mismatch, more than one workstream, a per-worktree failure, or the degenerate root-as-worktree shape runs the consolidated verify exactly as before: a gate that cannot prove equivalence runs the check.

**What you see:** the skip is not silent. The state file's notes and the trace carry

```
consolidated verify skipped: tree <hash> already passed in <worktree> — …
```

and the develop event log keeps its `verifyEvidence` / duration recording untouched, so a fast `develop` is explainable from the state file rather than inferred from the absence of a 20-minute gap. The commit-pr half of the same rule names it in that step's operator-facing summary too, and the `consolidated-verify-skipped` event is recorded on every path the develop gate re-runs (the first pass, the fence merge-and-retry, the sibling-symbol merge, and the converge corrective) — not only the first.

**The fast tier is covered by the skip as well:** `.pi/verify-cmd-fast` is skipped together with the full command, because both tiers already ran per-worktree on the same content (`PI_ENSEMBLE_CONSOLIDATED_VERIFY_SKIP=0` restores both).

**The named assumption — ignored dependency directories are unchanged between the two runs.** The tree hash covers tracked and staged content only, so an ignored directory (`node_modules`, `target`, `dist`) can never make the two sides differ. That is sound only because those directories are *shared* into each worktree by symlink (`worktree-provision.ts`): the per-worktree run and the repoRoot probe read the same dependency tree, so the run that passed judged the same content the skip declines to re-judge. If that assumption does not hold for your project — a per-checkout install, or a gitignored generated directory the verify reads and the probe produces differently — the skip is wrong for you and `PI_ENSEMBLE_CONSOLIDATED_VERIFY_SKIP=0` disables it. Untracked-but-not-ignored paths are the opposite case and are never exempt: only the driver's own artefacts (`.pi/work-state/`, `.worktrees/`, `tmp/issue-<N>/`) are invisible to the dirt check, so a stray `?? tmp/evil.ts` denies the identity and the command runs.

**Escape hatch:** `PI_ENSEMBLE_CONSOLIDATED_VERIFY_SKIP` set to `0`, `false`, `off` or `no` (trimmed, case-insensitive) restores the always-run behaviour (for example, to reproduce a gate failure that only appears in the probe's checkout).

### `develop` is silent for many minutes after the developer finished (#1415)

**Symptom:** the developer child reports done, then nothing reaches the console or the headless stream until `develop` completes 10–25 minutes later.

**Cause:** that gap is the develop gate running the project's verify command (per worktree, then the consolidated run). It is not a stall. Before #1415 nothing was recorded while it ran.

**What you see now:** the gate records `verify-started` (with the command) before the command runs, so it reaches the stream and `/work-status` while the gate is still running, and `verify-completed` when it ends, with `ok` and the duration in `ms`. Both are stable NDJSON kinds ([headless.md](headless.md#the-stable-subset)). A gate with no discoverable verify command runs nothing and records neither. The per-round repetition itself was removed for N=1 cycles by #1240 (above); a slow project gate is the project's to speed up — `.pi/verify-cmd-fast` and `PI_ENSEMBLE_VERIFY_TIMEOUT_MS` are the knobs.

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

A `contradicted` evidence row whose subject is memory — its source is `memory`/`vipune`, or the claim opens with "vipune rows …" — never parks a `proceed`: a stale memory row contradicts the memory, not the issue. It travels as an assumption in the PR body, and a handoff lists it under "Stale memory rows", apart from "Contradicting evidence".

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

**A session shutdown is handled as that crash, not as a step failure.** Quitting, reloading or replacing the Pi session aborts every in-flight child. The driver used to read its own aborted child as the step failing: it recorded `cap-hit: step-failed:<step>` and entered a handoff that cannot finish in an exiting process, leaving `status: running, step: handoff` and no reason. It now stops where it is — no cap, no handoff — appends one `cycle-interrupted` event (step, Pi's reason, the origin, branch and head sha) and says so once:

```
[pi-rukas] cycle interrupted: session shutdown (quit, origin: stdin-eof) during lens-fix; state is resumable — run /work 97 — work on feature/issue-97-… at 1d6a5dd0
```

Pi's `reason` only ever says `quit` / `reload` / `new` / `resume` / `fork`, which does not tell you who pulled the plug, so the origin is tracked at the process level (#1247): `stdin-eof` means **the caller closed its stdin pipe**, `signal:SIGTERM` / `signal:SIGINT` / `signal:SIGHUP` names the signal that arrived, and `unknown` means none of those fired — Pi exited on its own, or the quit came through a path the extension cannot observe. `unknown` is an answer, not a gap in the log. `/work-status` renders the same pair on its `cycle-interrupted` row; a state file written before #1247 has no `origin` and renders without it.

**`stdin-eof` is a claim about a caller, so it needs one to make it.** It is reported only when fd 0 is a pipe or a socket — something a parent process holds the other end of, and whose going away is the event worth naming (the usual shape of a headless `pi --mode rpc` session whose parent died). When fd 0 is `/dev/null`, or was closed, or is anything else, Node still reports the stream as ended, and the session was **born** in that state: nothing happened to it, and there was no caller to close anything. `stdio: "ignore"` and a shell's `< /dev/null` both look like this, and in `-p` mode they used to make every SIGTERM and every self-exit read as `origin: stdin-eof` — a dead pipe blamed for a quit that a signal or Pi itself caused. Those now report `signal:…` or `unknown`, which is what actually happened. If you were relying on `stdin-eof` appearing for an ignore-stdin session, that line was the bug, not a feature: keep fd 0 a pipe (a caller that can close it) and the origin is reported again.

**Arming the tracker does not change what a signal does.** Installing a listener replaces a signal's default action, and SIGINT / SIGTERM / SIGHUP are fatal by default, so a tracker that only recorded the origin would have made `kill <pi>` stop killing Pi. When the tracker's listener is the only one for a signal it removes itself and re-raises, so the fatal disposition runs; once anything else in the process handles that signal, the tracker stays out of the way and the process survives it as it asked to.

On `quit` that line goes to stderr; on a reload or session switch it arrives as a `kind=interrupted` driver event. The state file still says `running`, deliberately: `running` with a dead `owner.pid` is what "resumable" already means, so anything reading the file from outside must check owner liveness (or look for a trailing `cycle-interrupted`) before calling the cycle live. This is a different record from the headless runner's SIGTERM / SIGINT handling (the cycle `signal`, event kind `interrupted`, status `interrupted`): a Pi session shutdown never sets that signal, so the two are checked separately. If the line says `/work N will refuse this state` instead, the step that was cut off had not written ahead and the file is at the previous boundary — `resumable: false` on the event.

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

The floor cannot separate these by itself for a structural reason: every guard in this store is *about a pi-rukas filename*, so any plausible basename is semantically near all of them. Cosine cannot tell "about THIS file" from "about SOME file here"; BM25 can, because it only ranks a row first on a literal token match.

Three upstream issues are worked around rather than fixed here — [vipune#177](https://github.com/randomm/vipune/issues/177) (exit code 2 means both "conflict detected" and "you typed the flags wrong"; only stdout separates them), [#178](https://github.com/randomm/vipune/issues/178) (`memory_type` and `status` are settable and filterable but returned by no command, so a supersede cannot read back the type it must preserve), and [#179](https://github.com/randomm/vipune/issues/179) (retrieval telemetry is maintained but unreadable, so candidate promotion has no measured signal).

### Getting told when something needs you

`/work` over several issues is meant to be fire-and-forget, but until #388 nothing it produced reached you outside the Pi session — the scrollback and a JSON file both require you to already be looking. Fire over eight issues, go to lunch, come back to a queue that stopped after twenty minutes.

Set `PI_ENSEMBLE_NOTIFY_CMD` to any command. The message arrives on **stdin** and as `$PI_ENSEMBLE_NOTIFY_MESSAGE`:

```bash
# macOS desktop notification
export PI_ENSEMBLE_NOTIFY_CMD='terminal-notifier -title "pi-rukas" -message "$PI_ENSEMBLE_NOTIFY_MESSAGE"'

# macOS, no extra install
export PI_ENSEMBLE_NOTIFY_CMD='osascript -e "display notification \"$PI_ENSEMBLE_NOTIFY_MESSAGE\""'

# Linux
export PI_ENSEMBLE_NOTIFY_CMD='notify-send "pi-rukas" "$PI_ENSEMBLE_NOTIFY_MESSAGE"'

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

A handoff's numbered options are keyed on which cap fired. Caps that halt **before** the branch step — `intent-park`, `existing-pr-detected`, `explore-*`, and `continue-pr-ambiguous`, `continue-pr-fork`, `continue-pr-not-found` and `continue-pr-unsafe-head` — get a block that says so: nothing was written, no branch exists, nothing timed out. They point at `.pi/work-state/<issue>/spec.txt` and the specific human action, not at `git push`.

Before #398, `intent-park` had no branch in either renderer and inherited a block written for `developer-timeout` — so a cycle that never created a branch was told to run `git push -u origin (branch not captured)`, with the display placeholder inside a copy-pasteable command.

Recovery commands are also **never chained**. They arrive in the Pi chat, and the permission matcher cannot wildcard a chained shape, so every unique `a && b` re-prompts you. One command per line.

**`WORKTREE STATE NOT READ` means the handoff could not run `git`, not that the cycle produced nothing.** Developers commit on detached-HEAD worktrees by design, so a cycle's commits are reachable from no branch until commit-pr integrates them. When the host cannot start a process at handoff time (`/bin/sh: Cannot fork`, `spawn EAGAIN` — a container at its pid limit), every read fails; the handoff used to print those failures as `no committed work ahead of the base`, `(no branch was created)` and `0 file(s) modified` over a worktree holding reviewed commits. It now lists the failed reads and, per recorded worktree, the two commands to run once `git` works again: `git -C <worktree> log --oneline <base>..HEAD` to see the commits, `git -C <worktree> branch <branch> HEAD` to attach them. The numbered options under it still assume a readable repository — check the worktree first. The pid exhaustion itself is the host's to fix.

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

When either gate refuses, the cycle parks as `awaiting-human-merge`. **The work is done and pushed** — only the merge is held. Do not `--restart`: that wipes the state file but not the open PR, so the re-run halts immediately on the `existing-pr-detected` pre-flight. Fix the gate that refused instead, so an agent merge can go through:

```bash
gh pr checks <pr>        # what the checks actually say
gh pr view <pr> --web    # review the PR and the checks
```

Then remove the cause: add or repair the grant in `AGENTS.md` (see above), re-run with `/work <issue> --merge`, or resolve whatever the `gh` evidence is failing.

At the `ci` step a weaker version of gate 2 applies: **narration cannot promote a status, but executed evidence can demote one.** An ops agent claiming `ci-status: success` gets checked against `gh`; if `gh` disagrees, it becomes a failure. An unreadable `gh` there leaves the claim standing — burning the retry budget on a run that genuinely passed is worse, and the merge gate is the one that has to be right.

Escape hatch: `PI_ENSEMBLE_MERGE_AUTHORITY=0` restores the previous behaviour, where the driver merged whenever an ops child's reply contained the substring `ci-status: success`.

### A `/work` PR is still a draft

With `PI_ENSEMBLE_DRAFT_PR=1` — the default for a headless `/work` — commit-pr opens the PR as a draft so nobody merges it while the six-pass review is still running (#1292). The driver marks it ready once the review has produced a verdict: on entering CI, before its own merge, or at a handoff after the review concluded (an approval, or residual findings that a round cap posted to the PR). It is never marked ready over an open CRITICAL finding, nor over residual findings the PR cannot show it has — the driver reads the merge guard's own disclosure marker off the PR's comments, keyed on the patch being marked ready, so a ready is never licensed where the guard would then refuse the merge (#1398). A PR that **was** marked ready and then has to be reviewed again is made a draft again before that review runs (`gh pr ready N --undo` / `glab mr update N --draft`) — the CI and lens-fix loops used to leave it mergeable for the whole re-review (#1398). A PR that is still a draft at the end of a cycle means one of three things, and the handoff comment says which:

- **"Pull request is still a draft"** — the cycle stopped before the review concluded (a park or halt at commit-pr, during review, or in a fix round), the latest verdict is CRITICAL, or an `ISSUES_FOUND` verdict's findings were never disclosed on the PR. The work is not finished; mark it ready yourself with `gh pr ready <N>` when it is.
- **"Marking the pull request ready FAILED"** — the review is done but `gh pr ready` failed on every attempt (3 per mark point, 6 per cycle); the last error is quoted. Run `gh pr ready <N>`.
- **"the driver could not make the PR a draft again"** — the review was re-running and putting the PR back to a draft failed (or the cycle's `pr ready` attempts were already spent), so the cycle parked rather than review a PR anyone could merge. Make it a draft yourself with `gh pr ready <N> --undo` (GitHub) or `glab mr update <N> --draft` (GitLab) and re-run, or merge deliberately if the findings are settled (#1398).

A draft cannot be merged by `gh pr merge` (`mergeStateStatus: DRAFT`), so a ready that keeps failing also shows up as an `awaiting-human-merge` park. Set `PI_ENSEMBLE_DRAFT_PR=0` to open PRs ready, as before. If your CI skips draft PRs (`if: github.event.pull_request.draft == false`), add `ready_for_review` to the workflow's `pull_request` types, or the head commit's checks stay skipped after the PR is marked ready — and the merge gate does not count skipped as passing.

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

**The driver retried the step with a new child.** When the child's own retries are exhausted the step router re-runs the step (up to 2 more attempts for a severed provider). That is a fresh child with no memory of the first one, and the `↻ … retrying attempt 2` line now says what went with it: `explore attempt 1 lost: 15m09s, 45 turns, 412k tokens — the step restarts from the beginning`. For `develop` only the conversation is lost — the worktree is the same one, so the retried developer is told a previous attempt was interrupted and to read `git status` / `git log` there before implementing anything. Seeing this line means a provider or network fault, not a defect in the change.

**A fan-out step hit a 429 and halted instead of waiting.** The taxonomy honours a provider's `retry-after` — that is why single dispatches recover from throttling. It never ran for fan-out children, because the router classified only the last event and `runDevelop` ends on `branches-converged`. The first fix reached only the scrollback line: the `✗ step failed` line was withheld for a retry the router then never made, so a multi-workstream develop still halted with `transientRetryAttempts: {}`. The retry decision now uses the same lookup, and a fan-out whose workstreams *all* failed transiently waits and re-runs like a single dispatch (up to 2 more attempts). Note the deliberate limit: if *any* workstream succeeded, the step is not retried, because re-running it would re-dispatch work that already landed — the develop step itself re-runs only the failed workstreams, once.

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

**A path is the one exception, because a path asks a different question.** "Does this file exist?" is answerable directly, and the token's own occurrence adds nothing to the answer — so a `path` claim is also grounded when the file it names exists on the branch, resolved against the citing file's directory **or** the repo root (`git cat-file -e origin/<branch>:<path>`; either resolution existing is enough). Without it, every relative path in a `SKILL.md` was ungroundable by construction, because its target is itself prose: one cycle reported eight MEDIUM findings against six `references/*.md` files that all exist. Two boundaries keep the escape narrow. It applies to `kind === "path"` **only** — a product, quantity, flag or env token still needs a non-prose referent, so "Serverless v2" described only in another prose file remains a finding. And a token that is not a valid repo path (`..`, a leading `/`) is *"could not tell"*, not "absent": the scan never asked git, so it does not report a file it never checked. A git failure is the same signal, and likewise never becomes "Unsourced path".

If `claim-scan` flags something legitimate, the fix is usually to point the prose at something real. A URL or a product name that genuinely has no repo referent is the case the escape hatch exists for:

```bash
PI_ENSEMBLE_CLAIM_SCAN=0 /work <issue>
```

### How severe is "blocking"? Your project decides

A lens assigns a finding's severity — that is its judgment. Which severity is serious enough to **stop a merge** is your project's call, stated in your `AGENTS.md`:

> Six-pass review findings are blocking at MEDIUM severity and above.

That is pi-rukas's own sentence, and since this change it is read rather than merely written down. Say something equivalent in your own `AGENTS.md` to move the bar. Rules:

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

If the develop gate halts on a protected path, the message names each path and prints the exact command to re-run with. A developer re-dispatch can never satisfy this gate, so the remedy is yours. Either make that change yourself, or — if editing those files genuinely *is* the work you asked for — grant exactly those paths for one cycle (#1090):

```text
/work <issue> --restart --allow-protected .github/workflows/ci.yml
```

`--allow-protected` (or `--allow-protected=<path>`) is repeatable, takes a comma-separated list, and applies to a single-issue invocation only — a queue would hand it to unrelated cycles. It admits **only the paths it names**, matched exactly — case included — after normalisation (a leading `./`; a trailing `(new)`-style annotation is stripped from what you type, never from the paths develop touched): a grant for `.github/workflows/ci.yml` does not admit `.github/CODEOWNERS`, the `.github/workflows/` directory, or the destination of a rename it does not name. Any ungranted protected path in the same diff still halts, committed or not. The grant does not bypass the scope fence — a granted file outside the workstream's declared scope still trips it. Like `--merge`, it is operator-only: `start_work_driver` has no parameter for it and forces it empty, and nothing in the issue body, the spec or the planner's output is read as a grant. It is recorded in the state file (`protectedGrant`) and shown in the handoff and the PR body, so the reviewer knows to read those files as changes to what verification means. A path the gate never halts on (e.g. `src/a.ts`), or a flag with no path, is refused rather than ignored.

**A rename is checked on both sides (#1378), and each side needs naming separately.** `git mv .github/workflows/ci.yml src/ci.yml` — a workflow moved out of the way — halts on the **source**, even though the destination is an ordinary `src/` path; `git mv src/app.ts .github/workflows/deploy.yml` halts on the **destination**. A grant naming only one side does not admit the other, so moving a protected file aside is not a way through the gate. The rename *source* feeds only the protected-path check: it is not counted as a changed file by the frontend-only verify skip, the falsily-green evidence check, or the scope/fanout gate, so moving a file cannot change those verdicts.

**A protected path with a non-ASCII name cannot be granted.** The gate reads both change sets NUL-separated (`status --porcelain -z --untracked-files=all`, `diff -z --name-status -M -C`), so a name like `.github/workflows/wörkflows.yml` is decoded and named verbatim in the halt rather than as the `"…\303\266…"` git prints by default. But `--allow-protected` accepts only plain path tokens (`[A-Za-z0-9._/@+-]`), so such a path is ungrantable by construction: the halt says so and names it in prose instead of printing a copy-paste command for it. The command is printed for the paths that **can** be granted — one ungrantable name in a mixed change set does not cost the operator the grant for the ordinary paths, nor the caution to review each path's diff before granting. `PI_ENSEMBLE_PROTECTED_PATHS=0` is the only way past an ungrantable name — and the right answer is usually that a cycle should not be writing that file at all.

The process-wide escape hatch still exists and turns the gate off for every path, in every cycle that Pi process runs:

```bash
PI_ENSEMBLE_PROTECTED_PATHS=0 /work <issue>
```

A doctrine-prose edit is not a failure; it appears in the verify notes as *"allowed, and inert for this cycle"*. If merge authority is unexpectedly denied on a repo whose `AGENTS.md` clearly grants it, check that the grant is **committed at or before the cycle's base** — an uncommitted grant in your working tree is exactly what this gate ignores.

### Parallel group execution

`/work N M P …` runs up to `PI_ENSEMBLE_PARALLEL_GROUPS` (default **3**) groups concurrently. Each group develops in its own `.worktrees/` tree, so the only shared resource is the repo root, and every operation that touches it — branch creation, patch integration, commit, push, `gh pr create`, the verify gates, lens-fix re-integration, `restoreCheckout`, worktree teardown — runs under a single integration lock. That lock is an in-process promise chain plus an `O_EXCL` lockfile under `.git/`, so a second `/work` invocation or a second Pi process on the same clone is also serialised.

Child-process load is bounded by `PI_ENSEMBLE_SPAWN_CAP` (default 64), **not** by the group count: excess spawns queue FIFO. Each workstream's develop step spends one child — the developer; the speculative explore that used to accompany it is opt-in (`PI_ENSEMBLE_SPECULATIVE_EXPLORE=1`), so develop's default fanout is M, not 2M.

**Verify timeouts in a CPU-limited container** (#1325). Groups × workstreams each running a full suite used to ignore the machine: in a container with a 2-CPU quota, three concurrent cycles' verify runs starved each other past `PI_ENSEMBLE_VERIFY_TIMEOUT_MS`. The driver now reads the host's CPUs and memory (`os.availableParallelism()`, `os.totalmem()`, lowered by a cgroup v2 `cpu.max` / `memory.max` or the v1 equivalents) and lowers the unset group and workstream defaults to fit, and the verify commands it runs queue behind `PI_ENSEMBLE_VERIFY_CONCURRENCY`. Explicit settings win. The group and workstream defaults hold only from about 9 CPUs and 18 GiB up, so an 8-CPU / 16 GiB laptop now runs 2 groups and 4 concurrent verifies; set `PI_ENSEMBLE_PARALLEL_GROUPS`, `PI_ENSEMBLE_MAX_WORKSTREAMS` or `PI_ENSEMBLE_VERIFY_CONCURRENCY=0` to restore the old limits. To see what a cycle chose, run with `PI_ENSEMBLE_DEBUG=1` (the `resource budget` line at cycle start) or read `resources` in `pi-rukas-headless --json`.

Set `PI_ENSEMBLE_PARALLEL_WORK=0` for strictly sequential execution.

### Park-and-continue (was: halt-on-non-merged)

If a group's cycle terminates as anything other than `merged`, the queue **parks that group and carries on**. At the end you get one report:

```
pi-rukas: /work queue finished — 4 merged, 1 parked
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

#### What `verify-failed:<step>` means, and the caps that split from it (#1349)

`verify-failed:<step>` means the gate ran and judged the change. Parks that reached no verdict on the code have their own caps:

| Cap | Meaning | Before #1349 |
|---|---|---|
| `verify-timeout:<step>` | Every failure is a verify run killed at its bound. | (#1324) `verify-failed:<step>` |
| `verify-env:<step>` | The system refused to start a process (`[host-resource-exhaustion]`). Every failure is that or a timeout. | `verify-failed:<step>` |
| `verify-baseline-red:<step>` | The base-commit probe found the verify command red without the change (`[baseline-red]`) in the same way: every failure of the change's run shares the base's assertion, or both timed out. The verify command's failures are also the gate's only ones. | `verify-failed:<step>` |
| `pr-not-open:<step>` | The cycle's PR was merged or closed when the step started: the commit-pr re-entry refusal, or the PR-gone park. | `verify-failed:<step>` |
| `fix-pass-park` | The adversarial fix pass parked on its own check (scope fence, no-op pass, comment retention, a read that failed closed). | `verify-failed:develop` |

One real failure next to any of these is a code failure, so the cap stays `verify-failed:<step>`. A tool that counts or routes parks by cap (a queue, a dashboard, a headless host) used to file all of these as code failures. If it matched `verify-failed:` to mean "the gate parked", match the new caps too.

#### `[host-resource-exhaustion]`: the gate could not run

**Symptom:** The develop step ends with `verify-env:develop` (`verify-failed:develop` before #1349) and the evidence lines start with `[host-resource-exhaustion]`, quoting `/bin/sh: 1: Cannot fork`, `fork: retry: Resource temporarily unavailable` or `spawn … EAGAIN`. A real failure among them keeps the cap `verify-failed:develop`, and the handoff still says which checks never ran.

**Cause:** The host (or the container's pid limit) had no room to start a process, so the driver's git / verify / smoke commands never executed. This is an environment failure, not a verdict on the change — the gate still fails, because an unrun gate is not a pass, but nothing was learned about the diff. Before this label existed the same condition was reported as `[needs-human-decision] … (no specific assertion could be extracted)`, or as `consolidated-verify-conflict` ("two workstreams edited the same lines") even on a single-workstream cycle.

**Fix:** The evidence line quotes `cgroup pids.current=N of pids.max=M` for wherever the driver runs, with the counters read just after the failure. The quoted counters appear only when they are readable (cgroup v2 on Linux); otherwise the line says the limit is unknown and you read the limit yourself. In a container that is the container's own limit (docker `--pids-limit`), not a host ulimit — `ulimit -u` on the host will show nothing to raise. If the counters show headroom, the limit may have been hit transiently by a burst of parallel processes and drained before they were read; re-run the cycle before changing the limit, and check the other ceilings the evidence names. A count at the limit with a low load average means leaked or unreaped children: inside the container, check that PID 1 is an init (`cat /proc/1/comm` → `tini`), restart the container or raise its pid limit, then re-run the cycle. Do not start by inspecting the diff: it has not been judged either way.

#### The headless runner aborted (`panic: abort() called`) during lens-review

**Symptom:** `pi-rukas-headless work N --json` dies with `oh no: Bun has crashed` / `panic(main thread): abort() called` (exit 134), usually in `lens-review`, and the container's `pids.events` counts refused forks. Before #1591 the `--json` result was empty, even when the cycle had already opened its PR.

**Cause:** The container ran out of pids (`pids.max`, docker `--pids-limit`, which counts threads as well as processes). The review started all six lenses at once, and each lens can run the product's gate; a gate that runs its tests in parallel, six times side by side, can use many times what a cycle otherwise needs. When Bun cannot create a thread it aborts natively, so no JavaScript handler can write the result.

**Fix:** Since #1591 the lens fan-out is bounded by the host budget, which now reads `pids.max`: one lens per 1024 pids, and no more than the host's workstream slots (the `resource budget` trace line and `resources.limits.lensConcurrency` in the `--json` result show the value). Set `PI_ENSEMBLE_LENS_CONCURRENCY` to choose it yourself, or raise the container's pid limit. If the runner still dies, the headless supervisor writes the `--json` result from the state files (`error.code: "crash"`, exit 30), so the host sees the cycle's branch and PR. Re-running `work N` resumes a cycle whose runner died, from its last step boundary.

#### `verify-baseline-red:<step>`: the gate was already red at the base commit

**Symptom:** The develop step ends with `verify-baseline-red:develop` (`verify-failed:develop` before #1349), and the first evidence line starts with `[baseline-red]` and names the base sha and the assertion that fails there.

**Cause:** The verify command failed on the change, so the driver re-ran it once on a clean checkout of the cycle's base commit, and it failed there too. The gate was red before the change was written, so no change can pass it. The cap fires only when the base demonstrably fails the way the change does: every failure of the change's run contains the assertion extracted at base, or the base run and every change run timed out. A base that fails on a different assertion, on one that cannot be extracted, or by timing out while the change fails on a real assertion does not excuse the change. The cap is then `verify-failed:develop`, and the `[baseline-red]` finding still leads the evidence. It also fires only when the verify command's failures are the gate's only ones. A scope-fence, empty-diff, smoke or skip-ratchet failure next to it is a verdict on the change, so the cap stays `verify-failed:develop` (the handoff still leads with the `[baseline-red]` finding).

**Fix:** Fix the gate on the mainline (or the host it runs on), then re-run the cycle. Do not inspect the diff first, and do not set `PI_ENSEMBLE_VERIFY=0`.

#### `verify-timeout:<step>`: the gate did not finish

**Symptom:** The cycle parks as `verify-timeout:develop` or `verify-timeout:commit-pr`. The evidence lines start with `[verify-timeout]` and say the verify command *exceeded its <N>-min timeout*, and the handoff says the command TIMED OUT. Since #1509 the bound is per tier, so the number and the variable named tell you **which** gate did not finish — read them, they are the diagnosis:

| The evidence names | The gate that timed out | The knob that governs it |
|---|---|---|
| `PI_ENSEMBLE_VERIFY_SUITE_TIMEOUT_MS` (or `.pi/verify-timeout-ms`) | the project's verify command — in a worktree, the consolidated tree, or the baseline probe | `PI_ENSEMBLE_VERIFY_SUITE_TIMEOUT_MS`, default 30 min |
| `PI_ENSEMBLE_VERIFY_FAST_TIMEOUT_MS` (or `.pi/verify-cmd-fast-timeout-ms`) | the fast tier — `.pi/verify-cmd-fast`, typecheck plus lint | `PI_ENSEMBLE_VERIFY_FAST_TIMEOUT_MS`, default 10 min |
| `PI_ENSEMBLE_VERIFY_SMOKE_TIMEOUT_MS` (or `.pi/smoke-cmd-timeout-ms`) | the product-smoke gate — `.pi/smoke-cmd` | `PI_ENSEMBLE_VERIFY_SMOKE_TIMEOUT_MS`, default 10 min |
| `PI_ENSEMBLE_INTEGRATION_VERIFY_TIMEOUT_MS` | the consolidated verify at commit-pr | `PI_ENSEMBLE_INTEGRATION_VERIFY_TIMEOUT_MS`, default 15 min |
| `PI_ENSEMBLE_VERIFY_TIMEOUT_MS` | a project with one knob and nothing declared in `.pi/` — the shared fallback | `PI_ENSEMBLE_VERIFY_TIMEOUT_MS`, default 10 min |

Each failure string renders its bound through the same shared minutes/seconds formatting as every other timeout, so a non-minute-aligned value prints seconds rather than `0-min`, and it names the variable and `.pi/` file that actually decided that number — the one you would edit. When the tiers have separate bounds (the normal shape since #1509) a consolidated run's own string says so explicitly, because otherwise "verify command exceeded its 30-min timeout" would mislead an operator into widening a knob that belongs to a different tier.

**What hung is in the handoff.** Since #1427 a killed run also writes a **gate hang report** (`<repoRoot>/tmp/issue-<N>/gate-hang-<ISO>.log`, owner-only) and the handoff's timeout block leads with `What hung: <path>`. The report names the test the runner itself had flagged (cargo/libtest, Go and bun all print one), the gate's process tree taken *before* the kill — including the grandchildren that outlived their parent, which is how a test's own `git pull` leaves a `git remote-https` holding a worktree — and the last lines the run printed. Read that file before suspecting the diff. Where the runner printed no slow-test line, the report says so and the process tree is the only name the driver could establish; where the executor reported no gate pid (a test fake, a rethrown fast-tier error), it declines to walk anything rather than blame an unrelated process. The report is an addition to the failure: it never turns one into a pass, and a failure that was not killed writes none.

**Cause:** The verify command was killed at its bound, so it reached no verdict about the code. The usual cause is contention: several workstreams, or several cycles, running full suites on the same host at once. A second cause the report exists to reveal is a genuinely stuck gate — a test waiting on a lock, a network call with no timeout, or a subprocess that never exits — where more time changes nothing. The report's elapsed-time column is how you tell them apart: everything young and CPU-busy is contention; one process at `01:15:02` holding a lock is a hang.

This cap is distinct from `verify-failed:<step>`, which means the gate judged the change. It fires only when every failure is a timeout. One real failure next to a timeout still parks as `verify-failed:<step>`, because that failure is a verdict.

**Handoff criteria — what the handoff must state for you to act on it (#1509/#1041).** A timeout handoff is actionable when it names, all four:

1. the **cap** (`verify-timeout:develop` / `:commit-pr`) and the **step**;
2. the **command** that did not finish, with the tier it is (worktree / consolidated / baseline probe / fast tier / smoke gate);
3. the **bound that applied**, as a formatted duration, and **the variable and `.pi/` file that decided it** — not a fixed 10-minute string;
4. where relevant, the **baseline probe's own outcome** — a timeout at the cycle's base commit too means the gate does not fit the bound on this host, and the fix is the budget, not the diff.

If the handoff names a bound but not the knob, that is a documentation gap worth reporting: the whole point of the per-tier split is that the operator edits one number and knows which gate it moves.

**Fix:** Give the gate more time or more of the host, then re-run the cycle:

- Raise the knob the evidence named (see the table above). For the offline-suite tier specifically, prefer a project-level declaration — a `.pi/verify-timeout-ms` holding the milliseconds this repo's suite actually needs (#1041) — so the budget travels with the project instead of living in each operator's shell. Precedence is env → `.pi/` file → documented default, and a value that is not a positive integer is ignored with a trace rather than taken as `0` (a zero timeout means *no bound* to the executor).
- Reduce concurrency: fewer workstreams (`PI_ENSEMBLE_MAX_WORKSTREAMS`), fewer cycles at once (`PI_ENSEMBLE_PARALLEL_GROUPS`), or nothing else heavy on the host.
- Add a `.pi/verify-cmd-fast` (see "Verify command discovery" below). Developers then stop running the full suite in parallel, and a type error fails in seconds instead of after the whole suite.

Do not set `PI_ENSEMBLE_VERIFY=0` for this. The gate did not reject the change; it did not finish.

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

When the violation is between two sibling workstreams (one edited a file the other declared), develop merges the two and re-runs once instead of parking. Before #1343 the merged workstream's range started at the owner's tip, so the owner's own commits were missing from the consolidated verify and from the PR: the re-run could fail on a file that was plainly in the merged worktree, or the PR shipped the consumer without the producer. The merged workstream now keeps the owner's original base. If a PR from an older build is missing a sibling's files after a `fence-recovery-started` event, cherry-pick that workstream's commits from its worktree.

**commit-pr:**
- Commits exist on the branch: `git rev-list --count origin/<base>..HEAD` > 0.
- The parsed PR number resolves via `gh pr view`. If ops forgot the `pr: <N>` marker, the gate tries `gh pr list --head <branch>` and **adopts** the found number (bonus repair — pre-PR17 a missing marker silently degraded handoff/CI targeting).

On failure the driver emits cap `verify-failed:<step>` (or one of the no-verdict caps above) → handoff, with the per-check evidence in `pipelineState.verifyEvidence` (rendered into the handoff body).

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

#### Comment-retention check (#948)

The develop gate also detects **pre-existing comment lines that are deleted** without reappearing (a developer shrinking a file to hit the 500-line cap by stripping comments). For every removed comment line in `git diff <base>...<head> -- extension/src extension/smoke-tests agents-base`, the gate requires the same trimmed text to exist somewhere under those paths at `<head>` — a verbatim move (same or different file) is fine; a genuine deletion is reported **lost**.

**Three buckets:** every removed comment line is **retained** (its text survives at `<head>`), **exempt**, or **lost**.

**Exemption (the one rule):** a removed comment is exempt when the nearest following removed line that is *not* a comment is a **code** line, that code line's trimmed text does not reappear at `<head>`, *and* the hunk adds no comment line — i.e. the comment was deleted together with the code it documented. A comment deleted above code that still exists is never exempt. Multi-line block comments share the block's status.

**Lost comments are evidence, not a failure (#1040).** The develop gate records each lost line as a `comment-retention:` note (file, the line, and any added comment lines in the same hunk as context) and never fails the step. The adversarial reviewer receives the same list in a "Comments removed by this change" section and reports an unjustified loss as an ISSUES finding; every one of the six lenses receives the same section in its context. The quoted lines are diff data, each clipped to 160 characters, and at most 20 are listed. If the check cannot run, the reviewers are told it was not run rather than shown nothing. A check that cannot run (unreadable base, git failure, no base ref for a workstream) reads `comment-retention: NOT CHECKED (<reason>)` in the develop note, the adversarial report and the reviewer prompts. The lost-comment lines are also persisted as plumbing reports, so they reach the handoff even when no reviewer runs. The adversarial loop also appends a `comments: lost=<n> (exempt: <k>)` line (or `comments: NOT CHECKED (<reason>)`) to its report.

**Escape hatch:** `PI_ENSEMBLE_COMMENT_RETENTION=0` disables the check (use sparingly).

#### Product smoke command (PR277)

The develop gate runs an optional **smoke test** configured in `.pi/smoke-cmd` at the repo root. Format mirrors `.pi/verify-cmd`: first non-empty, non-comment line is the command verbatim, executed with the same 10-minute timeout as the verify command (`PI_ENSEMBLE_VERIFY_TIMEOUT_MS`; shared for simplicity).

If the smoke command exits non-zero, the gate fails with a `smoke:`-prefixed failure message carrying the output tail (~1500 chars). If `.pi/smoke-cmd` is absent, the gate notes the omission explicitly (never silent) — per the "never silently downgrade a six-pass review to a five-pass" doctrine.

**Security note:** The smoke command is executed via shell (`/bin/sh` on Unix), which allows pipes, command substitution, and chaining operators. This is intentional flexibility (e.g., `bun run smoke && curl localhost:8080/health`), but it means `.pi/smoke-cmd` is a privileged execution surface. If `.pi/smoke-cmd` is added to your repo (via a supply chain attack or malicious PR), it can execute arbitrary commands as your user. Treat write access to `.pi/smoke-cmd` as equivalent to shell access. The same surface exists for `.pi/verify-cmd` (pre-PR277).

**Why this exists:** A test suite passing in isolation doesn't prove the product works. vipune's failure mode was tests passing while the broken feature never executed; a smoke command forces a basic end-to-end path through the real artifact.

**Escape hatches:** `PI_ENSEMBLE_SMOKE=0` disables the smoke gate; remove `.pi/smoke-cmd` to omit the smoke test from verification.

#### `fork: Resource temporarily unavailable` after a gate timed out

**A timed-out gate no longer leaves its children running.** The driver's verify, smoke and `verify-cmd-full` runs used `child_process.exec`, whose timeout signals the shell alone — the test runner and everything under it kept running, holding pids and the worktree for the rest of the cycle. They now run in their own process group and the whole group gets SIGTERM at the timeout, then SIGKILL 5 s later (`extension/src/exec-tree.ts`). A command that leaves its group on purpose (`setsid`, GNU `timeout` without `--foreground`) is out of reach; the driver no longer waits on it, but it is not killed.

**Killing a tree does not reap it — that needs an init.** If `pi` is PID 1 of its container, every orphaned process is reparented to it and stays a zombie when it exits, because node only waits for children it spawned itself. Measured on `node:22-alpine`: 20 orphans killed under node-as-PID-1 leave 20 zombies; under `docker run --init`, none. Zombies count against the cgroup's `pids.max`, so the symptom is `pids.current` at the limit with a near-zero load average, and every later command failing to fork. The published image now does this itself: its ENTRYPOINT is `tini`, so `pi` is never PID 1 (check with `cat /proc/1/comm` inside the container — it must say `tini`). tini runs with `-s` (child subreaper), so it still reaps when a host adds `docker run --init`: `/proc/1/comm` then says `docker-init`, and that is fine. An image built before that change, or a launch that overrides `--entrypoint`, needs `docker run --init` (or another reaper as PID 1). The same applies to a gate a child agent's own bash tool timed out: Pi kills that process group itself, and the corpses still need reaping.

**The reviewer is told not to re-run the gate.** In a `/work` cycle the adversarial reviewer's prompt names the project's verify command and says the driver already owns it — run targeted checks only. `adversarial_loop` called directly is unchanged: nothing ran a gate there, so the reviewer is still asked to.

### Verify command discovery

Precedence (PR18 shape):

1. **`.pi/verify-cmd`** at the target repo root — first non-empty, non-comment line is the command verbatim. Use this when the derived command is wrong or you want tests instead of typecheck.
2. **`package.json` `typecheck` script** — an intentional project-level signal; wins even next to a `Cargo.toml`. Runner detected from the lockfile (`bun.lock`/`bun.lockb` → `bun run`, `pnpm-lock.yaml` → `pnpm run`, `yarn.lock` → `yarn`, else `npm run`).
3. **`Cargo.toml`** → `cargo check --quiet`. Beats a bare `package.json` `test` script — a Rust repo with a tooling package.json (docs build, hooks) must not run `npm run test` as its gate. (Pre-PR18 package.json won unconditionally, producing spurious verify-failures on Rust projects.)
4. **`package.json` `test` script** (non-Rust repos only).
5. Nothing found → the gate checks diff/commit/PR evidence only and notes the absence.

The command is capped at 10 minutes (`PI_ENSEMBLE_VERIFY_TIMEOUT_MS` to override).

**Fast tier (optional, #1324).** A `.pi/verify-cmd-fast` holds a cheap check, such as typecheck plus lint, as its first non-empty, non-comment line. The driver runs it before the verify command in every worktree, on the consolidated tree at develop and at commit-pr, and in the baseline probe. If the fast tier fails, the full command is not run; the evidence quotes the fast tier's output and ends with a `[verify-cmd-fast]` line naming it. Both tiers share the one bound. The develop prompt tells each developer to run the fast tier only and leave the full command to the driver. Without the file, nothing changes.

### If the gate keeps failing

- **Verify command fails on code the developer didn't touch** — the project was already broken before the cycle started. Fix the baseline first, or point `.pi/verify-cmd` at a narrower command (e.g., `cargo check -p <crate>`). The driver now checks this itself: when the verify command fails at develop it is re-run once on a clean checkout of the cycle's base commit (a temporary `.worktrees/baseline-verify-<N>`, removed afterwards; never on a passing cycle). If it fails there too, the handoff leads with a `[baseline-red]` finding naming the base sha and the assertion, and the cap is `verify-baseline-red:develop` (see above; `verify-failed:develop` when another check failed too, and before #1349). The gate cannot pass, so the cycle still parks, but the change is not what to inspect.
- **`exceeded its <N>-min timeout on the CONSOLIDATED tree`** — the run was killed at the bound, so it says nothing about the code (this used to render as `specific assertion: (no specific assertion could be extracted)`). When every failure is a timeout, the cap is `verify-timeout:develop`; see "`verify-timeout:<step>`: the gate did not finish" above. If the `[baseline-red]` finding reports a timeout at the base commit as well, the gate does not fit the bound on this host: raise the suite tier's budget (`PI_ENSEMBLE_VERIFY_SUITE_TIMEOUT_MS`, or a `.pi/verify-timeout-ms` that ships with the project) or make the gate faster.
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

## The plan-to-spec gate halted the cycle (`plan-spec-mismatch`)

### Symptom

A `/work` cycle stops at `plan` — no branch, no worktree, no PR — and the handoff names the cap `plan-spec-mismatch`. The state file's last events are the plan `dispatch-completed` followed by a `cap-hit` with `cap: "plan-spec-mismatch"` and `nextStep: "handoff"`, and `pipelineState.planQuality.reason` is `"plan-spec-mismatch"`.

### What the gate judged

`planSpecMismatchReason` (work-driver-plan-spec-coverage.ts) is a pure function of the plan reply's raw text, the parsed workstreams, and the resolved spec. It rejects two shapes: a reply carrying more than one `## Workstreams` section (the driver reads the first, and #818 shipped three blocks of which the first was fabricated), and a plan that declares none of the paths of at least one *measurable* spec deliverable. A deliverable whose `paths:` slot is empty, prose, or a filler word (`n/a`, `tbd`, `none`) is not measurable and rejects nothing — the gate has nothing to say about a spec that names no files.

### Fix

Read the cap's `evidence` in the handoff first: it names the uncovered deliverables (or the block count). Then either revise the issue body when the spec's deliverable paths are stale (files renamed, or the work already landed on main — a spec pointing at files that no longer exist rejects every honest plan), or re-run `/work <issue> --restart` and let the gate re-judge a fresh plan. Nothing was written, so a restart costs only the one planning dispatch it already spent.

### If the gate itself is wrong

Only when the deliverables genuinely name files this issue is about but the planner had no way to reach them: set `PI_ENSEMBLE_PLAN_QUALITY=0` in the **pi process's** environment (restart pi with it, or export it in the shell pi was started from) and re-run. `/work` is a Pi slash command, so a shell env prefix pasted in front of it is literal text and the command does not resolve. The variable disables BOTH plan-step gates — the shape gate and this one — so fix the spec afterwards: the next cycle hits the same wall.

### Related

- A corrective plan killed by one of the driver's own caps is NOT judged by this gate: a killed child produced no plan, and capping on that silence would be the driver inventing a finding about a kill it caused. Those route as a `dispatch-failed` carrying the structured cause and cap as `plan-timeout` / `loop-detected` / `token-budget` / `step-failed:plan` instead ([#819](https://github.com/trail-openers/pi-rukas/issues/819)).

## /plan pipeline latency and timeouts

### What changed

The `/plan` driver (`start_plan_driver`) used to serialize four dispatch barriers per ticket: mechanical inventory (three serial awaits) → duplicate-risk explore → angle fan-out → 1–2 gap-gate rounds — the structural origin of the 20–30-minute-per-ticket experience (see `outputs/spec-driven-plan-driver-gap.md` §4). Now:

- The duplicate-risk check and the investigation angles dispatch as **one parallel barrier** (`plan-investigate.ts`); the HIGH-risk hard stop applies after the barrier and still refuses to file.
- Every plan child is bounded at **30 minutes** (`PLAN_DISPATCH_TIMEOUT_MS`) instead of the 2-hour spawn backstop, and runs with `cwd` pinned to the repo root. (Initially 8 minutes; raised 2026-09-09 after a live fixture run killed two heavy investigation angles at exactly 8m00s under concurrent load — killing a child loses its whole context, and the operator's historical floor for agent runs is 30 min.)
- The tool result ends with a `=== TIMINGS ===` line (per-phase wall clock: inventory / investigate / gap-gate / filing / total).

### The call returns a notice, not a result (#1044)

`start_plan_driver` and `start_research_driver` run the pipeline in a background job. The tool returns within milliseconds with a launch notice carrying a `jobId` and **no verdict at all** — that is the contract, not a failure. The rendered result arrives later as a user message beginning `[ensemble:async]`, naming the same `jobId`.

Symptoms people hit, and what they actually mean:

- **"It returned 'started' and nothing happened."** Correct so far — check whether the steer arrived. The run takes minutes; the harness says so in the notice. Re-calling the tool to "check progress" starts a SECOND run (a second set of child tokens, a second ticket) and is the wrong move; `dispatch_status` is the one-shot look (metadata only, and it says so), or wait for the steer.
- **"I killed it and got no reply."** A killed run is still owed its report: the steer says `PLAN CANCELLED` / `RESEARCH CANCELLED` and names who killed it (`dispatch_kill` vs a session teardown). A killed run never files and never reports a verdict it did not earn.
- **"A dry run returned, so I have a digest."** No — the dry run's `reviewedDigest` is on its **report**, not on the launch notice. A confirm that echoes a digest it never received, or echoes one from a different run, is refused. Wait for the dry run's steer, then confirm with the digest it carried.
- **"Too many jobs running."** With 50 jobs live the tools refuse with `started: false, error: "jobs-saturated"` and no `jobId`. Nothing launched, so nothing is owed a steer; finish or kill an existing job and re-call.

### A plan child hit the 30-minute bound

The dispatch is killed and routed through paths that already existed: an angle fails closed (`ok=false`; if ALL angles fail, the pipeline halts with `skipped-all-angles-failed` and files nothing), a timed-out duplicate-risk child yields no risk verdict (traced, pipeline proceeds), and a timed-out gap-gate reviewer routes `gate-unavailable` (spec NOT filed — no reviewer saw it; re-run `start_plan_driver`). A child that repeatedly times out usually means a hung tool call or a suspended host (see "Host suspend is not a provider failure" in AGENTS.md §7) — check the per-phase timings line to see which phase ate the budget.

### "Not filed (by policy): the descriptor is under the word floor…" (needs-clarification)

The deterministic pre-triage (`plan-precheck.ts`) fired: the descriptor is below the word floor AND names no code identifier AND no `context` param was supplied — the strongest under-specification signal, and the defect class the research base ranks first among spec defects. Nothing was dispatched; the result lists targeted questions. Answer them by re-running `start_plan_driver` with a fuller descriptor or a `context` param. Any ONE of the three signals (enough words, a file/symbol name, a context param) passes the check, so a legitimately terse descriptor that names code is never blocked.

### "Not filed (by policy): the drafted body failed deterministic validation" (draft-invalid)

`plan-validate.ts` halted the draft before the gap gate: bug/feature drafts need a non-fallback Acceptance criteria section (otherwise the issue is not /work-consumable), and an epic needs an actual sub-issue decomposition of sane size. This is the partial-junk case the all-angles-failed guard cannot see (some angle items arrived, but not the load-bearing ones). Re-run (the angles are re-dispatched), or supply the missing content directly via the `context` param (e.g. an `ACCEPTANCE CRITERIA` block — operator directives satisfy the check).

### "PLAN NOT FILED — THE REVIEWED SPEC CHANGED"

A confirm echoed a dry run's `reviewedDigest`, but the reviewed spec could not be filed verbatim — the reason is in the result (the dry run expired, origin/<default> moved, or no cached dry run was found, e.g. in a fresh clone). The full pipeline re-ran and drafted different bytes, so nothing was filed: the confirmation covered the reviewed spec, not the new one. Show the new spec and confirm with the new `reviewedDigest` — read from the dry run's **delivered report**, which is where it actually arrives since #1044 (a confirm launched off a launch notice's placeholder digests nothing). For long gaps between dry run and confirm, set `PI_ENSEMBLE_PLAN_CACHE_TTL_MS` (`0` = no expiry); for a fresh clone per turn, set `PI_ENSEMBLE_PLAN_CACHE_DIR` to a directory outside the clone; a confirm then files verbatim as long as origin/<default> has not moved since the dry run ([#1224](https://github.com/trail-openers/pi-rukas/issues/1224)).

### Chore/spike tickets skip the adversarial gap gate

By design (no env knob): chore/spike are low-blast-radius and deterministic validation is their gate. The old `PI_ENSEMBLE_PLAN_GAP_GATE` variable is deleted and inert. Bug/feature/epic always run the gate; its round 2 (fires only on CRITICAL) is a scoped verification of the carried resolutions, not a second full review — multi-round full re-review of the same artifact measurably adds false positives (arXiv:2603.16244).

## /research — the compiled research spine

### What it is

`/research` runs through `start_research_driver` (`extension/src/research-driver.ts`): memory inventory → one parallel barrier of angle children (each reporting structured claims via the `report_research_claim` companion tool) → deterministic verification → a dated artifact + provenance sidecar → one typed vipune candidate row. PM keeps judgement (tier, angle choice, the conversation after the artifact). Every child is bounded at 30 minutes (shared `PLAN_DISPATCH_TIMEOUT_MS` bound) and pinned to the repo root.

### Where the artifact lands

`<repo>/outputs/research-<slug>.md` plus `research-<slug>.provenance.md`. The driver adds `outputs/` to `.git/info/exclude` (per-clone, same mechanism as the `tmp/` scratch convention) so an untracked artifact can never dirty a later /work cycle's clean-tree check — the project's own `.gitignore` is never edited; committing artifacts is the operator's call. A re-run on the same topic gets a `-2` suffix, never a silent overwrite.

### Verification classes (provenance legend)

- URL sources: `live` / `dead` (confident 404/410-class absence) / `unreachable` (403/429/405 bot-filters, timeouts — the page refusing automation still exists).
- Code sources (`path` or `path#symbol`): `grounded` / `ungrounded` against the pinned commit (`git rev-parse HEAD`, recorded in the artifact header); a check that could not run leaves the claim `unchecked` rather than condemning it.

### "NO RELIABLY VERIFIED FINDINGS" (abstention)

Zero findings survived deterministic verification. The artifact is still written — it records what was checked so the next attempt starts further ahead. This is the honest output, not an error: re-run with sharper `angles` or more `context` rather than lowering the bar.

### "all angles produced zero report_research_claim calls"

The retrieval children returned prose only — usually the research-reporter extension did not load (check `RESEARCH_REPORTER_PATH`) or the model made no tool calls. Nothing was filed or written; re-run `start_research_driver`.

### Deep and adoption tiers

- `deep` = standard retrieval + ONE scoped entailment dispatch: a reviewer opens each cited source and judges per-claim support (`full`/`partial`/`none`/`unreachable`), annotated in the artifact rows. A `none` verdict demotes the finding out of the verified count (annotation never upgrades). If the reviewer dispatch fails, the artifact carries an explicit "Entailment pass unavailable" banner — absent annotations are never presented as clean.
- `adoption` = the OSS decision memo for "should we adopt X": fixed signals/alternatives/integration-fit angles plus ONE synthesis dispatch whose RECOMMENDATION and COMPARISON sections embed verbatim in the memo. A failed synthesis leaves "(synthesis unavailable — decide from the signals…)" — the driver never fabricates a recommendation.

### "NOT FILEABLE AS-IS (duplicate-risk)" — and how to proceed

The duplicate-risk child returned HIGH: an OPEN issue (or closed-but-unlanded work) appears to cover the same scope. The result carries the child's rationale and names the issue. If your ticket deliberately reverses or extends a CLOSED, landed decision, that is NOT a duplicate — re-run `start_plan_driver` with a `context` param acknowledging it (e.g. "this deliberately reverses #103 because …"); the acknowledgment reaches the risk child, which treats a reconciled issue as medium at most. The risk prompt itself distinguishes DUPLICATE (open/unlanded scope → HIGH) from REVERSAL (closed, landed → named reference, never a block). There is deliberately no force flag.

### My context prose appeared as Test-surface bullets (directive-block grammar)

Pre-fix (2026-09-10, vipune round 9): the directive parser had no block terminator — after a `TEST SURFACE:` heading, EVERY subsequent line until the next recognized heading became a bullet, so `BEGIN`/`END` fence lines leaked as bullets (with list prefixes stripped) and whole trailing paragraphs were swallowed into the section. The grammar is now explicit: a block ends at the next heading, an **END fence** (`TEST SURFACE END`, or a bare `END`/`- END`/`-----END-----` line; `BEGIN` fences are consumed silently), or a **blank line followed by a non-bullet line** (spaced bullet lists stay open). Contiguous unbulleted lines are still items — put a blank line before trailing prose, or close with END. Demoted lines are not lost: the whole context param independently renders in the Prior-context inventory. Bonus fixes in the same change: a keyword flowing into prose ("Out of scope for this round was…") no longer hijacks the open block, digit-leading items ("42 is the answer") are no longer mangled by the bullet strip, and operator TEST SURFACE items are count-capped at the section cap (text never clipped — D2).

### The spec contradicts my context param (children never saw it)

Pre-fix (2026-09-10, vipune round 9): the prior-context block in every child prompt was head-clipped at 2,000 chars TOTAL — a single-paragraph 4–5k operator context lost everything past the clip, including "Do NOT claim X" constraints and the positive rulings behind them, and the angle children **regenerated** exactly the claims the operator had ruled out (not phrase-echo: a forbidden phrase appeared in a round before it existed anywhere in the session, and the gap gate — which reviews the filed body where operator context renders uncapped — flagged the contradiction rather than emitting it). Now operator `context` entries render into child prompts FIRST and WHOLE under their own 12,000-char cap (`plan-prior-context.ts`); vipune snapshots and issue inventory keep the original 2,000-char cap and truncation marker. If your context exceeds 12k, the marker names the operator channel — and the body-budget halt already makes trimming your call. Practical note: negative constraints work when they arrive; phrasing them positively ("rankings WILL shift and the CHANGELOG documents it") plus the typed directive blocks remains the strongest channel.

### Operator directive channels (the trusted path into a spec)

Children treat everything quoted in a descriptor as untrusted data (prompt-injection defense), so instructions travel through typed `context` blocks instead: `ACCEPTANCE CRITERIA`, `PITFALLS`/`EDGE CASES`, `OUT OF SCOPE`, `TEST SURFACE` (REPLACES the angle-derived section — "exactly: none" stays exactly none), `DECOMPOSITION`/`SUB-ISSUES` (epic constraints), and `NEVER CLAIM` (or `FORBIDDEN`) — verbatim forbidden phrases (see below). "EXACTLY N sub-issues" anywhere in the descriptor or context is threaded into the decomposition angle and asserted by validation (mismatch → draft-invalid). Spikes have no gap gate, so when a context param was supplied, a spike draft still showing scaffold strings in its deliverable or Test-surface section halts as draft-invalid — the deterministic bar is the spike's only bar.

### A child echoed a forbidden phrase back into a filed spec (NEVER CLAIM)

The `NEVER CLAIM` (or `FORBIDDEN`) typed block in the `context` param declares verbatim phrases the operator has ruled out. Each phrase is one line in the block; the same grammar (heading → block terminator) applies as for every other directive. Three deterministic backstops run in sequence — the phrase never reaches a filed spec without being named in the disclosure:

1. **Prompt backstop** — the phrases are threaded as a dedicated, uncapped block into every investigation angle prompt, the duplicate-risk prompt, and the gap-gate reviewer prompt. The block is structurally immune to any render cap (the prior-context inventory that renders the operator's ruling verbatim is the one render path that caps; this list is not).
2. **Post-filter** — between investigation and drafting, any structured item whose normalised text (trim + collapse whitespace + lowercase) contains a forbidden phrase as an exact normalised substring is dropped. Dropped items are disclosed: a line in the drafted body (`> NEVER CLAIM filter disclosure — …`) names the matched phrase and the per-angle drop count, and the result details carry the disclosure. Paraphrases are NOT matched (measured: loose matching false-positives on the epic's own true invariants and correctly-negated restatements), so the filter is a verbatim-only backstop, not the primary mechanism.
3. **Validation assertion** — `validateDraft` asserts no forbidden phrase appears in any generated section of the drafted body. The `## Prior context inventory` section is excluded (it re-renders the operator context verbatim and would always match by construction).

If a phrase you declared in `NEVER CLAIM` still appears in a filed spec's body outside the Prior context inventory, the `validateDraft` assertion would have halted the run as `draft-invalid` — file a bug if you see it.

### "NOT FILEABLE AS-IS (review-unparseable)" — the gap gate fails closed on an unreadable review

The reviewer's dispatch succeeded but its reply carried no `GAP:` findings and no verdict (or a bare NEEDS_ITERATION with nothing to iterate on), even after one automatic strict-contract retry. Nothing was reviewed, so nothing files — severity describes the spec, parse success describes the review, and the old conflation (`[MEDIUM] no structured gaps parsed → proceed`) let an unreadable review pass by construction under CRITICAL-only blocking. A genuinely clean review is textually distinct: it renders `GAP DISPOSITIONS: (none)` and files. The FILING STATUS detail carries the raw reviewer output head so you can tell parser drift from prompt drift; re-run `start_plan_driver` to retry the gate.

### "NOT FILEABLE AS-IS (body-too-large)" — the spec exceeds the forge's body limit

GitHub caps an issue body at 65,536 characters, and body size scales with *investigation volume*, not feature complexity — a quarter-scope ticket can hit the wall if its angles emit essays. The driver now budgets the render deterministically BEFORE the gap gate: the default render caps each section at 20 items with item text clipped at 400 chars; if that overflows the budget (65,536 minus 4,096 headroom for the residual-disclosure and corrective-round appends), ONE compaction pass re-renders at 10 items / 220 chars. Clipping applies to item TEXT only — an epic's sub-issue checkboxes keep their `- [ ] #N —` prefix and `(sub-issue N, from angle)` attribution at every stage (a clipped item ends with `…` mid-text instead of losing its structure). A compacted body carries a visible `> Compacted to fit the forge's 65536-char body limit …` line, the tool result says `COMPACTED`, and the gap gate reviews the compacted body — what it approves is exactly what files. If even compaction cannot fit — typically a very large operator `context` param, which is deliberately never clipped (operator authority) — the run halts as `body-too-large` with a per-section character breakdown (e.g. `Prior context inventory: 70000 chars`) so you know what to trim; nothing is dispatched to the gate and nothing files. **The dominant section in that breakdown is the lever, and it is not always the `context` param**: a `Dropped investigation items: 56738 chars` line meant the disclosure of investigation items the operator's lines contradicted had itself become the oversized section (#1383 — it was the one section the budget never clipped or count-capped, so both compaction stages rendered the same 56k and the fitter gave up). That section is now bounded at both stages (`plan-dropped-budget.ts`: item text clipped to 200 chars, the whole section to 8,000) and its omission line states how many further items were dropped and where the full list lives — the run's `.pi/work-state/plan-dropped/<slug>-<runId>.json`, under the harness's own untracked-state directory and excluded through `.git/info/exclude` (the same mechanism that keeps `.worktrees/` and `/tmp/` out of `git status`), so a `/plan` never leaves untracked files in a project's tree — so a wide investigation can no longer make a spec unfileable. Remedy: shrink the named section (usually the `context` you passed; for a dominant dropped section, narrow the contradicting lines in your `ACCEPTANCE CRITERIA` / `OUT OF SCOPE` blocks, which are what cause items to be dropped) and re-run `start_plan_driver`. There is deliberately no override flag — the forge would reject the body anyway, after the full spend.

### A "(gate resolution)" bullet in a filed spec — and when a gap stays open instead

When the /plan gap gate finds a CRITICAL and its proposed resolution is a plain declarative addition, the driver writes it into the named section as a bullet prefixed `(gate resolution)` — the marker is provenance, so a gate-authored bullet is never mistakable for an investigator-derived criterion (vipune round 9 mistook one for an AC). When the resolution is an *edit instruction* (contains delete/remove/replace/reword/rewrite/instead — e.g. `delete "reproduce bit-for-bit" … and instead state …`), the driver does NOT splice it: deterministic surgery on arbitrary bullets is fragile, and pasting the instruction beside the bullet it contradicts made round-8/9 specs self-contradict. Those route to the Open Questions section as `status: open; decision owner: operator` — apply the edit yourself (e.g. via `/plan N`) or re-run. Also fixed in the same change: two writebacks into one section used to glue the next `## ` heading onto the last bullet (`…phrasing.## References`) while reporting the write as applied.

### A cycle stuck at `status: "running"` with `currentStep: "merged"` and an `awaiting-human-merge` cap as its last event

Pre-fix (2026-09-09) driver bug: `nextStep()` answered "done" on `currentStep: "merged"` before consulting the trailing cap-hit's routing, so a merge hold never executed its declared handoff — no comment, no label, no notification, and `/work-status` + the queue read the cycle as still running. **Self-healing:** re-run `/work <issue>` on the stuck cycle — resume re-enters the `merged` step, re-judges merge authority, and now actually routes to handoff (or merges, if a grant + green evidence exist). The census that found this (25 of 240 cycles on one host) is in the fix PR; a loop that ends with status still "running" now traces and notifies instead of exiting silently.

### Re-entering a crashed cycle no longer duplicates PRs or handoff comments

Resume re-enters at the STEP, and the mechanized seams are now explicitly idempotent: `commit-pr` checks for an open PR already heading the cycle's exact branch (`findOpenPrForBranch`) and short-circuits with its number instead of resetting the branch and creating a duplicate (fails open on an unreadable `gh` — the push rejection remains the backstop); the handoff writer reuses a previously delivered comment URL from the `handoff-emitted` event instead of posting a second comment (the label re-applies — server-side idempotent). Mechanized driver events carry unique jobIds via `synthesizeDriverCompletion` (the old literal `"mechanized"` made the id useless as a correlation key).

### Accepting a review finding (#1105)

A recorded review finding is suppressed from later rounds only when the operator accepts it. Run it from a terminal, never from an agent:

```bash
bun extension/scripts/review-accept.ts <branch> <row-id> --reason "<at least 20 characters>"
```

The acceptance boundary is layered:

1. The script refuses to run when `PI_ENSEMBLE_ROLE` is set, or when `PI_ENSEMBLE_SUBAGENT_MODE=1` or `PI_ENSEMBLE_TRUST_MODE=1` is in its environment.
2. The acceptance write itself (`acceptFinding` in `extension/src/review-findings-store.ts`) is called by no other `src/` module and registered by no Pi tool, and `src/` imports nothing from `scripts/` — the operator script is the only caller in the tree, and smoke tests assert both. The reason rule and the CRITICAL refusal live with it in the store.
3. `review-accept-guard.ts` refuses agent bash that names the operator script `extension/scripts/review-accept.ts`, the findings file `review-findings.json`, or the store module `review-findings-store.ts`, and agent `edit`/`write`/`multiedit` of `review-findings.json`.

Layers 1 and 3 are **advisory in trust mode**. They are environment and string checks, so an agent with a shell can still bypass them. They stop an agent that is not trying to bypass them; the operator's terminal is the real boundary.

#### An ordinary git/gh read got blocked by the accept guard (#1125)

Layer 3 hardening closed three routes, and a legitimate command can be caught by the shape test. It now refuses:

- **a git/gh argument that writes or execs**, naming a protected file — `--output` / `-o` (spaced `-o <file>` or attached `-o<file>`), `-c`, `gh alias set`, `gh config set alias`, `git config alias.`. Those arguments make the tool write a file or run a shell, so they are outside the plain-git exemption that lets a commit message name the store.
- **a JS runtime invoked in a command that names the store**, on any line — a `bun <<EOF` here-doc importing the module, a program piped into `bun -`, or the `-e` / `-p` / `--print` / `--eval` forms.
- **a plain git that removes the data file** — `checkout` / `restore` / `rm` / `stash` / `clean` naming `review-findings.json`. The data file dominates the exemption.

Remedy: drop the write-capable argument — `git show HEAD:x` without `--output`, and `git --no-pager log` instead of `git -c core.pager=cat log` — and the read is allowed again. Reading the store **module** is now an accepted over-refusal: `git log -- extension/src/review-findings-store.ts` and `git diff HEAD -- …` are refused because a path segment whose last segment is a protected stem is refused by position, and `grep`/`wc`/`sed -n` on the file are refused the same way (clause (b): over-refusing a harmless read is the accepted cost). Read the module with the `read` tool instead, which is not bash and is not guarded. A commit message stays prose only inside a quoted `-m`; the guard refuses `-F`/`--file` outright, so keep the message in `-m "…"`. Git repo-location selectors (`-C <path>`, `--git-dir`, `--work-tree`, `--exec-path`, spaced or `=`-attached, either case) are refused outright: they move the repository a "plain read" runs against, so no arm can vouch for the tree it reads.

Three shapes are refused **on purpose** and have no workaround inside the guard, because a string match cannot tell them from a command: a fenced `bun run build` line followed by prose naming the store, a quoted markdown table whose cells hold `|` and name the store, and a regex literal `/bun|node|deno/` beside a store path. Write the prose without naming the file, or run the read separately. All three are asserted as refusals in `test-review-accept-guard-hardened.ts`. What the guard does not cover at all is in the module header — most load-bearing: it does not guard writes to the store module's own **source** (`sed -i`, `cp`, `tee`, a redirect, `edit`/`write`), only the findings data file and its `.tmp` / `.corrupt` siblings.

A corrupt `review-findings.json` is never overwritten. The reader and the writer both copy it to `review-findings.json.corrupt-<hash>` — the hash is of the bytes that were copied, so a repeat of the same fault names the same file and never duplicates it — and the round then REFUSES: it does not read the corrupt file as "no memory", because a round recorded on no memory would resolve open rows the unreadable file may still hold. The refusal names the copy and the cause and says `repair or remove <file>, or set PI_ENSEMBLE_REVIEW_LEDGER_FILE to a healthy ledger`; the summary carries it as `findings memory unavailable: …`, and every finding is still reported. Fix or remove the file, then re-run the review. A single malformed row is handled the same way on its own (`<file>.corrupt-<hash of the row>`) while the valid rows carry on.

## The offline smoke suite

### The offline suite is slow, or a test interferes with its neighbours

Since #1365 `extension/smoke-tests/lib/verify-loop.sh` runs tests through a bounded job pool (`lib/verify-pool.sh`), default `PI_ENSEMBLE_VERIFY_TEST_JOBS=2`. Two symptoms mean the pool, not the tests:

- **The suite is slower than it used to be**, or a run is thrashing on a busy host — the ceiling is 16 and the count is also clamped to the number of collected tests, either clamp warned on stderr.
- **A test fails only in the full run and passes alone** — it shares state with a neighbour (a temp path, a port, a per-clone file the neighbour also writes).

**Fix for both:** `PI_ENSEMBLE_VERIFY_TEST_JOBS=1 bash extension/smoke-tests/lib/verify-loop.sh extension/smoke-tests/test-*.ts` restores strictly sequential execution — the pre-#1365 shape, same output and exit codes (pinned by `test-verify-loop-parallel.ts` cases 1-2, which compare JOBS=1 and JOBS=3 byte-for-byte). If one test still fails alone, it is the test.

The other knob is the per-test bound, unchanged by the pool: `PI_ENSEMBLE_VERIFY_TEST_TIMEOUT_S` (default 300s, positive integer, else 300 with a warning). A test that hits it is reported `FAILED: <file> (timed out after <N>s)` with a `✗ timed out after <N>s` line prepended to its capture; the whole descendant tree is killed, so a hung test does not take the pool with it. Both variables are read once at startup.

When the suite is on the critical path of a **gate** rather than a developer's own run, the ceiling is the gate's bound, not the pool's: this repo's `.pi/verify-cmd` passes `--jobs-from-host` to `verify-loop.sh`, which sizes the pool from the host when `PI_ENSEMBLE_VERIFY_TEST_JOBS` is unset (4 on 8 or more CPUs, 2 otherwise; an ambient setting of the variable wins) so the full develop-gate command stays inside `PI_ENSEMBLE_VERIFY_TIMEOUT_MS`. It is a flag on the script and not an inline `PI_ENSEMBLE_VERIFY_TEST_JOBS="${…:-$(getconf …)}"` prefix because the review-accept guard's A5 arm (#1125) admits `bash …/verify-loop.sh` only when every word after the script is `--digest` or a test path, and an expansion-word is neither (A5 is this arm's argv rule, not a general ban on expansions in a `bash` command; `test-review-accept-guard-hardened.ts` checks each `.pi/verify-cmd` arm against it). CI passes no flag, so `.github/workflows/ci.yml` keeps the shipped default of 2. `test-verify-loop-jobs-from-host.ts` pins all three branches against a stubbed `getconf`. See `docs/configuration.md` → `PI_ENSEMBLE_VERIFY_TEST_JOBS`.

### A consolidated verify parks with "the verify report file …" instead of naming failing tests

Since #1404 the commit-pr baseline probe reads failing-test **names** only from an out-of-band report file the smoke loop writes, never from the run's stdout/stderr. The reason is a forgery: a test that prints the loop's whole failure triad — a per-file `FAILED: <path>`, a count-matched `FAILED: 1 test(s) — <path>`, and a non-zero `P:/F:` tally — is byte-for-byte what the loop emits, so under stream-parsing a **green** base could be made to name the change's failure, the change-caused failure was excused, and the cycle pushed red code.

The channel: the driver creates a private `0700` temp dir per verify call and passes `VERIFY_REPORT_FILE` to the gate. `lib/verify-report-file.sh` writes the verdict (one path per line, `FAILED-TESTS: <count>` trailer) on every exit path, and `lib/verify-kill.sh` starts every test under `env -u VERIFY_REPORT_FILE`, so a test cannot learn the path. The writer, the reader in `src/work-driver-verify-report-file.ts`, and the scrub's canary fixture are pinned by `test-verify-report-file.ts` and `test-verify-loop.ts` case 9.

**Symptoms and what they mean:**

- **`the verify report file was empty`** — the run was killed before its report half. Same outcome as any unattributable shape: the consolidated failure parks as before (#1404 changed the excuse path, not the park path).
- **`no verify report file exists at the path the driver created`** — the project's verify command is not this repo's smoke loop, or the gate swallowed the environment. This is the **fail-closed default**: no report, no names, nothing excused, the cycle parks exactly as it did before the probe existed. A project that wants the pre-existing-failure excuse must run its gate through `verify-loop.sh`.
- **`its last line was not the loop's FAILED-TESTS trailer`** — something else wrote to that path, or the loop is a stale copy. Check `extension/smoke-tests/lib/verify-report-file.sh` is present and sourced.
- **Every cycle parks although the base is genuinely red** — the writer and reader have drifted. `bun smoke-tests/test-verify-report-file.ts` section 4 runs the real loop and reads its report back; that is the assertion that catches writer drift a parser unit test cannot see.

The variable is a driver-internal process contract, not operator configuration — deliberately **not** a `PI_ENSEMBLE_*` name and not in `HEADLESS_INPUTS`. There is no supported way to set it by hand, and a relative value is refused with a warning rather than written into the checkout under test.
