import { expect, test } from "bun:test";
import { latestPerWorkflow, verdict } from "./await-commit-checks.mjs";

const run = (over) => ({
  id: 1,
  workflow_id: 1,
  run_number: 1,
  run_attempt: 1,
  event: "push",
  name: "checks",
  status: "completed",
  conclusion: "success",
  ...over,
});

test("the gate's own run and non-push runs are not checks", () => {
  const result = verdict(
    [
      run({ id: 7, workflow_id: 9, conclusion: null, status: "in_progress" }),
      run({ id: 8, workflow_id: 2, event: "schedule", conclusion: "failure" }),
      run({ id: 9, workflow_id: 3 }),
    ],
    7,
  );
  expect(result.state).toBe("green");
  expect(result.passed.map((r) => r.id)).toEqual([9]);
});

test("a queued or running check keeps the gate pending", () => {
  expect(
    verdict(
      [
        run({ id: 2 }),
        run({ id: 3, workflow_id: 2, status: "queued", conclusion: null }),
      ],
      1,
    ).state,
  ).toBe("pending");
});

test("failure and timeout are red; skipped is green", () => {
  for (const conclusion of [
    "failure",
    "timed_out",
    "startup_failure",
    "action_required",
  ])
    expect(verdict([run({ id: 2, conclusion })], 1).state).toBe("red");
  expect(verdict([run({ id: 2, conclusion: "skipped" })], 1).state).toBe(
    "green",
  );
});

test("only cancelled checks: superseded, once nothing is pending", () => {
  const cancelled = run({ id: 2, conclusion: "cancelled" });
  expect(verdict([cancelled, run({ id: 3, workflow_id: 2 })], 1).state).toBe(
    "superseded",
  );
  expect(
    verdict(
      [
        cancelled,
        run({ id: 3, workflow_id: 2, status: "queued", conclusion: null }),
      ],
      1,
    ).state,
  ).toBe("pending");
  expect(
    verdict(
      [cancelled, run({ id: 3, workflow_id: 2, conclusion: "failure" })],
      1,
    ).state,
  ).toBe("red");
});

test("a red check wins over a pending one", () => {
  expect(
    verdict(
      [
        run({ id: 2, conclusion: "failure" }),
        run({ id: 3, workflow_id: 2, status: "in_progress", conclusion: null }),
      ],
      1,
    ).state,
  ).toBe("red");
});

test("a later run of the same workflow replaces the earlier one", () => {
  const runs = [
    run({ id: 2, run_number: 4, conclusion: "failure" }),
    run({ id: 3, run_number: 5 }),
  ];
  expect(latestPerWorkflow(runs).map((r) => r.id)).toEqual([3]);
  expect(verdict(runs, 1).state).toBe("green");
});

test("no checks at all is green (nothing the commit touched is tested)", () => {
  expect(verdict([], 1).state).toBe("green");
});
