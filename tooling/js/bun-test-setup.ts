// Preloaded by every package's `bun test` (`--preload`): workarounds for
// bun:test defects, kept in one place and removed when bun fixes them.
//
// 1. toMatchObject writes into the value under test (bun 1.4.3). With an
//    asymmetric matcher anywhere in the expected object —
//    `expect(row).toMatchObject({ members: expect.arrayContaining(["A"]) })`
//    — bun replaces `row.members` with the matcher object. A test that
//    goes on using `row`, or a schema object the code under test shares,
//    then sees `{}` where its array was (plugin-sdk object-model-v71 failed
//    on exactly that). The override below remembers every property of the
//    received value that the expected object reaches, runs bun's own
//    matcher, and puts each one back.

import { expect } from "bun:test";

type Saved = [object, PropertyKey, unknown];

const nativeToMatchObject = Object.getPrototypeOf(expect(0)).toMatchObject as (
  this: unknown,
  expected: unknown,
) => void;

function remember(received: unknown, expected: unknown, out: Saved[], seen: Set<object>): void {
  if (!received || typeof received !== "object" || !expected || typeof expected !== "object") return;
  if (seen.has(expected)) return;
  seen.add(expected);
  for (const key of Reflect.ownKeys(expected)) {
    if (!Object.prototype.hasOwnProperty.call(received, key)) continue;
    const value = (received as Record<PropertyKey, unknown>)[key];
    out.push([received, key, value]);
    remember(value, (expected as Record<PropertyKey, unknown>)[key], out, seen);
  }
}

expect.extend({
  toMatchObject(received: unknown, expected: unknown) {
    const saved: Saved[] = [];
    remember(received, expected, saved, new Set());
    try {
      nativeToMatchObject.call(expect(received), expected);
      return { pass: true, message: () => "expected the value not to match the object" };
    } catch (err) {
      return { pass: false, message: () => (err instanceof Error ? err.message : String(err)) };
    } finally {
      for (const [obj, key, value] of saved) {
        const rec = obj as Record<PropertyKey, unknown>;
        if (!Object.is(rec[key], value)) rec[key] = value;
      }
    }
  },
});
