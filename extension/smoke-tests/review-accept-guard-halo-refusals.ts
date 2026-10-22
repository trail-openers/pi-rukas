/**
 * #1764 — the two HALO tables that record what the guard must NOT do: the rows the
 * narrowing did not change (allowed before, allowed after — a regression here is #1665
 * shipping twice) and the rows that name the store or the accept script and must stay
 * refused. Split from `review-accept-guard-halo-cases.ts` for the 500-line file cap; the
 * harvest provenance, the class legend and the `\u0072eview-…` spelling rule all live in
 * that module's header, which is the file the corpus is described in.
 */

import type { HaloCase } from "./review-accept-guard-halo-cases.ts";

/** Allowed at 52a81946 and still allowed — the rows a re-widening would break first. */
export const HALO_ALREADY_ALLOWED_AT_BASE: readonly HaloCase[] = [
  {
    c: "git -C /home/janni/projects/pi-ab-bench log --oneline -5",
    why: "shape: git -C <path> log --oneline -N",
    count: 115,
    cls: "f",
  },
  {
    c: "git -C /home/janni/projects/pi-ab-bench status --porcelain",
    why: "shape: git -C <path> status --porcelain",
    count: 104,
    cls: "f",
  },
  {
    c: 'gh issue list --state all --limit 200 --json number,state,title --jq ".[] | \\"\\(.number) [\\(.state)] \\(.title)\\""',
    why: 'shape: gh issue list --state all --limit N --json number,state,title --jq ".[] | \\"\\(.number) [\\(.state)] \\(.title)\\""',
    count: 20,
    cls: "f",
  },
  {
    c: 'gh issue list --state all --search "Object Storage" --limit 10 --json number,state,title --jq ".[] | \\"\\(.number) [\\(.state)] \\(.title)\\""',
    why: 'shape: gh issue list --state all --search "Object Storage" --limit N --json number,state,title --jq ".[] | \\"\\(.number) [\\(.state)] \\(.title)\\""',
    count: 15,
    cls: "f",
  },
  {
    c: "git -C /home/janni/projects/pi-ab-bench log --oneline -n 3",
    why: "shape: git -C <path> log --oneline -n N",
    count: 12,
    cls: "f",
  },
  {
    c: "git -C /home/janni/projects/pi-ab-bench status --short",
    why: "shape: git -C <path> status --short",
    count: 12,
    cls: "f",
  },
  {
    c: "git -C /home/janni/projects/pi-ab-bench rev-parse --short HEAD",
    why: "shape: git -C <path> rev-parse --short HEAD",
    count: 10,
    cls: "f",
  },
  {
    c: "git -C /home/janni/projects/pi-ab-bench/.worktrees/issue-4-default status",
    why: "shape: git -C <path> status",
    count: 7,
    cls: "f",
  },
  {
    c: "git -C /home/janni/projects/pi-ab-bench worktree list",
    why: "shape: git -C <path> worktree list",
    count: 7,
    cls: "f",
  },
  {
    c: "git -C /home/janni/projects/pi-ab-bench branch --show-current",
    why: "shape: git -C <path> branch --show-current",
    count: 6,
    cls: "f",
  },
  {
    c: "git -C /home/janni/projects/pi-tehas-hermes-bridge/.worktrees/issue-78-default rev-parse --abbrev-ref HEAD",
    why: "shape: git -C <path> rev-parse --abbrev-ref HEAD",
    count: 6,
    cls: "f",
  },
  {
    c: "git -C /home/janni/projects/pi-ab-bench rev-parse HEAD",
    why: "shape: git -C <path> rev-parse HEAD",
    count: 5,
    cls: "f",
  },
  {
    c: "git -C /home/janni/projects/pi-ab-bench show --stat --oneline HEAD",
    why: "shape: git -C <path> show --stat --oneline HEAD",
    count: 5,
    cls: "f",
  },
  { c: "git -C . log --oneline -15", why: "shape: git -C . log --oneline -N", count: 4, cls: "f" },
  {
    c: "git -C /home/janni/projects/pi-ab-bench branch -a",
    why: "shape: git -C <path> branch -a",
    count: 4,
    cls: "f",
  },
  {
    c: "git -C /home/janni/projects/pi-ab-bench/.worktrees/issue-4-default diff --stat HEAD",
    why: "shape: git -C <path> diff --stat HEAD",
    count: 4,
    cls: "f",
  },
  {
    c: "git -C /home/janni/projects/pi-tehas-hermes-bridge remote get-url origin",
    why: "shape: git -C <path> remote get-url origin",
    count: 4,
    cls: "f",
  },
  {
    c: 'gh issue list --state all --limit 25 --json number --jq "map(.number)|join(\\" \\")"',
    why: 'shape: gh issue list --state all --limit N --json number --jq "map(.number)|join(\\" \\")"',
    count: 3,
    cls: "f",
  },
  {
    c: 'gh issue list --state all --search "state" --limit 12 --json number,state,title --jq ".[] | \\"\\(.number) [\\(.state)] \\(.title)\\""',
    why: 'shape: gh issue list --state all --search "state" --limit N --json number,state,title --jq ".[] | \\"\\(.number) [\\(.state)] \\(.title)\\""',
    count: 3,
    cls: "f",
  },
  {
    c: "git -C /home/janni/projects/pi-rukas rev-parse --short HEAD; git -C /home/janni/projects/pi-rukas status --porcelain | head -20",
    why: "shape: git -C <path> rev-parse --short HEAD; git -C <path> status --porcelain | head -N",
    count: 3,
    cls: "f",
  },
  {
    c: "git -C /home/janni/projects/pi-ab-bench/.worktrees/issue-4-default status --porcelain=v1",
    why: "shape: git -C <path> status --porcelain=v1",
    count: 3,
    cls: "f",
  },
  {
    c: "git -C /home/janni/projects/pi-ab-bench/.worktrees/issue-4-default status --short --branch",
    why: "shape: git -C <path> status --short --branch",
    count: 3,
    cls: "f",
  },
  {
    c: 'grep -n "PI_ENSEMBLE_NO_DOCKER_SOCKET\\|PI_ENSEMBLE_NO_SSH" /home/janni/projects/pi-rukas/extension/src/headless/inputs.ts',
    why: 'shape: grep -n "PI_ENSEMBLE_NO_DOCKER_SOCKET\\|PI_ENSEMBLE_NO_SSH" <path>',
    count: 3,
    cls: "f",
  },
  {
    c: 'grep -n "def \\|^class " /home/janni/projects/pi-ab-bench/tests/agents_harness_base.py',
    why: 'shape: grep -n "def \\|^class " <path>',
    count: 3,
    cls: "f",
  },
  {
    c: 'grep -n "spec\\." tests/test_render_settings.py',
    why: 'shape: grep -n "spec\\." tests<path>',
    count: 3,
    cls: "f",
  },
  {
    c: 'grep -rn "README\\|SECURITY" /home/janni/projects/pi-rukas/extension/smoke-tests/test-file-size-limit.ts | head',
    why: 'shape: grep -rn "README\\|SECURITY" <path> | head',
    count: 3,
    cls: "f",
  },
  {
    c: 'grep -rn "execFileSync\\|spawnSync" /home/janni/projects/pi-rukas/extension/smoke-tests/test-headless-plan.ts | head',
    why: 'shape: grep -rn "execFileSync\\|spawnSync" <path> | head',
    count: 3,
    cls: "f",
  },
  {
    c: 'cd /home/janni/projects/pi-rukas && grep -n "live\\|cage\\|selftest\\|docker\\|podman" extension/src/headless/inputs.ts | head -40',
    why: 'shape: cd <path> && grep -n "live\\|cage\\|selftest\\|docker\\|podman" extension<path> | head -N',
    count: 2,
    cls: "a",
  },
  {
    c: 'cd /home/janni/projects/pi-tehas-hermes-bridge/.worktrees/issue-78-default && grep -n "log_path\\|\\.err" skills/pi-rukas-driver/scripts/pi-work.py',
    why: 'shape: cd <path> && grep -n "log_path\\|\\.err" skills<path>',
    count: 2,
    cls: "a",
  },
  {
    c: "cat .gitignore 2>/dev/null; echo ---; git -C . status --porcelain --untracked-files=all",
    why: "shape: cat .gitignore N><path>; echo ---; git -C . status --porcelain --untracked-files=all",
    count: 1,
    cls: "c",
  },
  {
    c: 'cat .pi/verify-cmd 2>/dev/null; echo "--- always-run:"; grep -n "dockerfile\\|sandbox\\|prerequisite\\|pi-rukas-symlink\\|headless-inputs-wrapper" extension/src/work-driver-verify-always-run.ts | head',
    why: 'shape: cat .pi<path> N><path>; echo "--- always-run:"; grep -n "dockerfile\\|sandbox\\|prerequisite\\|pi-rukas-symlink\\|headless-inputs-wrapper" extension<path>',
    count: 1,
    cls: "c",
  },
  {
    c: "python3 - <<'PY' lines=open('/home/janni/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/cli/args.js').read().splitlines() for i in range(95,215): print(i+1, lines[i][:120]) PY",
    why: "shape: python3 - <<'PY' lines=open('<path>').read().splitlines() for i in range(N,N): print(i+N, lines[i][:N]) PY",
    count: 2,
    cls: "d",
  },
  {
    c: "timeout 120 python3 /dev/stdin <<'PY' import subprocess, pathlib, difflib old = subprocess.run(['git','show','HEAD:desktop/plugin.js'],capture_output=True,text=True).stdout.splitlines() new = pathlib.Path('desktop/plugin.js').read_text().sp",
    why: "shape: timeout N python3 <path> <<'PY' import subprocess, pathlib, difflib old = subprocess.run(['git','show','HEAD:desktop<path>'],capture_output=True,text=",
    count: 2,
    cls: "d",
  },
  {
    c: ".venv/bin/python - << 'EOF' import re, pathlib p = pathlib.Path(\"ab_bench/config_spec.py\") src = p.read_text() start = src.index('#: The provider name Harbor writes into ``models.json``') end = src.index('#: A run of 20+ characters from the",
    why: "shape: .venv<path> - << 'EOF' import re, pathlib p = pathlib.Path(\"ab_bench<path>\") src = p.read_text() start = src.index('#: The provider name Harbor writes",
    count: 1,
    cls: "d",
  },
  {
    c: 'grep -n "README\\|SECURITY\\|docs/" /home/janni/projects/pi-rukas/extension/smoke-tests/test-\u0072eview-accept-guard-hardened.ts | head',
    why: "KEEP-REFUSED: reaches the checker's own smoke-test file by name - whether a prose-level reach stays refused is a #1764 decision — allowed at base too: the name is a test module BESIDE the store, not a protected basename",
    count: 1,
    cls: "f",
  },
];

/** The rows that name the store or the operator script: refused before, refused now. */
export const HALO_KEEP_REFUSED: readonly HaloCase[] = [
  {
    c: 'cd /home/janni/projects/pi-tehas-hermes-bridge rg -n -i "tehas" extension/scripts/\u0072eview-accept.ts | head -20',
    why: "KEEP-REFUSED: greps inside the operator-only file",
    count: 1,
    cls: "a",
  },
  {
    c: 'find / -maxdepth 5 -name "\u0072eview-accept.ts" 2>/dev/null | head',
    why: "KEEP-REFUSED: hunts the operator-only file across the filesystem",
    count: 1,
    cls: "f",
  },
  {
    c: 'find / -maxdepth 7 -path /proc -prune -o -name "\u0072eview-accept.ts" -print 2>/dev/null | head -3',
    why: "KEEP-REFUSED: hunts the operator-only file across the filesystem",
    count: 1,
    cls: "f",
  },
  {
    c: 'find / -name "\u0072eview-accept.ts" -not -path "*/node_modules/*" 2>/dev/null | head -5',
    why: "KEEP-REFUSED: hunts the operator-only file across the filesystem",
    count: 1,
    cls: "f",
  },
  {
    c: 'find /home/janni -maxdepth 3 -name "\u0072eview-accept.ts" 2>/dev/null',
    why: "KEEP-REFUSED: hunts the operator-only file under the home tree",
    count: 1,
    cls: "f",
  },
  {
    c: 'find /home/janni -maxdepth 5 -name "\u0072eview-accept.ts" -not -path "*/node_modules/*" 2>/dev/null',
    why: "KEEP-REFUSED: hunts the operator-only file under the home tree",
    count: 1,
    cls: "f",
  },
  {
    c: 'find /home/janni/pi-work/pi-agent -maxdepth 3 -name "\u0072eview-accept*" 2>/dev/null; ls /home/janni/pi-work/pi-agent/extension/scripts 2>/dev/null | head',
    why: "KEEP-REFUSED: locates the operator-only file and lists its directory",
    count: 1,
    cls: "f",
  },
  {
    c: 'find /home/janni/pi-work/pi-agent -name "\u0072eview-accept*" -not -path "*/node_modules/*"',
    why: "KEEP-REFUSED: locates the operator-only file",
    count: 1,
    cls: "f",
  },
  {
    c: 'grep -c "if False" /home/janni/projects/pi-ab-bench/.git/\u0072eview-findings.json',
    why: "KEEP-REFUSED: reads the JSON file under .git directly",
    count: 1,
    cls: "f",
  },
  {
    c: 'grep -n "findings store\\|\u0072eview-accept" /home/janni/CLAUDE.md /home/janni/projects/pi-tehas-hermes-bridge/AGENTS.md 2>/dev/null | head -5',
    why: "KEEP-REFUSED: greps the doctrine to learn how to reach the operator-only file",
    count: 1,
    cls: "f",
  },
  {
    c: 'grep -n "\u0072eview-accept" /home/janni/CLAUDE.md | head -3',
    why: "KEEP-REFUSED: greps the doctrine for the acceptance entry point",
    count: 1,
    cls: "f",
  },
  {
    c: 'grep -n "\u0072eview-accept\\|findings store" /home/janni/pi-work/pi-agent/AGENTS.md 2>/dev/null | head -3',
    why: "KEEP-REFUSED: greps the doctrine in another checkout",
    count: 1,
    cls: "f",
  },
  {
    c: 'grep -n -E "if False|HASH_LIKE_FIELDS|_WORD_CHARS|<key " /home/janni/projects/pi-ab-bench/.git/\u0072eview-findings.json',
    why: "KEEP-REFUSED: reads the JSON file under .git and probes its field names",
    count: 1,
    cls: "f",
  },
  {
    c: "grep -rl -e '\u0072eview-accept.ts' -e 'findings store' -e 'body-indirect' /home/janni/pi-work/pi-agent /home/janni/.bun/install/global/node_modules/@earendil-works/pi-coding-agent 2>/dev/null | head -20",
    why: "KEEP-REFUSED: recursive discovery of the implementation",
    count: 1,
    cls: "f",
  },
  {
    c: 'grep -rn "findings" /home/janni/pi-work/pi-agent/extension/scripts/\u0072eview-accept.ts 2>/dev/null | head -5; echo "---"; ls /home/janni/pi-work/pi-agent',
    why: "KEEP-REFUSED: greps the operator-only file and enumerates its tree",
    count: 1,
    cls: "f",
  },
  {
    c: "head -40 extension/scripts/\u0072eview-accept.ts 2>&1 | head -20; ls extension 2>&1 | head",
    why: "KEEP-REFUSED: reads the operator-only file through a reader",
    count: 1,
    cls: "c",
  },
  {
    c: "head -60 extension/scripts/\u0072eview-accept.ts 2>/dev/null; ls extension/scripts 2>/dev/null | head",
    why: "KEEP-REFUSED: reads the operator-only file and lists its directory",
    count: 1,
    cls: "c",
  },
  {
    c: "ls -la /home/janni/pi-work/pi-agent/extension/scripts/\u0072eview-accept.ts",
    why: "KEEP-REFUSED: stats the operator-only file by path",
    count: 1,
    cls: "f",
  },
  {
    c: "ls /home/janni/projects/pi-ab-bench/.git/\u0072eview-findings.json",
    why: "KEEP-REFUSED: stats the JSON file under .git by path",
    count: 1,
    cls: "f",
  },
  {
    c: "ls /tmp/ensemble-findings 2>&1; ls -d /tmp/ensemble-findings /tmp/\u0072eview-findings /tmp/rukas-findings 2>&1 | head -5",
    why: "KEEP-REFUSED: enumerates candidate locations for the operator-only file",
    count: 1,
    cls: "f",
  },
  {
    c: "ls extension/scripts/\u0072eview-accept.ts extension/scripts/ 2>&1 | head -30",
    why: "KEEP-REFUSED: lists the operator-only file and its directory",
    count: 1,
    cls: "f",
  },
  {
    c: 'python3 - <<\'PY\' from pathlib import Path src = Path("/opt/data/bridge-loop/conductor-prompt.md").read_text() for pat in ("review findings", "findings store", "\u0072eview-findings", "reviewFindings", "review findings store"): print(pat, "->", s…',
    why: "KEEP-REFUSED: quoted heredoc whose whole payload is alternate spellings of the operator-only file - only the tag is visible",
    count: 1,
    cls: "d",
  },
  {
    c: "rm -f /home/janni/projects/pi-tehas-hermes-bridge/tmp/issue-84/probe3.txt; rg -n -i '\u0072eview-findings|reviewFindings|findings' /opt/data/bridge-loop/conductor-prompt.md | head -3",
    why: "KEEP-REFUSED: deletes a probe file then greps for the operator-only file - a write plus a reach on one line",
    count: 1,
    cls: "f",
  },
  {
    c: "vipune add 'gh issue list --json is DENIED in the explore sandbox (subagent ask -> headless deny; --jq form trips a false \u0072eview-findings guard), so issue-set facts come from vipune rows only. Open set for pi-tehas-hermes-bridge at e63cbeb…",
    why: "KEEP-REFUSED (verify): a memory write that only mentions the checker in prose - refused solely because the text names the file. Whether prose mentions count is the #1764 call.",
    count: 1,
    cls: "f",
  },
  {
    c: 'git -C /repo/.git log --oneline -5 && git commit -m "docs: record the \u0072eview-accept guard schema"',
    why: "the twin: a selector at .git stays refused",
    count: 1,
    cls: "f #1764(a) twin KEEP-REFUSED",
  },
  {
    c: 'git commit -m "docs: the \u0072eview-findings.json schema" && gh pr view 1 --json body --jq ".body + \\"|\\" + .title" && cat .git/\u0072eview-findings.json',
    why: "the twin: the store named as a path operand stays refused",
    count: 1,
    cls: "e #1764(b) twin KEEP-REFUSED",
  },
];

