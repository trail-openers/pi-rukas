/**
 * Version information in the interactive session (#1614), so an operator can
 * tell which pi-rukas build a Pi session is running without leaving it.
 *
 *   - On `session_start` (parent only — index.ts returns before this in
 *     subagent mode) a one-line `pi-rukas v<version> · <sha>` notice.
 *   - `/pi-rukas-version` prints version, full commit, install root and the
 *     running Pi version, in a form meant to be pasted into a bug report.
 *
 * Both read the same resolver the headless CLI reports (`headless/build.ts`):
 * the commit the image build bakes into `.pi/pi-rukas-commit`, else the
 * install checkout's HEAD, else "commit unknown" — never a guess.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { INSTALL_ROOT, readBuildCommit, readBuildVersion } from "./headless/build.ts";
import { probePiVersion } from "./pi-version-probe.ts";

/** `pi-rukas v0.12.80 · bf2deb1a9c3e`, or `· commit unknown` when nothing records it. */
export function formatVersionLine(version: string, commit: string | null): string {
  return `pi-rukas v${version} · ${commit ? commit.slice(0, 12) : "commit unknown"}`;
}

export interface VersionReport {
  version: string;
  commit: string | null;
  installRoot: string;
  piVersion: string | null;
}

/** The multi-line `/pi-rukas-version` answer. */
export function formatVersionReport(r: VersionReport): string {
  return [
    `pi-rukas:     v${r.version}`,
    `commit:       ${r.commit ?? "unknown (no baked marker, install root is not a git checkout)"}`,
    `install root: ${r.installRoot}`,
    `pi:           ${r.piVersion ?? "unknown"}`,
  ].join("\n");
}

/** The version line for the running build — shared with `/ensemble-debug`. */
export function currentVersionLine(): string {
  return formatVersionLine(readBuildVersion(), readBuildCommit());
}

export function registerVersionInfo(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.notify(currentVersionLine(), "info");
  });
  pi.registerCommand("pi-rukas-version", {
    description: "Show the pi-rukas version, commit and Pi version (for bug reports)",
    handler: async (_args, ctx) => {
      const { version: piVersion } = await probePiVersion();
      ctx.ui.notify(
        formatVersionReport({
          version: readBuildVersion(),
          commit: readBuildCommit(),
          installRoot: INSTALL_ROOT,
          piVersion,
        }),
        "info",
      );
    },
  });
}
