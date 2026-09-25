use std::collections::HashMap;
use serde::Serialize;
use tauri::State;
use crate::duck::{DuckDbState, PivotValue};
use crate::quote_sql_identifier;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClientPivotValueRange {
    pub(crate) column: String,
    pub(crate) source_type: String,
    pub(crate) aggregation: String,
    pub(crate) checked: bool,
    pub(crate) unsafe_value_count: i64,
    pub(crate) sample_unsafe_value: Option<String>,
    pub(crate) sum_checked: bool,
    pub(crate) unsafe_sum: bool,
    pub(crate) sum_abs_value: Option<String>,
}

#[tauri::command]
pub(crate) fn validate_duckdb_client_pivot_values(
    duckdb: State<'_, DuckDbState>,
    source_name: String,
    values: Vec<PivotValue>,
) -> Result<Vec<ClientPivotValueRange>, String> {
    const JS_MAX_SAFE_INTEGER: &str = "9007199254740991";

    let source_name = source_name.trim().to_string();
    if source_name.is_empty() {
        return Err("A Pivot source table or view is required.".to_string());
    }

    if !duckdb
        .tables_by_path
        .lock()
        .unwrap()
        .values()
        .any(|table| table.name == source_name)
    {
        return Err(format!("Pivot source \"{source_name}\" is not available."));
    }

    let source_sql = quote_sql_identifier(&source_name);
    let connection = duckdb.connection.lock().unwrap();

    let describe_sql = format!("DESCRIBE {source_sql}");
    let mut describe = connection
        .prepare(&describe_sql)
        .map_err(|error| format!("Could not describe Pivot source: {error}"))?;
    let mut rows = describe
        .query([])
        .map_err(|error| format!("Could not read Pivot source schema: {error}"))?;

    let mut column_types = HashMap::<String, String>::new();
    while let Some(row) = rows
        .next()
        .map_err(|error| format!("Could not read Pivot source schema: {error}"))?
    {
        let name: String = row
            .get(0)
            .map_err(|error| format!("Could not read Pivot column name: {error}"))?;
        let type_name: String = row
            .get(1)
            .map_err(|error| format!("Could not read Pivot column type: {error}"))?;

        column_types.insert(name, type_name);
    }

    let mut result = Vec::new();

    for value in values {
        let column = value.column.trim().to_string();
        if column.is_empty() {
            continue;
        }

        let source_type = column_types
            .get(&column)
            .cloned()
            .ok_or_else(|| format!("Pivot value field \"{column}\" does not exist."))?;

        let aggregation = value.aggregation.trim().to_ascii_lowercase();
        let normalized_type = source_type.trim().to_ascii_uppercase();
        let column_sql = quote_sql_identifier(&column);
        let is_sum = aggregation == "sum";

        let (checked, unsafe_predicate, safe_abs_expression) =
            match normalized_type.as_str() {
                "BIGINT" | "HUGEINT" => (
                    true,
                    format!(
                        "{column_sql} < -{JS_MAX_SAFE_INTEGER}::HUGEINT \
                         OR {column_sql} > {JS_MAX_SAFE_INTEGER}::HUGEINT"
                    ),
                    format!(
                        "CASE
                            WHEN {column_sql} BETWEEN -{JS_MAX_SAFE_INTEGER}::HUGEINT
                                AND {JS_MAX_SAFE_INTEGER}::HUGEINT
                            THEN ABS(CAST({column_sql} AS HUGEINT))
                        END"
                    ),
                ),
                "UBIGINT" | "UHUGEINT" | "UINT128" => (
                    true,
                    format!("{column_sql} > {JS_MAX_SAFE_INTEGER}::UHUGEINT"),
                    format!(
                        "CASE
                            WHEN {column_sql} <= {JS_MAX_SAFE_INTEGER}::UHUGEINT
                            THEN CAST({column_sql} AS HUGEINT)
                        END"
                    ),
                ),
                _ => (false, String::new(), String::new()),
            };

        if !checked {
            result.push(ClientPivotValueRange {
                column,
                source_type,
                aggregation,
                checked: false,
                unsafe_value_count: 0,
                sample_unsafe_value: None,
                sum_checked: false,
                unsafe_sum: false,
                sum_abs_value: None,
            });
            continue;
        }

        let sum_projection = if is_sum {
            format!(
                ",
                COALESCE(
                    SUM({safe_abs_expression}) > {JS_MAX_SAFE_INTEGER}::HUGEINT,
                    FALSE
                ) AS unsafe_sum,
                CAST(SUM({safe_abs_expression}) AS VARCHAR)
                    AS sum_abs_value"
            )
        } else {
            ",
                FALSE AS unsafe_sum,
                NULL::VARCHAR AS sum_abs_value"
                .to_string()
        };

        let sql = format!(
            "SELECT
                COUNT(*) FILTER (WHERE {unsafe_predicate}) AS unsafe_value_count,
                MIN(CAST({column_sql} AS VARCHAR))
                    FILTER (WHERE {unsafe_predicate}) AS sample_unsafe_value
                {sum_projection}
             FROM {source_sql}"
        );

        let mut statement = connection
            .prepare(&sql)
            .map_err(|error| format!("Could not validate Pivot value \"{column}\": {error}"))?;
        let mut range_rows = statement
            .query([])
            .map_err(|error| format!("Could not validate Pivot value \"{column}\": {error}"))?;

        let row = range_rows
            .next()
            .map_err(|error| format!("Could not read Pivot value validation: {error}"))?
            .ok_or_else(|| "Pivot value validation returned no result.".to_string())?;

        let unsafe_value_count: i64 = row
            .get(0)
            .map_err(|error| format!("Could not read unsafe value count: {error}"))?;
        let sample_unsafe_value: Option<String> = row
            .get(1)
            .map_err(|error| format!("Could not read unsafe value sample: {error}"))?;
        let unsafe_sum = row
            .get::<_, Option<bool>>(2)
            .map_err(|error| format!("Could not read unsafe SUM result: {error}"))?
            .unwrap_or(false);
        let sum_abs_value: Option<String> = row
            .get(3)
            .map_err(|error| format!("Could not read SUM magnitude: {error}"))?;

        result.push(ClientPivotValueRange {
            column,
            source_type,
            aggregation,
            checked: true,
            unsafe_value_count,
            sample_unsafe_value,
            sum_checked: is_sum,
            unsafe_sum,
            sum_abs_value,
        });
    }

    Ok(result)
}