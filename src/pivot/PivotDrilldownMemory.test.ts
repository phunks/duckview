import { tableFromArrays } from "apache-arrow";
import { describe, expect, it } from "vitest";
import { PivotData } from "../ext/streamlit-pivot-table/streamlit_pivot/frontend/src/engine/PivotData";
import { createArrowDataSource } from "../ext/streamlit-pivot-table/streamlit_pivot/frontend/src/engine/parseArrow";
import type { PivotConfigV1 } from "../ext/streamlit-pivot-table/streamlit_pivot/frontend/src/engine/types";

const config: PivotConfigV1 = {
  version: 1,
  rows: ["region"],
  columns: ["year"],
  values: ["amount"],
  aggregation: { amount: "sum" },
  show_totals: true,
  empty_cell_value: "-",
  interactive: true,
  filters: { region: { include: ["East"] } },
};

describe("on-demand Pivot drill-down", () => {
  it("counts all matching rows while materializing only the requested page", () => {
    const table = tableFromArrays({
      region: ["East", "East", "West", "East", "East"],
      year: [2024, 2024, 2024, 2023, 2024],
      amount: new Float64Array([10, 20, 30, 40, 50]),
    });
    const source = createArrowDataSource(table)!;
    const pivot = new PivotData(source, config);

    expect(pivot.getAggregator(["East"], ["2024"], "amount").value()).toBe(80);
    expect(pivot.getGrandTotal("amount").value()).toBe(120);
    const matching = pivot.getMatchingRecords({ region: "East", year: "2024" }, 2);
    expect(matching.totalCount).toBe(3);
    expect(matching.records.map((record) => record.amount)).toEqual([10, 20]);
    expect(pivot.getMatchingRecords({ region: "West" }).totalCount).toBe(0);
    expect(pivot.getMatchingRecords({ region: "East", year: "2023" }).totalCount).toBe(1);
  });

  it("does not retain an O(rows × fields) row-index cache", () => {
    const table = tableFromArrays({
      region: Array.from({ length: 20_000 }, (_, index) => `Region ${index % 100}`),
      year: Int32Array.from({ length: 20_000 }, (_, index) => 2020 + index % 5),
      amount: new Float64Array(20_000).fill(1),
    });
    const pivot = new PivotData(createArrowDataSource(table)!, {
      ...config,
      filters: undefined,
    });

    expect(pivot.getGrandTotal("amount").value()).toBe(20_000);
    expect("_recordIndexesByFieldValue" in pivot).toBe(false);
    const matching = pivot.getMatchingRecords({ region: "Region 1" }, 1);
    expect(matching.totalCount).toBe(200);
    expect(matching.records).toHaveLength(1);
  });
});