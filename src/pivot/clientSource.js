import { MAX_ARROW_PAGE_SIZE } from "../data/arrowIpcConnector.ts";

export const DEFAULT_CLIENT_PIVOT_ROWS = 10_000;
export const CLIENT_PIVOT_ROW_LIMITS = [10_000, 50_000, 100_000, 500_000];

// DuckDB re-executes the source query for each LIMIT/OFFSET Arrow page. Without
// an ORDER BY, GROUP BY/UNION results can arrive in a different order on each
// execution, silently duplicating some rows and skipping others at page edges.
// Sort by every projected column so even duplicate dimension keys with different
// measures have a deterministic position (ties are identical Pivot records).
export function clientPivotSourceSql(quotedSourceName) {
  return `SELECT * FROM ${quotedSourceName} ORDER BY ALL`;
}

// Only count enough rows to tell whether the configured limit is exceeded.
export function clientPivotPreflightSql(quotedSourceName, rowLimit) {
  const limit = clientPivotRowLimit(rowLimit);
  return `SELECT COUNT(*) AS row_count FROM (SELECT 1 FROM ${quotedSourceName} LIMIT ${limit + 1}) AS pivot_source`;
}

export function checkClientPivotRowCount(rowCount, rowLimit) {
  const limit = clientPivotRowLimit(rowLimit);
  if (rowCount == null) throw new Error("Could not count Pivot source rows.");
  if (BigInt(rowCount) > BigInt(limit)) {
    throw new Error(
        `This Pivot source exceeds the ${limit.toLocaleString()} ` +
        "row client-side limit. Increase the limit in Settings or filter the source with a SQL View.",
    );
  }
}

export function clientPivotRowLimit(value) {
  const limit = Number(value);
  return CLIENT_PIVOT_ROW_LIMITS.includes(limit)
    ? limit
    : DEFAULT_CLIENT_PIVOT_ROWS;
}

// Keep each request within the backend's page cap, retaining Arrow types and
// checking the look-ahead row even when the configured limit is reached.
export async function fetchClientPivotSource(queryId, rowLimit, fetchPage) {
  const limit = clientPivotRowLimit(rowLimit);
  const pages = [];
  let rowCount = 0;

  while (rowCount < limit) {
    const page = await fetchPage({
      queryId,
      offset: rowCount,
      limit: Math.min(MAX_ARROW_PAGE_SIZE, limit - rowCount),
    });
    pages.push(page.table);
    rowCount += page.table.numRows;

    if (!page.hasMore) return pages[0].concat(...pages.slice(1));
    if (!page.table.numRows || rowCount === limit) {
      if (rowCount === limit) {
        checkClientPivotRowCount(limit + 1, limit);
      }
      throw new Error("Pivot source paging ended unexpectedly.");
    }
  }
}