# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| latest  | ✅        |

pi-rukas is a pre-1.0 alpha maintained by a single maintainer at hobby cadence. Only the current release line receives security attention.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting:

<https://github.com/trail-openers/pi-rukas/security/advisories/new>

On the repo's Security tab, use the **"Report a vulnerability"** button. This opens a private draft GitHub security advisory — do not file an issue or PR for a vulnerability, which would make it public. Do not email credentials or repro secrets in the report; describe the vulnerability and, if helpful, link to a minimal repro.

If the button is missing or the report is rejected, private vulnerability reporting is not enabled on the repo at that moment — open a regular (public-safe) issue titled "Re-enable private vulnerability reporting" and we will enable it under Settings → Security → Private vulnerability reporting.

## Scope

**In scope (please report here):**

- The pi-rukas extension (`extension/`): the `/work` driver, dispatch/spawn paths, permission guards, sandbox wiring.
- The install and runtime chain: `install.sh`, `bin/pi-rukas`, `.devcontainer/` sandbox image, `build.sh`, `build-prompts.sh`.
- Supply chain: `extension/package.json`, `bun.lock`, `.npmrc` / `bunfig.toml` embargo config, release tooling (release-please, `RELEASE_PAT` handling).
- The prompt layer shipped to agents (`agents-base/`, `modules/`, `manifests/`, `pi-prompts/`) where a defect could cause unsafe agent behaviour (e.g. an injected instruction that weakens a safety gate).
- A subagent or the orchestrator bypassing a documented safety gate (permission guard, scope fence, merge-authority check) by a defect in pi-rukas code.

**Out of scope (file a regular GitHub issue):**

- Vulnerabilities in upstream dependencies (Pi, bun, Docker, the model providers) — report to the upstream project.
- Misuse by the operator's own user account: running pi-rukas with credentials you do not want an agent to have is a configuration problem, not a pi-rukas bug.
- The absence of network egress filtering or other features documented as "v1 does NOT include" in `docs/sandbox.md`.
- Availability / DoS of the maintainer's own infrastructure.
- General security advice, audit requests, or requests for a penetration test.

## Acknowledgement SLA

Reports get an **acknowledgement within 7 days** — the maintainer confirms receipt and states a triage direction (fix, non-vulnerability, or needs-more-info).

This is an acknowledgement window, not a promise to ship a fix within any timeframe. pi-rukas is a single-maintainer hobby project; resolutions arrive on maintainer cadence and may take longer than a week. We will communicate the status of the advisory as it progresses, and a confirmed vulnerability that is resolved is published as a GitHub security advisory with the affected versions listed.

## Trust model (read before reporting)

pi-rukas's design is explicit about what it does and does not protect against. If your report is "X can do Y by design, and the documentation over-promised", that is in scope (please cite the doc line). If your report is "the sandbox does not contain a hostile subagent", that is the documented default, not a vulnerability:

- **Trust mode is the default.** In both sandbox and interactive host mode, per-call permission prompts are off; the role's system prompt is the behavioural guidance, not a runtime gate.
- **Full host environment forwarding.** Subagent children receive the parent's entire shell environment (`extension/src/spawn.ts` forwards `process.env`), so **by default a subagent in trust mode can read host environment variables (including credentials) and can push to GitHub** using `GH_TOKEN` or forwarded SSH identities. The sandbox does not prevent this.
- **Passthroughs are on by default.** The sandbox bind-mounts the host Docker socket (root-equivalent host access) and `~/.ssh/` with `SSH_AUTH_SOCK` forwarded, so docker-based MCPs and outbound SSH Just Work. Opt out with `PI_ENSEMBLE_NO_DOCKER_SOCKET=1` and/or `PI_ENSEMBLE_NO_SSH=1` for a tighter boundary — and note that even with those opt-outs, **v1 still has unrestricted network egress**.
- **The honest position** (per `docs/sandbox.md`): the default sandbox is the agent's runtime, not the user's security boundary. The container protects your filesystem layout and caches; it does not protect your credentials, your SSH identities, your Docker daemon, or your network.
- **Strict mode exists** (`PI_ENSEMBLE_STRICT_PERMISSIONS=1` in interactive mode) and headless `pi -p` hard-denies novel commands; neither is on by default in the configurations above.

## What we do about a confirmed vulnerability

1. Acknowledge within the window above.
2. Triage with the reporter; ask for more info if the repro is unclear.
3. Fix on maintainer cadence; communicate the fix timeline in the advisory.
4. Publish a GitHub security advisory crediting the reporter (with opt-out) and list affected versions.
