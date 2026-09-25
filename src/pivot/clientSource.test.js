import { tableFromArrays } from "apache-arrow";
import { describe, expect, it, vi } from "vitest";
import {
  clientPivotRowLimit,
  clientPivotSourceSql,
  DEFAULT_CLIENT_PIVOT_ROWS,
  fetchClientPivotSource,
} from "./clientSource.js";

function fetchRows(totalRows) {
  return vi.fn(async ({ offset, limit }) => {
    const count = Math.min(limit, Math.max(0, totalRows - offset));
    const values = Int32Array.from({ length: count }, (_, index) => offset + index);
    return {
      table: tableFromArrays({ value: values }),
      hasMore: offset + count < totalRows,
    };
  });
}

describe("client Pivot source row limit", () => {
  it("orders all projected fields before paging a grouped SQL view", () => {
    expect(clientPivotSourceSql('"deaths ""by year"""'))
      .toBe('SELECT * FROM "deaths ""by year""" ORDER BY ALL');
  });
  it("defaults invalid or missing settings to 10,000", () => {
    expect(clientPivotRowLimit(undefined)).toBe(DEFAULT_CLIENT_PIVOT_ROWS);
    expect(clientPivotRowLimit("50000")).toBe(50_000);
    expect(clientPivotRowLimit(-1)).toBe(DEFAULT_CLIENT_PIVOT_ROWS);
    expect(clientPivotRowLimit(999_999)).toBe(DEFAULT_CLIENT_PIVOT_ROWS);
  });

  it("accepts exactly the limit, including a full last page", async () => {
    const fetchPage = fetchRows(10_000);
    const table = await fetchClientPivotSource("query", 10_000, fetchPage);
    expect(table.numRows).toBe(10_000);
    expect(fetchPage).toHaveBeenCalledWith({ queryId: "query", offset: 0, limit: 10_000 });
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("rejects a source over the default limit without truncating it", async () => {
    const fetchPage = fetchRows(10_001);
    await expect(fetchClientPivotSource("query", 10_000, fetchPage))
      .rejects.toThrow("exceeds the 10,000 row client-side limit");
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("combines typed Arrow pages when a higher limit is selected", async () => {
    const fetchPage = fetchRows(20_001);
    const table = await fetchClientPivotSource("query", 50_000, fetchPage);
    expect(table.numRows).toBe(20_001);
    expect(table.getChild("value").get(10_000)).toBe(10_000);
    expect(table.getChild("value").get(20_000)).toBe(20_000);
    expect(fetchPage.mock.calls.map(([request]) => request.offset))
      .toEqual([0, 10_000, 20_000]);
    expect(fetchPage.mock.calls.every(([request]) => request.limit <= 10_000)).toBe(true);
  });

  it("detects rows beyond the selected higher limit", async () => {
    const fetchPage = fetchRows(50_001);
    await expect(fetchClientPivotSource("query", 50_000, fetchPage))
      .rejects.toThrow("exceeds the 50,000 row client-side limit");
    expect(fetchPage).toHaveBeenCalledTimes(5);
  });
});