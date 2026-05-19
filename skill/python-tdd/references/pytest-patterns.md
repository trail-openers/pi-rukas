# Pytest Patterns and Best Practices

## Test Discovery

Pytest discovers tests in:
- Files: `test_*.py` or `*_test.py`
- Classes: `Test*` (no `__init__`)
- Functions: `test_*`

## Fixture Patterns

### Basic Fixtures

```python
import pytest

@pytest.fixture
def sample_user():
    return {"id": 1, "name": "Test User", "email": "test@example.com"}

@pytest.fixture
def db_session():
    session = create_session()
    yield session
    session.rollback()
    session.close()
```

### Fixture Scopes

```python
@pytest.fixture(scope="function")  # Default: new instance per test
@pytest.fixture(scope="class")     # One per test class
@pytest.fixture(scope="module")    # One per module
@pytest.fixture(scope="session")   # One per test session
```

### Factory Fixtures

```python
@pytest.fixture
def make_user():
    def _make_user(name="Test", email=None):
        email = email or f"{name.lower()}@example.com"
        return User(name=name, email=email)
    return _make_user

def test_user_creation(make_user):
    user = make_user(name="Alice")
    assert user.email == "alice@example.com"
```

## Parametrization

```python
@pytest.mark.parametrize("input,expected", [
    (1, 2),
    (2, 4),
    (3, 6),
])
def test_double(input, expected):
    assert double(input) == expected

# Multiple parameters
@pytest.mark.parametrize("x", [1, 2])
@pytest.mark.parametrize("y", [3, 4])
def test_multiply(x, y):  # Runs 4 times: (1,3), (1,4), (2,3), (2,4)
    assert multiply(x, y) == x * y
```

## Markers

```python
# pytest.ini or pyproject.toml
[tool.pytest.ini_options]
markers = [
    "slow: marks tests as slow",
    "integration: marks integration tests",
    "unit: marks unit tests",
]

# Usage
@pytest.mark.slow
def test_slow_operation():
    pass

@pytest.mark.integration
def test_database_connection():
    pass

# Run specific markers
# pytest -m "not slow"
# pytest -m "unit"
```

## Exception Testing

```python
def test_raises_value_error():
    with pytest.raises(ValueError) as exc_info:
        raise ValueError("invalid value")
    assert "invalid" in str(exc_info.value)

def test_raises_with_match():
    with pytest.raises(ValueError, match=r"invalid.*value"):
        raise ValueError("invalid value provided")
```

## Mocking

```python
from unittest.mock import Mock, patch, MagicMock

def test_with_mock():
    mock_api = Mock()
    mock_api.get_user.return_value = {"id": 1}

    result = process_user(mock_api)
    mock_api.get_user.assert_called_once()

@patch("module.external_api")
def test_with_patch(mock_api):
    mock_api.fetch.return_value = {"data": "test"}
    result = my_function()
    assert result == "test"

# Context manager
def test_with_context_patch():
    with patch("module.function") as mock_func:
        mock_func.return_value = 42
        assert my_code() == 42
```

## Async Testing

```python
import pytest

@pytest.mark.asyncio
async def test_async_function():
    result = await async_operation()
    assert result == expected

# Async fixture
@pytest.fixture
async def async_client():
    async with AsyncClient() as client:
        yield client
```

## Coverage Configuration

```toml
# pyproject.toml
[tool.coverage.run]
source = ["src"]
branch = true
omit = ["*/tests/*", "*/__pycache__/*"]

[tool.coverage.report]
exclude_lines = [
    "pragma: no cover",
    "if TYPE_CHECKING:",
    "raise NotImplementedError",
]
fail_under = 80
```

## Running Tests

```bash
# Basic
pytest

# Verbose with coverage
pytest -v --cov=src --cov-report=term-missing

# Parallel execution
pytest -n auto  # requires pytest-xdist

# Fail fast
pytest -x  # Stop on first failure
pytest --maxfail=3  # Stop after 3 failures

# Run specific tests
pytest tests/test_module.py::test_function
pytest -k "test_user"  # Pattern matching
```
