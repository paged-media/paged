import { expect, test } from "bun:test";
import { check, glob, TEST_FILE } from "./test-lanes.mjs";

const workflows = { "a.yml": "steps:\n  - run: bun   run test\n" };
const read = (name) => workflows[name] ?? null;
const lane = (over) => ({
  name: "pkg",
  workflow: "a.yml",
  evidence: "bun run test",
  files: ["pkg/**"],
  ...over,
});

test("globs: ** crosses directories, * does not, {a,b} alternates", () => {
  expect(glob("pkg/**").test("pkg/a/b.test.ts")).toBe(true);
  expect(glob("pkg/**/*.dom.test.*").test("pkg/x.dom.test.tsx")).toBe(true);
  expect(glob("pkg/*.test.ts").test("pkg/a/b.test.ts")).toBe(false);
  expect(glob("s/{a,b}.test.mjs").test("s/b.test.mjs")).toBe(true);
  expect(glob("s/{a,b}.test.mjs").test("s/c.test.mjs")).toBe(false);
  expect(glob("a.b").test("axb")).toBe(false);
});

test("what counts as a test file", () => {
  for (const f of ["a.test.ts", "a.spec.tsx", "a.dom.test.tsx", "a_test.mjs"])
    expect(TEST_FILE.test(f)).toBe(true);
  for (const f of ["a.ts", "test.ts", "a.test.json", "a.film.ts"])
    expect(TEST_FILE.test(f)).toBe(false);
});

test("a file in a lane passes; a file in none is a problem", () => {
  const ok = check({ lanes: [lane()], unlaned: [] }, ["pkg/a.test.ts"], read);
  expect(ok.problems).toEqual([]);
  const bad = check(
    { lanes: [lane()], unlaned: [] },
    ["pkg/a.test.ts", "other/b.spec.ts"],
    read,
  );
  expect(bad.problems).toHaveLength(1);
  expect(bad.problems[0]).toContain("other/b.spec.ts: no CI lane");
});

test("except takes files out of a lane", () => {
  const result = check(
    { lanes: [lane({ except: ["**/*.dom.test.*"] })], unlaned: [] },
    ["pkg/a.test.ts", "pkg/b.dom.test.tsx"],
    read,
  );
  expect(result.problems.join("\n")).toContain(
    "pkg/b.dom.test.tsx: no CI lane",
  );
});

test("the evidence must still be in the workflow (whitespace aside)", () => {
  const gone = check(
    { lanes: [lane({ evidence: "bun run test:dom" })], unlaned: [] },
    ["pkg/a.test.ts"],
    read,
  );
  expect(gone.problems.join("\n")).toContain("no longer contains");
  const missing = check(
    { lanes: [lane({ workflow: "b.yml" })], unlaned: [] },
    ["pkg/a.test.ts"],
    read,
  );
  expect(missing.problems.join("\n")).toContain("no workflow b.yml");
});

test("dead lanes, dead or reasonless unlaned entries, and double listing", () => {
  const result = check(
    {
      lanes: [lane(), lane({ name: "dead", files: ["gone/**"] })],
      unlaned: [
        { file: "pkg/a.test.ts", reason: "x" },
        { file: "nothing/**", reason: "y" },
        { file: "local/**" },
      ],
    },
    ["pkg/a.test.ts", "local/b.spec.ts"],
    read,
  );
  const text = result.problems.join("\n");
  expect(text).toContain('lane "dead": matches no test file');
  expect(text).toContain("pkg/a.test.ts: listed as unlaned, but lane");
  expect(text).toContain("unlaned nothing/**: matches no test file");
  expect(text).toContain("unlaned local/**: no reason given");
});
