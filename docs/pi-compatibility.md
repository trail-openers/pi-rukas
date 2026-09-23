# Pi compatibility

pi-rukas depends on Pi's CLI flags, JSON event stream shape, and `ExtensionAPI` surface.

## Last verified against pi 0.84.4 (2026-09-23)

Verified by running `extension/smoke-tests/test-pi-shape-live.ts` against the host's installed pi — all event-shape assertions (agent_end, message_end, toolCall blocks, tool_execution_start/end) and the tool-roster integrity check passed.

This line is the single source of truth for the project's Pi version claim: the version its live shape tests (`extension/smoke-tests/test-*-live.ts`) last passed against, i.e. the version to fall back to if you hit trouble on a newer Pi. Every other Pi version claim in the repo must agree with this line; the contradiction gate `extension/smoke-tests/test-pi-version-drift.ts` enforces that.

- **Operators are free to upgrade Pi at any time** — `pi` is a global `npm install -g` outside the extension's package manager, and nothing in this project pins down which Pi version you run. If a newer Pi breaks something, this line is the documented fallback, not a ceiling.
- The dev-dependency pins in `extension/package.json` (`@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`, co-pinned and moved in lockstep) are a **CI-reproducibility device, not a support claim**: they exist so `bun install --frozen-lockfile` in CI is reproducible. They are explicitly **non-normative** — they do not define what Pi versions the project supports or works with. A floating/latest pin is structurally impossible anyway: `extension/bunfig.toml` sets `minimumReleaseAge = 345600` (the 4-day embargo), which governs THIS project's dev dependency installs only — never your own Pi.
- The sandbox image pins `npm install -g` to the install floor (`.devcontainer/Dockerfile`; the floor itself lives in `install-preflight.sh` `MIN_PI_VERSION`) and is independent of both the line above and the dev pins.

Sites asserting a Pi version and the relationship each must maintain (all checked by the drift gate):

- `extension/package.json` — the declared dev pins (CI-reproducibility device; must not be read as a support ceiling; the two co-pins must move in lockstep).
- `install-preflight.sh` (`MIN_PI_VERSION`), the README install line, and `.devcontainer/Dockerfile` — install-floor sites (must agree with each other at or above the floor; the floor is NOT constrained to equal the dev pin — operators may run anything newer).
- `docs/mcp.md` (the `pi install` verification claim) and this line — verified-against claims (must equal the line above).

To update the line: run the live smoke tests under `extension/smoke-tests/test-*-live.ts` against the new version (real child-process spawn, JSON event parsing, tool-call extraction — CI runs offline tests only), then update this line (version + date) and re-align the sites above. Do NOT edit released CHANGELOG.md entries — those are historical records. See [CONTRIBUTING.md](CONTRIBUTING.md) → "Pi compatibility" for the specific fields and flags we depend on.
