import { expect, test } from "bun:test";
import { scan } from "./private-paths.mjs";

// The examples are assembled so that this file passes its own check.
const users = ["", "Users", "jdoe", "notes.md"].join("/");
const volume = ["", "Volumes", "Backup", "targets"].join("/");
const rules = (text) => scan(text).map((f) => f.rule);

test("a real-looking home directory is a finding, a placeholder is not", () => {
  expect(rules(`see ${users}`)).toEqual(["home"]);
  expect(rules(["", "home", "jdoe", "x"].join("/"))).toEqual(["home"]);
  expect(rules(["C:", "Users", "jdoe", "x"].join("\\"))).toEqual(["home"]);
  for (const name of ["alice", "Alice", "me", "runner", "<user>"])
    expect(rules(["", "Users", name, "x"].join("/"))).toEqual([]);
});

test("a named volume is a finding, the documented RAM disk is not", () => {
  expect(rules(volume)).toEqual(["volume"]);
  expect(rules(["", "Volumes", "PagedTarget", "core"].join("/"))).toEqual([]);
});

test("tool state, the machine's checkout layout and the private repository", () => {
  expect(rules([".claude", "plans", "a.md"].join("/"))).toEqual(["tool-state"]);
  expect(rules([".claude", "settings.json"].join("/"))).toEqual([]);
  expect(rules(["~", "paged", "core"].join("/"))).toEqual(["checkout"]);
  expect(rules(["thoughts", "docs", "a.md"].join("/"))).toEqual([
    "private-repo",
  ]);
  expect(rules("after" + ["thoughts", "x"].join("/"))).toEqual([]);
});

test("findings carry the line", () => {
  expect(scan(`one\ntwo ${volume}\n`)[0].line).toBe(2);
});
