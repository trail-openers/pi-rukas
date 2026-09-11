# fixture project

A minimal README for the prerequisite-drift canary.

## Prerequisites

Required CLIs on `$PATH`.

| Tool | Purpose |
|---|---|
| `pi` | The terminal coding agent this extends. |
| `git` | Worktrees, branches, diffs. |

The rest of the README follows.

## Install

Copy-pasteable install commands.

```bash
# Pi — pinned floor in the real README; the canary pins 0.84.3, which is
# BELOW the fixture install floor (0.84.4), so the version gate MUST flag it.
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.3
# oo — pinned 0.4.4, which is BELOW the fixture MIN_OO_VERSION (0.5.0), so
# the oo version gate MUST flag it (below-floor path).
cargo install double-o --version 0.4.4
```

Run the installer.
