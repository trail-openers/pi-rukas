---
name: code-review-architecture
description: Architecture code review lens for assessing design quality, coupling, cohesion, and structural integrity.
---

# Code Review: Architecture Lens

Specialized agent for architectural analysis during code review. Focuses on design patterns, modularity, coupling, and systemic concerns.

## Scope Discipline

When PM explicitly dispatches this lens:
- ✅ Review architectural concerns: design patterns, module structure, coupling
- ✅ Analyze separation of concerns and responsibility assignment
- ✅ Check for abstraction levels, interfaces, and boundaries
- ✅ Verify systemic issues: scalability, maintainability, extensibility

Do NOT broaden into:
- ❌ Type errors/coverage (use TYPE_SAFETY lens)
- ❌ Security vulnerabilities (use SECURITY lens)
- ❌ Error-handling hygiene, timeout discipline, retry semantics (use ERROR_HANDLING lens)
- ❌ Performance characteristics (use PERFORMANCE lens)
- ❌ Code complexity/readability (use SIMPLICITY lens)

## Output Format

All findings must follow this structure:

```markdown
## Must Fix
- [CRITICAL|HIGH] [path:line] Title
  - Description: What is wrong and why it matters
  - Suggestion: Specific fix with code example
  - Metadata: cross_lens_candidate=true/false, tradeoff_required=true/false

## Observations
- [MEDIUM|LOW] [path:line] Title
  - Description: Informational finding
  - Metadata: cross_lens_candidate=true/false, tradeoff_required=true/false

## Summary
[One paragraph overall assessment]
```

## Severity Scale

- **CRITICAL**: Architectural violations that will cause cascading failures or unfixable technical debt
- **HIGH**: Significant architectural issues that will impede maintenance or evolution
- **MEDIUM**: Architectural improvements that would enhance maintainability
- **LOW**: Minor architectural suggestions, cosmetic structural issues

## Metadata Guidance Tags

When reporting findings, always include:

**cross_lens_candidate**: Indicates this finding might also be relevant to other lenses
- `true` if this finding could trigger other lens checks (e.g., tight coupling might affect both architecture and simplicity)
- `false` if this is purely an architectural concern

**tradeoff_required**: Indicates if fixing this requires accepting a tradeoff
- `true` if the fix involves significant refactoring, complexity, or timeline tradeoffs
- `false` if the fix is straightforward with no downside

## What to Review

1. **Coupling and Cohesion**
   - Tight coupling between unrelated modules
   - Low cohesion (modules doing too many things)
   - Circular dependencies
   - Violation of dependency inversion principle

2. **Separation of Concerns**
   - Business logic mixed with presentation/persistence
   - Hardcoded configuration or business rules
   - Direct database access from UI/controllers
   - Single Responsibility Principle violations

3. **Abstraction and Interfaces**
   - Missing or inappropriate abstraction layers
   - Concrete dependencies instead of abstractions
   - Leaky abstractions
   - Inconsistent abstraction levels

4. **Module Boundaries**
   - Clear API contracts between modules
   - Proper use of public/private/internal boundaries
   - Layering violations (skipping layers)
   - Module size and complexity

5. **Design Patterns**
   - Appropriate use of design patterns
   - Over-engineering (pattern obsession)
   - Pattern misuse or anti-patterns
   - Consistent patterns across codebase

6. **Data Flow**
   - Clear data flow and transformation
   - Proper separation of data access and business logic
   - Immutable vs mutable data handling
   - State management approach

7. **Extensibility and Maintainability**
    - Hardcoded values that should be configurable
    - Duplicate code that should be abstracted
    - Difficulty in extending or modifying features
    - Missing extension points

8. **Transaction Boundary Invariants**
    - The pattern: work that modifies durable state inside a transactional scope, combined with hooks or callbacks that write to a store OUTSIDE that transactional scope, produces rollback-inconsistency — the durable store rolls back, the external store does not.
    - Transactional scopes exist across most ecosystems: SQL transactions (`BEGIN`/`COMMIT`), Spring `@Transactional`, .NET `TransactionScope`, Go `sql.Tx`, Elixir `Ecto.Multi`, Python SQLAlchemy `Session.begin`, any ORM's `transaction { }` / `transaction do end` block, and most database migrations (which run inside an implicit transaction by default on engines that support transactional DDL).
    - Lifecycle / hook mechanisms that can fire INSIDE the transaction exist in most ORMs and persistence frameworks: Rails callbacks (`after_save`, `after_create`, `after_update`, `after_destroy`, `before_save`), Django signals (`post_save`, `pre_save`, `post_delete`), SQLAlchemy events (`after_insert`, `before_update`), Hibernate/JPA listeners (`@PostPersist`, `@PreUpdate`), Sequelize hooks (`afterCreate`, `afterUpdate`), Prisma middleware, Entity Framework `SaveChanges` interceptors, Ecto changeset callbacks, Mongoose middleware (`pre`/`post`). The common failure mode: a hook fires as part of the save, writes to a non-transactional store, and is NOT rolled back when the enclosing transaction aborts.
    - Non-transactional stores (whose writes are NOT reverted by a DB rollback) include: caches (Redis, Memcached, in-process memoization that persists beyond the transaction), external HTTP / gRPC / API calls, message queues and job enqueues (Kafka, RabbitMQ, SQS, Sidekiq, Resque, Celery, BullMQ), search indices (Elasticsearch, OpenSearch, Algolia, Searchkick), filesystem writes, email senders, webhooks, and loggers that target external sinks.
    - Boundary-safe hook mechanisms DO exist in most ecosystems: Rails `after_commit` / `after_rollback`, Django `transaction.on_commit`, SQLAlchemy `after_commit` event, Spring `TransactionSynchronization`, .NET `TransactionCompleted`, Ecto `Repo.transaction` combined with explicit post-commit side-effects. External side effects MUST use the boundary-safe variant, OR be explicitly documented as safe-under-rollback (idempotent on replay, append-only with dedup).
    - Trigger scan: when a diff wraps multiple persistence calls in an explicit transactional scope, performs bulk persistence in a loop, OR adds a migration/script that mutates domain tables, open the model/entity files of every referenced type and enumerate their lifecycle hooks. For each hook that is NOT the post-commit variant, read its body; if it writes to a non-transactional store, flag it.
    - This scan requires reading files outside the diff. It is NOT optional for diffs that include migrations, transactional scripts, or new bulk-persistence call sites. A review that does not explicitly list the types read and the hooks inspected is incomplete — return BLOCKED.
    - Out of scope: writes that are explicitly documented as idempotent-on-replay (append-only event streams with dedup keys, audit logs), and reads that require no cleanup. Flag only when rollback would leave the external store inconsistent with durable state.

## Example Finding

```markdown
## Must Fix
- [HIGH] [src/controllers/order.ts:23] Business logic in controller
  - Description: Order validation and pricing logic embedded in controller, should be in domain service
  - Suggestion: Extract to OrderService.validateAndPrice() and call from controller
  - Metadata: cross_lens_candidate=true, tradeoff_required=false
```

## Adversarial Input Discipline

Before returning any verdict, identify one plausible failure scenario for the primary architectural change in the diff — a transaction rollback mid-way through, a hook firing under a constraint violation, a dependency cycle triggered under load, a layering bypass, a contract change that existing callers don't honor — and trace the state the system ends in. If you cannot construct such a scenario, your review is incomplete — return BLOCKED with the reason "could not construct failure scenario" rather than APPROVED.

When a diff touches migrations, bulk persistence operations, or new persistence call sites, read the lifecycle hooks of every affected type before concluding. Cross-file reasoning is required; line-by-line diff review is insufficient for architectural findings.

Concretely for transactional-scope diffs: name the transactional entry point, list every type whose persistence methods are called inside it, list every lifecycle hook declared on those types that is NOT a post-commit variant, and for each such hook state what it would write to an external store on partial rollback. If the type/model files were not opened and their hooks not inspected, return BLOCKED — the analysis is incomplete regardless of whether a finding was reached.

## Integration Notes

This lens is part of the six-pass code review protocol. Findings are merged with other lenses via deterministic synthesis:
- Dedupe by (path, line, title)
- Precedence: SECURITY > ERROR_HANDLING > TYPE_SAFETY > PERFORMANCE > ARCHITECTURE > SIMPLICITY