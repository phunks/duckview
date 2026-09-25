import { describe, expect, it } from "vitest";
import { lockResultColumnWidths, resizeResultColumn } from "./resultColumnWidths.js";

function makeTable(widths) {
  const table = document.createElement("table");
  table.innerHTML = `<thead><tr>${widths.map(() => "<th>Column</th>").join("")}</tr></thead>`;
  Array.from(table.tHead.rows[0].cells).forEach((cell, index) => {
    cell.getBoundingClientRect = () => ({ width: widths[index] });
  });
  return table;
}

describe("lockResultColumnWidths", () => {
  it("captures the initial widths and reuses them after rows change", () => {
    const result = { rows: [["first", "short"]] };
    const first = makeTable([54.2, 124.1, 210]);
    lockResultColumnWidths(result, first);
    expect(result.columnWidths).toEqual([55, 125, 210]);
    expect(first.style.width).toBe("390px");
    expect(first.querySelectorAll("col")).toHaveLength(3);

    result.rows = [["other", "a much longer cell"]];
    const scrolled = makeTable([80, 350, 400]);
    lockResultColumnWidths(result, scrolled);
    expect(result.columnWidths).toEqual([55, 125, 210]);
    expect(Array.from(scrolled.querySelectorAll("col"), (col) => col.style.width))
      .toEqual(["55px", "125px", "210px"]);
    expect(scrolled.style.tableLayout).toBe("fixed");
    expect(scrolled.style.minWidth).toBe("0px");
    expect(scrolled.style.width).toBe("390px");
  });

  it("resizes a data column without losing its width on the next render", () => {
    const result = { rows: [["2400.123456789"]] };
    const table = makeTable([54, 72]);
    lockResultColumnWidths(result, table);
    resizeResultColumn(result, table, 1, 185.6);
    expect(result.columnWidths).toEqual([54, 186]);
    expect(table.querySelectorAll("col")[1].style.width).toBe("186px");
    expect(table.style.width).toBe("240px");

    const scrolled = makeTable([54, 100]);
    lockResultColumnWidths(result, scrolled);
    expect(scrolled.querySelectorAll("col")[1].style.width).toBe("186px");
    resizeResultColumn(result, scrolled, 1, 1);
    expect(result.columnWidths).toEqual([54, 48]);
    expect(scrolled.style.width).toBe("102px");
  });

  it("resizes the row number column and retains its width on the next render", () => {
    const result = { rows: [["first"]] };
    const table = makeTable([54, 120]);
    lockResultColumnWidths(result, table);
    resizeResultColumn(result, table, 0, 96.4);
    expect(result.columnWidths).toEqual([96, 120]);
    expect(table.querySelectorAll("col")[0].style.width).toBe("96px");
    expect(table.style.width).toBe("216px");

    const scrolled = makeTable([54, 120]);
    lockResultColumnWidths(result, scrolled);
    expect(scrolled.querySelectorAll("col")[0].style.width).toBe("96px");
    resizeResultColumn(result, scrolled, 0, 1);
    expect(result.columnWidths).toEqual([48, 120]);
    expect(scrolled.style.width).toBe("168px");
    resizeResultColumn(result, scrolled, -1, 200);
    expect(result.columnWidths[0]).toBe(48);
  });

  it("waits for actual rows and a measurable result pane", () => {
    const result = { rows: [] };
    const table = makeTable([55, 120]);
    lockResultColumnWidths(result, table);
    expect(result.columnWidths).toBeUndefined();

    result.rows = [["first"]];
    lockResultColumnWidths(result, makeTable([0, 0]));
    expect(result.columnWidths).toBeUndefined();

    lockResultColumnWidths(result, table);
    expect(result.columnWidths).toEqual([55, 120]);

    const hiddenAgain = makeTable([0, 0]);
    lockResultColumnWidths(result, hiddenAgain);
    expect(Array.from(hiddenAgain.querySelectorAll("col"), (col) => col.style.width))
      .toEqual(["55px", "120px"]);
  });
});