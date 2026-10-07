## Subtask 1: the pure function — done
Summary: Added `src/greet.ts`, exporting `greet(name: string): string` as a single template interpolation returning `Hello, <name>!`, and `tests/greet.test.ts` covering a plain name and an empty string. The implementation matches the plan verbatim and the two tests pass (`vitest run tests/greet.test.ts`, 2 passed).
Decisions: None material — the function body is verbatim from the plan. The test names are descriptive prose ("greets a name", "interpolates an empty string rather than judging it") that state the intent the plan gives in prose.
Open issues: none
Files: src/greet.ts, tests/greet.test.ts
