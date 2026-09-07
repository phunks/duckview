// Prevents an extra console window on Windows in release. No effect on macOS.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod duck;

use std::cmp::Ordering;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::sync::Mutex;

use duckdb::arrow::array::{new_empty_array, Array, ArrayRef, UInt32Array};
use duckdb::arrow::compute::{concat, sort_to_indices, take, SortOptions};
use duckdb::arrow::datatypes::{DataType, SchemaRef};
use duckdb::arrow::record_batch::RecordBatch;
use duckdb::arrow::util::display::{ArrayFormatter, FormatOptions};

use parquet::arrow::arrow_reader::{
    ArrowReaderMetadata,
    ArrowReaderOptions,
    ParquetRecordBatchReaderBuilder,
    RowSelection,
    RowSelector,
};
use parquet::arrow::ProjectionMask;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};
use crate::duck::{configure_duckdb_memory_limit, execute_duckdb_query, export_duckdb_query, get_duckdb_query_rows, get_duckdb_query_rows_arrow, get_duckdb_table_columns, list_duckdb_tables, register_duckdb_query_as_table, remove_duckdb_result_table, restore_duckdb_view, run_filter_duckdb, run_sort_duckdb, DuckDbState, DuckTable};

// Cap on how many matching rows a search will collect, to bound memory/time on
// huge files. Beyond this the result set is marked truncated.
const SEARCH_CAP: usize = 100_000;

// Upper bound on rows fetched in a single `get_rows` call (defense in depth
// against an over-large `limit`).
const MAX_PAGE: usize = 10_000;

// Cap on a single rendered cell's length, so a huge binary/blob value can't
// produce a multi-megabyte string in the UI.
const CELL_MAX_CHARS: usize = 2_000;

// ---------------------------------------------------------------------------
// Types serialized to the frontend
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
struct ColumnInfo {
    name: String,
    #[serde(rename = "type")]
    type_name: String,
    numeric: bool,
}

#[derive(Serialize, Clone)]
struct FileMeta {
    path: String,
    file_name: String,
    file_size: u64,
    num_rows: i64,
    num_columns: usize,
    num_row_groups: usize,
    compression: String,
    created_by: Option<String>,
    version: i32,
    columns: Vec<ColumnInfo>,
}

#[derive(Deserialize, Clone, PartialEq)]
struct SortSpec {
    column: usize,
    ascending: bool,
}

/// One condition of an advanced filter, e.g. column 3 "gt" "500".
#[derive(Deserialize, Clone, PartialEq)]
struct Condition {
    column: usize,
    /// One of: contains, not_contains, equals, not_equals, starts_with,
    /// ends_with, regex, gt, gte, lt, lte, is_null, is_not_null.
    op: String,
    #[serde(default)]
    value: String,
    #[serde(default)]
    case_sensitive: bool,
}

#[derive(Deserialize, Clone, PartialEq)]
#[serde(tag = "mode", rename_all = "lowercase")]
enum FilterSpec {
    /// A set of conditions combined with AND (`combine = "and"`) or OR.
    Advanced {
        conditions: Vec<Condition>,
        #[serde(default = "default_combine")]
        combine: String,
    },
}

fn default_combine() -> String {
    "and".to_string()
}

impl FilterSpec {
    fn is_active(&self) -> bool {
        match self {
            FilterSpec::Advanced { conditions, .. } => !conditions.is_empty(),
        }
    }
}

#[derive(Serialize)]
struct RowsResponse {
    rows: Vec<Vec<Option<String>>>,
    /// Global (file) row index for each returned row, in display order. Lets the
    /// frontend pin per-cell edits to a stable row regardless of sort/filter.
    indices: Vec<u32>,
    total_rows: usize,
    offset: usize,
    /// True when an active filter hit the SEARCH_CAP and results are partial.
    truncated: bool,
}

// ---------------------------------------------------------------------------
// Backend state
// ---------------------------------------------------------------------------

struct FileCache {
    /// Parsed footer/schema, loaded once so paging never re-reads it.
    meta: ArrowReaderMetadata,
    schema: SchemaRef,
    num_rows: usize,
    num_columns: usize,
    /// Sorted permutation of global row indices for the active sort.
    sort_cache: Option<(SortSpec, Vec<u32>)>,
    /// Matching global row indices for the active filter (+ truncated flag).
    filter_cache: Option<(FilterSpec, Vec<u32>, bool)>,
    /// Fully materialized single columns, kept for sorting.
    column_cache: HashMap<usize, ArrayRef>,
}

#[derive(Default)]
struct AppState {
    files: Mutex<HashMap<String, FileCache>>,
    /// A file passed at launch (CLI arg or macOS "Open With") awaiting pickup.
    pending_open: Mutex<Option<String>>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn load_metadata(path: &str) -> Result<ArrowReaderMetadata, String> {
    let file = File::open(path).map_err(|e| format!("Cannot open file: {e}"))?;
    let opts = ArrowReaderOptions::new();
    ArrowReaderMetadata::load(&file, opts).map_err(|e| format!("Not a valid Parquet file: {e}"))
}

fn friendly_type(dt: &DataType) -> String {
    use DataType::*;
    match dt {
        Boolean => "bool".into(),
        Int8 => "int8".into(),
        Int16 => "int16".into(),
        Int32 => "int32".into(),
        Int64 => "int64".into(),
        UInt8 => "uint8".into(),
        UInt16 => "uint16".into(),
        UInt32 => "uint32".into(),
        UInt64 => "uint64".into(),
        Float16 | Float32 => "float".into(),
        Float64 => "double".into(),
        Utf8 | LargeUtf8 => "string".into(),
        Binary | LargeBinary | FixedSizeBinary(_) => "binary".into(),
        Date32 | Date64 => "date".into(),
        Time32(_) | Time64(_) => "time".into(),
        Timestamp(_, _) => "timestamp".into(),
        Decimal128(_, _) | Decimal256(_, _) => "decimal".into(),
        List(_) | LargeList(_) | FixedSizeList(_, _) => "list".into(),
        Struct(_) => "struct".into(),
        Map(_, _) => "map".into(),
        other => format!("{other:?}").to_lowercase(),
    }
}

fn is_numeric(dt: &DataType) -> bool {
    use DataType::*;
    matches!(
        dt,
        Int8 | Int16
            | Int32
            | Int64
            | UInt8
            | UInt16
            | UInt32
            | UInt64
            | Float16
            | Float32
            | Float64
            | Decimal128(_, _)
            | Decimal256(_, _)
    )
}

/// Turns a batch into rows of stringified cells, appending to `out`.
/// Nulls become `None` so the frontend can style them distinctly.
fn append_batch_rows(
    batch: &RecordBatch,
    out: &mut Vec<Vec<Option<String>>>,
) -> Result<(), String> {
    let opts = FormatOptions::default().with_null("");
    let ncols = batch.num_columns();
    let formatters: Vec<ArrayFormatter> = (0..ncols)
        .map(|c| ArrayFormatter::try_new(batch.column(c).as_ref(), &opts))
        .collect::<Result<_, _>>()
        .map_err(|e| format!("Formatting error: {e}"))?;

    for row in 0..batch.num_rows() {
        let mut record = Vec::with_capacity(ncols);
        for (c, _item) in formatters.iter().enumerate().take(ncols) {
            if batch.column(c).is_null(row) {
                record.push(None);
            } else {
                let v = formatters[c].value(row).to_string();
                let v = if v.chars().count() > CELL_MAX_CHARS {
                    let mut t: String = v.chars().take(CELL_MAX_CHARS).collect();
                    t.push('…');
                    t
                } else {
                    v
                };
                record.push(Some(v));
            }
        }
        out.push(record);
    }
    Ok(())
}

/// Reads a contiguous window `[offset, offset+limit)` in file order. This skips
/// entire row groups that fall before `offset`, so it stays cheap deep into
/// huge files.
fn read_contiguous(
    meta: &ArrowReaderMetadata,
    path: &str,
    offset: usize,
    limit: usize,
) -> Result<Vec<Vec<Option<String>>>, String> {
    if limit == 0 {
        return Ok(vec![]);
    }
    let file = File::open(path).map_err(|e| format!("Cannot open file: {e}"))?;
    let reader = ParquetRecordBatchReaderBuilder::new_with_metadata(file, meta.clone())
        .with_offset(offset)
        .with_limit(limit)
        .with_batch_size(limit)
        .build()
        .map_err(|e| format!("Read error: {e}"))?;

    let mut out = Vec::with_capacity(limit);
    for batch in reader {
        let batch = batch.map_err(|e| format!("Read error: {e}"))?;
        append_batch_rows(&batch, &mut out)?;
    }
    Ok(out)
}

/// Builds a RowSelection selecting exactly the given ascending, unique row
/// indices (skip the gaps, select the hits).
fn selection_for(indices: &[u32]) -> RowSelection {
    let mut selectors = Vec::new();
    let mut cursor: u32 = 0;
    let mut run: u32 = 0;
    for &g in indices {
        if g > cursor {
            if run > 0 {
                selectors.push(RowSelector::select(run as usize));
                run = 0;
            }
            selectors.push(RowSelector::skip((g - cursor) as usize));
        }
        run += 1;
        cursor = g + 1;
    }
    if run > 0 {
        selectors.push(RowSelector::select(run as usize));
    }
    RowSelection::from(selectors)
}

/// Reads an arbitrary set of (possibly scattered) global row indices, returned
/// in the same order as `page`. Uses a RowSelection so only the pages holding
/// those rows are decoded.
fn read_scattered(
    meta: &ArrowReaderMetadata,
    path: &str,
    page: &[u32],
) -> Result<Vec<Vec<Option<String>>>, String> {
    if page.is_empty() {
        return Ok(vec![]);
    }
    // Sort by file position (required for RowSelection) while remembering each
    // row's display position so we can restore the requested order afterward.
    let mut ordered: Vec<(u32, usize)> =
        page.iter().enumerate().map(|(pos, &g)| (g, pos)).collect();
    ordered.sort_by_key(|(g, _)| *g);
    let sorted_global: Vec<u32> = ordered.iter().map(|(g, _)| *g).collect();

    let file = File::open(path).map_err(|e| format!("Cannot open file: {e}"))?;
    let reader = ParquetRecordBatchReaderBuilder::new_with_metadata(file, meta.clone())
        .with_row_selection(selection_for(&sorted_global))
        .with_batch_size(sorted_global.len())
        .build()
        .map_err(|e| format!("Read error: {e}"))?;

    let mut file_order = Vec::with_capacity(sorted_global.len());
    for batch in reader {
        let batch = batch.map_err(|e| format!("Read error: {e}"))?;
        append_batch_rows(&batch, &mut file_order)?;
    }
    if file_order.len() != ordered.len() {
        return Err("Row selection returned an unexpected count".into());
    }

    // Scatter back into requested (display) order.
    let mut result: Vec<Vec<Option<String>>> = vec![Vec::new(); page.len()];
    for (k, (_, disp_pos)) in ordered.into_iter().enumerate() {
        result[disp_pos] = std::mem::take(&mut file_order[k]);
    }
    Ok(result)
}

/// Loads one full column (all row groups, projected to just that column) as a
/// single contiguous array. Memory scales with one column, not the whole file.
fn load_full_column(
    cache: &mut FileCache,
    path: &str,
    col: usize,
) -> Result<ArrayRef, String> {
    if let Some(a) = cache.column_cache.get(&col) {
        return Ok(a.clone());
    }
    let descr = cache.meta.metadata().file_metadata().schema_descr();
    let mask = ProjectionMask::roots(descr, [col]);
    let file = File::open(path).map_err(|e| format!("Cannot open file: {e}"))?;
    let reader = ParquetRecordBatchReaderBuilder::new_with_metadata(file, cache.meta.clone())
        .with_projection(mask)
        .with_batch_size(16384)
        .build()
        .map_err(|e| format!("Read error: {e}"))?;

    let mut arrays: Vec<ArrayRef> = Vec::new();
    for batch in reader {
        let batch = batch.map_err(|e| format!("Read error: {e}"))?;
        arrays.push(batch.column(0).clone());
    }
    let full: ArrayRef = if arrays.is_empty() {
        new_empty_array(cache.schema.field(col).data_type())
    } else {
        let refs: Vec<&dyn Array> = arrays.iter().map(|a| a.as_ref()).collect();
        concat(&refs).map_err(|e| format!("Concat error: {e}"))?
    };
    cache.column_cache.insert(col, full.clone());
    Ok(full)
}

/// Ensures `cache.sort_cache` holds a full-file permutation for `spec`.
fn ensure_sort(cache: &mut FileCache, path: &str, spec: &SortSpec) -> Result<(), String> {
    if cache.sort_cache.as_ref().map(|(s, _)| s == spec).unwrap_or(false) {
        return Ok(());
    }
    let col = load_full_column(cache, path, spec.column)?;
    let opts = SortOptions {
        descending: !spec.ascending,
        nulls_first: false,
    };
    let idx = sort_to_indices(col.as_ref(), Some(opts), None)
        .map_err(|e| format!("Sort error: {e}"))?;
    let perm: Vec<u32> = idx.values().to_vec();
    cache.sort_cache = Some((spec.clone(), perm));
    Ok(())
}

#[allow(unused)]
fn ensure_sort_with_duckdb(
    duckdb: &DuckDbState,
    cache: &mut FileCache,
    path: &str,
    spec: &SortSpec,
) -> Result<(), String> {
    if cache.sort_cache.as_ref().map(|(s, _)| s == spec).unwrap_or(false) {
        return Ok(());
    }

    match run_sort_duckdb(duckdb, cache, path, spec) {
        Ok(perm) => {
            cache.sort_cache = Some((spec.clone(), perm));
            Ok(())
        }
        Err(duck_err) => {
            eprintln!("[duckview] DuckDB sort failed, falling back to Arrow sort: {duck_err}");
            ensure_sort(cache, path, spec)
        }
    }
}

/// Sorts the given filtered global indices by column `spec.column`.
fn sort_filtered(
    cache: &mut FileCache,
    path: &str,
    filtered: &[u32],
    spec: &SortSpec,
) -> Result<Vec<u32>, String> {
    let col = load_full_column(cache, path, spec.column)?;
    let idx_arr = UInt32Array::from(filtered.to_vec());
    let sub = take(col.as_ref(), &idx_arr, None).map_err(|e| format!("Take error: {e}"))?;
    let opts = SortOptions {
        descending: !spec.ascending,
        nulls_first: false,
    };
    let order = sort_to_indices(sub.as_ref(), Some(opts), None)
        .map_err(|e| format!("Sort error: {e}"))?;
    Ok(order.values().iter().map(|&p| filtered[p as usize]).collect())
}

/// Dispatches a filter to the simple or advanced scanner.
fn run_filter(
    meta: &ArrowReaderMetadata,
    path: &str,
    num_columns: usize,
    filter: &FilterSpec,
) -> Result<(Vec<u32>, bool), String> {
    match filter {
        FilterSpec::Advanced {
            conditions,
            combine,
        } => run_advanced(
            meta,
            path,
            num_columns,
            conditions,
            combine.eq_ignore_ascii_case("or"),
        ),
    }
}


// A comparison/predicate operator for an advanced condition.
enum Op {
    Contains,
    NotContains,
    Equals,
    NotEquals,
    StartsWith,
    EndsWith,
    Regex,
    Gt,
    Gte,
    Lt,
    Lte,
    IsNull,
    IsNotNull,
}

/// A condition pre-processed for the row scan (regex compiled, needle cached).
struct Prepared {
    column: usize,
    op: Op,
    needle: String,
    regex: Option<regex::Regex>,
    case_sensitive: bool,
}

fn prepare(cond: &Condition) -> Result<Prepared, String> {
    let op = match cond.op.as_str() {
        "contains" => Op::Contains,
        "not_contains" => Op::NotContains,
        "equals" => Op::Equals,
        "not_equals" => Op::NotEquals,
        "starts_with" => Op::StartsWith,
        "ends_with" => Op::EndsWith,
        "regex" => Op::Regex,
        "gt" => Op::Gt,
        "gte" => Op::Gte,
        "lt" => Op::Lt,
        "lte" => Op::Lte,
        "is_null" | "is_empty" => Op::IsNull,
        "is_not_null" | "is_not_empty" => Op::IsNotNull,
        other => return Err(format!("Unknown operator: {other}")),
    };
    let regex = if matches!(op, Op::Regex) {
        Some(
            regex::RegexBuilder::new(&cond.value)
                .case_insensitive(!cond.case_sensitive)
                .build()
                .map_err(|e| format!("Invalid regex: {e}"))?,
        )
    } else {
        None
    };
    Ok(Prepared {
        column: cond.column,
        op,
        needle: cond.value.clone(),
        regex,
        case_sensitive: cond.case_sensitive,
    })
}

/// Compares two cell strings numerically when both parse as numbers, else
/// lexicographically.
fn compare_vals(a: &str, b: &str) -> Option<Ordering> {
    match (a.trim().parse::<f64>(), b.trim().parse::<f64>()) {
        (Ok(x), Ok(y)) => x.partial_cmp(&y),
        _ => Some(a.cmp(b)),
    }
}

/// Evaluates one prepared condition against a cell (`None` == null).
fn eval(p: &Prepared, cell: Option<&str>) -> bool {
    match p.op {
        Op::IsNull => return cell.is_none(),
        Op::IsNotNull => return cell.is_some(),
        _ => {}
    }
    let Some(s) = cell else { return false };
    match p.op {
        Op::Regex => p.regex.as_ref().map(|re| re.is_match(s)).unwrap_or(false),
        Op::Gt => matches!(compare_vals(s, &p.needle), Some(Ordering::Greater)),
        Op::Gte => matches!(
            compare_vals(s, &p.needle),
            Some(Ordering::Greater | Ordering::Equal)
        ),
        Op::Lt => matches!(compare_vals(s, &p.needle), Some(Ordering::Less)),
        Op::Lte => matches!(
            compare_vals(s, &p.needle),
            Some(Ordering::Less | Ordering::Equal)
        ),
        _ => {
            // String predicates, honoring case sensitivity.
            let (hay, needle) = if p.case_sensitive {
                (s.to_string(), p.needle.clone())
            } else {
                (s.to_lowercase(), p.needle.to_lowercase())
            };
            match p.op {
                Op::Contains => hay.contains(&needle),
                Op::NotContains => !hay.contains(&needle),
                Op::Equals => hay == needle,
                Op::NotEquals => hay != needle,
                Op::StartsWith => hay.starts_with(&needle),
                Op::EndsWith => hay.ends_with(&needle),
                _ => false,
            }
        }
    }
}

/// Streams the file and collects global indices of rows satisfying the given
/// conditions, combined with AND (default) or OR when `any` is true.
fn run_advanced(
    meta: &ArrowReaderMetadata,
    path: &str,
    num_columns: usize,
    conditions: &[Condition],
    any: bool,
) -> Result<(Vec<u32>, bool), String> {
    let prepared: Vec<Prepared> = conditions.iter().map(prepare).collect::<Result<_, _>>()?;
    for p in &prepared {
        if p.column >= num_columns {
            return Err("Condition references an invalid column".to_string());
        }
    }

    let file = File::open(path).map_err(|e| format!("Cannot open file: {e}"))?;
    let reader = ParquetRecordBatchReaderBuilder::new_with_metadata(file, meta.clone())
        .with_batch_size(8192)
        .build()
        .map_err(|e| format!("Read error: {e}"))?;

    let opts = FormatOptions::default().with_null("");
    let mut indices: Vec<u32> = Vec::new();
    let mut global: u32 = 0;
    let mut truncated = false;

    'outer: for batch in reader {
        let batch = batch.map_err(|e| format!("Read error: {e}"))?;
        let ncols = batch.num_columns();
        let formatters: Vec<ArrayFormatter> = (0..ncols)
            .map(|c| ArrayFormatter::try_new(batch.column(c).as_ref(), &opts))
            .collect::<Result<_, _>>()
            .map_err(|e| format!("Formatting error: {e}"))?;

        for row in 0..batch.num_rows() {
            let mut result = !any; // AND starts true, OR starts false
            for p in &prepared {
                let cell = if batch.column(p.column).is_null(row) {
                    None
                } else {
                    Some(formatters[p.column].value(row).to_string())
                };
                let m = eval(p, cell.as_deref());
                if any {
                    if m {
                        result = true;
                        break;
                    }
                } else if !m {
                    result = false;
                    break;
                }
            }
            if result {
                indices.push(global);
                if indices.len() >= SEARCH_CAP {
                    truncated = true;
                    break 'outer;
                }
            }
            global += 1;
        }
    }
    Ok((indices, truncated))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn open_file(
    state: State<'_, AppState>,
    duckdb: State<'_, DuckDbState>,
    path: String,
) -> Result<FileMeta, String> {
    let meta = load_metadata(&path)?;
    let schema = meta.schema().clone();
    let pq = meta.metadata();
    let fmd = pq.file_metadata();

    let num_rows = fmd.num_rows();
    let num_row_groups = pq.num_row_groups();
    let num_columns = schema.fields().len();

    // Row indices are tracked as u32 throughout; refuse files that would overflow
    // it rather than silently wrapping.
    if num_rows > u32::MAX as i64 {
        return Err(format!(
            "File has {num_rows} rows, which exceeds the {} row limit.",
            u32::MAX
        ));
    }

    // Collect the distinct compression codecs used across row group 0.
    let compression = if num_row_groups > 0 {
        let rg = pq.row_group(0);
        let mut codecs: Vec<String> = Vec::new();
        for i in 0..rg.num_columns() {
            let c = format!("{:?}", rg.column(i).compression()).to_uppercase();
            if !codecs.contains(&c) {
                codecs.push(c);
            }
        }
        codecs.join(", ")
    } else {
        "—".into()
    };

    let file_size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let file_name = std::path::Path::new(&path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| "Unnamed Parquet file".to_string());

    let columns: Vec<ColumnInfo> = schema
        .fields()
        .iter()
        .map(|f| ColumnInfo {
            name: f.name().clone(),
            type_name: friendly_type(f.data_type()),
            numeric: is_numeric(f.data_type()),
        })
        .collect();

    let file_meta = FileMeta {
        path: path.clone(),
        file_name,
        file_size,
        num_rows,
        num_columns,
        num_row_groups,
        compression,
        created_by: fmd.created_by().map(|s| s.to_string()),
        version: fmd.version(),
        columns,
    };

    let cache = FileCache {
        meta,
        schema,
        num_rows: num_rows.max(0) as usize,
        num_columns,
        sort_cache: None,
        filter_cache: None,
        column_cache: HashMap::new(),
    };

    state.files.lock().unwrap().insert(path.clone(), cache);

    let mut tables = duckdb.tables_by_path.lock().unwrap();
    if !tables.contains_key(&path) {
        let base = duck_table_base_name(&path);
        let mut table_name = base.clone();
        let mut suffix = 2usize;

        while tables.values().any(|table| table.name == table_name) {
            table_name = format!("{base}_{suffix}");
            suffix += 1;
        }

        let create_view = format!(
            "CREATE VIEW {} AS SELECT * FROM read_parquet({})",
            quote_sql_identifier(&table_name),
            quote_sql_string(&path),
        );

        duckdb
            .connection
            .lock()
            .unwrap()
            .execute_batch(&create_view)
            .map_err(|e| format!("Could not register Parquet with DuckDB: {e}"))?;

        tables.insert(
            path.clone(),
            DuckTable {
                name: table_name,
                path: path.clone(),
                is_view: false,
            },
        );
    }

    Ok(file_meta)
}

#[tauri::command]
async fn get_rows(
    state: State<'_, AppState>,
    duckdb: State<'_, DuckDbState>,
    path: String,
    offset: usize,
    limit: usize,
    sort: Option<SortSpec>,
    filter: Option<FilterSpec>,
) -> Result<RowsResponse, String> {
    let mut files = state.files.lock().unwrap();
    let cache = files.get_mut(&path).ok_or("File is not open")?;
    let num_rows = cache.num_rows;
    let num_columns = cache.num_columns;
    let meta = cache.meta.clone();

    let limit = limit.min(MAX_PAGE);
    if let Some(s) = &sort
        && s.column >= num_columns {
            return Err("Sort column is out of range".to_string());
    }

    let filtered: Option<Vec<u32>> = match &filter {
        Some(f) if f.is_active() => {
            let hit = cache
                .filter_cache
                .as_ref()
                .map(|(cf, _, _)| cf == f)
                .unwrap_or(false);

            if !hit {
                let (idx, trunc) = match run_filter_duckdb(&duckdb, cache, &path, f) {
                    Ok(ok) => ok,
                    Err(duck_err) => {
                        eprintln!(
                            "[duckview] DuckDB filter failed, falling back to Arrow scan: {duck_err}"
                        );
                        run_filter(&meta, &path, num_columns, f)?
                    }
                };
                cache.filter_cache = Some((f.clone(), idx, trunc));
            }

            Some(cache.filter_cache.as_ref().unwrap().1.clone())
        }
        _ => None,
    };
    let truncated = filtered
        .as_ref()
        .and(cache.filter_cache.as_ref().map(|(_, _, t)| *t))
        .unwrap_or(false);

    let (rows, total_rows, indices) = match (&filter_or_none(&filter), &sort) {
        (None, None) => {
            let rows = read_contiguous(&meta, &path, offset, limit)?;
            let idx: Vec<u32> = (0..rows.len()).map(|k| (offset + k) as u32).collect();
            (rows, num_rows, idx)
        }
        (None, Some(spec)) => {
            ensure_sort(cache, &path, spec)?;
            let perm = &cache.sort_cache.as_ref().unwrap().1;
            let page = slice_page(perm, offset, limit);
            let rows = read_scattered(&meta, &path, &page)?;
            (rows, num_rows, page)
        }
        (Some(_), None) => {
            let fi = filtered.as_ref().unwrap();
            let page = slice_page(fi, offset, limit);
            let rows = read_scattered(&meta, &path, &page)?;
            (rows, fi.len(), page)
        }
        (Some(_), Some(spec)) => {
            let fi = filtered.as_ref().unwrap();
            let sorted = sort_filtered(cache, &path, fi, spec)?;
            let page = slice_page(&sorted, offset, limit);
            let rows = read_scattered(&meta, &path, &page)?;
            (rows, sorted.len(), page)
        }
    };

    Ok(RowsResponse {
        rows,
        indices,
        total_rows,
        offset,
        truncated,
    })
}

#[tauri::command]
fn close_file(
    state: State<'_, AppState>,
    duckdb: State<'_, DuckDbState>,
    path: String,
) {
    state.files.lock().unwrap().remove(&path);

    let table = duckdb.tables_by_path.lock().unwrap().remove(&path);

    if let Some(table) = table {
        let drop_view = format!(
            "DROP VIEW IF EXISTS {}",
            quote_sql_identifier(&table.name),
        );

        if let Err(error) = duckdb
            .connection
            .lock()
            .unwrap()
            .execute_batch(&drop_view)
        {
            eprintln!(
                "[duckview] Could not unregister table view \"{}\": {error}",
                table.name
            );
        }
    }
}

#[tauri::command]
fn parquet_file_exists(path: String) -> bool {
    std::fs::metadata(path)
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
}

/// A file passed at launch, consumed once by the frontend on startup.
#[tauri::command]
fn take_startup_file(state: State<'_, AppState>) -> Option<String> {
    state.pending_open.lock().unwrap().take()
}

#[tauri::command]
async fn pick_parquet_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let picked = app
        .dialog()
        .file()
        .add_filter("Parquet", &["parquet"])
        .blocking_pick_file();

    Ok(picked
        .and_then(|file| file.into_path().ok())
        .map(|path| path.to_string_lossy().to_string()))
}

#[tauri::command]
async fn pick_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let picked = app
        .dialog()
        .file()
        .add_filter("Data files", &["parquet", "csv"])
        .add_filter("Parquet", &["parquet"])
        .add_filter("CSV", &["csv"])
        .blocking_pick_file();

    Ok(picked
        .and_then(|file| file.into_path().ok())
        .map(|path| path.to_string_lossy().to_string()))
}

#[tauri::command]
async fn import_csv_as_parquet(
    app: tauri::AppHandle,
    duckdb: State<'_, DuckDbState>,
    path: String,
    encoding: String,
    all_varchar: bool,
    max_csv_import_mib: u64,
    max_csv_line_size_mib: u64,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    ensure_csv_import_size(&path, max_csv_import_mib)?;
    let max_line_size_bytes = csv_line_size_bytes(max_csv_line_size_mib)?;

    let source = std::path::Path::new(&path);
    let file_name = source
        .file_stem()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("import");

    let output_path = app
        .dialog()
        .file()
        .add_filter("Parquet", &["parquet"])
        .set_file_name(format!("{file_name}.parquet"))
        .blocking_save_file()
        .and_then(|file| file.into_path().ok());

    let Some(output_path) = output_path else {
        return Ok(None);
    };

    let temporary_csv = csv_source_for_import(&path, &encoding)?;
    let csv_path = temporary_csv
        .as_deref()
        .unwrap_or_else(|| std::path::Path::new(&path));
    let output_path = output_path.to_string_lossy().to_string();
    let all_varchar = if all_varchar { "true" } else { "false" };

    let copy_sql = format!(
        "COPY (
                SELECT *
                FROM read_csv_auto(
                    {},
                    all_varchar = {},
                    max_line_size = {}
                )
             ) TO {} WITH (FORMAT PARQUET, COMPRESSION ZSTD)",
        quote_sql_string(&csv_path.to_string_lossy()),
        all_varchar,
        max_line_size_bytes,
        quote_sql_string(&output_path),
    );

    let import_result = duckdb
        .connection
        .lock()
        .unwrap()
        .execute_batch(&copy_sql);

    if let Some(temporary_csv) = temporary_csv {
        let _ = std::fs::remove_file(temporary_csv);
    }

    import_result.map_err(|error| format!("Could not convert CSV to Parquet: {error}"))?;

    Ok(Some(output_path))
}

// Treats an inactive (empty) filter as "no filter" for the match arm above.
fn filter_or_none(filter: &Option<FilterSpec>) -> Option<FilterSpec> {
    match filter {
        Some(f) if f.is_active() => Some(f.clone()),
        _ => None,
    }
}

/// Returns `order[offset..offset+limit]` (clamped) as an owned page.
fn slice_page(order: &[u32], offset: usize, limit: usize) -> Vec<u32> {
    if offset >= order.len() {
        return Vec::new();
    }
    let end = (offset + limit).min(order.len());
    order[offset..end].to_vec()
}

fn quote_sql_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn quote_sql_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn ensure_csv_import_size(path: &str, max_csv_import_mib: u64) -> Result<(), String> {
    const MIN_CSV_IMPORT_MIB: u64 = 256;
    const MAX_CSV_IMPORT_MIB: u64 = 65_536;

    if !(MIN_CSV_IMPORT_MIB..=MAX_CSV_IMPORT_MIB).contains(&max_csv_import_mib) {
        return Err(format!(
            "CSV import limit must be between {MIN_CSV_IMPORT_MIB} MiB and {MAX_CSV_IMPORT_MIB} MiB."
        ));
    }

    let metadata = std::fs::metadata(path)
        .map_err(|error| format!("Cannot inspect CSV file: {error}"))?;

    if !metadata.is_file() {
        return Err("The selected CSV path is not a regular file.".to_string());
    }

    let max_bytes = max_csv_import_mib * 1024 * 1024;
    if metadata.len() > max_bytes {
        return Err(format!(
            "This CSV is {:.2} GiB, but the configured import limit is {:.2} GiB. \
             Increase “Maximum CSV import size” in Settings, split the file, \
             or convert it with DuckDB externally.",
            metadata.len() as f64 / (1024.0 * 1024.0 * 1024.0),
            max_bytes as f64 / (1024.0 * 1024.0 * 1024.0),
        ));
    }

    Ok(())
}

fn csv_line_size_bytes(max_csv_line_size_mib: u64) -> Result<u64, String> {
    const MIN_CSV_LINE_SIZE_MIB: u64 = 1;
    const MAX_CSV_LINE_SIZE_MIB: u64 = 64;

    if !(MIN_CSV_LINE_SIZE_MIB..=MAX_CSV_LINE_SIZE_MIB).contains(&max_csv_line_size_mib) {
        return Err(format!(
            "CSV line size limit must be between {MIN_CSV_LINE_SIZE_MIB} MiB and {MAX_CSV_LINE_SIZE_MIB} MiB."
        ));
    }

    Ok(max_csv_line_size_mib * 1024 * 1024)
}

fn csv_source_for_import(
    path: &str,
    encoding_name: &str,
) -> Result<Option<std::path::PathBuf>, String> {
    if encoding_name == "utf-8" {
        // DuckDB reads CSV files incrementally. Do not load the entire file only
        // to validate UTF-8: invalid UTF-8 is reported by the import itself.
        return Ok(None);
    }

    let encoding = match encoding_name {
        "shift_jis" => encoding_rs::SHIFT_JIS,
        "euc-jp" => encoding_rs::EUC_JP,
        "iso-2022-jp" => encoding_rs::ISO_2022_JP,
        "gbk" => encoding_rs::GBK,
        "big5" => encoding_rs::BIG5,
        "windows-1252" => encoding_rs::WINDOWS_1252,
        _ => return Err("Unsupported CSV text encoding.".to_string()),
    };

    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| format!("Could not create a temporary CSV path: {error}"))?
        .as_nanos();

    let temporary_path = std::env::temp_dir().join(format!(
        "duckview-csv-{}-{unique}.csv",
        std::process::id()
    ));

    let conversion_result = (|| -> Result<(), String> {
        const INPUT_BUFFER_SIZE: usize = 64 * 1024;
        const OUTPUT_BUFFER_SIZE: usize = 256 * 1024;

        let source = File::open(path)
            .map_err(|error| format!("Cannot read CSV file: {error}"))?;
        let destination = File::create(&temporary_path)
            .map_err(|error| format!("Could not create temporary CSV: {error}"))?;

        let mut reader = BufReader::new(source);
        let mut writer = BufWriter::new(destination);
        let mut decoder = encoding.new_decoder_without_bom_handling();
        let mut input = [0_u8; INPUT_BUFFER_SIZE];
        let mut output = [0_u8; OUTPUT_BUFFER_SIZE];
        let mut had_errors = false;

        loop {
            let bytes_read = reader
                .read(&mut input)
                .map_err(|error| format!("Cannot read CSV file: {error}"))?;

            if bytes_read == 0 {
                break;
            }

            let mut consumed = 0;

            loop {
                let (result, read, written, decode_had_errors) = decoder.decode_to_utf8(
                    &input[consumed..bytes_read],
                    &mut output,
                    false,
                );

                consumed += read;
                had_errors |= decode_had_errors;

                writer
                    .write_all(&output[..written])
                    .map_err(|error| format!("Could not write temporary CSV: {error}"))?;

                match result {
                    encoding_rs::CoderResult::InputEmpty => break,
                    encoding_rs::CoderResult::OutputFull => continue,
                }
            }
        }

        loop {
            let (result, _, written, decode_had_errors) =
                decoder.decode_to_utf8(b"", &mut output, true);

            had_errors |= decode_had_errors;

            writer
                .write_all(&output[..written])
                .map_err(|error| format!("Could not write temporary CSV: {error}"))?;

            if result == encoding_rs::CoderResult::InputEmpty {
                break;
            }
        }

        writer
            .flush()
            .map_err(|error| format!("Could not finish temporary CSV: {error}"))?;

        if had_errors {
            return Err(format!(
                "The CSV contains invalid characters for {}.",
                encoding.name()
            ));
        }

        Ok(())
    })();

    if conversion_result.is_err() {
        let _ = std::fs::remove_file(&temporary_path);
    }

    conversion_result?;
    Ok(Some(temporary_path))
}

fn duck_table_base_name(path: &str) -> String {
    let file_stem = std::path::Path::new(path)
        .file_stem()
        .and_then(|name| name.to_str())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("parquet");

    let mut result: String = file_stem
        .chars()
        .map(|ch| if ch == '\0' { '_' } else { ch })
        .collect();

    if result.trim().is_empty() {
        result = "parquet".to_string();
    }

    if result
        .chars()
        .next()
        .is_some_and(|ch| ch.is_ascii_digit())
    {
        result.insert(0, '_');
    }

    result
}

/// Removes SQL line/block comments while preserving quoted string literals and
/// quoted identifiers. Newlines in comments are retained so adjacent tokens
/// cannot accidentally be joined together.
fn strip_sql_comments(sql: &str) -> String {
    let mut result = String::with_capacity(sql.len());
    let mut chars = sql.chars().peekable();
    let mut quote: Option<char> = None;

    while let Some(ch) = chars.next() {
        if let Some(delimiter) = quote {
            result.push(ch);

            if ch == delimiter {
                if chars.peek().is_some_and(|next| *next == delimiter) {
                    result.push(chars.next().unwrap());
                } else {
                    quote = None;
                }
            }

            continue;
        }

        if matches!(ch, '\'' | '"' | '`') {
            quote = Some(ch);
            result.push(ch);
            continue;
        }

        if ch == '-' && chars.peek().is_some_and(|next| *next == '-') {
            chars.next();

            for comment_char in chars.by_ref() {
                if comment_char == '\n' {
                    result.push('\n');
                    break;
                }
            }

            continue;
        }

        if ch == '/' && chars.peek().is_some_and(|next| *next == '*') {
            chars.next();

            let mut previous = '\0';
            for comment_char in chars.by_ref() {
                if comment_char == '\n' {
                    result.push('\n');
                }

                if previous == '*' && comment_char == '/' {
                    break;
                }

                previous = comment_char;
            }

            continue;
        }

        result.push(ch);
    }

    result
}

fn normalize_read_only_sql(sql: &str) -> Result<String, String> {
    let sql = strip_sql_comments(sql);
    let sql = sql.trim();
    let sql = sql.strip_suffix(';').unwrap_or(sql).trim();

    if sql.is_empty() {
        return Err("Enter a SQL query first.".to_string());
    }
    if sql.contains(';') {
        return Err("Only one SQL statement may be executed at a time.".to_string());
    }

    let upper = sql.to_ascii_uppercase();
    let first_keyword = upper.split_whitespace().next().unwrap_or("");

    if !matches!(first_keyword, "SELECT" | "WITH" | "PIVOT" | "UNPIVOT"
        | "DESCRIBE" | "SHOW" | "VALUES") {
        return Err("Only SELECT, WITH, and PIVOT queries are allowed.".to_string());
    }

    const BLOCKED: [(&str, &str); 23] = [
        ("READ_CSV_AUTO", "`read_csv_auto` is not allowed. Import the CSV file as Parquet first, then query the imported table."),
        ("READ_CSV", "`read_csv` is not allowed. Import the CSV file as Parquet first, then query the imported table."),
        ("READ_PARQUET", "`read_parquet` is not allowed. Open the Parquet file in DuckView, then query its table."),
        ("READ_JSON", "`read_json` is not allowed."),
        ("READ_JSON_AUTO", "`read_json_auto` is not allowed."),
        ("JSON_EXTRACT", "`json_extract` is not allowed."),
        ("JSON_TRANSFORM", "`json_transform` is not allowed."),
        ("READ_TEXT", "`read_text` is not allowed."),
        ("READ_BLOB", "`read_blob` is not allowed."),
        ("SQLITE_SCAN", "`sqlite_scan` is not allowed."),
        ("INSERT", "`INSERT` is not allowed because this SQL editor is read-only."),
        ("UPDATE", "`UPDATE` is not allowed because this SQL editor is read-only."),
        ("DELETE", "`DELETE` is not allowed because this SQL editor is read-only."),
        ("CREATE", "`CREATE` is not allowed because this SQL editor is read-only."),
        ("DROP", "`DROP` is not allowed because this SQL editor is read-only."),
        ("COPY", "`COPY` is not allowed from the SQL editor. Use the export feature instead."),
        ("ATTACH", "`ATTACH` is not allowed."),
        ("DETACH", "`DETACH` is not allowed."),
        ("INSTALL", "`INSTALL` is not allowed."),
        ("LOAD", "`LOAD` is not allowed."),
        ("EXPORT", "`EXPORT` is not allowed."),
        ("IMPORT", "`IMPORT` is not allowed."),
        ("GLOB", "`glob` is not allowed."),
    ];

    if let Some((_, message)) = BLOCKED.iter().find(|(keyword, _)| upper.contains(keyword)) {
        return Err((*message).to_string());
    }

    Ok(sql.to_string())
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

fn main() {
    let duckdb = DuckDbState::new().expect("Could not initialize DuckDB");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .manage(duckdb)
        .invoke_handler(tauri::generate_handler![
                open_file,
                get_rows,
                close_file,
                parquet_file_exists,
                list_duckdb_tables,
                get_duckdb_table_columns,
                execute_duckdb_query,
                get_duckdb_query_rows,
                get_duckdb_query_rows_arrow,
                export_duckdb_query,
                register_duckdb_query_as_table,
                remove_duckdb_result_table,
                restore_duckdb_view,
                configure_duckdb_memory_limit,
                take_startup_file,
                pick_file,
                pick_parquet_file,
                import_csv_as_parquet
            ])
        .setup(|app| {
            // A file path may arrive as a CLI arg when launched via `open -a`.
            if let Some(path) = std::env::args()
                .skip(1)
                .find(|arg| {
                    let lower = arg.to_ascii_lowercase();
                    lower.ends_with(".parquet") || lower.ends_with(".csv")
                })
            {
                *app.state::<AppState>().pending_open.lock().unwrap() = Some(path);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building DuckView")
        .run(|app_handle, event| {
            #[cfg(target_os = "macos")]
            {
                // macOS delivers "Open With" / dock-drop files through this event.
                if let tauri::RunEvent::Opened { urls } = event {
                    for url in urls {
                        if let Ok(p) = url.to_file_path() {
                            let path = p.to_string_lossy().to_string();
                            if let Some(state) = app_handle.try_state::<AppState>() {
                                *state.pending_open.lock().unwrap() = Some(path.clone());
                            }
                            let _ = app_handle.emit("open-file", path);
                        }
                    }
                }
            }
        });
}

