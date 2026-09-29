#!/usr/bin/env bun
/**
 * #915 — the steer re-open loop is retired. The view's input line sends
 * in-place (Enter → onSend), so there is no `done("steer")` → `ctx.ui.editor`
 * re-open loop. The single-subscription guarantee (one onBufferAppend
 * per view open → append → close) is now tested in
 * test-agent-view-input.ts block 12.
 *
 * before: this file tested the steer re-open loop (3 custom calls, 2 steer
 * calls, one append → one render) / after: the loop is gone; the
 * single-subscription guarantee is tested in test-agent-view-input.ts (#915)
 */
process.exit(0);
