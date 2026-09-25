import { describe, expect, it } from "vitest";
import { restoredPivotDefinitions, savedPivotTabs } from "./workspaceSnapshot.js";

describe("Pivot workspace definitions", () => {
  it("saves only source and config, preserving the active Pivot index", () => {
    const config = {
      version: 1, rows: ["region"], columns: ["year"],
      values: ["revenue"], aggregation: { revenue: "sum" },
      filters: { region: { excluded: ["West"] } },
    };
    const tabs = [
      { id: "sql", kind: "sql" },
      { id: "first", kind: "pivot", title: "First", sourceName: "sales",
        sourceIsView: false, arrowTable: { numRows: 100 }, queryId: "q1" },
      { id: "second", kind: "pivot", title: "By year", sourceName: "sales_view",
        sourceIsView: true, standaloneConfig: config, columns: ["region"], error: "old" },
    ];
    const saved = savedPivotTabs(tabs, "second");
    expect(saved).toEqual({
      pivotTabs: [
        { title: "First", sourceName: "sales", sourceIsView: false, standaloneConfig: null },
        { title: "By year", sourceName: "sales_view", sourceIsView: true, standaloneConfig: config },
      ],
      activeTabRef: { kind: "pivot", index: 1 },
    });
    expect(restoredPivotDefinitions(saved)).toEqual([
      { index: 0, title: "First", sourceName: "sales", sourceIsView: false,
        standaloneConfig: undefined },
      { index: 1, title: "By year", sourceName: "sales_view", sourceIsView: true,
        standaloneConfig: config },
    ]);
  });

  it("supports old snapshots and ignores invalid saved entries", () => {
    expect(savedPivotTabs([{ kind: "sql", id: "sql" }], "sql"))
      .toEqual({ pivotTabs: [], activeTabRef: null });
    expect(restoredPivotDefinitions({ sqlTabs: [] })).toEqual([]);
    expect(restoredPivotDefinitions({ pivotTabs: [
      null, { sourceName: "  " },
      { sourceName: "  missing  ", standaloneConfig: { version: 99 } },
    ] })).toEqual([{
      index: 2, title: "Pivot: missing", sourceName: "missing",
      sourceIsView: false, standaloneConfig: undefined,
    }]);
  });
});
