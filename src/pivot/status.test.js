import { describe, expect, it } from "vitest";
import { pivotStatusFor } from "./status.js";

describe("Pivot status", () => {
  it("shows loaded source without marking a configuration change as dirty", () => {
    const tab = { arrowTable: { numRows: 1234 }, standaloneConfig: { rows: ["gender"] } };
    expect(pivotStatusFor(tab)).toEqual({
      className: "pivot-status",
      text: "React Pivot · 1,234 Arrow rows loaded. Refresh to reload source data.",
    });
    tab.standaloneConfig = { rows: ["gender", "age"] };
    expect(pivotStatusFor(tab).className).toBe("pivot-status");
    expect(pivotStatusFor(tab).text).not.toContain("configuration changed");
  });

  it("shows source loading and errors instead of a stale loaded status", () => {
    expect(pivotStatusFor({ loading: true, arrowTable: { numRows: 1 } })).toEqual({
      className: "pivot-status",
      text: "Loading Pivot source…",
    });
    expect(pivotStatusFor({ error: "Source unavailable" })).toEqual({
      className: "pivot-status error",
      text: "Source unavailable",
    });
  });
});