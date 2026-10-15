#!/usr/bin/env bash
# pi-rukas provider-retry defaults — a source-able helper for install.sh.
#
# Sourced by install.sh (not executed), like install-preflight.sh: install.sh
# sits against the 500-line hard limit, and a function on its own is
# testable in isolation (smoke test: test-install-retry-settings.ts runs it
# against temp settings files and reads them back through the pinned Pi's
# own SettingsManager). This file performs no side effects on source — it
# only defines apply_provider_retry_defaults.
#
# PR #236, retuned by #295, extended by #313, key placement fixed by #1347.
#
# Two timeout knobs and one retry count control provider request lifetimes:
#
# 1. `retry.provider.timeoutMs` — the OUTER per-request SDK deadline. Pi-ai
#    uses this as the overall HTTP request timeout. Without it, providers
#    default to ~10 min before a hung request falls out as a synthetic
#    `stopReason: error` assistant message (see PR #236). The earlier 3-min
#    default (#236) sat BELOW the legitimate turn length of thinking-heavy
#    models (a single xhigh-thinking turn routinely streams 10-17 min): one
#    slow-but-healthy request would burn two stacked retry layers (~10-17 min
#    of silence) and surface as "Request timed out." / "terminated" on a
#    perfectly healthy endpoint — the #295 reliability regression. 10 min
#    (`600000`) matches pi's own upstream default while keeping the block
#    explicit and operator-tunable.
#
# 2. `httpIdleTimeoutMs` — the INNER undici socket bound, a TOP-LEVEL key
#    (`getHttpIdleTimeoutMs()` reads `settings.httpIdleTimeoutMs`; the pinned
#    Pi's `getProviderRetrySettings()` returns only `timeoutMs`, `maxRetries`
#    and `maxRetryDelayMs` from `retry.provider`). Pi sets BOTH
#    `headersTimeout` (time-to-first-byte) AND `bodyTimeout` (time between
#    chunks) to this value. THE SMALLER OF THE TWO KNOBS WINS.
#
# The trade-off: one key drives both timeouts, but they want opposite values.
# `headersTimeout` should be seconds (a dead socket never sends headers).
# `bodyTimeout` must tolerate minutes (thinking-heavy generation pauses
# between chunks). No single value is correct for both — an upstream Pi
# limitation this setting cannot fully fix.
#
# install.sh writes 300000 (Pi's own default), on purpose (#1347). From #314
# until #1347 install.sh wrote 120000 under `retry.provider`, where Pi has
# never read it, so every host has in fact run at 300000 — the only value
# with field evidence behind it under thinking-heavy models. The old
# "120000 is the tested floor" note rested on that ignored key; 60000 is
# recorded as having aborted healthy xhigh-thinking streams mid-generation.
# Lowering below 300000 needs a re-test under a thinking-heavy model first:
# a false abort throws away a healthy multi-minute turn, which costs far more
# than finding a dead socket three minutes sooner.
#
# 3. `retry.provider.maxRetries` — 3. Without the key Pi makes NO
#    request-level retry (`retryProviderRequest` uses `maxRetries ?? 0`).
#    These retries are SILENT: no event reaches the child's stdout until they
#    are spent, so their worst case has to fit inside the 30-min model-silence
#    watchdog (spawn-support.ts). At 3 that is 4 x (300s idle + 60s
#    retry-after ceiling) = 24 min; 8 would be 54 min, so the watchdog would
#    kill a child Pi was still retrying. Pi's agent-level retry
#    (`retry.maxRetries`, default 3, emits `auto_retry_start`) stacks on top,
#    so a throttle still gets several minutes to clear. 3 is also what
#    install.sh has always written, so no host changes.
#
# `maxRetryDelayMs` restored to Pi's own default of 60000. It had been lowered
# to 10000 on the reasoning that "with 3 retries, the old value added 3 x 60s
# of backoff". That reasoning was wrong: `maxRetryDelayMs` is a CEILING, not
# a delay — Pi's own backoff is `min(0.5 * 2 ** retryIndex, 8) * 1000`,
# capped at 8s, always below the old 10s ceiling — so lowering it changed
# nothing except that a provider's explicit `retry-after` (routinely 59-60s)
# was discarded without waiting at all. One measured run: three parallel
# research children and two /work developers all died on
# `Server requested 59s retry delay (max: 10s). 429 status code` having
# gathered ~305k characters between them; at 60000 the same 429 is slept
# through and the work survives.
#
# Idempotent + non-clobbering: writes the block only when
# `retry.provider.timeoutMs` is absent (or null). Three exceptions, all our
# own footprints rather than operator choices, repaired wherever they are
# found: `timeoutMs` of exactly 180000 (#236), `maxRetryDelayMs` of exactly
# 10000 (the value documented above), and any `retry.provider.httpIdleTimeoutMs`
# (a key Pi never reads, #1347). That last one is removed; a value other than
# our own 120000 is an operator's choice made in the wrong place, so it moves
# to the top level unless a top-level value is already set. Any other value
# is preserved.

apply_provider_retry_defaults() {
  local settings="$1" tmp existing bad_delay
  local timeout_ms=600000
  local max_retries=3
  local max_delay_ms=60000      # Pi's own default; see the note above before lowering
  local bad_max_delay_ms=10000  # our own past footprint, repaired on sight
  local idle_ms=300000          # Pi's own default; see the note above before lowering
  local bad_nested_idle_ms=120000  # our own past footprint under retry.provider

  if [ ! -f "$settings" ]; then
    echo "==> No $settings yet — Pi will create it on first run. Re-run ./install.sh after to set retry defaults."
    return 0
  fi
  if ! jq empty "$settings" >/dev/null 2>&1; then
    echo "!! $settings is not valid JSON — skipping provider-retry defaults."
    echo "   Fix the file and re-run install.sh, or add manually:"
    echo "     httpIdleTimeoutMs = $idle_ms (top level)"
    echo "     retry.provider = { timeoutMs: $timeout_ms, maxRetries: $max_retries, maxRetryDelayMs: $max_delay_ms }"
    return 0
  fi

  existing="$(jq -r '.retry.provider.timeoutMs // "null"' "$settings")"
  if [ "$existing" = "null" ] || [ "$existing" = "180000" ]; then
    if [ "$existing" = "180000" ]; then
      echo "==> Repairing provider-retry timeout in $settings (old 180000ms default from #236 → ${timeout_ms}ms)"
    else
      echo "==> Setting provider-retry defaults in $settings"
    fi
    echo "    timeoutMs=$timeout_ms (10 min/request), maxRetries=$max_retries, httpIdleTimeoutMs=$idle_ms"
    tmp="$(mktemp)"
    jq --argjson t "$timeout_ms" --argjson r "$max_retries" --argjson d "$max_delay_ms" \
      --argjson i "$idle_ms" '
      .retry //= {} |
      .retry.provider //= {} |
      .retry.provider.timeoutMs = $t |
      .retry.provider.maxRetries //= $r |
      .retry.provider.maxRetryDelayMs //= $d |
      .httpIdleTimeoutMs //= $i
    ' "$settings" > "$tmp" && mv "$tmp" "$settings"
    chmod 600 "$settings"
  else
    echo "==> Keeping existing retry.provider.timeoutMs=$existing in $settings"
  fi

  # Repair our own 10000 footprint independently of the branch above. A host
  # that already had `timeoutMs` set never entered it, so the bad ceiling
  # survived every re-install — which is exactly how it persisted long enough
  # to kill five dispatches.
  bad_delay="$(jq -r '.retry.provider.maxRetryDelayMs // "null"' "$settings")"
  if [ "$bad_delay" = "$bad_max_delay_ms" ]; then
    echo "==> Repairing provider retry ceiling in $settings (${bad_max_delay_ms}ms → ${max_delay_ms}ms)"
    echo "    At ${bad_max_delay_ms}ms a provider asking for the usual 59s is discarded without waiting at all."
    tmp="$(mktemp)"
    jq --argjson d "$max_delay_ms" '.retry.provider.maxRetryDelayMs = $d' \
      "$settings" > "$tmp" && mv "$tmp" "$settings"
    chmod 600 "$settings"
  fi

  # #1347 — `retry.provider.httpIdleTimeoutMs` is a key Pi never reads. Our
  # own 120000 is dropped for the top-level default; any other value moves to
  # the top level unless one is already set there.
  if [ "$(jq '[.retry.provider? | objects | has("httpIdleTimeoutMs")] | any' "$settings")" = "true" ]; then
    echo "==> Repairing httpIdleTimeoutMs placement in $settings (retry.provider → top level; Pi reads only the top level)"
    tmp="$(mktemp)"
    jq --argjson i "$idle_ms" --argjson bad "$bad_nested_idle_ms" '
      .retry.provider.httpIdleTimeoutMs as $n |
      .httpIdleTimeoutMs //= (if $n == null or $n == $bad then $i else $n end) |
      del(.retry.provider.httpIdleTimeoutMs)
    ' "$settings" > "$tmp" && mv "$tmp" "$settings"
    chmod 600 "$settings"
  fi
}
