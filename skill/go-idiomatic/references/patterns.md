# Go Idiomatic Programming Patterns

## Go Proverbs (The North Star)

1. "Clear is better than clever"
2. "Don't communicate by sharing memory; share memory by communicating"
3. "Concurrency is not parallelism"
4. "The bigger the interface, the weaker the abstraction"
5. "Make the zero value useful"
6. "interface{} says nothing"
7. "Gofmt's style is no one's favorite, yet gofmt is everyone's favorite"
8. "A little copying is better than a little dependency"
9. "Syscall must always be guarded with build tags"
10. "Cgo must always be guarded with build tags"
11. "Cgo is not Go"
12. "With the unsafe package there are no guarantees"
13. "Reflection is never clear"
14. "Errors are values"
15. "Don't just check errors, handle them gracefully"
16. "Design the architecture, name the components, document the details"
17. "Documentation is for users"

## Go Mantras (2025)

- "Clear is better than clever"
- "Stdlib before packages"
- "Small interfaces, big possibilities"
- "Errors are values, handle them gracefully"
- "A little copying is better than a little dependency"
- "Make the zero value useful"
- "Channels for coordination, mutexes for state"
- "Accept interfaces, return structs"
- "Gofmt is law"

## Interface Patterns

### Small and Focused (Preferred)

```go
// YES: Small, focused interface
type Writer interface {
    Write([]byte) (int, error)
}

// NO: Large interface with many methods
type Repository interface {
    GetUser(id int) (*User, error)
    CreateUser(u *User) error
    UpdateUser(u *User) error
    DeleteUser(id int) error
    ListUsers() ([]*User, error)
}

// BETTER: Small interfaces composed as needed
type UserGetter interface {
    GetUser(id int) (*User, error)
}
```

**Rules:**
- Accept interfaces, return structs
- Define interfaces where they're used, not where types are defined
- 1-3 methods is ideal (io.Reader/io.Writer are perfect examples)

## Error Handling

### Explicit and Clear

```go
// YES: Clear error handling with context
if err := doSomething(); err != nil {
    return fmt.Errorf("do something: %w", err)
}

// YES: Sentinel errors for control flow
var ErrNotFound = errors.New("not found")

// NO: Generic error returns
return errors.New("error")

// NO: Ignoring errors
_ = doSomething()
```

**Rules:**
- Wrap errors with `fmt.Errorf` and `%w` for context
- Use `errors.Is()` and `errors.As()` for error checking (Go 1.13+)
- Define sentinel errors at package level

## Concurrency Patterns

### Channels for Coordination

```go
// Use channels to orchestrate
func process(ctx context.Context, items <-chan Item) <-chan Result {
    results := make(chan Result)
    go func() {
        defer close(results)
        for item := range items {
            select {
            case <-ctx.Done():
                return
            case results <- processItem(item):
            }
        }
    }()
    return results
}

// Use sync.Mutex to protect state
type SafeCounter struct {
    mu    sync.Mutex
    count int
}
```

**Rules:**
- Context for cancellation
- `select` for non-blocking operations
- Close channels to signal completion
- Channels for orchestration, mutexes for state protection

## Struct Design

### Make Zero Value Useful

```go
// YES: Zero value is useful
type Buffer struct {
    buf []byte  // nil slice is fine
}

func (b *Buffer) Write(p []byte) (int, error) {
    b.buf = append(b.buf, p...)  // works with nil
    return len(p), nil
}

// YES: Clear initialization when needed
func NewClient(url string) *Client {
    return &Client{
        URL:        url,
        HTTPClient: &http.Client{Timeout: 10 * time.Second},
    }
}
```

## Dependency Decision Tree

```
Can stdlib do this? → Check pkg.go.dev/std → Use stdlib
Is it <100 lines to implement? → Write those lines
Is copying better than dependency? → Copy and adapt
Is it genuinely complex? → Research alternatives → MAYBE add package
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
   go test -v ./...
   go build ./...
   go vet ./...
   golangci-lint run
   ```

2. **READ GO'S CLEAR ERROR MESSAGES**:
   - Copy the EXACT error message
   - Note the file and line number
   - Check the immediate context

3. **ONLY USE PERPLEXITY FOR SPECIFIC ERRORS**:
   - BAD: "Go error handling"
   - GOOD: "Go 'cannot use X as Y in return statement' with [specific code context]"

## Pre-Commit Quality Gates

**MANDATORY before ANY git delegation:**
- `go test -v -race -cover ./...` -- minimum 80% coverage required
- Verify all tests pass -- zero failures allowed
- `gofmt -s -w .` -- code must be formatted
- `go vet ./...` -- zero warnings allowed
- `golangci-lint run` (if project uses it) -- zero warnings allowed
- `go mod tidy` -- dependencies must be clean
- Check for goroutine leaks in tests
- Verify no unnecessary external dependencies

## Go 1.24.x Features to Leverage

- Generics for type-safe collections (but sparingly)
- Improved error handling with `errors.Join()`
- Range over func iterators (Go 1.23+)
- Improved type inference
- Enhanced standard library additions

## Anti-Patterns to Avoid

- God packages with everything
- Large interfaces (>3 methods without good reason)
- Panic for error handling (except truly unrecoverable)
- Reflection unless absolutely necessary
- Global mutable state
- Ignoring errors (`_ = err`)
- Context in structs (pass as first param to methods)
- Premature optimization
- Using `interface{}` instead of `any` (Go 1.18+)

## Framework Preferences

When working with common Go ecosystems, prefer minimal approaches:
- **Web**: net/http with simple middleware, avoid heavy frameworks unless required
- **CLI**: flag package first, cobra/viper only when proven necessary
- **Testing**: testing package, testify assertions only if project uses it
- **Database**: database/sql with pgx/mysql drivers, avoid ORMs unless required
- **Logging**: slog (Go 1.21+) for structured logging
- **Configuration**: Standard library or simple envconfig
