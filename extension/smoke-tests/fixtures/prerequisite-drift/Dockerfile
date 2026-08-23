# Canary fixture for test-prerequisite-drift.ts — NOT a buildable image.
# mystery-tool is installed here but appears in neither REQUIRED_CLIS (the
# fixture install.sh) nor any exception, so the reverse direction MUST flag
# exactly it.
FROM debian:stable-slim
# pi — the npm package installs the `pi` binary (a REQUIRED_CLIS entry).
RUN npm install -g --ignore-scripts pi
RUN apt-get install -y git
RUN npm install -g mystery-tool
