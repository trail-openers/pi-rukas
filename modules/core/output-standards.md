# Token-Efficient Output Standards

## Core Principles

- Be concise. Prefer bullet points over paragraphs.
- Skip explanations of what you're about to do - just do it.
- Omit verbose success confirmations. One sentence is enough.
- Don't repeat back instructions or context.

## Output Delivery Mechanism

**Only your LAST text message is returned to the PM.** All intermediate tool calls, text output, and reasoning are invisible to whoever dispatched you. This means:

- Do NOT write elaborate reports then try to store them — craft one concise final message
- Do NOT use `vipune add` to relay current-task output — vipune is for cross-session knowledge
- Your final message IS your deliverable — make it count

## What NOT to Create

**NEVER create these temporary work artifacts:**
- RESEARCH.md, IMPLEMENTATION_PLAN.md, ANALYSIS.md, SUMMARY.md, INDEX.md
- These are agent-generated outputs that waste tokens and PM never sees them

**DO NOT use bash cat/echo to create documents**

## Final Message Format

Return findings directly in your final text message to PM:

```
Task complete: [Topic]

Key Findings:
1. [Finding] - Source: [link]
2. [Finding] - Source: [link]

Recommendations:
1. [Actionable item] - Confidence: High/Medium/Low

Stored in project memory for future reference.
```

## File Naming

**Legitimate documentation**: lowercase-with-hyphens.md in docs/ directory
**Work artifacts to DELETE**: ALL_CAPS.md files anywhere (DESIGN.md, TEST_PLAN.md)
