#!/usr/bin/env bash
# Pre-existing SIGINT gap in verify-loop.sh — minimal reproducer, committed
# from /tmp/pi-dev-1365/interrupt-min.sh so the comment in lib/verify-pool.sh
# (run_pool's tick) points at something that outlives the scratch dir.
#
# `bash` defers a trapped signal until the foreground command it is waiting on
# returns, and for a NON-interactive shell (no job control) a SIGINT delivered
# while blocked in a foreground `sleep` or a foreground `wait` is not delivered
# to the trap at all. Measured on bash 5.3.9 with all three shapes (`sleep 30`,
# `sleep 30 & wait $!`, and the pool's own tick+wait loop): none ran the handler
# within 6s of SIGINT.
#
# Consequence for the offline smoke gate: Ctrl-C on `verify-loop.sh` does not
# reach interrupt_now while the pool is inside a tick, so the running jobs'
# process trees are not taken down and survive as orphans.
#
# Reproduce THIS file (expect: HANDLER-RAN never prints, the child survives):
#   bash fixtures/verify-loop/interrupt-min.sh & p=$!
#   sleep 2; kill -INT $p; sleep 3
#   kill -0 $p 2>/dev/null && echo "STILL-ALIVE (SIGINT not delivered)"
#
# Against the real loop:
#   cd extension && bash smoke-tests/lib/verify-loop.sh smoke-tests/test-*.ts &
#   sleep 10; kill -INT %1        # loop keeps running; job children survive
#
# SIGTERM is unaffected — the shipped case 5 of test-verify-loop-parallel.ts
# asserts the SIGTERM path and passes, taking the whole tree down with no
# orphans. A terminal Ctrl-C sends SIGINT, so the interactive path is the one
# that leaks. Verified in this repo's environment: the INT run above prints
# STILL-ALIVE, the same run with `kill -TERM` prints DIED.
#
# Fix shape (needs its own round, not folded into #1365): the pool cannot make
# a non-interactive bash deliver SIGINT promptly, so either run the pool body
# under `set -m` (job control, which makes the wait interruptible) or bind the
# interactive key to SIGTERM-equivalent handling. Deciding between them is a
# PM/spec call, not an implementation detail.
#
# Deliberately not named test-*.sh: it is a reproducer for a known gap, not a
# gate, and the whole file is one trap and one sleep.
# The shebang and the trap are the reproducer; the block above is documentation
# only, which is why the executable body sits at the very bottom of the file.
trap 'echo "HANDLER-RAN" >&2; exit 130' INT
sleep 30
