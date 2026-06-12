# syntax=docker/dockerfile:1.6
#
# pi-ensemble sandboxed runtime
# =============================
#
# A devcontainer-style image that bakes in every CLI pi-ensemble's role
# prompts assume on $PATH. The container fence IS the trust boundary —
# inside, PI_ENSEMBLE_SANDBOX_MODE=1 disables all per-call permission gating
# (see extension/src/permission-guard.ts). State that should survive across
# sessions (vipune memories, ensemble-models.json, transcripts, MCP config)
# is bind-mounted from the host by the wrapper script bin/pi-ensemble — see
# that script + .devcontainer/devcontainer.json for the mount shape.
#
# Build:  docker build -t randomm/pi-ensemble:latest .devcontainer/
# Launch: pi-ensemble    (from any project root on the host)

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
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd
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
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# ctx7 — current library docs
RUN npm install -g --ignore-scripts ctx7 || true

# vipune — cross-session memory
RUN cargo install vipune \
    && install -m 0755 /usr/local/cargo/bin/vipune /usr/local/bin/vipune

# oo (double-o) — context-efficient wrapper for chatty CLIs
RUN cargo install double-o \
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

# parallel-cli — used by explore role for web research.
# Upstream supports `brew install parallel-web/tap/parallel-cli`; Linux fallback
# documented at https://docs.parallel.ai/cli/overview. For v1 we skip if the
# install path isn't obvious — the explore role degrades gracefully when
# parallel-cli isn't on $PATH. File as follow-up if/when upstream ships a
# clean Linux installer.

# -----------------------------------------------------------------------------
# 6. Copy pi-ensemble repo + run install.sh
#    Layout chosen so the repo is read-only image content; user state lives
#    in volumes (bind-mounted by the wrapper / devcontainer.json).
# -----------------------------------------------------------------------------
ENV PI_ENSEMBLE_DIR=/opt/pi-ensemble
COPY --chown=vscode:vscode . ${PI_ENSEMBLE_DIR}

# Drop to vscode user for state setup — install.sh creates symlinks under
# ~/.pi/agent/ + writes ~/.config/mcp/mcp.json (in the user's home, not root).
USER vscode
ENV PATH=/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    HOME=/home/vscode

# Bring extension deps into the image (no network at runtime needed for `bun install`).
RUN cd ${PI_ENSEMBLE_DIR}/extension && bun install --frozen-lockfile

# pi-mcp-adapter must be installed as the running user — pi's `pi install`
# writes under ~/.pi/agent/npm/. This is the user-level install path.
RUN pi install npm:pi-mcp-adapter || true

# Build per-role prompts + symlink extension + skills + write the codebase_memory
# MCP entry into ~/.config/mcp/mcp.json. install.sh is idempotent — safe to
# also run at container start if a bind-mounted state volume needs re-wiring.
RUN cd ${PI_ENSEMBLE_DIR} && ./install.sh || true

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
# pi-ensemble-cache volumes don't need to `pi-ensemble prune` after the
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
COPY --chown=vscode:vscode .devcontainer/entrypoint.sh /usr/local/bin/pi-ensemble-entrypoint
RUN chmod +x /usr/local/bin/pi-ensemble-entrypoint

# -----------------------------------------------------------------------------
# 9. Workspace + sandbox-mode env + entrypoint
# -----------------------------------------------------------------------------
USER vscode
WORKDIR /workspace
ENV PI_ENSEMBLE_SANDBOX_MODE=1

# Entrypoint seeds the HF cache if needed, then exec's the CMD (or whatever
# the user supplies after `docker run ... image <cmd>`).
ENTRYPOINT ["/usr/local/bin/pi-ensemble-entrypoint"]

# Default: drop the user into `pi` directly. The wrapper script overrides via
# `pi-ensemble shell` for a bash prompt instead.
CMD ["pi"]
