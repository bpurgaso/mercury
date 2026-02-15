# Development Workflow

This project follows a spec-driven development workflow with multi-lens review.

## Core Principles

1. **Spec before code**: Every significant feature gets a specification before implementation
2. **Review before proceeding**: Specs and implementations are reviewed through multiple lenses
3. **Iterate on findings**: Critical issues are fixed before moving forward

---

## When Asked to Build Something

Follow this workflow for any non-trivial feature or component:

### Phase 1: Specification

1. Create a spec document at `specs/<feature-name>.md`
2. Include these sections:
   - **Problem Statement**: What problem does this solve? Who has this problem?
   - **Proposed Solution**: High-level approach
   - **Goals**: What success looks like (be specific and measurable)
   - **Non-Goals**: What this explicitly won't do (prevents scope creep)
   - **Detailed Design**: Core behavior, step-by-step flows, data structures
   - **Edge Cases**: What happens when things go wrong
   - **Acceptance Criteria**: Testable conditions for "done"

### Phase 2: Spec Review

Before showing the spec to the user, review it yourself through these lenses **sequentially**:

**Lens 1 - Correctness**
- Are there logical errors or contradictions?
- Will this actually solve the stated problem?
- Are there false assumptions?

**Lens 2 - Completeness**  
- What edge cases are missing?
- What error conditions are unhandled?
- What implicit assumptions should be explicit?

**Lens 3 - Security**
- Can malicious input cause harm?
- Are there access control gaps?
- Could sensitive data leak?

After each lens, note issues found. Then revise the spec to address Critical and Important issues before presenting it.

### Phase 3: User Approval

Present the spec to the user with a summary of:
- What will be built
- Key design decisions made
- Any open questions that need input

**Wait for user approval before implementing.**

### Phase 4: Implementation

Implement against the approved spec:
- Follow the spec exactly—don't add unspecified features
- Handle all edge cases mentioned in the spec
- Include appropriate error handling
- Write clear code with comments for non-obvious logic

### Phase 5: Implementation Review

Before presenting the implementation, review it through these lenses:

**Lens 1 - Correctness**
- Does the code match the spec?
- Are there bugs or logic errors?

**Lens 2 - Security**
- Input validation present?
- No injection vulnerabilities?
- Secrets handled properly?

**Lens 3 - Performance**
- Are there O(n²) or worse operations that could be O(n)?
- Any N+1 query patterns or unnecessary database calls?
- Unnecessary memory allocations or copies?
- Blocking operations that should be async?
- Will this scale to expected load?

**Lens 4 - Maintainability**
- Is the code clear and readable?
- Are concerns properly separated?
- Would someone understand this in 6 months?

Fix Critical issues before presenting. Note Important issues for the user.

---

## Custom Commands

### /spec <description>

Create a specification for the described feature.

1. Write the spec following the template above
2. Run the three-lens review on it
3. Revise to address Critical/Important issues
4. Present the spec and ask for approval

Example: `/spec user authentication with email and password`

### /implement <spec-file>

Implement an approved specification.

1. Read the spec file
2. Implement all requirements
3. Run the four-lens implementation review (correctness, security, performance, maintainability)
4. Fix Critical issues
5. Present the implementation with notes on any Important issues

Example: `/implement specs/auth.md`

### /review <target> [lens]

Review a file or the current implementation.

Lenses available:
- `correctness` - Logic errors, bugs, false assumptions
- `completeness` - Missing edge cases, unhandled errors
- `security` - Vulnerabilities, injection, access control
- `maintainability` - Clarity, complexity, coupling
- `performance` - Bottlenecks, algorithmic complexity

If no lens specified, run all five sequentially.

Example: `/review src/auth.py security`
Example: `/review specs/api.md` (runs all lenses)

### /revise <target>

Review the target through all lenses and apply fixes for Critical and Important issues.
Present a summary of changes made.

Example: `/revise src/auth.py`

---

## For Quick Tasks

Not everything needs a full spec. Use judgment:

**Needs a spec:**
- New features or components
- Significant refactors
- Anything touching security, payments, or user data
- Work that will take more than ~30 minutes to implement

**Skip the spec:**
- Bug fixes with clear reproduction steps
- Small refactors (renaming, extracting a function)
- Adding tests for existing code
- Documentation updates

For quick tasks, still do a self-review before presenting the result.

---

## Project Structure

```
project/
├── CLAUDE.md           # This file
├── specs/              # Specification documents
│   └── *.md
├── src/                # Source code
├── tests/              # Test files
└── docs/               # Documentation
```

---

## Review Lens Reference

Use these detailed prompts when doing self-review:

### Correctness
Focus on: Logic errors, contradictions, false assumptions, coherence between parts.
Ignore: Style, performance, security (unless it's a logic bug).
Ask: "Does this actually work? Does it solve the stated problem?"

### Completeness
Focus on: Missing elements, unhandled edge cases, implicit assumptions, error paths.
Ignore: Whether existing content is correct.
Ask: "What's missing? What happens when X goes wrong?"

### Security
Focus on: Input validation, injection, access control, data exposure, trust boundaries.
Ignore: Non-security functional issues.
Ask: "How could an attacker abuse this?"

### Maintainability
Focus on: Clarity, complexity, naming, documentation, coupling, consistency.
Ignore: Correctness, performance.
Ask: "Will someone understand this in 6 months? Is this more complex than needed?"

### Performance
Focus on: Algorithmic complexity, bottlenecks, resource usage, scalability.
Ignore: Correctness, security, style.
Ask: "What happens at 10x scale? 100x? Where are the slow parts?"

---

## Handling Disagreement

If the user asks you to skip the spec or review process:
- For trivial changes, that's fine
- For significant work, explain why the process helps and offer a lightweight version
- Ultimately defer to the user's judgment—they know their context

If you find issues during review that conflict with the user's requirements:
- Present the issues clearly
- Explain the tradeoffs
- Let the user decide how to proceed
