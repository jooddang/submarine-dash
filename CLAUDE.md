

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.




# Software Engineering Principles — Do’s & Don’ts

> Reusable reference for LLM coding agents (e.g. CLAUDE.md).
> Distilled from Clean Code, Code Complete, TDD, SOLID, Pragmatic Programmer, and industry-proven practices.
> Every rule is **actionable** — abstract platitudes are excluded by design.

-----

## 1. Naming

### Do

- Name variables, functions, and classes to reveal **intent**. A reader should understand *what* and *why* without reading the implementation.
  
  ```python
  # good
  elapsed_days_since_last_login = 30
  def calculate_monthly_revenue(transactions): ...
  
  # bad
  d = 30
  def calc(t): ...
  ```
- Use **domain vocabulary** consistently. If the business calls it an “Order”, don’t rename it “Purchase” in code.
- Name booleans as predicates: `is_active`, `has_permission`, `can_retry`.
- Name functions as **verb + noun**: `fetch_user()`, `validate_input()`, `send_notification()`.
- Use searchable names. Avoid single-letter variables except for trivial loop indices (`i`, `j`).

### Don’t

- Don’t use abbreviations or acronyms that aren’t universally understood in your domain.
- Don’t encode type information into names (Hungarian notation): ~`strName`~, ~`iCount`~.
- Don’t use `data`, `info`, `temp`, `result`, `value` as standalone names — they convey nothing.
- Don’t use names that differ only by case or by a single character: `user` vs `users` vs `userList`.
- Don’t prefix interfaces with `I` or abstract classes with `Abstract` unless it’s an established convention in your stack.

-----

## 2. Functions & Methods

### Do

- **One function, one job.** If you can’t describe what a function does without using “and”, split it.
- Keep functions **short** — aim for under 20 lines. Extract when you feel the urge to comment a block.
- Limit arguments to **3 or fewer**. Group related parameters into an object/struct if more are needed.
  
  ```typescript
  // good
  function createUser(config: CreateUserConfig): User
  
  // bad
  function createUser(name: string, email: string, age: number, role: string, team: string): User
  ```
- Return **early** for edge cases; avoid deep nesting.
  
  ```python
  def process(order):
      if not order:
          return None
      if order.is_cancelled:
          return refund(order)
      # main logic at base indentation
  ```
- Maintain a **single level of abstraction** per function. Don’t mix high-level orchestration with low-level details.
- Make functions **pure** where possible — same inputs always produce same outputs, no side effects. Isolate impure code (I/O, state mutation) at the boundary.

### Don’t

- Don’t use boolean flags as function parameters — they signal the function does two things.
  
  ```python
  # bad
  def create_user(name, is_admin=False): ...
  
  # good — separate functions
  def create_user(name): ...
  def create_admin(name): ...
  ```
- Don’t use output parameters. Return values instead.
- Don’t let functions silently swallow errors or return `None`/`null` when a clear failure occurred.
- Don’t write functions that require the caller to understand internal implementation details.

-----

## 3. Error Handling

### Do

- Use **exceptions for exceptional situations**, return values for expected outcomes.
- Fail **fast and loud**. The closer an error is caught to its source, the easier it is to debug.
- Create **domain-specific error types** that carry context.
  
  ```python
  class InsufficientBalanceError(DomainError):
      def __init__(self, account_id: str, requested: Decimal, available: Decimal):
          self.account_id = account_id
          self.requested = requested
          self.available = available
          super().__init__(
              f"Account {account_id}: requested {requested}, available {available}"
          )
  ```
- Handle errors at the **appropriate level**. Low-level code raises; high-level code decides recovery strategy.
- Log errors with sufficient context: **what happened, what was the input, what was the expected outcome**.
- Use the **Result pattern** (e.g., `Result<T, E>` in Rust, or equivalent) when failure is a normal control flow, not an exception.

### Don’t

- Don’t catch generic `Exception` / `Error` unless you’re at the top-level boundary (e.g., HTTP handler, main loop).
- Don’t use `try/catch` as flow control for expected conditions.
- Don’t return error codes mixed with data (e.g., returning `-1` from a function that normally returns a positive integer).
- Don’t log and rethrow the same error — it creates duplicate noise.
- Don’t ignore caught exceptions with empty catch blocks. At minimum, log with context.
- Don’t expose internal error details (stack traces, DB queries) to end users.

-----

## 4. Testing & TDD

### Do

- Follow the **Red → Green → Refactor** cycle:
1. Write a failing test that defines the expected behavior.
1. Write the minimum code to make it pass.
1. Refactor while keeping tests green.
- Write tests that are **FIRST**: Fast, Independent, Repeatable, Self-validating, Timely.
- **One assertion per test** (conceptually). A test should verify one behavior.
  
  ```python
  # good — clear what broke
  def test_user_creation_sets_default_role():
      user = create_user("alice")
      assert user.role == Role.MEMBER
  
  def test_user_creation_sets_created_timestamp():
      user = create_user("alice")
      assert user.created_at is not None
  ```
- Name tests as **behavior specifications**: `test_<unit>_<scenario>_<expected>` or `should <do something> when <condition>`.
- Use the **Arrange → Act → Assert** (or Given → When → Then) structure in every test.
- Maintain the **test pyramid**: many unit tests, fewer integration tests, minimal E2E tests.
- Test **edge cases**: empty inputs, nulls, boundary values, overflow, concurrency, timeouts.
- Treat test code with the **same quality standards** as production code — clean, readable, maintainable.
- Use **test doubles** intentionally: stubs for inputs, mocks for verifying interactions, fakes for complex dependencies.

### Don’t

- Don’t test implementation details. Test **behavior and outcomes**, not how they’re achieved.
  
  ```python
  # bad — coupled to implementation
  def test_user_service_calls_repository_save():
      mock_repo.save.assert_called_once()
  
  # good — tests observable behavior
  def test_created_user_can_be_retrieved():
      create_user("alice")
      user = get_user("alice")
      assert user.name == "alice"
  ```
- Don’t write tests that depend on other tests’ execution order.
- Don’t use production data or external services in unit tests.
- Don’t skip tests to make CI pass. Fix or delete them.
- Don’t aim for 100% coverage as a goal — aim for **meaningful** coverage of critical paths and edge cases.
- Don’t mock everything. Over-mocking makes tests brittle and meaningless.

-----

## 5. SOLID Principles

### Single Responsibility (SRP)

**Do**: Each module/class has one reason to change. If a class handles both user validation and email sending, split it.

**Don’t**: Create “God classes” or “Manager” / “Handler” / “Processor” classes that accumulate unrelated responsibilities.

### Open/Closed (OCP)

**Do**: Design modules to be extended via new code (new implementations, new strategies) without modifying existing code.

**Don’t**: Use long `if/elif/else` or `switch` chains to handle types. Use polymorphism or a strategy pattern instead.

### Liskov Substitution (LSP)

**Do**: Subtypes must be usable wherever their parent type is expected without breaking correctness.

**Don’t**: Override a method in a way that violates the parent’s contract (e.g., a `ReadOnlyFile` subclass of `File` that throws on `write()`).

### Interface Segregation (ISP)

**Do**: Prefer **small, focused interfaces**. A client should not be forced to depend on methods it doesn’t use.

**Don’t**: Create fat interfaces with 15+ methods that force implementers to stub out half of them.

### Dependency Inversion (DIP)

**Do**: High-level modules depend on abstractions, not concrete implementations. Inject dependencies.

```python
# good — depends on abstraction
class OrderService:
    def __init__(self, repository: OrderRepository, notifier: Notifier):
        self.repository = repository
        self.notifier = notifier
```

**Don’t**: Instantiate dependencies inside constructors. Don’t `import` and directly call concrete implementations from business logic.

-----

## 6. Code Organization & Architecture

### Do

- Follow a **consistent directory structure** documented at the project root.
- Separate **concerns by layer**: presentation, business logic, data access.
- Keep **business logic framework-agnostic**. Business rules should not import HTTP libraries, ORM decorators, or UI frameworks.
- Colocate related code. Files that change together should live together.
- Use **dependency injection** at application boundaries to wire things together.
- Apply the **Strangler Fig pattern** for incremental refactors of legacy code — wrap and replace, don’t rewrite.

### Don’t

- Don’t create deeply nested folder hierarchies (>3 levels) without clear justification.
- Don’t spread a single feature across 8+ files in different directories if they’re always edited together.
- Don’t introduce architectural patterns (microservices, event sourcing, CQRS) before the complexity demands it. **YAGNI** (You Aren’t Gonna Need It).
- Don’t let infrastructure concerns leak into domain logic (e.g., SQL queries in a service class, HTTP status codes in business logic).
- Don’t create circular dependencies between modules.

-----

## 7. Comments & Documentation

### Do

- Write code that **doesn’t need comments** — clear names and structure are the primary documentation.
- Use comments to explain **why**, never **what**. If you feel the need to explain what code does, refactor the code instead.
  
  ```python
  # bad — explains what
  # increment counter by one
  counter += 1
  
  # good — explains why
  # Reset rate limiter window after the grace period
  # to avoid penalizing users for transient spikes
  counter = 0
  ```
- Document **public APIs** with docstrings: parameters, return types, exceptions, and usage examples.
- Maintain a project-level `README.md` with: what it is, how to set up, how to run, how to test.
- Use `TODO` / `FIXME` / `HACK` with a brief explanation and ideally a ticket reference.

### Don’t

- Don’t write comments that restate the code in English.
- Don’t leave commented-out code. Use version control.
- Don’t write Javadoc-style comments on every private method — they become stale and misleading.
- Don’t maintain external documentation that duplicates code. Single source of truth.

-----

## 8. Version Control & Commits

### Do

- Write **atomic commits** — each commit is a single logical change that compiles and passes tests.
- Use **conventional commits**: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`.
- Write commit messages as imperative present tense: “Add user validation” not “Added user validation”.
- Keep the subject line **under 72 characters**. Use the body for context and reasoning.
- Commit **frequently**. Small, incremental commits are easier to review, bisect, and revert.

### Don’t

- Don’t commit generated files, build artifacts, secrets, or environment-specific config.
- Don’t make “WIP” or “fix stuff” commits to shared branches.
- Don’t squash meaningful history into a single commit without reason.
- Don’t commit code that doesn’t compile or breaks existing tests.

-----

## 9. Dependencies & Third-Party Code

### Do

- Pin dependency versions for reproducible builds.
- Wrap third-party libraries behind your own **adapter/interface**. You should be able to swap any dependency without touching business logic.
- Evaluate dependencies critically: maintenance status, license, transitive dependency count, security track record.
- Keep dependencies **up to date** with a regular cadence (e.g., weekly automated PRs via Dependabot/Renovate).

### Don’t

- Don’t add a dependency for trivial functionality you can implement in a few lines.
- Don’t add a new dependency without checking if an existing one already covers the use case.
- Don’t use unmaintained or single-maintainer libraries for critical paths without a mitigation plan.
- Don’t commit `node_modules`, `venv`, or other dependency directories.

-----

## 10. Security Fundamentals

### Do

- **Validate all inputs** at the boundary: type, length, format, range.
- Use **parameterized queries** for all database operations. No string concatenation for SQL.
- Apply the **principle of least privilege**: every module, user, and service gets the minimum access required.
- Store secrets in environment variables or a secrets manager — never in code or config files.
- Sanitize outputs to prevent XSS, especially user-generated content rendered in HTML.
- Use established libraries for authentication, encryption, and hashing — never roll your own crypto.

### Don’t

- Don’t trust client-side validation as the sole defense. Always validate server-side.
- Don’t log sensitive data: passwords, tokens, PII, credit card numbers.
- Don’t expose detailed error messages or stack traces to external users.
- Don’t use hard-coded secrets, even “temporarily”.
- Don’t disable security features (CORS, CSRF, HTTPS) for convenience during development and forget to re-enable them.

-----

## 11. Performance & Optimization

### Do

- **Measure before optimizing.** Use profiling tools to identify actual bottlenecks.
- Choose the right **data structures and algorithms** first — this is the highest-leverage optimization.
- Design for **O(n) or better** in hot paths. Know the Big-O of your collections’ operations.
- Use caching **intentionally** with clear invalidation strategies.
- Write **database queries efficiently**: use indexes, avoid N+1 queries, limit result sets.
- Set timeouts on all external calls (HTTP, DB, message queues).

### Don’t

- Don’t optimize prematurely. Make it **correct**, then make it **clear**, then make it **fast** — in that order.
- Don’t micro-optimize code that runs once at startup while ignoring code that runs per-request.
- Don’t add caching without understanding the invalidation model — stale caches cause subtle bugs.
- Don’t ignore algorithmic complexity by throwing hardware at the problem.

-----

## 12. Concurrency & Async

### Do

- Prefer **immutable data** in concurrent contexts. Immutability eliminates a whole class of race conditions.
- Use language-provided concurrency primitives (channels, async/await, actors) over raw threads and locks.
- Design for **idempotency** in distributed systems — operations should be safe to retry.
- Use **timeouts and circuit breakers** for all external dependencies.

### Don’t

- Don’t share mutable state across threads without synchronization.
- Don’t use `sleep()` as a synchronization mechanism.
- Don’t nest locks — it invites deadlocks.
- Don’t fire-and-forget async operations without error handling.

-----

## 13. Code Smells — Red Flags to Fix Immediately

|Smell                     |What It Looks Like                                      |What To Do                                       |
|--------------------------|--------------------------------------------------------|-------------------------------------------------|
|**Long method**           |>30 lines, multiple levels of indentation               |Extract methods by responsibility                |
|**Large class**           |>300 lines, >10 methods                                 |Split by SRP                                     |
|**Primitive obsession**   |Passing `str`, `int` everywhere instead of domain types |Create value objects: `Email`, `Money`, `UserId` |
|**Feature envy**          |Method uses another class’s data more than its own      |Move the method to the class it envies           |
|**Shotgun surgery**       |One change requires edits in 5+ files                   |Consolidate related logic                        |
|**God object**            |One class/module that knows and does everything         |Decompose by domain boundary                     |
|**Magic numbers/strings** |`if status == 3`, `timeout = 86400`                     |Extract to named constants                       |
|**Deep nesting**          |4+ levels of `if/for/while`                             |Use early returns, extract functions             |
|**Dead code**             |Unreachable code, unused variables, commented-out blocks|Delete it. Version control remembers.            |
|**Copy-paste duplication**|Same logic in 2+ places with slight variations          |Extract shared function, parameterize differences|
|**Boolean blindness**     |`process(data, true, false, true)`                      |Use enums, named parameters, or config objects   |
|**Speculative generality**|Abstractions for hypothetical future use cases          |Delete until actually needed (YAGNI)             |

-----

## 14. Defensive Programming

### Do

- Validate **preconditions** at function entry for public APIs.
- Use **assertions** for conditions that should never be false (invariant checks during development).
- Apply the **Fail-Fast** principle: detect errors early, report immediately, halt if state is corrupt.
- Default to **deny** — whitelist acceptable inputs rather than blacklisting known bad ones.
- Handle the “impossible” case in `switch/match` — it often becomes possible during maintenance.

### Don’t

- Don’t rely on caller discipline. If a function can be misused, it will be.
- Don’t use assertions for runtime error handling in production — they can be disabled.
- Don’t silently coerce bad data into “close enough” values. Reject clearly.

-----

## 15. Refactoring

### Do

- Refactor **continuously** in small steps, not in large “refactoring sprints.”
- Refactor **under test coverage**. Never refactor code that isn’t tested — write tests first.
- Apply the **Boy Scout Rule**: leave code cleaner than you found it, even if the improvement is small.
- Use automated refactoring tools in your IDE when available — they’re safer than manual edits.
- Refactor when you find **duplication**, **unclear intent**, or **difficult-to-test structure**.

### Don’t

- Don’t refactor and change behavior at the same time. Refactoring = same behavior, better structure.
- Don’t refactor code you don’t understand. Read and understand first.
- Don’t rename or restructure across the entire codebase at once without a clear migration plan.

-----

## 16. API Design

### Do

- Design APIs from the **consumer’s perspective** first. Write the calling code before the implementation.
- Make APIs **hard to misuse**: use types to enforce constraints, make invalid states unrepresentable.
  
  ```typescript
  // bad — easy to pass arguments in wrong order
  function createRange(start: number, end: number): Range
  
  // better — impossible to misuse
  function createRange(config: { start: number; end: number }): Range
  ```
- Follow the **principle of least surprise**. Methods should do what their names suggest and nothing more.
- Version APIs explicitly. Never break backwards compatibility without a version bump.
- Return **consistent response shapes**. Don’t return a list sometimes and a single object other times.

### Don’t

- Don’t expose internal implementation details through the API surface.
- Don’t create APIs that require calls in a specific order to function correctly (temporal coupling).
- Don’t return `null` where an **empty collection** or **Optional/Maybe** type is more appropriate.
- Don’t mix concerns in a single endpoint/method (e.g., an endpoint that both creates and queries).

-----

## 17. Logging & Observability

### Do

- Use **structured logging** (JSON) with consistent fields: `timestamp`, `level`, `message`, `context`.
- Log at appropriate levels: `DEBUG` for development details, `INFO` for state changes, `WARN` for recoverable issues, `ERROR` for failures requiring attention.
- Include **correlation IDs** in distributed systems to trace requests across services.
- Log **business events** at key points: user created, payment processed, order shipped.
- Make logs **grep-friendly**: include identifiers, avoid multi-line messages.

### Don’t

- Don’t log sensitive data (credentials, tokens, PII, financial details).
- Don’t log inside tight loops — the volume will overwhelm your logging infrastructure.
- Don’t use `print` statements as a substitute for a proper logging framework.
- Don’t log without context. `"Error occurred"` is useless. `"Failed to charge card for order {order_id}: {error}"` is useful.

-----

## 18. Configuration

### Do

- Separate **configuration from code**. Use environment variables, config files, or a configuration service.
- Provide **sensible defaults** so the application runs with minimal configuration in development.
- Validate configuration **at startup** — fail immediately if required config is missing or invalid.
- Document every configuration option: what it does, acceptable values, default.

### Don’t

- Don’t hard-code values that could change between environments (URLs, credentials, feature flags, timeouts).
- Don’t use the same config file for all environments — separate or use overrides.
- Don’t scatter configuration reads throughout the codebase. Centralize config loading and inject values.

-----

## 19. Database & Data Access

### Do

- Use **migrations** for all schema changes — never modify production schema manually.
- Design schemas with **normalization first**, denormalize only when measured performance requires it.
- Add **indexes** for columns used in WHERE, JOIN, ORDER BY clauses.
- Use **transactions** for operations that must be atomic.
- Separate **read and write models** when query patterns diverge significantly from write patterns.

### Don’t

- Don’t store business logic in stored procedures or triggers — keep logic in application code where it’s testable.
- Don’t use `SELECT *` — select only the columns you need.
- Don’t access the database from presentation/controller layers. Use a repository or data access layer.
- Don’t ignore query performance in development. Use `EXPLAIN` / query plans regularly.
- Don’t use auto-incrementing IDs as public-facing identifiers (use UUIDs or opaque IDs).

-----

## 20. The “Definition of Done” Checklist

Before considering any piece of work complete:

- [ ] Code **compiles/builds** with zero warnings
- [ ] All **existing tests** pass
- [ ] **New tests** cover the added/changed behavior
- [ ] No **linting** errors or warnings
- [ ] **Edge cases** are handled (null, empty, boundary values, error states)
- [ ] **Error handling** is in place — no silently swallowed exceptions
- [ ] **Naming** is clear and consistent with the project’s vocabulary
- [ ] **No dead code**, commented-out blocks, or debug logging left behind
- [ ] **Public APIs** are documented with docstrings
- [ ] **Secrets and credentials** are not hard-coded
- [ ] **Performance** implications considered for data-heavy operations
- [ ] Code has been **self-reviewed** (read your own diff before submitting)

-----

## Appendix: Principles Summary

|Principle                       |One-Line Summary                                                                |
|--------------------------------|--------------------------------------------------------------------------------|
|**DRY**                         |Every piece of knowledge has a single, unambiguous representation in the system.|
|**KISS**                        |The simplest solution that works is the best solution.                          |
|**YAGNI**                       |Don’t build it until you need it.                                               |
|**Separation of Concerns**      |Each module addresses a distinct concern.                                       |
|**Composition over Inheritance**|Prefer combining simple pieces over extending complex hierarchies.              |
|**Encapsulation**               |Hide internal details; expose only what’s necessary.                            |
|**Law of Demeter**              |A method should only talk to its immediate friends, not friends of friends.     |
|**Principle of Least Surprise** |Software should behave the way users expect.                                    |
|**Fail Fast**                   |Detect and report errors as early as possible.                                  |
|**Boy Scout Rule**              |Leave the code better than you found it.                                        |
|**Postel’s Law**                |Be liberal in what you accept, conservative in what you produce.                |
|**Command-Query Separation**    |A method either changes state or returns data, never both.                      |





# Project Foundation — Pre-Coding Checklist & Templates

> **이 문서의 목적**: 코드를 한 줄이라도 작성하기 전에, 프로젝트의 기반 문서 3종이 준비되었는지 확인한다.
> 문서가 없으면 작성을 먼저 요청한다. 문서 없이 코딩을 시작하지 않는다.

-----

## Pre-Coding Gate

코딩 작업을 시작하기 전에 아래 3개 문서가 프로젝트 루트에 존재하는지 확인한다.

|#|문서                |파일명              |상태|
|-|------------------|-----------------|--|
|1|Tech Stack & 환경 명세|`TECH_STACK.md`  |☐ |
|2|디렉토리 구조 & 아키텍처    |`ARCHITECTURE.md`|☐ |
|3|프로젝트 개요 & 비즈니스 설계 |`PROJECT.md`     |☐ |

**하나라도 ☐ 상태면 코드 작성을 중단하고, 해당 문서 작성을 먼저 요청한다.**

순서는 반드시 **3 → 1 → 2** (PROJECT → TECH_STACK → ARCHITECTURE) 로 작성한다.
왜 만드는지(목적)를 먼저 정의해야 어떤 기술로(스택) 어떻게 구성할지(아키텍처)를 결정할 수 있다.

-----

## 문서 1: PROJECT.md — 프로젝트 개요 & 비즈니스 설계

> 이 프로젝트가 **무엇**이고, **왜** 존재하며, **누구**를 위한 것인지 정의한다.

### 작성 템플릿

```markdown
# [프로젝트명]

## 한 줄 요약
<!-- 이 프로젝트가 무엇인지 한 문장으로 설명. 엘리베이터 피치. -->


## 해결하는 문제
<!-- 이 프로젝트가 없으면 사용자/비즈니스에 어떤 문제가 있는가? -->


## 타겟 사용자
<!-- 누가 쓰는가? 페르소나 또는 사용자 유형을 구체적으로. -->
- 주요 사용자:
- 부차적 사용자:

## 핵심 기능 (MVP Scope)
<!-- 첫 번째 릴리스에 반드시 포함되어야 하는 기능만 나열. -->
1.
2.
3.

## 핵심 기능 외 (Out of Scope)
<!-- 의도적으로 이번에 하지 않는 것. 스코프 관리의 핵심. -->
-
-

## 비즈니스 모델 / 성공 지표
<!-- 어떻게 가치를 만드는가? 성공을 어떻게 측정하는가? -->
- 수익 모델:
- KPI:

## 주요 도메인 용어
<!-- 프로젝트에서 사용하는 핵심 용어와 정의. 코드의 네이밍 기준이 된다. -->
| 용어 | 정의 | 코드에서의 표현 |
|------|------|----------------|
|      |      |                |

## 제약 조건
<!-- 기술적, 법적, 비즈니스적 제약. 예: 규제 준수, 예산, 일정. -->
-
-

## 참고 자료
<!-- 기획서, 디자인 시안, 경쟁사 분석 등 링크. -->
-
```

### 작성 기준

- **한 줄 요약**이 명확하지 않으면 프로젝트를 충분히 이해하지 못한 것이다. 다시 정리한다.
- **핵심 기능**은 5개 이하로 제한한다. 5개를 넘으면 우선순위를 재검토한다.
- **Out of Scope**은 반드시 채운다. 빈 칸은 스코프 크리프의 시작이다.
- **도메인 용어 테이블**은 코드 네이밍의 single source of truth다. 여기 정의된 용어를 코드에서 그대로 사용한다.

-----

## 문서 2: TECH_STACK.md — 기술 스택 & 환경 명세

> 이 프로젝트가 **어떤 기술**로, **어떤 환경**에서 동작하는지 명시한다.

### 작성 템플릿

```markdown
# Tech Stack & Environment

## Language & Runtime
- Language:              <!-- e.g., TypeScript 5.7 -->
- Runtime:               <!-- e.g., Node.js 22 LTS -->
- Target:                <!-- e.g., ES2022, browser + server -->

## Framework
- Core:                  <!-- e.g., Next.js 15 (App Router) -->
- UI:                    <!-- e.g., React 19 -->
- Styling:               <!-- e.g., Tailwind CSS 4.0 -->
- Component Library:     <!-- e.g., shadcn/ui -->

## Data
- Primary DB:            <!-- e.g., PostgreSQL 17 -->
- ORM / Query Builder:   <!-- e.g., Drizzle ORM -->
- Cache:                 <!-- e.g., Redis 7, Upstash -->
- Search:                <!-- e.g., Elasticsearch 8.x (해당 시) -->

## Infrastructure
- Hosting:               <!-- e.g., Vercel, AWS ECS -->
- CI/CD:                 <!-- e.g., GitHub Actions -->
- Container:             <!-- e.g., Docker 27 (해당 시) -->
- IaC:                   <!-- e.g., Terraform, Pulumi (해당 시) -->

## Package Management
- Package Manager:       <!-- e.g., pnpm 9.x -->
- Monorepo Tool:         <!-- e.g., Turborepo (해당 시) -->

## Testing
- Unit / Integration:    <!-- e.g., Vitest -->
- E2E:                   <!-- e.g., Playwright -->
- Coverage Target:       <!-- e.g., 80% line coverage on business logic -->

## Code Quality
- Linter:                <!-- e.g., ESLint 9 (flat config) -->
- Formatter:             <!-- e.g., Prettier 3.x (또는 Biome) -->
- Type Checking:         <!-- e.g., tsc --strict -->

## Authentication & Security
- Auth:                  <!-- e.g., NextAuth.js v5, Clerk -->
- Secrets Management:    <!-- e.g., .env.local + Vercel env vars -->

## External Services & APIs
<!-- 사용하는 외부 서비스를 모두 나열 -->
| Service | Purpose | SDK / Client |
|---------|---------|-------------|
|         |         |             |

## Version Constraints
<!-- 특정 버전을 고정해야 하는 이유가 있으면 명시 -->
| Package | Pinned Version | Reason |
|---------|---------------|--------|
|         |               |        |

## Dev Environment Setup
<!-- 새 개발자가 0에서 실행까지 필요한 단계 -->
1.
2.
3.

## Required Environment Variables
| Variable | Description | Example | Required |
|----------|-------------|---------|----------|
|          |             |         |          |
```

### 작성 기준

- 버전은 **반드시 메이저 버전 이상**을 명시한다. “React” 가 아니라 “React 19”.
- 해당되지 않는 섹션은 “N/A” 또는 “해당 없음”으로 명시한다. 빈 칸으로 두지 않는다.
- **Dev Environment Setup**은 `git clone` 후 실행까지의 전체 과정이 빠짐없이 있어야 한다.
- **Environment Variables**는 모든 필수 변수를 나열한다. 실제 값이 아닌 설명과 예시를 적는다.

-----

## 문서 3: ARCHITECTURE.md — 디렉토리 구조 & 아키텍처

> 코드가 **어디에**, **어떤 패턴**으로 구성되는지 정의한다.

### 작성 템플릿

```markdown
# Architecture & Directory Structure

## 아키텍처 개요
<!-- 전체 시스템의 구조를 한 문단으로 설명. -->
<!-- 예: "Next.js App Router 기반 모놀리스. 서버 컴포넌트 중심, API Routes로 외부 연동." -->


## 아키텍처 다이어그램
<!-- ASCII, Mermaid, 또는 이미지 링크. 시스템의 주요 컴포넌트와 데이터 흐름. -->
```

[Client] → [Next.js Server] → [PostgreSQL]
↓
[External APIs]

```
## 디렉토리 구조
```

project-root/
├── src/
│   ├── app/                  # Next.js App Router pages & layouts
│   │   ├── (auth)/           # Auth-related route group
│   │   ├── (dashboard)/      # Dashboard route group
│   │   ├── api/              # API Routes
│   │   ├── layout.tsx        # Root layout
│   │   └── page.tsx          # Landing page
│   ├── components/           # Shared UI components
│   │   ├── ui/               # Primitive UI (Button, Input, Modal…)
│   │   └── features/         # Feature-specific compound components
│   ├── lib/                  # Shared utilities & configurations
│   │   ├── db/               # Database client, schema, migrations
│   │   ├── auth/             # Auth configuration
│   │   └── utils/            # Pure utility functions
│   ├── services/             # Business logic layer
│   │   └── [domain]/         # Domain-specific service modules
│   ├── repositories/         # Data access layer
│   │   └── [domain]/         # Domain-specific data access
│   ├── types/                # Shared TypeScript type definitions
│   └── constants/            # App-wide constants
├── tests/                    # Test files (mirrors src/ structure)
├── public/                   # Static assets
├── scripts/                  # Build, deploy, migration scripts
├── docs/                     # Additional documentation
└── [config files]            # .env.example, tsconfig, etc.

```
## 각 디렉토리의 역할과 규칙

### `src/app/`
- **역할**: 라우팅과 페이지 렌더링만 담당.
- **규칙**: 비즈니스 로직을 직접 포함하지 않는다. `services/`를 호출한다.

### `src/components/`
- **역할**: 재사용 가능한 UI 컴포넌트.
- **규칙**: 데이터 fetching이나 비즈니스 로직을 포함하지 않는다. Props로만 동작한다.

### `src/services/`
- **역할**: 핵심 비즈니스 로직. 프레임워크에 의존하지 않는다.
- **규칙**: HTTP 객체, ORM 엔티티 등을 직접 참조하지 않는다. 순수 함수 중심.

### `src/repositories/`
- **역할**: 데이터 소스와의 통신. DB 쿼리, 외부 API 호출.
- **규칙**: 비즈니스 판단을 하지 않는다. 데이터를 가져오고 저장하는 것만.

### `tests/`
- **역할**: 테스트 파일. `src/`의 구조를 미러링한다.
- **명명**: `*.test.ts` (unit), `*.integration.test.ts`, `*.e2e.test.ts`

## 계층 간 의존성 규칙
```

app (pages/routes)
↓ calls
services (business logic)
↓ calls
repositories (data access)
↓ calls
lib (DB client, external SDKs)

```
- 위 → 아래 방향으로만 의존한다. 아래 계층이 위 계층을 import하지 않는다.
- 같은 계층 간 import는 허용하되, 순환 의존은 금지.
- `components/`는 `services/`를 직접 호출하지 않는다. 데이터는 page/layout에서 주입.

## 파일 명명 규칙
| 대상 | 규칙 | 예시 |
|------|------|------|
| 컴포넌트 | PascalCase | `UserProfile.tsx` |
| 유틸리티/서비스 | camelCase | `orderService.ts` |
| 타입 정의 | camelCase | `user.types.ts` |
| 테스트 | 원본명 + `.test` | `orderService.test.ts` |
| 상수 | camelCase or UPPER_SNAKE | `apiEndpoints.ts` |

## 새 파일을 추가할 때의 결정 기준

| 이 파일은... | 여기에 둔다 |
|-------------|------------|
| 페이지 UI를 렌더링한다 | `src/app/` |
| 여러 페이지에서 재사용되는 UI다 | `src/components/` |
| 비즈니스 규칙을 구현한다 | `src/services/` |
| DB나 외부 API와 통신한다 | `src/repositories/` |
| 순수 유틸리티 함수다 | `src/lib/utils/` |
| 타입만 정의한다 | `src/types/` |
| 앱 전체에서 쓰는 상수다 | `src/constants/` |

## 주요 설계 결정 기록 (ADR)
<!-- Architecture Decision Records. 중요한 기술 결정과 그 이유. -->

### ADR-001: [결정 제목]
- **상태**: Accepted / Proposed / Deprecated
- **맥락**: 어떤 상황에서 이 결정이 필요했는가
- **결정**: 무엇을 선택했는가
- **근거**: 왜 이것을 선택했는가
- **대안**: 어떤 다른 선택지가 있었고 왜 선택하지 않았는가
```

### 작성 기준

- **디렉토리 구조**는 실제 프로젝트 구조와 항상 동기화한다. 구조가 바뀌면 이 문서도 업데이트한다.
- **각 디렉토리의 규칙**이 없으면 LLM이 파일을 엉뚱한 곳에 만든다. 반드시 채운다.
- **의존성 방향**은 위반 시 즉시 수정한다. 이것이 깨지면 아키텍처가 붕괴한다.
- **파일 배치 결정 기준 테이블**은 LLM이 새 파일을 만들 때 참조하는 핵심 가이드다.
- **ADR**은 “왜 이렇게 했는가”를 기록한다. 나중에 본인이든 다른 개발자든 같은 질문을 반복하지 않게 한다.
- 위 템플릿은 Next.js 기준 예시다. 프로젝트의 실제 스택에 맞게 조정한다.

-----

## CLAUDE.md 에 추가할 Gate 지시문

위 3개 문서가 준비된 후, 프로젝트 루트의 `CLAUDE.md`에 다음을 포함한다:

```markdown
## Pre-Coding Gate

코드를 작성하기 전에 반드시 아래 파일들이 존재하는지 확인한다.
하나라도 없으면 코드 작성을 중단하고 사용자에게 해당 문서 작성을 먼저 요청한다.

1. `PROJECT.md` — 프로젝트 개요, 목적, 비즈니스 설계, 도메인 용어
2. `TECH_STACK.md` — 기술 스택, 버전, 환경 설정, 환경 변수
3. `ARCHITECTURE.md` — 디렉토리 구조, 계층 규칙, 파일 배치 기준

이 문서들은 코드의 모든 판단 기준이 된다:
- 네이밍은 `PROJECT.md`의 도메인 용어를 따른다.
- 기술 선택은 `TECH_STACK.md`에 명시된 스택만 사용한다.
- 파일 위치는 `ARCHITECTURE.md`의 배치 기준 테이블을 따른다.
```
