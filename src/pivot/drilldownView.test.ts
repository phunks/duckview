import { describe, expect, it } from "vitest";
import { drilldownViewName, drilldownViewSql } from "./drilldownView";
import type { CellClickPayload, ColumnTypeMap, PivotConfigV1 } from "../ext/streamlit-pivot-table/streamlit_pivot/frontend/src/engine/types";

const config: PivotConfigV1 = {
  version: 1, rows: ["region"], columns: ["year"], values: ["amount"],
  aggregation: { amount: "sum" }, show_totals: true, empty_cell_value: "-", interactive: true,
};
const cell = (filters: Record<string, string>): CellClickPayload => ({
  rowKey: [], colKey: [], value: 42, filters,
});
const types: ColumnTypeMap = new Map([
  ["region", "string"], ["year", "integer"], ["date", "date"],
]);
const columns = ["region", "year", "date", "amount"];

describe("drill-down View SQL", () => {
  it("applies cell and Pivot filters to the full parent table", () => {
    const sql = drilldownViewSql("parent", cell({ year: "2024" }), {
      ...config, filters: { region: { include: ["East", "O'Brien"] } },
    }, types, columns);
    expect(sql).toContain('FROM "parent" WHERE');
    expect(sql).toContain("IN ('East', 'O''Brien')");
    expect(sql).toContain('CAST("year" AS VARCHAR)');
    expect(sql).toContain("= '2024'");
    expect(sql).not.toContain("LIMIT");
  });

  it("generates an unrestricted grand total and a named View", () => {
    expect(drilldownViewSql("parent", cell({}), config, types, columns)).toBe('SELECT * FROM "parent"');
    expect(drilldownViewName("parent", {})).toBe("parent_all_records");
    expect(drilldownViewName("parent", { region: "East", year: "2024" })).toBe("parent_region_East_year_2024");
    expect(drilldownViewName("parent", {}, { ...config, filters: { region: { include: ["East"] } } })).toBe("parent_region_East");
    expect(drilldownViewName("parent", { year: "2024" }, { ...config, filters: { region: { include: ["East"] } } })).toBe("parent_year_2024_region_East");
  });

  it("expands grouped members and uses the date grain", () => {
    const sql = drilldownViewSql('my"view', cell({ region: "Coast", date: "2024-01" }), {
      ...config, columns: ["date"], member_groups: [{ field: "region", name: "Coast", members: ["East", "West"] }],
      date_grains: { date: "month" },
    }, types, columns);
    expect(sql).toContain('FROM "my""view"');
    expect(sql).toContain("IN ('East', 'West')");
    expect(sql).toContain("strftime(\"date\", '%Y-%m')");
  });

  it("rejects filters referencing missing source columns", () => {
    expect(() => drilldownViewSql("parent", cell({ missing: "x" }), config, types, columns)).toThrow("no longer in the parent source");
  });

  it("respects adaptive date grains used by the Pivot", () => {
    const sql = drilldownViewSql("parent", cell({ date: "2024-Q2" }), { ...config, columns: ["date"] }, types, columns, { date: "quarter" });
    expect(sql).toContain("quarter(\"date\")");
  });
});