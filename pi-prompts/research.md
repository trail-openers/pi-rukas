---
description: Multi-pronged research on a topic using web, codebase, memory, and specialist tools
argument-hint: "<topic>"
---

# Research Mission

**Topic**: $ARGUMENTS

If no topic was provided, ask the user before proceeding.

---

## Role

You are orchestrating research. Your job:
1. Understand the topic enough to dispatch targeted parallel research.
2. Ask clarifying questions only if scope/depth/angle would materially change the approach.
3. Dispatch parallel explore tasks via the `dispatch_parallel` tool — different angles run simultaneously.
4. Synthesise findings into a coherent picture.
5. Save results to vipune memory by default.
6. Stay in conversation — offer to dig deeper.

## Execution

1. **Search memory first.** Derive a few conceptual keywords from the topic and run a focused `vipune search "<keyword>" --limit 5` per keyword. Use your judgment for what's worth searching. Avoid passing the user's whole sentence as a single query — vipune is keyword-semantic search and prefers short phrases.

2. **Dispatch parallel explore** — use the `dispatch_parallel` tool with 2–4 specs covering different angles:
   ```
   specs:
     - role: explore
       prompt: "Web/current information angle: …"
     - role: explore
       prompt: "Technical depth angle (docs, specs): …"
     - role: explore
       prompt: "Codebase relevance angle: use colgrep to find existing code related to the topic. ColGREP is code-only — only useful if the topic is something that would exist in source files (a function, feature, module). Skip if the topic is meta/project-level."
   ```
   Up to 10 parallel slots; do NOT serialise independent angles.

3. **Synthesise** — combine findings into a coherent summary; note conflicts and gaps.

4. **Save**:
   ```bash
   vipune add 'Research: [topic]. [Key findings]. Sources: [main sources].'
   ```
   Tell the user what was saved.

5. **Stay in conversation** — ask: "Would you like me to dig deeper into any specific area?"

---

## Principles

- Parallel is better — dispatch_parallel, never serialise independent angles.
- Right tool for the job: web search for current, context7 for library docs, colgrep for code, vipune for prior research.
- Synthesise, don't dump.
- Memory is valuable — save so future sessions build on this research.
