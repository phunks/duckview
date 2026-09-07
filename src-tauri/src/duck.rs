use std::collections::HashMap;
use std::io::{copy, Write};
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::Mutex;

use duckdb::arrow::datatypes::{DataType, SchemaRef};
use duckdb::arrow::util::display::{ArrayFormatter, FormatOptions};
use duckdb::Connection;
use arrow::record_batch::RecordBatch;
use arrow_ipc::writer::StreamWriter;
use serde::Serialize;
use tauri::{ipc::Response, State};
use crate::{is_numeric, normalize_read_only_sql, quote_sql_string, Condition, FileCache, FilterSpec, SortSpec, CELL_MAX_CHARS, MAX_PAGE, SEARCH_CAP};

#[derive(Serialize, Clone)]
pub(crate) struct DuckTable {
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) is_view: bool,
}

#[derive(Serialize, Clone)]
pub(crate) struct DuckTableColumn {
    pub(crate) name: String,
    #[serde(rename = "type")]
    pub(crate) type_name: String,
}

#[derive(Serialize, Clone)]
pub(crate) struct QueryColumn {
    pub(crate) name: String,
    #[serde(rename = "type")]
    pub(crate) type_name: String,
    pub(crate) numeric: bool,
}

#[derive(Serialize)]
pub(crate) struct QueryStartResponse {
    pub(crate) query_id: String,
    pub(crate) columns: Vec<QueryColumn>,
}

#[derive(Serialize)]
pub(crate) struct QueryRowsResponse {
    rows: Vec<Vec<Option<String>>>,
    offset: usize,
    has_more: bool,
}

pub(crate) struct QuerySession {
    pub(crate) sql: String,
    pub(crate) column_count: usize,
}

pub(crate) struct DuckDbState {
    pub(crate) connection: Mutex<Connection>,
    pub(crate) tables_by_path: Mutex<HashMap<String, DuckTable>>,
    pub(crate) queries: Mutex<HashMap<String, QuerySession>>,
    pub(crate) next_query_id: AtomicU64,
}

impl DuckDbState {
    pub(crate) fn new() -> Result<Self, String> {
        let connection = Connection::open_in_memory()
            .map_err(|e| format!("Could not start DuckDB: {e}"))?;

        connection
            .execute_batch(
                "
                SET memory_limit = '2GiB';
                SET preserve_insertion_order = false;
                ",
            )
            .map_err(|e| format!("Could not configure DuckDB: {e}"))?;

        Ok(Self {
            connection: Mutex::new(connection),
            tables_by_path: Mutex::new(HashMap::new()),
            queries: Mutex::new(HashMap::new()),
            next_query_id: AtomicU64::new(1),
        })
    }
}

#[tauri::command]
pub(crate) fn configure_duckdb_memory_limit(
    duckdb: State<'_, DuckDbState>,
    memory_limit_mib: u64,
) -> Result<(), String> {
    const MIN_MEMORY_LIMIT_MIB: u64 = 512;
    const MAX_MEMORY_LIMIT_MIB: u64 = 65_536;

    if !(MIN_MEMORY_LIMIT_MIB..=MAX_MEMORY_LIMIT_MIB).contains(&memory_limit_mib) {
        return Err(format!(
            "DuckDB memory limit must be between {MIN_MEMORY_LIMIT_MIB} MiB and {MAX_MEMORY_LIMIT_MIB} MiB."
        ));
    }

    duckdb
        .connection
        .lock()
        .unwrap()
        .execute_batch(&format!("SET memory_limit = '{memory_limit_mib}MiB'"))
        .map_err(|error| format!("Could not configure DuckDB memory limit: {error}"))?;

    Ok(())
}

#[allow(unused)]
fn escape_like_pattern(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn condition_to_duckdb_sql(schema: &SchemaRef, cond: &Condition) -> Result<String, String> {
    if cond.column >= schema.fields().len() {
        return Err("Condition references an invalid column".to_string());
    }

    let field = schema.field(cond.column);
    let col = quote_sql_identifier(field.name());
    let col_text = format!("CAST({col} AS VARCHAR)");
    let value_lit = quote_sql_string(&cond.value);

    let sql = match cond.op.as_str() {
        "contains" => {
            if cond.case_sensitive {
                format!("contains({col_text}, {value_lit})")
            } else {
                format!("contains(lower({col_text}), lower({value_lit}))")
            }
        }
        "not_contains" => {
            if cond.case_sensitive {
                format!("NOT contains({col_text}, {value_lit})")
            } else {
                format!("NOT contains(lower({col_text}), lower({value_lit}))")
            }
        }
        "starts_with" => {
            if cond.case_sensitive {
                format!("starts_with({col_text}, {value_lit})")
            } else {
                format!("starts_with(lower({col_text}), lower({value_lit}))")
            }
        }
        "ends_with" => {
            if cond.case_sensitive {
                format!("ends_with({col_text}, {value_lit})")
            } else {
                format!("ends_with(lower({col_text}), lower({value_lit}))")
            }
        }
        "equals" => {
            if cond.case_sensitive {
                format!("{col_text} = {value_lit}")
            } else {
                format!("LOWER({col_text}) = LOWER({value_lit})")
            }
        }
        "not_equals" => {
            if cond.case_sensitive {
                format!("{col_text} <> {value_lit}")
            } else {
                format!("LOWER({col_text}) <> LOWER({value_lit})")
            }
        }
        "regex" => {
            let pattern = if cond.case_sensitive {
                cond.value.clone()
            } else {
                format!("(?i){}", cond.value)
            };
            regex::Regex::new(&pattern).map_err(|e| format!("Invalid regex: {e}"))?;
            format!("REGEXP_MATCHES({col_text}, {})", quote_sql_string(&pattern))
        }
        "gt" | "gte" | "lt" | "lte" => {
            let op = match cond.op.as_str() {
                "gt" => ">",
                "gte" => ">=",
                "lt" => "<",
                _ => "<=",
            };
            if is_numeric(field.data_type()) {
                format!("TRY_CAST({col} AS DOUBLE) {op} TRY_CAST({value_lit} AS DOUBLE)")
            } else {
                format!("{col_text} {op} {value_lit}")
            }
        }
        "is_null" | "is_empty" => format!("{col} IS NULL"),
        "is_not_null" | "is_not_empty" => format!("{col} IS NOT NULL"),
        other => return Err(format!("Unknown operator: {other}")),
    };

    Ok(sql)
}

fn numbered_projection_sql(schema: &SchemaRef, conditions: &[Condition]) -> Result<String, String> {
    let mut cols: Vec<usize> = conditions.iter().map(|c| c.column).collect();
    cols.sort_unstable();
    cols.dedup();

    let mut projection = Vec::with_capacity(cols.len() + 1);
    projection.push("row_number() OVER () - 1 AS idx".to_string());

    for col_idx in cols {
        if col_idx >= schema.fields().len() {
            return Err("Condition references an invalid column".to_string());
        }
        let field = schema.field(col_idx);
        projection.push(quote_sql_identifier(field.name()));
    }

    Ok(projection.join(", "))
}

pub(crate) fn run_filter_duckdb(
    duckdb: &DuckDbState,
    cache: &FileCache,
    path: &str,
    filter: &FilterSpec,
) -> Result<(Vec<u32>, bool), String> {
    let (conditions, any) = match filter {
        FilterSpec::Advanced { conditions, combine } => {
            (conditions, combine.eq_ignore_ascii_case("or"))
        }
    };

    if conditions.is_empty() {
        return Ok((Vec::new(), false));
    }

    let predicates: Vec<String> = conditions
        .iter()
        .map(|c| condition_to_duckdb_sql(&cache.schema, c))
        .collect::<Result<_, _>>()?;

    let joiner = if any { " OR " } else { " AND " };
    let where_sql = predicates.join(joiner);

    let table_sql = duckdb
        .tables_by_path
        .lock()
        .unwrap()
        .get(path)
        .map(|t| quote_sql_identifier(&t.name))
        .unwrap_or_else(|| format!("read_parquet({})", quote_sql_string(path)));

    let projection_sql = numbered_projection_sql(&cache.schema, conditions)?;

    let sql = format!(
        "SELECT idx FROM (
            SELECT {projection_sql}
            FROM {table_sql}
         ) duckview_rows
         WHERE {where_sql}
         LIMIT {}",
        SEARCH_CAP + 1
    );

    let connection = duckdb.connection.lock().unwrap();
    let mut stmt = connection
        .prepare(&sql)
        .map_err(|e| format!("DuckDB filter SQL error: {e}"))?;

    let mut rows = stmt
        .query([])
        .map_err(|e| format!("DuckDB filter SQL error: {e}"))?;

    let mut out = Vec::<u32>::new();
    while let Some(row) = rows.next().map_err(|e| format!("DuckDB filter SQL error: {e}"))? {
        let idx: i64 = row
            .get(0)
            .map_err(|e| format!("Could not read filter row index: {e}"))?;
        if !(0..=u32::MAX as i64).contains(&idx) {
            return Err("Row index out of supported range".to_string());
        }
        out.push(idx as u32);
    }

    let truncated = out.len() > SEARCH_CAP;
    if truncated {
        out.truncate(SEARCH_CAP);
    }

    Ok((out, truncated))
}

#[allow(unused)]
pub(crate) fn run_sort_duckdb(
    duckdb: &DuckDbState,
    cache: &FileCache,
    path: &str,
    spec: &SortSpec,
) -> Result<Vec<u32>, String> {
    if spec.column >= cache.schema.fields().len() {
        return Err("Sort column is out of range".to_string());
    }

    let field = cache.schema.field(spec.column);
    let sort_col = quote_sql_identifier(field.name());

    let table_sql = duckdb
        .tables_by_path
        .lock()
        .unwrap()
        .get(path)
        .map(|t| quote_sql_identifier(&t.name))
        .unwrap_or_else(|| format!("read_parquet({})", quote_sql_string(path)));

    let direction = if spec.ascending { "ASC" } else { "DESC" };

    let sql = format!(
        "SELECT idx FROM (
            SELECT row_number() OVER () - 1 AS idx, {sort_col}
            FROM {table_sql}
         ) duckview_rows
         ORDER BY {sort_col} {direction} NULLS LAST"
    );

    let connection = duckdb.connection.lock().unwrap();
    let mut stmt = connection
        .prepare(&sql)
        .map_err(|e| format!("DuckDB sort SQL error: {e}"))?;

    let mut rows = stmt
        .query([])
        .map_err(|e| format!("DuckDB sort SQL error: {e}"))?;

    let mut out = Vec::<u32>::with_capacity(cache.num_rows);
    while let Some(row) = rows.next().map_err(|e| format!("DuckDB sort SQL error: {e}"))? {
        let idx: i64 = row
            .get(0)
            .map_err(|e| format!("Could not read sort row index: {e}"))?;
        if !(0..=u32::MAX as i64).contains(&idx) {
            return Err("Row index out of supported range".to_string());
        }
        out.push(idx as u32);
    }

    if out.len() != cache.num_rows {
        return Err(format!(
            "Unexpected sorted index count: expected {}, got {}",
            cache.num_rows,
            out.len()
        ));
    }

    Ok(out)
}

#[tauri::command]
pub(crate) async fn export_duckdb_query(
    app: tauri::AppHandle,
    duckdb: State<'_, DuckDbState>,
    query_id: String,
    format: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (extension, copy_options, write_utf8_bom) = match format.as_str() {
        "csv" => ("csv", "FORMAT CSV, HEADER TRUE", false),
        "csv_excel" => ("csv", "FORMAT CSV, HEADER TRUE", true),
        "parquet" => ("parquet", "FORMAT PARQUET, COMPRESSION ZSTD", false),
        "json" => ("json", "FORMAT JSON", false),
        _ => return Err("Unsupported export format.".to_string()),
    };

    let sql = duckdb
        .queries
        .lock()
        .unwrap()
        .get(&query_id)
        .map(|query| query.sql.clone())
        .ok_or("Query result is no longer available. Run the query again.")?;

    let output_path = app
        .dialog()
        .file()
        .add_filter(format.to_uppercase(), &[extension])
        .set_file_name(format!("query-result.{extension}"))
        .blocking_save_file()
        .and_then(|file| file.into_path().ok());

    let Some(output_path) = output_path else {
        return Ok(None);
    };

    let export_path = if write_utf8_bom {
        std::env::temp_dir().join(format!(
            "duckview-export-{}-{}.csv",
            std::process::id(),
            duckdb.next_query_id.fetch_add(1, AtomicOrdering::Relaxed)
        ))
    } else {
        output_path.clone()
    };

    let copy_sql = format!(
        "COPY ({sql}) TO {} WITH ({copy_options})",
        quote_sql_string(&export_path.to_string_lossy())
    );

    let export_result = duckdb
        .connection
        .lock()
        .unwrap()
        .execute_batch(&copy_sql);

    if let Err(error) = export_result {
        if write_utf8_bom {
            let _ = std::fs::remove_file(&export_path);
        }
        return Err(format!("Export failed: {error}"));
    }

    if write_utf8_bom {
        let bom_result = (|| -> Result<(), String> {
            let mut source = std::fs::File::open(&export_path)
                .map_err(|error| format!("Could not read temporary CSV: {error}"))?;
            let mut destination = std::fs::File::create(&output_path)
                .map_err(|error| format!("Could not create CSV file: {error}"))?;

            destination
                .write_all(b"\xEF\xBB\xBF")
                .map_err(|error| format!("Could not write UTF-8 BOM: {error}"))?;
            copy(&mut source, &mut destination)
                .map_err(|error| format!("Could not write CSV file: {error}"))?;

            Ok(())
        })();

        let _ = std::fs::remove_file(&export_path);
        bom_result?;
    }

    Ok(Some(output_path.to_string_lossy().to_string()))
}

fn quote_sql_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

#[tauri::command]
pub(crate) fn register_duckdb_query_as_table(
    duckdb: State<'_, DuckDbState>,
    query_id: String,
    table_name: String,
) -> Result<DuckTable, String> {
    let table_name = table_name.trim().to_string();
    if table_name.is_empty() {
        return Err("A table name is required.".to_string());
    }

    let sql = duckdb
        .queries
        .lock()
        .unwrap()
        .get(&query_id)
        .map(|query| query.sql.clone())
        .ok_or("Query result is no longer available. Run the query again.")?;

    register_duckdb_sql_as_view_inner(&duckdb, table_name, sql)
}

#[tauri::command]
pub(crate) fn restore_duckdb_view(
    duckdb: State<'_, DuckDbState>,
    view_name: String,
    sql: String,
) -> Result<DuckTable, String> {
    let view_name = view_name.trim().to_string();
    if view_name.is_empty() {
        return Err("A view name is required.".to_string());
    }

    let sql = normalize_read_only_sql(&sql)?;
    register_duckdb_sql_as_view_inner(&duckdb, view_name, sql)
}

fn register_duckdb_sql_as_view_inner(
    duckdb: &DuckDbState,
    table_name: String,
    sql: String,
) -> Result<DuckTable, String> {
    let base_name = table_name.trim();

    if base_name.is_empty() {
        return Err("A table name is required.".to_string());
    }

    let mut tables = duckdb.tables_by_path.lock().unwrap();
    let mut unique_name = base_name.to_string();
    let mut suffix = 2usize;

    while tables
        .values()
        .any(|existing| existing.name == unique_name)
    {
        unique_name = format!("{base_name}_{suffix}");
        suffix += 1;
    }

    let table = DuckTable {
        name: unique_name.clone(),
        path: "SQL result".to_string(),
        is_view: true,
    };

    let create_view = format!(
        "CREATE TEMP VIEW {} AS {sql}",
        quote_sql_identifier(&unique_name),
    );

    duckdb
        .connection
        .lock()
        .unwrap()
        .execute_batch(&create_view)
        .map_err(|error| format!("Could not create view: {error}"))?;

    tables.insert(format!("sql-result:{unique_name}"), table.clone());

    Ok(table)
}

#[tauri::command]
pub(crate) fn remove_duckdb_result_table(
    duckdb: State<'_, DuckDbState>,
    table_name: String,
) -> Result<(), String> {
    let key = format!("sql-result:{table_name}");

    {
        let tables = duckdb.tables_by_path.lock().unwrap();
        if !tables.contains_key(&key) {
            return Ok(());
        }
    }

    let drop_view = format!(
        "DROP VIEW IF EXISTS {}",
        quote_sql_identifier(&table_name),
    );

    duckdb
        .connection
        .lock()
        .unwrap()
        .execute_batch(&drop_view)
        .map_err(|error| format!("Could not remove result view: {error}"))?;

    duckdb.tables_by_path.lock().unwrap().remove(&key);

    Ok(())
}

#[tauri::command]
pub(crate) fn list_duckdb_tables(duckdb: State<'_, DuckDbState>) -> Vec<DuckTable> {
    duckdb
        .tables_by_path
        .lock()
        .unwrap()
        .values()
        .cloned()
        .collect()
}

#[tauri::command]
pub(crate) fn get_duckdb_table_columns(
    duckdb: State<'_, DuckDbState>,
    table_name: String,
) -> Result<Vec<DuckTableColumn>, String> {
    let table_name = table_name.trim().to_string();

    if table_name.is_empty() {
        return Err("A table name is required.".to_string());
    }

    let sql = format!("DESCRIBE {}", quote_sql_identifier(&table_name));
    let connection = duckdb.connection.lock().unwrap();
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("Could not describe table \"{table_name}\": {error}"))?;

    let mut rows = statement
        .query([])
        .map_err(|error| format!("Could not read table \"{table_name}\": {error}"))?;

    let mut columns = Vec::new();

    while let Some(row) = rows
        .next()
        .map_err(|error| format!("Could not read table \"{table_name}\": {error}"))?
    {
        columns.push(DuckTableColumn {
            name: row
                .get(0)
                .map_err(|error| format!("Could not read column name: {error}"))?,
            type_name: row
                .get(1)
                .map_err(|error| format!("Could not read column type: {error}"))?,
        });
    }

    Ok(columns)
}

#[tauri::command]
pub(crate) fn execute_duckdb_query(
    duckdb: State<'_, DuckDbState>,
    sql: String,
) -> Result<QueryStartResponse, String> {
    let sql = normalize_read_only_sql(&sql)?;
    let probe_sql = format!("SELECT * FROM ({sql}) AS duckview_result LIMIT 0");

    let connection = duckdb.connection.lock().unwrap();
    let mut statement = connection
        .prepare(&probe_sql)
        .map_err(|e| format!("SQL error: {e}"))?;

    {
        let rows = statement
            .query([])
            .map_err(|e| format!("SQL error: {e}"))?;
        drop(rows);
    }

    let columns: Vec<_> = statement
        .column_names()
        .iter()
        .map(|name| QueryColumn {
            name: name.to_string(),
            type_name: "value".to_string(),
            numeric: false,
        })
        .collect();

    drop(statement);
    drop(connection);

    let query_id = format!(
        "query-{}",
        duckdb.next_query_id.fetch_add(1, AtomicOrdering::Relaxed)
    );

    let column_count = columns.len();

    duckdb
        .queries
        .lock()
        .unwrap()
        .insert(
            query_id.clone(),
            QuerySession {
                sql,
                column_count,
            },
        );

    Ok(QueryStartResponse { query_id, columns })
}

fn format_arrow_cell(
    formatter: &ArrayFormatter<'_>,
    data_type: &DataType,
    row: usize,
) -> String {
    match data_type {
        DataType::List(_) | DataType::LargeList(_) | DataType::FixedSizeList(_, _) => {
            formatter.value(row).to_string()
        }
        _ => formatter.value(row).to_string(),
    }
}

#[tauri::command]
pub(crate) fn get_duckdb_query_rows_arrow(
    duckdb: State<'_, DuckDbState>,
    query_id: String,
    offset: usize,
    limit: usize,
) -> Result<Response, String> {
    let limit = limit.min(MAX_PAGE);

    let sql = duckdb
        .queries
        .lock()
        .unwrap()
        .get(&query_id)
        .map(|query| query.sql.clone())
        .ok_or("Query result is no longer available.")?;
    
    let fetch_limit = limit.saturating_add(1);
    let page_sql = format!(
        "SELECT * FROM ({sql}) AS duckview_result LIMIT {fetch_limit} OFFSET {offset}"
    );

    let connection = duckdb.connection.lock().unwrap();
    let mut statement = connection
        .prepare(&page_sql)
        .map_err(|error| format!("SQL error: {error}"))?;

    let arrow_started = std::time::Instant::now();

    let batches = statement
        .query_arrow([])
        .map_err(|error| format!("SQL error: {error}"))?;

    let arrow_iterator_ready = std::time::Instant::now();

    let batches: Vec<RecordBatch> = batches.collect();

    let arrow_batches_ready = std::time::Instant::now();

    eprintln!(
        "[duckview] DuckDB Arrow: create-iterator={} ms, collect-batches={} ms",
        arrow_iterator_ready.duration_since(arrow_started).as_millis(),
        arrow_batches_ready.duration_since(arrow_iterator_ready).as_millis(),
    );

    let schema = batches
        .first()
        .map(|batch| batch.schema())
        .ok_or("Could not determine the Arrow schema for this result.")?;

    let mut bytes = Vec::new();
    let ipc_started = std::time::Instant::now();

    {
        let mut writer = StreamWriter::try_new(&mut bytes, schema.as_ref())
            .map_err(|error| format!("Could not encode Arrow IPC stream: {error}"))?;

        for batch in &batches {
            writer
                .write(batch)
                .map_err(|error| format!("Could not encode Arrow batch: {error}"))?;
        }

        writer
            .finish()
            .map_err(|error| format!("Could not finish Arrow IPC stream: {error}"))?;
    }

    eprintln!(
        "[duckview] Arrow page: batches={}, rows={}, ipc-encode={} ms, payload={:.2} MiB",
        batches.len(),
        batches.iter().map(RecordBatch::num_rows).sum::<usize>(),
        // query_finished.duration_since(query_started).as_millis(),
        ipc_started.elapsed().as_millis(),
        bytes.len() as f64 / (1024.0 * 1024.0),
    );

    Ok(Response::new(bytes))
}

#[tauri::command]
pub(crate) fn get_duckdb_query_rows(
    duckdb: State<'_, DuckDbState>,
    query_id: String,
    offset: usize,
    limit: usize,
) -> Result<QueryRowsResponse, String> {
    let limit = limit.min(MAX_PAGE);

    let (sql, column_count) = duckdb
        .queries
        .lock()
        .unwrap()
        .get(&query_id)
        .map(|query| (query.sql.clone(), query.column_count))
        .ok_or("Query result is no longer available.")?;

    let fetch_limit = limit + 1;
    let page_sql = format!(
        "SELECT * FROM ({sql}) AS duckview_result LIMIT {fetch_limit} OFFSET {offset}"
    );

    let connection = duckdb.connection.lock().unwrap();
    let mut statement = connection
        .prepare(&page_sql)
        .map_err(|e| format!("SQL error: {e}"))?;

    let batches = statement
        .query_arrow([])
        .map_err(|e| format!("SQL error: {e}"))?;

    let options = FormatOptions::default().with_null("");
    let mut rows = Vec::with_capacity(limit + 1);

    for batch in batches {
        let formatters: Vec<ArrayFormatter<'_>> = (0..batch.num_columns())
            .map(|column| {
                ArrayFormatter::try_new(batch.column(column).as_ref(), &options)
                    .map_err(|e| format!("Formatting error: {e}"))
            })
            .collect::<Result<_, _>>()?;

        for row in 0..batch.num_rows() {
            let mut values = Vec::with_capacity(column_count);

            for column in 0..column_count {
                let array = batch.column(column);

                if array.is_null(row) {
                    values.push(None);
                    continue;
                }

                let value = format_arrow_cell(
                    &formatters[column],
                    array.data_type(),
                    row,
                );

                let value = if value.chars().count() > CELL_MAX_CHARS {
                    let mut truncated: String = value.chars().take(CELL_MAX_CHARS).collect();
                    truncated.push('…');
                    truncated
                } else {
                    value
                };

                values.push(Some(value));
            }

            rows.push(values);

            if rows.len() > limit {
                break;
            }
        }

        if rows.len() > limit {
            break;
        }
    }

    let has_more = rows.len() > limit;
    rows.truncate(limit);

    Ok(QueryRowsResponse {
        rows,
        offset,
        has_more,
    })
}