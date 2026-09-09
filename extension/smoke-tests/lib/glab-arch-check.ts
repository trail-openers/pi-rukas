#!/usr/bin/env bun
/**
 * glab install arch-neutrality — #645.
 *
 * The .devcontainer/Dockerfile used to hardcode `linux_amd64.deb` for the
 * glab download, which breaks `dpkg -i` on the arm64 leg (BuildKit's
 * TARGETARCH for `linux/arm64` is the literal `arm64` — same vocabulary as
 * `dpkg --print-architecture`). This module owns:
 *   - the asset-name regex (the shape a line must contain to be a glab .deb
 *     download, with the arch token captured),
 *   - checkGlabArchNeutrality (neutrality, not "is it amd64" — both literal
 *     pins are wrong; substitution forms are ok by containing `$`),
 *   - the four inline canary string constants, and
 *   - runGlabArchCanaries, which exercises all four and returns the
 *     failed-assertion count (no process.exit inside the module — the
 *     caller folds the return into its own accumulator).
 *
 * Intentionally NOT named test-*.ts — CI's smoke-tests glob must not
 * self-execute this; coverage comes through test-prerequisite-drift.ts.
 */

/**
 * Asset-name regex for a glab .deb download on a single line. Captures the
 * arch token in group 1. Space-free in the arch position so the post-fix
 * Dockerfile's `linux_${ARCH}.deb` (a standalone variable, no embedded
 * space) matches cleanly. No co-occurrence with dpkg/curl required — the
 * URL lives on a continuation line by itself.
 */
export const GLAB_ASSET_RE = /glab_[^\s"']+_linux_([^\s"']+)\.deb/;

/**
 * Per-line arch-neutrality check for a glab .deb download.
 *   - matched:false — no asset-shape match (a bare `glab` word is not a
 *     match; the caller uses this to report "not checked", not "ok").
 *   - matched:true — the line names a glab .deb download; token is the arch
 *     segment.
 *   - ok:true iff token contains `$` (substitution form — no whitelist, so
 *     a future `${GLAB_ARCH}` works out of the box).
 *   - ok:false iff token is exactly the literal `amd64` OR `arm64` (both
 *     hard pins are equally wrong; no arch-name translation table).
 */
export function checkGlabArchNeutrality(line: string): {
  matched: boolean;
  ok: boolean;
  token: string | null;
} {
  const m = line.match(GLAB_ASSET_RE);
  if (!m) return { matched: false, ok: true, token: null };
  const token = m[1] as string;
  return { matched: true, ok: token.includes("$"), token };
}

// Canary string constants (all space-free in the arch-token position).
// (a) FAIL: the historical hard pin — the exact pre-fix shape on line 73.
export const GLAB_CANARY_FAIL =
  'curl -fsSL "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/glab_${GLAB_VERSION}_linux_amd64.deb" -o /tmp/glab.deb && dpkg -i /tmp/glab.deb';
// (b) PASS: the post-fix shape — ARCH as a standalone variable, space-free
// in the URL. Matches the acceptance criterion's `linux_${ARCH}.deb` form.
export const GLAB_CANARY_PASS =
  'curl -fsSL "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/glab_${GLAB_VERSION}_linux_${ARCH}.deb" -o /tmp/glab.deb && dpkg -i /tmp/glab.deb';
// (c) negative: a different tool prefix — the `glab_` prefix is load-bearing.
export const GLAB_CANARY_FOREIGN_PREFIX =
  "curl -fsSL https://example.com/foo_1.0_linux_amd64.deb -o /tmp/foo.deb && dpkg -i /tmp/foo.deb";
// (d) negative: the bare word `glab` on a verification line — the new
// asset-name rule must add no extra glab entry (existing rules may apply).
export const GLAB_CANARY_BARE_WORD = "&& command -v glab";

/**
 * Run the four canaries and return the count of failed assertions. No
 * process.exit inside the module — the caller (test-prerequisite-drift.ts)
 * folds the return into its own `let exit = 0` accumulator so a failure
 * here fails the whole gate. `parseDockerInstalls` is injected as a
 * callback so this module does not import the main test (which would be a
 * cycle: the main test imports this module).
 */
export function runGlabArchCanaries(
  parseDockerInstalls: (dockerfile: string) => { name: string; line: number }[],
): number {
  let failed = 0;
  const check = (cond: boolean, msg: string) => {
    if (cond) console.log(`✓ glab-arch ${msg}`);
    else {
      console.error(`✗ glab-arch ${msg}`);
      failed++;
    }
  };

  // (a) FAIL: the pre-fix hard pin must produce a glab entry AND fail
  // neutrality (token is the literal `amd64` or `arm64` — both hard pins
  // are equally wrong under decision 4).
  {
    const installs = parseDockerInstalls(GLAB_CANARY_FAIL);
    const neutral = checkGlabArchNeutrality(GLAB_CANARY_FAIL);
    check(
      installs.some((d) => d.name === "glab"),
      "canary (a) FAIL: parseDockerInstalls produces a glab entry for the pre-fix hard-pin URL",
    );
    check(
      neutral.matched === true && neutral.ok === false && neutral.token === "amd64",
      `canary (a) FAIL: checkGlabArchNeutrality flags the literal amd64 pin (got: ${JSON.stringify(neutral)})`,
    );
  }
  // (b) PASS: the post-fix substitution form must produce a glab entry AND
  // pass neutrality (token is the literal string `${ARCH}`, contains `$`).
  {
    const installs = parseDockerInstalls(GLAB_CANARY_PASS);
    const neutral = checkGlabArchNeutrality(GLAB_CANARY_PASS);
    check(
      installs.some((d) => d.name === "glab"),
      "canary (b) PASS: parseDockerInstalls produces a glab entry for the $-substituted URL",
    );
    check(
      neutral.matched === true && neutral.ok === true && neutral.token === "${ARCH}",
      `canary (b) PASS: checkGlabArchNeutrality accepts the $-substituted token (got: ${JSON.stringify(neutral)})`,
    );
  }
  // (c) negative: a different tool prefix must NOT produce a glab entry.
  {
    const installs = parseDockerInstalls(GLAB_CANARY_FOREIGN_PREFIX);
    const neutral = checkGlabArchNeutrality(GLAB_CANARY_FOREIGN_PREFIX);
    check(
      !installs.some((d) => d.name === "glab"),
      "canary (c) negative: a foo_1.0_linux_amd64.deb line does not produce a glab entry",
    );
    check(
      neutral.matched === false,
      "canary (c) negative: checkGlabArchNeutrality does not match a non-glab asset shape",
    );
  }
  // (d) negative: a bare-word line must not contribute a NEW glab entry
  // from the new asset-name rule. The existing rules may independently
  // produce a glab entry (e.g. a piped-curl line with a glab marker); this
  // canary pins only that the new asset-name rule's contribution is zero.
  {
    const installs = parseDockerInstalls(GLAB_CANARY_BARE_WORD);
    const neutral = checkGlabArchNeutrality(GLAB_CANARY_BARE_WORD);
    check(
      neutral.matched === false,
      "canary (d) negative: checkGlabArchNeutrality returns matched:false for a bare-word glab line",
    );
    // The bare-word line contains no asset shape and no piped curl and no
    // apt-get — so under the existing rules AND the new rule, it produces
    // no glab entry.
    const glabEntriesOnThisLine = installs.filter((d) => d.name === "glab");
    check(
      glabEntriesOnThisLine.length === 0,
      `canary (d) negative: a bare-word glab line produces no glab entry from any rule (got: ${JSON.stringify(glabEntriesOnThisLine)})`,
    );
  }
  return failed;
}
