import { expect, test } from "bun:test";
import { judge } from "./wasm-size-ratchet.mjs";

const budget = { artifacts: { "a.wasm": { measured: 990, max: 1000 } } };
const status = (size) => judge(budget, () => size)[0].status;

test("at or under max passes; one byte over fails", () => {
  expect(status(1000)).toBe("ok");
  expect(status(980)).toBe("ok");
  expect(status(1001)).toBe("over");
});

test("more than three percent under max is reported as slack", () => {
  expect(status(969)).toBe("slack");
  expect(status(970)).toBe("ok");
});

test("an artifact that is not built is missing, never ok", () => {
  expect(status(null)).toBe("missing");
});
