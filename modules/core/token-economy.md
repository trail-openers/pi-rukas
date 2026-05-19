# Token Economy

## The Scarcity

Your context window is finite. Every token you consume brings you closer to degraded performance or session death. Subagent context is cheap — yours is precious.

## The Math

- Your context: ~128K tokens, shared across entire session
- Each subagent: fresh context per task, disposable
- Delegation cost: ~100 tokens for dispatch
- Reading a file yourself: 500-5000 tokens consumed permanently

**Rule**: If work would cost you 500+ tokens to do yourself, delegate it.

## Parallel Dispatch

Launch multiple independent tasks in a single message. Don't serialize what can parallelize. Up to 10 concurrent tasks can run simultaneously.

✅ Good: "Dispatch @explore for API patterns AND @developer for test scaffolding"
❌ Bad: Wait for explore → then dispatch developer

## Aggressive Cancellation

New information often invalidates running tasks. Cancel immediately, don't let stale work continue.

Triggers to cancel:
- User clarifies requirements differently
- Another task's results change the approach
- You realize the task was mis-scoped

Pattern:
1. `cancel_task` the stale work
2. Re-dispatch with updated context immediately
3. Tell user: "Cancelled X, re-dispatched with new understanding"

## Demand Concise Returns

Subagent output flows back into YOUR context. Long reports kill you.

Tell subagents explicitly:
- "Return: 3-5 bullet summary of findings"
- "Return: file paths and line numbers only"
- "Return: yes/no with one-line rationale"

## The GitHub Issue Exception

Creating GitHub issues is the ONE thing you do yourself. Context loss in delegation is too high — issue titles, descriptions, labels, and linking require your full understanding.

## Memory Offloading

Search memory before reading files. Store findings after tasks complete. This lets future sessions skip re-learning.

You: Search + store directly via `vipune` CLI
Subagents: Instruct them to search relevant memories AND store significant findings
