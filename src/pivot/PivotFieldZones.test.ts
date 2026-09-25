import { describe, expect, it } from "vitest";
import {
    applyDragMove,
    getUnselectedFields,
    moveFieldToZone,
} from "../ext/streamlit-pivot-table/streamlit_pivot/frontend/src/config/Toolbar";
import type { PivotConfigV1 } from "../ext/streamlit-pivot-table/streamlit_pivot/frontend/src/engine/types";
import { selectedStandalonePivotValues } from "./numericSafety";

const numeric = new Set(["revenue", "profit"]);
const config: PivotConfigV1 = {
    version: 1,
    rows: ["region"],
    columns: ["year"],
    values: ["revenue"],
    aggregation: { revenue: "avg" },
    show_totals: true,
    empty_cell_value: "-",
    interactive: true,
};

describe("Pivot toolbar field roles", () => {
    it("keeps value-only measures in Fields, while excluding row and column dimensions", () => {
        expect(getUnselectedFields(["region", "year", "revenue", "profit"], config))
            .toEqual(["revenue", "profit"]);
    });

    it("copies a field from Fields into Values without removing it from Fields", () => {
        const next = moveFieldToZone(config, "profit", "unselected", "values", numeric)!;
        expect(next.values).toEqual(["revenue", "profit"]);
        expect(next.aggregation).toEqual({ revenue: "avg", profit: "sum" });
        expect(getUnselectedFields(["region", "year", "revenue", "profit"], next))
            .toEqual(["revenue", "profit"]);
        const duplicate = moveFieldToZone(next, "profit", "unselected", "values", numeric)!;
        expect(duplicate.values).toEqual(["revenue", "profit", "profit #2"]);
        expect(duplicate.value_sources).toEqual({ "profit #2": "profit" });
        expect(selectedStandalonePivotValues({ standaloneConfig: {
            ...duplicate, aggregation: { ...duplicate.aggregation, "profit #2": "avg" },
        } })).toContainEqual({ column: "profit", aggregation: "avg" });
        const removed = moveFieldToZone(duplicate, "profit #2", "values", "unselected", numeric)!;
        expect(removed.values).toEqual(["revenue", "profit"]);
        expect(removed.aggregation).toEqual({ revenue: "avg", profit: "sum" });
        expect(removed.value_sources).toEqual({});
        expect(moveFieldToZone(config, "region", "unselected", "values", numeric)).toBeNull();
    });

    it("moves only between Rows and Columns, preserving Values", () => {
        const withRow = moveFieldToZone(config, "revenue", "unselected", "rows", numeric)!;
        expect(withRow.values).toEqual(["revenue"]);
        const withColumn = moveFieldToZone(withRow, "revenue", "rows", "columns", numeric)!;
        expect(withColumn.rows).toEqual(["region"]);
        expect(withColumn.columns).toEqual(["year", "revenue"]);
        expect(withColumn.values).toEqual(["revenue"]);
    });

    it("removing a dimension or measure does not remove its other role", () => {
        const both = { ...config, rows: ["region", "revenue"] };
        const noRow = moveFieldToZone(both, "revenue", "rows", "unselected", numeric)!;
        expect(noRow.values).toEqual(["revenue"]);
        const noValue = moveFieldToZone(both, "revenue", "values", "unselected", numeric)!;
        expect(noValue.rows).toEqual(["region", "revenue"]);
        expect(noValue.values).toEqual([]);
        expect(noValue.aggregation).toEqual({});
    });

    it("copies numeric dimensions to Values, and Values to Rows without removing the measure", () => {
        const withRow = { ...config, rows: ["region", "profit"] };
        const withValue = applyDragMove({
            sourceZone: "rows", targetZone: "values", field: "profit",
            config: withRow, numericColumns: [...numeric],
        })!;
        expect(withValue.rows).toEqual(["region", "profit"]);
        expect(withValue.values).toEqual(["revenue", "profit"]);
        const duplicate = applyDragMove({
            sourceZone: "rows", targetZone: "values", field: "profit",
            config: withValue, numericColumns: [...numeric],
        })!;
        expect(duplicate.value_sources).toEqual({ "profit #2": "profit" });

        const withColumn = applyDragMove({
            sourceZone: "values", targetZone: "columns", field: "profit",
            config: withValue, numericColumns: [...numeric],
        });
        expect(withColumn).toBeNull(); // Rows and Columns remain exclusive.
        const withoutRow = moveFieldToZone(withValue, "profit", "rows", "unselected", numeric)!;
        const copied = applyDragMove({
            sourceZone: "values", targetZone: "columns", field: "profit",
            config: withoutRow, numericColumns: [...numeric],
        })!;
        expect(copied.values).toEqual(["revenue", "profit"]);
        expect(copied.columns).toEqual(["year", "profit"]);
    });
});