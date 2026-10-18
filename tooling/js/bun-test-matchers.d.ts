// bun:test's matchers, typed as loosely as vitest's were.
//
// bun-types declares `toBe(expected: T)` and `toEqual(expected: T)` against
// the received value's type, so `expect(value).toEqual({ kind: "x" })`
// fails to typecheck wherever `value` is a union or a branded type. vitest
// typed the expected value as anything (`toEqual<E>(expected: E)`). The
// suites were written against vitest's contract; this file restores it for
// type checking only (runtime behaviour is bun's either way), so the B7 flip
// stays a codemod rather than a cast at every assertion.
//
// `toHaveBeenCalledOnce` exists at runtime in bun 1.4.3 but is missing from
// bun-types; it is declared here.
//
// A package opts in by listing this file in its tsconfig `include`.

import "bun:test";

declare module "bun:test" {
  interface Matchers<T> {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toStrictEqual(expected: unknown): void;
    toContainEqual(expected: unknown): void;
    toBeOneOf(expected: Iterable<unknown>): void;
    toHaveBeenCalledOnce(): void;
  }
}
