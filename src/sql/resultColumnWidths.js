/** Keep the widths chosen for the first visible rows when virtual scrolling replaces them. */
export function lockResultColumnWidths(result, table) {
  if (!result.columnWidths) {
    if (!result.rows?.length) return;
    const headers = table.tHead?.rows[0]?.cells;
    if (!headers?.length) return;
    const widths = Array.from(headers, (header) => header.getBoundingClientRect().width);
    // A hidden result pane cannot be measured; retry when it becomes visible.
    if (widths.some((width) => !Number.isFinite(width) || width <= 0)) return;
    result.columnWidths = widths.map(Math.ceil);
  }

  const colgroup = document.createElement("colgroup");
  for (const width of result.columnWidths) {
    const col = document.createElement("col");
    col.style.width = `${width}px`;
    colgroup.appendChild(col);
  }
  table.prepend(colgroup);
  table.classList.add("sql-result-locked");
  table.style.tableLayout = "fixed";
  table.style.minWidth = "0";
  table.style.width = `${result.columnWidths.reduce((sum, width) => sum + width, 0)}px`;
}

export function resizeResultColumn(result, table, index, width) {
  if (!result.columnWidths || index < 0 || index >= result.columnWidths.length) return;
  result.columnWidths[index] = Math.max(48, Math.round(width));
  const col = table.querySelectorAll("col")[index];
  if (col) col.style.width = `${result.columnWidths[index]}px`;
  table.style.width = `${result.columnWidths.reduce((sum, value) => sum + value, 0)}px`;
}