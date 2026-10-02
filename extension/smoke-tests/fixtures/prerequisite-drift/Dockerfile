# Canary fixture for test-prerequisite-drift.ts — NOT a buildable image.
# mystery-tool is installed here but appears in neither REQUIRED_CLIS (the
# fixture install.sh) nor any exception, so the reverse direction MUST flag
# exactly it. The pi global install is pinned above the install floor
# (1.1.0 vs floor 1.0.0) so the version gate's "above floor" path is
# exercised; the below-floor path is the README side (0.84.3 < 1.0.0).
# The oo pin (1.1.0) is above the fixture MIN_OO_VERSION (0.5.0) for the
# same "above floor" canary path on the oo gate.
FROM debian:stable-slim
# pi — the npm package installs the `pi` binary (a REQUIRED_CLIS entry).
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.1.0
# oo — pinned above the fixture floor (0.5.0), exercising the "above floor" canary path.
RUN cargo install double-o --version 1.1.0
RUN apt-get install -y git
RUN npm install -g mystery-tool
# gh via apt-get — the forge OR-gate canary: the real Dockerfile installs gh
# via apt and glab via a piped curl one-liner; this line keeps that shape
# (and the apt-get rule in parseDockerInstalls) exercised by the canary.
RUN apt-get install -y gh
