// Pivot configuration is applied immediately to the loaded Arrow data.
// Only Refresh re-queries the source; editing the configuration does not.
export function pivotStatusFor(tab) {
  if (tab.error) return { className: "pivot-status error", text: tab.error };
  if (tab.loading) {
    return { className: "pivot-status", text: "Loading Pivot source…" };
  }
  if (tab.arrowTable) {
    return {
      className: "pivot-status",
      text: `React Pivot · ${tab.arrowTable.numRows.toLocaleString()} Arrow rows loaded. Refresh to reload source data.`,
    };
  }
  return { className: "pivot-status", text: "Loading Pivot source…" };
}