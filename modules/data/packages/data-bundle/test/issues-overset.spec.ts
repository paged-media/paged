// Data issues (data ADR 564): whose word an overset notice is. The host's
// frame chain is the composer's and is believed as it reports (a table's
// overflow may be a cell's, so its message names the cells); a story the
// bundle measured because the host could not tell says it is an estimate.

import { describe, expect, it } from "bun:test";

import type { BundleHost } from "@paged-media/plugin-api";

import { oversetIssues } from "../src/issues";

/** A host whose frame chains are `chains` (story → links). */
function hostWith(
  chains: Record<string, { frameId: string; overflow: boolean }[]>,
): BundleHost {
  return {
    document: { frameChain: async (story: string) => chains[story] ?? [] },
  } as unknown as BundleHost;
}

describe("overset issues: the composer's word or an estimate [data.issues]", () => {
  it("believes the host's overflow and names a table's cells in its message", async () => {
    const host = hostWith({
      s1: [{ frameId: "f1", overflow: true }],
      s2: [{ frameId: "f2", overflow: true }],
    });
    const issues = await oversetIssues(
      host,
      [
        { binding: "v", storyId: "s1" },
        { binding: "t", storyId: "s2", table: true },
      ],
      async () => null,
      async () => {
        throw new Error("a story the host reports is not measured");
      },
    );
    expect(issues.map((i) => [i.binding, i.address])).toEqual([
      ["v", "textFrame:f1"],
      ["t", "textFrame:f2"],
    ]);
    expect(issues[0]!.message).toContain("does not fit its frame");
    expect(issues[0]!.message).not.toContain("estimate");
    expect(issues[1]!.message).toContain("one of its cells");
  });

  it("says a measured overset is an estimate, named at the chain's last frame", async () => {
    const host = hostWith({
      s1: [
        { frameId: "a", overflow: false },
        { frameId: "b", overflow: false },
      ],
      s2: [{ frameId: "c", overflow: false }],
    });
    const issues = await oversetIssues(
      host,
      [
        { binding: "v", storyId: "s1", record: 2 },
        { binding: "w", storyId: "s2" },
      ],
      async () => null,
      async (story) => story === "s1",
    );
    expect(issues).toEqual([
      {
        kind: "overset",
        severity: "warning",
        message: expect.stringContaining("an estimate"),
        binding: "v",
        address: "textFrame:b",
        record: 2,
      },
    ]);
    expect(issues[0]!.message).toContain("record 3");
  });

  it("names each table cell the composer reports overset, at the table's frame", async () => {
    const host = {
      document: {
        frameChain: async () => [{ frameId: "f2", overflow: false }],
        collection: async () => [
          {
            selfId: "s2",
            oversetCells: [
              { table: "ut", row: 2, column: 0 },
              { table: "ut", row: 4, column: 1 },
            ],
          },
          { selfId: "s9" },
        ],
      },
    } as unknown as BundleHost;
    const issues = await oversetIssues(
      host,
      [{ binding: "t", storyId: "s2", table: true }],
      async () => null,
    );
    expect(issues.map((i) => [i.address, i.message])).toEqual([
      ["textFrame:f2", expect.stringContaining("row 3, column 1")],
      ["textFrame:f2", expect.stringContaining("row 5, column 2")],
    ]);
  });
});
