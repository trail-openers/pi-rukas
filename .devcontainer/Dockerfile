# syntax=docker/dockerfile:1.6
#
# pi-rukas sandboxed runtime
# =============================
#
# A devcontainer-style image that bakes in every CLI pi-rukas's role
# prompts assume on $PATH. The container fence IS the trust boundary —
# inside, PI_ENSEMBLE_SANDBOX_MODE=1 disables all per-call permission gating
# (see extension/src/permission-guard.ts). State that should survive across
# sessions (vipune memories, ensemble-models.json, transcripts, MCP config)
# is bind-mounted from the host by the wrapper script bin/pi-rukas — see
# that script + .devcontainer/devcontainer.json for the mount shape.
#
# Build:  docker build -t ghcr.io/trail-openers/pi-rukas:latest .devcontainer/
# Launch: pi-rukas    (from any project root on the host)

ARG VARIANT=ubuntu-24.04
FROM mcr.microsoft.com/devcontainers/base:${VARIANT}

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# -----------------------------------------------------------------------------
# 1. System packages (as root)
# -----------------------------------------------------------------------------
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget gnupg lsb-release \
      git jq tree less unzip xz-utils \
      build-essential pkg-config libssl-dev \
      python3 python3-pip \
      sudo \
      ripgrep fd-find \
      docker.io \
      util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd
# docker.io: CLI only (we never spawn the daemon inside the container — the
# wrapper bind-mounts the HOST docker socket by default,
# unless opted out with PI_ENSEMBLE_NO_DOCKER_SOCKET=1, and
# our CLI calls become sibling containers on the host daemon). Enables
# docker-based MCP servers in .pi/mcp.json (e.g. `docker run -i some-db-mcp`).
# util-linux: brings `setpriv` for the entrypoint's root → vscode drop.
# ripgrep + fd-find: Pi's built-in rg/search tooling looks for `rg` and `fd`
# on $PATH and self-downloads them into ~/.pi/agent/bin/ on first run if
# missing — which (a) slows first start by ~10s, (b) needs network at boot.
# Baking them in eliminates both. Ubuntu's `fd-find` package installs the
# binary as `fdfind` to avoid a conflict with `fdupes-fd`; we symlink to `fd`
# so Pi finds it without renaming.

# -----------------------------------------------------------------------------
# 2. GitHub CLI
# -----------------------------------------------------------------------------
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod a+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# glab — GitLab CLI. Installed via the latest release deb from GitLab's
# release assets. The install script (docs/installation.sh) was removed from
# the repo (404), so we resolve the latest version via the GitLab API and
# download the deb directly. This avoids pinning a version in the Dockerfile
# while still getting the current release (what the forge CLI needs for
# dual-forge support, #608). Same supply-chain posture as the bun/curl
# installs below.
RUN GLAB_VERSION=$(curl -fsSL "https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/releases" \
      | jq -r '.[0].tag_name' | sed 's/^v//') \
    && ARCH="${TARGETARCH:-$(dpkg --print-architecture)}" \
    && curl -fsSL "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/glab_${GLAB_VERSION}_linux_${ARCH}.deb" \
       -o /tmp/glab.deb \
    && dpkg -i /tmp/glab.deb \
    && rm /tmp/glab.deb \
    && command -v glab

# -----------------------------------------------------------------------------
# 3. Node 22 (NodeSource) + bun (latest)
# -----------------------------------------------------------------------------
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g npm@latest

# bun — install system-wide (the upstream installer drops into $HOME by default
# which would land in /root and not be visible to the vscode user).
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash \
    && chmod +x /usr/local/bin/bun \
    && bun --version

# -----------------------------------------------------------------------------
# 4. Rust toolchain (system-wide) — needed for vipune + oo
# -----------------------------------------------------------------------------
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --no-modify-path --profile minimal --default-toolchain stable \
    && rustup component add rustfmt clippy \
    && chmod -R a+rwX "$CARGO_HOME" "$RUSTUP_HOME"

# -----------------------------------------------------------------------------
# 5. CLI prerequisites (system-wide where possible)
# -----------------------------------------------------------------------------

# Pi (per https://pi.dev/docs/latest/quickstart)
# Pinned to the install floor 1.0.0 (install-preflight.sh MIN_PI_VERSION).
# The floor (install-preflight.sh) and this line are cross-checked by
# test-prerequisite-drift.ts; the separate "last verified" claim in
# docs/pi-compatibility.md is cross-checked by test-pi-version-drift.ts —
# re-run the relevant gate when the built image's pi changes.
# 1.0.0 is the first release with native MCP (mcp.json) and the `-e
# builtin:mcp` flag that pi-rukas's subagent spawn path relies on (issue
# #959). The 4-day embargo was overridden for this bump (operator decision
# 2026-10-02; see extension/bunfig.toml minimumReleaseAgeExcludes).
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.0.0

# ctx7 — current library docs
RUN npm install -g --ignore-scripts ctx7 || true

# vipune — cross-session memory
RUN cargo install vipune \
    && install -m 0755 /usr/local/cargo/bin/vipune /usr/local/bin/vipune

# oo (double-o) — context-efficient wrapper for chatty CLIs
# Pinned to the install floor 0.5.0 (install-preflight.sh MIN_OO_VERSION, #715).
RUN cargo install double-o --version 0.5.0 \
    && install -m 0755 /usr/local/cargo/bin/oo /usr/local/bin/oo

# codebase-memory-mcp — knowledge-graph code indexer (ships as a static binary)
# The upstream installer auto-detects arch and drops to ~/.local/bin/. We
# install as root then move to /usr/local/bin so it's on PATH for any user.
RUN curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh \
      | bash || true \
    && if [ -x /root/.local/bin/codebase-memory-mcp ]; then \
         install -m 0755 /root/.local/bin/codebase-memory-mcp /usr/local/bin/codebase-memory-mcp; \
       fi \
    && rm -rf /root/.local/share

# parallel-cli — web research tool for the @explore role. Subcommands:
# search / fetch / research run|poll. Auth via PARALLEL_API_KEY env (auto-
# forwarded by bin/pi-rukas). Linux install path per
# https://github.com/parallel-web/parallel-web-tools. Soft-fail consistent
# with ctx7 above so an upstream npm hiccup doesn't break the whole image
# build; @explore's prompt surfaces the missing-binary case to the user
# (instead of letting agents fall back to bare `curl` scraping).
#
# Unlike most globals here, parallel-web-cli ships as a thin npm wrapper
# whose postinstall (scripts/install.js) downloads the checksum-pinned
# platform binary from GitHub Releases and verifies its SHA256 sum.
# With --ignore-scripts (used for most other packages) this hook is skipped,
# leaving a non-functional stub on PATH that errors at runtime with
# "binary not found". We therefore omit --ignore-scripts here so the
# postinstall hook runs and pulls the binary from
# github.com/parallel-web/parallel-web-tools/releases.
# `|| true` is preserved so a transient GitHub outage doesn't break the build.
RUN npm install -g parallel-web-cli || true

# wigolo — keyless local web-intelligence CLI; the /research fallback when
# parallel-cli fails with credit-exhausted / auth-missing / network-failed
# (#773). One-shot tools used here: search / fetch / research run.
# Unlike parallel-web-cli (whose postinstall downloads a platform binary),
# wigolo@0.2.1 ships NO install scripts — only build/test/lint dev scripts —
# so --ignore-scripts is safe and keeps the supply-chain posture of the rest
# of this image. Node >= 20 (the image carries Node 22). Its ~1.5 GB browser
# engine downloads lazily on first use, so the image stays small. Soft-fail
# like parallel-cli above: an upstream npm hiccup must not break the build,
# and the fallback is optional by definition.
# `|| true` preserved for the same reason as the parallel-cli line.
# The ~1.5 GB engine is fetched lazily at runtime by wigolo itself, unpinned and without a checksum — accepted because wigolo is an optional fallback that runs only after a Parallel failure; revisit if wigolo becomes primary.
RUN npm install -g --ignore-scripts wigolo@0.2.1 || true

# -----------------------------------------------------------------------------
# 6. Copy pi-rukas repo + run install.sh
#    Layout chosen so the repo is read-only image content; user state lives
#    in volumes (bind-mounted by the wrapper / devcontainer.json).
# -----------------------------------------------------------------------------
ENV PI_ENSEMBLE_DIR=/opt/pi-rukas
COPY --chown=vscode:vscode . ${PI_ENSEMBLE_DIR}

# Drop to vscode user for state setup — install.sh creates symlinks under
# ~/.pi/agent/ + writes ~/.config/mcp/mcp.json (in the user's home, not root).
USER vscode
ENV PATH=/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    HOME=/home/vscode

# Bring extension deps into the image (no network at runtime needed for `bun install`).
RUN cd ${PI_ENSEMBLE_DIR}/extension && bun install --frozen-lockfile

# Build per-role prompts + symlink extension + skills + write the codebase_memory
# MCP entry into ~/.pi/agent/mcp.json (native MCP, issue #959). install.sh is
# idempotent — safe to also run at container start if a bind-mounted state
# volume needs re-wiring. It also removes any lingering pi-mcp-adapter install
# (the adapter's /mcp extension would replace native MCP and silently disable
# it — see docs/mcp.md → Security notes).
RUN cd ${PI_ENSEMBLE_DIR} && ./install.sh || true

# Issue #933 (fresh-host EACCES): bake the state mount points into the image
# as vscode-owned so Docker creates NEW named volumes vscode-owned when the
# launcher falls back to them (bin/pi-rukas build_mounts). When a named volume
# is mounted at a path that didn't exist in the image, Docker creates the
# volume owned by the mount point's owner — here root:root (755), which the
# vscode user (UID 1000) can't write to, crashing pi on first launch in a
# fresh sandbox. This mkdir (as vscode) fixes volumes created from now on; the
# entrypoint repairs PRE-EXISTING root-owned volumes. Mirrors the entrypoint
# allowlist and the launcher's PI_ENSEMBLE_VOLUME_MOUNTS derivation.
RUN mkdir -p /home/vscode/.pi/agent/sessions \
             /home/vscode/.pi/agent/ensemble-runs \
             /home/vscode/.vipune \
             /home/vscode/.cache \
             /home/vscode/.bun \
             /home/vscode/.cargo
# /commandhistory lives at the filesystem root, outside vscode's write scope;
# create it as root then hand it to vscode (same #933 class — the always-on
# pi-ensemble-history volume would otherwise be root-owned).
USER root
RUN mkdir -p /commandhistory && chown vscode:vscode /commandhistory
USER vscode

# -----------------------------------------------------------------------------
# 7. Workspace + sandbox-mode env
# -----------------------------------------------------------------------------
# -----------------------------------------------------------------------------
# 8. Pre-fetch vipune's embedding model so it doesn't need network at first run
# -----------------------------------------------------------------------------
# Vipune downloads BAAI/bge-small-en-v1.5 from HuggingFace on first
# semantic-search call. The pinned revision currently returns 404 from
# vipune's HTTP client (URLs work via curl — likely a redirect / User-Agent
# handling quirk), so vipune fails with "Failed to download embedding
# model" on every fresh container. Fix: pre-fetch at build time. Cached at
# /opt/hf-cache-seed/ AND copied into the vscode user's standard HF cache
# location. The entrypoint script seeds the named-volume cache from
# /opt/hf-cache-seed/ on container start, so users with existing
# pi-ensemble-cache volumes don't need to `pi-rukas prune` after the
# upgrade — first launch of the new image automatically populates.
USER root
RUN pip3 install --no-cache-dir --break-system-packages "huggingface_hub>=0.20"
USER vscode
RUN huggingface-cli download \
      BAAI/bge-small-en-v1.5 \
      --revision 5c38ec7c405ec4b44b94cc5a9bb96e735b38267a \
      --cache-dir /home/vscode/.cache/huggingface/hub \
    || echo "WARNING: pre-fetch of BAAI/bge-small-en-v1.5 failed at image build; vipune may need network at first use"
USER root
RUN if [ -d /home/vscode/.cache/huggingface ]; then \
      cp -r /home/vscode/.cache/huggingface /opt/hf-cache-seed \
      && chown -R vscode:vscode /opt/hf-cache-seed; \
    fi

# Entrypoint: seed ~/.cache/huggingface from the image's /opt/hf-cache-seed
# if the user's mounted cache is empty (handles named-volume masking).
COPY --chown=vscode:vscode .devcontainer/entrypoint.sh /usr/local/bin/pi-rukas-entrypoint
RUN chmod +x /usr/local/bin/pi-rukas-entrypoint

# -----------------------------------------------------------------------------
# 9. Workspace + sandbox-mode env + entrypoint
# -----------------------------------------------------------------------------
WORKDIR /workspace
ENV PI_ENSEMBLE_SANDBOX_MODE=1

# Entrypoint runs as ROOT briefly to (a) seed the HF cache, (b) chmod the
# host docker socket if bind-mounted (by default, unless opted out with
# PI_ENSEMBLE_NO_DOCKER_SOCKET=1), then drops privileges to vscode via setpriv
# before exec'ing the user command.
# Keeping the entrypoint as root for these one-time fixups is safer than the
# alternatives (sudoers carve-outs, GID guessing across host platforms).
ENTRYPOINT ["/usr/local/bin/pi-rukas-entrypoint"]

# Default: drop the user into `pi` directly. The wrapper script overrides via
# `pi-rukas shell` for a bash prompt instead.
CMD ["pi"]
