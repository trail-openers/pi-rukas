# Rust Systems Programming Patterns

## Rust Mantras

- "The compiler is my pair programmer"
- "std before crates"
- "Stack before heap"
- "&str before String"
- "Move before borrow before Rc before Arc"
- "Safe before unsafe"
- "Sync before async"
- "Let the type system be your tests"

## Ownership Patterns

### Simple, Clear Ownership (Preferred)

```rust
// YES: Simple, clear ownership
fn process(data: Vec<u8>) -> String {
    String::from_utf8_lossy(&data).into_owned()
}

// NO: Unnecessary complexity with lifetimes when ownership suffices
fn process<'a, 'b>(data: &'a [u8]) -> Cow<'b, str> where 'a: 'b { ... }
```

**Guidance:**
- Move semantics first, borrow when measured as necessary
- Clone only when profiling proves it's not a bottleneck
- Store ownership patterns that avoided complexity

## Error Handling

### Simple and Explicit

```rust
// YES: Simple Result with clear error
fn parse(s: &str) -> Result<u32, ParseIntError> {
    s.parse()
}

// NO: Custom error types before they're needed
#[derive(Debug)]
enum MyError { Parse(ParseIntError), Io(IoError), ... }
```

**Guidance:**
- Use `Result<T, Box<dyn Error>>` until you need more
- `?` operator everywhere
- Store error patterns that stayed simple

## Async Guidance

```rust
// START: Try synchronous first
fn fetch_data() -> Result<String, Error> {
    std::fs::read_to_string("data.txt")
}

// ONLY IF NEEDED: Add async when proven necessary
async fn fetch_data() -> Result<String, Error> {
    tokio::fs::read_to_string("data.txt").await
}
```

**Decision Order:**
1. Blocking I/O is often sufficient
2. Single-threaded before multi-threaded
3. `std::thread` before async runtime
4. Research: "Can this be synchronous in Rust?"

## Dependencies - Std First

**ALWAYS check std library first:**
- `std::collections` not external data structures
- `std::sync` not parking_lot (unless benchmarked)
- `std::fs` not tokio::fs (unless async required)
- `std::process` not command crates

## Unsafe Guidance

```rust
// YES: Safe Rust even if "slower"
vec.get(index).copied().unwrap_or_default()

// NO: Unsafe for marginal gains
unsafe { *vec.get_unchecked(index) }
```

**Rules:**
- Profile before unsafe
- Document every unsafe block extensively
- Store patterns that avoided unsafe

## Dependency Decision Tree

```
Can std do this? → Check docs.rs/std → Use std
Is it <50 lines to implement? → Write those lines
Is it performance critical? → Benchmark first, then decide
Is it genuinely complex? → Research alternatives → MAYBE add crate
```

## Zero Test Failures Rule

**ALL tests must pass - ZERO failures allowed, NO exceptions.**

**FORBIDDEN rationalizations (instant quality gate FAILURE):**
- "Pre-existing issue, unrelated to this fix"
- "External library problem"
- "Integration test only, unit tests pass"
- "Known flaky test"
- "Will be fixed in separate PR"
- "Not caused by my changes"

## Debugging Workflow

1. **IMMEDIATE LOCAL INVESTIGATION**:
   ```bash
   cargo build
   cargo test
   cargo clippy -- -D warnings
   ```

2. **READ RUST'S EXCELLENT ERROR MESSAGES**:
   - Copy the EXACT error codes (E0597, E0308, etc.)
   - Note the helpful suggestions Rust provides
   - Check the error explanations with `rustc --explain E0597`

3. **ONLY USE PERPLEXITY FOR SPECIFIC ERRORS**:
   - BAD: "Rust lifetime problems"
   - GOOD: "Rust E0597 borrowed value does not live long enough in async block with [specific code]"

## Pre-Commit Quality Gates

**MANDATORY before ANY git delegation:**
- `cargo test` with coverage -- minimum 80% required
- Verify all tests pass -- zero failures allowed
- `cargo clippy -- -D warnings` -- zero warnings allowed
- `cargo fmt -- --check` -- must be formatted
- `cargo doc --no-deps` -- docs must build
- Check Cargo.lock for unnecessary dependencies
- Verify no unnecessary unsafe blocks

## Framework Preferences

When working with common Rust ecosystems, prefer minimal approaches:
- **Web**: actix-web or axum (both minimal), avoid complex middleware stacks
- **CLI**: clap only if needed, `std::env::args()` first
- **Serialization**: serde only when necessary, manual parsing first
- **Async**: tokio only when proven necessary, `std::thread` first
- **Database**: raw SQL before ORMs
