# Python Linting and Type Checking Configuration

## Ruff (Recommended - All-in-One)

Ruff replaces flake8, isort, black, and many other tools.

### pyproject.toml Configuration

```toml
[tool.ruff]
target-version = "py311"
line-length = 88
src = ["src"]

[tool.ruff.lint]
select = [
    "E",     # pycodestyle errors
    "W",     # pycodestyle warnings
    "F",     # Pyflakes
    "I",     # isort
    "B",     # flake8-bugbear
    "C4",    # flake8-comprehensions
    "UP",    # pyupgrade
    "ARG",   # flake8-unused-arguments
    "SIM",   # flake8-simplify
    "TCH",   # flake8-type-checking
    "PTH",   # flake8-use-pathlib
    "ERA",   # eradicate (commented code)
    "PL",    # pylint
    "RUF",   # Ruff-specific
]
ignore = [
    "E501",  # line too long (handled by formatter)
    "PLR0913",  # too many arguments
]

[tool.ruff.lint.per-file-ignores]
"tests/**/*.py" = ["S101"]  # Allow assert in tests

[tool.ruff.format]
quote-style = "double"
indent-style = "space"
docstring-code-format = true
```

### Running Ruff

```bash
# Check for issues
ruff check .

# Auto-fix issues
ruff check --fix .

# Check formatting
ruff format --check .

# Format code
ruff format .
```

## Mypy (Type Checking)

### pyproject.toml Configuration

```toml
[tool.mypy]
python_version = "3.11"
strict = true
warn_return_any = true
warn_unused_configs = true
disallow_untyped_defs = true
disallow_incomplete_defs = true
check_untyped_defs = true
disallow_untyped_decorators = true
no_implicit_optional = true
warn_redundant_casts = true
warn_unused_ignores = true
warn_no_return = true
warn_unreachable = true

[[tool.mypy.overrides]]
module = "tests.*"
disallow_untyped_defs = false

[[tool.mypy.overrides]]
module = [
    "third_party_lib.*",
]
ignore_missing_imports = true
```

### Running Mypy

```bash
# Full check
mypy src/

# With specific config
mypy --config-file pyproject.toml src/

# Show error codes
mypy --show-error-codes src/
```

### Common Type Patterns

```python
from typing import Optional, Union, List, Dict, Callable, TypeVar, Generic

# Optional (can be None)
def get_user(id: int) -> Optional[User]:
    ...

# Union types
def process(data: Union[str, bytes]) -> str:
    ...

# Python 3.10+ syntax
def process(data: str | bytes) -> str:
    ...

# Callable
def apply(fn: Callable[[int], int], value: int) -> int:
    return fn(value)

# TypeVar for generics
T = TypeVar("T")
def first(items: List[T]) -> Optional[T]:
    return items[0] if items else None

# TypedDict
from typing import TypedDict

class UserDict(TypedDict):
    id: int
    name: str
    email: str
```

## Black (If Not Using Ruff Format)

```toml
[tool.black]
line-length = 88
target-version = ['py311']
include = '\.pyi?$'
exclude = '''
/(
    \.git
    | \.mypy_cache
    | \.venv
    | build
    | dist
)/
'''
```

## isort (If Not Using Ruff)

```toml
[tool.isort]
profile = "black"
line_length = 88
known_first_party = ["mypackage"]
skip_gitignore = true
```

## Pre-commit Configuration

```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/astral-sh/ruff-pre-commit
    rev: v0.4.4
    hooks:
      - id: ruff
        args: [--fix]
      - id: ruff-format

  - repo: https://github.com/pre-commit/mirrors-mypy
    rev: v1.10.0
    hooks:
      - id: mypy
        additional_dependencies: [types-requests]
```

## Quality Gate Commands

Run these before any git operations:

```bash
# All checks
ruff check . && ruff format --check . && mypy src/ && pytest --cov=src --cov-fail-under=80

# Or with make
make lint  # if Makefile exists
```
