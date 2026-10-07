# Skill vetting — vendoring & retirement

How to add a third-party agent skill to `skill/` and how to retire one. Skills are a prompt-injection surface: an installed skill's body is prompt text the model follows, and its bundled scripts are code it may run.

## Trust boundary

`skill/` is the trust boundary. **No third-party skill is ever fetched automatically** — not at install, not at build, not at runtime. `install.sh` only symlinks `skill/*` into `$PI_AGENT_DIR/skills/` (a local-only `ln -sfn` loop; no network fetch), and the extension never reaches out for skills. Any skill in `skill/` got there because a human copied it after vetting it.

Upstream package supply-chain doctrine (4-day embargo, npm-registry-only, `--ignore-scripts`) lives in [AGENTS.md §5](../AGENTS.md) and applies to npm dependencies; the rules below are what additionally apply to skill content itself.

## Vendoring checklist

Every item must pass before the skill lands in `skill/`. Record the result as a one-line provenance note (source URL, commit SHA, licence, vetting date) in the PR description or a `PROVENANCE.md` alongside the skill.

1. **Provenance & pin.** Record the exact upstream source (repo + path) and **pin to a commit SHA** — not a branch name or tag, which move. Note the vetting date.
2. **Licence.** Check the licence is compatible with this repo's licence and that it covers the SKILL.md and every bundled file (some collections licence scripts differently from docs). Record the licence.
3. **Prompt-injection review — every file, not just SKILL.md.** Read `SKILL.md` and all bundled files (scripts, `references/`, `assets/`). A skill body is instructions-to-the-model; a bundled script is code the model may execute. Reject or fix anything that tells the model to exfiltrate data, read credentials/secrets, ignore its role or limits, fetch and run remote code, or modify files outside the task.
4. **Frontmatter `allowed-tools`.** `allowed-tools` is an *experimental* frontmatter field that pre-approves a tool list for the skill (see Pi's skills docs). **No bundled skill currently uses it.** If a vendored skill ships it, review the list file-by-file and remove entries that go beyond what the skill's task needs — do not accept it at face value.
5. **Frontmatter `name` equals directory name.** The frontmatter `name:` in the first `---` block of `skill/<name>/SKILL.md` must equal `<name>`. This is enforced mechanically by [extension/smoke-tests/test-skill-name-surface.ts](../extension/smoke-tests/test-skill-name-surface.ts) — a mismatched skill fails the offline gate. If the vendor's file mismatches, rename the directory or the frontmatter to match; the gate reads only the first `---` block, so an in-body `name:` line is ignored.
6. **Body must never contain:** instructions to read/leak secrets, credentials, or environment variables; network exfiltration (curling data to external hosts); commands that bypass sandbox or permission limits; content that rewrites this repo's AGENTS.md, install.sh, or the skill roster; or hidden/obfuscated payloads (base64 blobs, `eval`, remote script execution).

## Retirement

To remove a skill:

1. Delete `skill/<name>/`.
2. Remove any references to it in the prompt sources (`agents-base/`, `modules/`, `pi-prompts/`) — `test-skill-name-surface.ts` also checks that every referenced skill name resolves to an existing `skill/<name>/SKILL.md`, so a dangling reference fails the offline gate.
3. If it was a symlinked third-party skill, the `install.sh` symlink loop picks up the deletion on the next install (`ln -sfn` won't recreate a removed target, but a stale `~/.pi/agent/skills/<name>` link may remain — remove it manually).
4. Note the retirement in the PR (reason + date). No backfill of provenance is required for removal.
