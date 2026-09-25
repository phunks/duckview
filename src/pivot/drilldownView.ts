import { getEffectiveDateGrain, type CellClickPayload, type ColumnTypeMap, type DateGrain, type PivotConfigV1 } from "../ext/streamlit-pivot-table/streamlit_pivot/frontend/src/engine/types";

const identifier = (value: string) => `"${value.replace(/"/g, '""')}"`;
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

export function drilldownViewName(source: string, filters: Record<string, string>, config?: PivotConfigV1): string {
  const parts = Object.entries(filters).flatMap(([field, value]) => [field, value]);
  for (const [field, filter] of Object.entries(config?.filters ?? {})) {
    if (filter.include?.length) parts.push(field, ...filter.include);
    else if (filter.exclude?.length) parts.push(field, "not", ...filter.exclude);
  }
  const clean = (value: string) => value.replace(/[^\p{L}\p{N}_-]+/gu, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "empty";
  return [source, ...(parts.length ? parts : ["all_records"])].map(clean).join("_").slice(0, 160);
}

/** Match the keys used by PivotData._resolveDimKey, against the entire parent source. */
function dimensionKey(field: string, config: PivotConfigV1, columnTypes: ColumnTypeMap, adaptiveDateGrains?: Record<string, DateGrain>): string {
  const column = identifier(field);
  const type = columnTypes.get(field);
  const grain = getEffectiveDateGrain(config, field, type, adaptiveDateGrains?.[field]);
  let value = `CAST(${column} AS VARCHAR)`;
  if (type === "date" || type === "datetime") {
    const formats = {
      year: "%Y", quarter: null, month: "%Y-%m", week: "%G-W%V", day: "%Y-%m-%d",
    } as const;
    if (grain === "quarter") {
      value = `concat(strftime(${column}, '%Y'), '-Q', CAST(quarter(${column}) AS VARCHAR))`;
    } else if (grain) {
      value = `strftime(${column}, '${formats[grain]}')`;
    } else {
      value = type === "date"
        ? `strftime(${column}, '%Y-%m-%d')`
        : `strftime(${column}, '%Y-%m-%dT%H:%M:%S.') || substr(strftime(${column}, '%f'), 1, 3) || 'Z'`;
    }
  }
  // Pivot treats both SQL NULL and the empty string as a null dimension.
  return `CASE WHEN ${column} IS NULL OR CAST(${column} AS VARCHAR) = '' THEN '' ELSE ${value} END`;
}

export function drilldownViewSql(
  source: string,
  payload: CellClickPayload,
  config: PivotConfigV1,
  columnTypes: ColumnTypeMap,
  availableColumns: readonly string[],
  adaptiveDateGrains?: Record<string, DateGrain>,
): string {
  const available = new Set(availableColumns);
  const clauses: string[] = [];
  const key = (field: string) => {
    if (!available.has(field)) throw new Error(`Pivot field “${field}” is no longer in the parent source.`);
    return dimensionKey(field, config, columnTypes, adaptiveDateGrains);
  };
  for (const [field, filter] of Object.entries(config.filters ?? {})) {
    if (!filter.include?.length && !filter.exclude?.length) continue;
    const expr = key(field);
    if (filter.include?.length) {
      clauses.push(`${expr} IN (${filter.include.map(literal).join(", ")})`);
    } else if (filter.exclude?.length) {
      clauses.push(`${expr} NOT IN (${filter.exclude.map(literal).join(", ")})`);
    }
  }
  for (const [field, value] of Object.entries(payload.filters)) {
    const expr = key(field);
    const group = config.member_groups?.find((entry) => entry.field === field && entry.name === value);
    if (group) {
      clauses.push(`${expr} IN (${group.members.map(literal).join(", ") || "NULL"})`);
    } else {
      clauses.push(`${expr} = ${literal(value)}`);
    }
  }
  return `SELECT * FROM ${identifier(source)}${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""}`;
}