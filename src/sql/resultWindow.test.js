import { describe, expect, it } from "vitest";
import { resultWindow, RESULT_ROW_HEIGHT, RESULT_HEADER_HEIGHT } from "./resultWindow.js";

describe("resultWindow", () => {
  it("renders only the visible rows and overscan for large results", () => {
    const top = resultWindow(1_000_000, 0, 300);
    expect(top.start).toBe(0);
    expect(top.end).toBeLessThan(40);
    expect(top.top + (top.end - top.start) * RESULT_ROW_HEIGHT + top.bottom)
      .toBe(1_000_000 * RESULT_ROW_HEIGHT);

    const middle = resultWindow(1_000_000, RESULT_HEADER_HEIGHT + 500_000 * RESULT_ROW_HEIGHT, 300);
    expect(middle.start).toBeLessThanOrEqual(500_000);
    expect(middle.end).toBeGreaterThan(500_000);
    expect(middle.end - middle.start).toBeLessThan(40);
    expect(middle.top + (middle.end - middle.start) * RESULT_ROW_HEIGHT + middle.bottom)
      .toBe(1_000_000 * RESULT_ROW_HEIGHT);
  });

  it("clamps the range for empty, short, and end-of-list results", () => {
    expect(resultWindow(0, 0, 300)).toEqual({ start: 0, end: 0, top: 0, bottom: 0 });
    expect(resultWindow(3, 10000, 300)).toEqual({ start: 0, end: 3, top: 0, bottom: 0 });
    const last = resultWindow(1000, 1000 * RESULT_ROW_HEIGHT, 300);
    expect(last.end).toBe(1000);
    expect(last.start).toBeLessThan(1000);
  });
});