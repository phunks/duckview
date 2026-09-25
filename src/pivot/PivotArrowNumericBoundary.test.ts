import {
    Decimal,
    makeData,
    makeVector,
    Table,
    tableFromArrays,
    vectorFromArray,
} from "apache-arrow";
import { describe, expect, it } from "vitest";
import { PivotData } from "../ext/streamlit-pivot-table/streamlit_pivot/frontend/src/engine/PivotData";
import { addValueInstance, getRenderedValueLabel, validatePivotConfigV1 } from "../ext/streamlit-pivot-table/streamlit_pivot/frontend/src/engine/types";
import { createArrowDataSource } from "../ext/streamlit-pivot-table/streamlit_pivot/frontend/src/engine/parseArrow";
import { buildExportGrid } from "../ext/streamlit-pivot-table/streamlit_pivot/frontend/src/engine/exportData";
import type { PivotConfigV1 } from "../ext/streamlit-pivot-table/streamlit_pivot/frontend/src/engine/types";

const CATEGORY = "第17章　先天奇形，変形及び染色体異常（Q00-Q99）";

const CONFIG: PivotConfigV1 = {
    version: 1,
    rows: ["cat03_name"],
    columns: ["time_display"],
    values: ["total_value"],
    aggregation: { total_value: "sum" },
    show_totals: true,
    empty_cell_value: "-",
    interactive: true,
};

describe("PivotData Arrow numeric boundary", () => {
    it("aggregates independent instances of the same source and reloads their config", () => {
        const table = tableFromArrays({
            cat03_name: ["A", "A", "B"],
            time_display: ["2024", "2024", "2024"],
            total_value: new Float64Array([10, 20, 30]),
        });
        const source = createArrowDataSource(table)!;
        const added = addValueInstance(CONFIG, "total_value");
        const config = validatePivotConfigV1(JSON.parse(JSON.stringify({
            ...added, aggregation: { total_value: "count", "total_value #2": "avg" },
        })));
        const pivot = new PivotData(source, config);
        expect(config.values).toEqual(["total_value", "total_value #2"]);
        expect(config.value_sources).toEqual({ "total_value #2": "total_value" });
        expect(getRenderedValueLabel(config, "total_value #2")).toBe("total_value (Avg)");
        expect(pivot.getAggregator(["A"], ["2024"], "total_value").value()).toBe(2);
        expect(pivot.getAggregator(["A"], ["2024"], "total_value #2").value()).toBe(15);
        expect(pivot.getGrandTotal("total_value #2").value()).toBe(20);
        expect(pivot.getRowTotal(["A"], "total_value #2").value()).toBe(15);
        const exported = buildExportGrid(pivot, config, "raw");
        expect(exported.flat()).toContain("total_value (Avg)");
        expect(exported.flat()).toContain("15");
        expect(validatePivotConfigV1(CONFIG).values).toEqual(["total_value"]);
    });
    it("sorts chapter labels by the number captured from a regular expression", () => {
        const table = tableFromArrays({
            chapter: ["第10章", "第11章", "第1章", "第20章", "その他"],
            total_value: new Float64Array([10, 11, 1, 20, 0]),
        });
        const source = createArrowDataSource(table);
        expect(source).not.toBeNull();

        const pivot = new PivotData(source!, {
            ...CONFIG,
            rows: ["chapter"],
            columns: [],
            row_sort: {
                by: "regex_number",
                direction: "asc",
                regex_pattern: "第(\\d+)",
            },
        });

        expect(pivot.getRowKeys()).toEqual([
            ["第1章"],
            ["第10章"],
            ["第11章"],
            ["第20章"],
            ["その他"],
        ]);
    });

    it("aggregates Float64 values without dropping yearly totals", () => {
        const table = tableFromArrays({
            cat03_name: Array(10).fill(CATEGORY),
            time_display: [
                "2015年",
                "2016年",
                "2017年",
                "2018年",
                "2019年",
                "2020年",
                "2021年",
                "2022年",
                "2023年",
                "2024年",
            ],
            total_value: new Float64Array([
                2896, 2836, 2941, 2781, 2798,
                2496, 2553, 2608, 2654, 2415,
            ]),
        });

        const source = createArrowDataSource(table);
        expect(source).not.toBeNull();

        const pivot = new PivotData(source!, CONFIG);
        const rowKey = [CATEGORY];

        expect(pivot.getGrandTotal("total_value").value()).toBe(26_978);
        expect(pivot.getRowTotal(rowKey, "total_value").value()).toBe(26_978);

        expect(
            pivot.getAggregator(rowKey, ["2015年"], "total_value").value(),
        ).toBe(2896);
        expect(
            pivot.getAggregator(rowKey, ["2016年"], "total_value").value(),
        ).toBe(2836);
        expect(
            pivot.getAggregator(rowKey, ["2017年"], "total_value").value(),
        ).toBe(2941);
        expect(
            pivot.getAggregator(rowKey, ["2024年"], "total_value").value(),
        ).toBe(2415);
    });

    it("converts DuckDB HUGEINT Decimal128 values to exact JavaScript numbers", () => {
        // DuckDB exposes SUM(INTEGER) through Arrow as Decimal128(38, 0).
        // The decimal's physical buffer is four little-endian u32 words.
        const table = new Table({
            cat03_name: vectorFromArray([CATEGORY]),
            time_display: vectorFromArray(["2024年"]),
            total_value: makeVector(makeData({
                type: new Decimal(0, 38),
                length: 1,
                data: new Uint32Array([24_313, 0, 0, 0]),
            })),
        });
        const source = createArrowDataSource(table);
        expect(source).not.toBeNull();
        expect(source!.getValue(0, "total_value")).toBe(24_313);

        const pivot = new PivotData(source!, CONFIG);
        expect(
            pivot.getAggregator([CATEGORY], ["2024年"], "total_value").value(),
        ).toBe(24_313);
    });

    it("converts safe Int64 values to exact JavaScript numbers", () => {
        const table = tableFromArrays({
            value: new BigInt64Array([
                -9_007_199_254_740_991n,
                1000n,
                9_007_199_254_740_991n,
            ]),
        });

        const source = createArrowDataSource(table);
        expect(source).not.toBeNull();

        expect(source!.getValue(0, "value")).toBe(-9_007_199_254_740_991);
        expect(source!.getValue(1, "value")).toBe(1000);
        expect(source!.getValue(2, "value")).toBe(9_007_199_254_740_991);
    });

    it("rejects Int64 values outside the exact JavaScript integer range", () => {
        const table = tableFromArrays({
            value: new BigInt64Array([
                9_007_199_254_740_992n,
                -9_007_199_254_740_992n,
            ]),
        });

        const source = createArrowDataSource(table);
        expect(source).not.toBeNull();

        expect(() => source!.getValue(0, "value")).toThrow(
            /cannot be represented exactly as a JavaScript number/,
        );
        expect(() => source!.getValue(1, "value")).toThrow(
            /cannot be represented exactly as a JavaScript number/,
        );
    });
});