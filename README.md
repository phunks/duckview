# DuckView
Parquet file viewer and SQL editor.


![Screenshot](.github/images/window.png)

DuckView is a powerful, modern Parquet file viewer and SQL editor built with Tauri and DuckDB.
It started as a complete rewrite and expansion of the excellent parquetview (an OSX Parquet viewer),
supercharging it with multi-tab support and analytical capabilities.

## Features
- **Built for large datasets**  
  Parquet files are read on demand with paged rows and columns, so you can browse large files without loading the entire dataset into the UI at once.
- **Large CSV import support**  
  Open CSV files and convert them to Parquet for efficient browsing and querying. The maximum CSV import size is configurable in Settings (default: 4 GiB), and several text encodings are supported.
- **SQL workspace powered by DuckDB**  
  Query opened files with a read-only SQL editor, keep multiple SQL tabs, and export query results as Parquet or CSV.
- **AI-assisted SQL generation**  
  Select one or more SQL comments (or place the cursor on a comment), right-click, and choose **AI: Generate SQL from Comment** to generate a SQL suggestion from your request. Press <kbd>Tab</kbd> to accept it or <kbd>Esc</kbd> to dismiss it.
- **Secure API key storage**  
  AI API keys are stored in the operating system’s secure keychain / credential store rather than in DuckView’s application settings.
- **Multiple workspaces and tabs**  
  Keep multiple files, SQL tabs, saved views, and workspaces open while preserving your local workspace layout.
- **Saved Pivot definitions**
  Pivot tabs keep their source and configuration in the workspace, not a copy of the data. Reopening a Pivot reloads its source; if the source file or view is unavailable, the definition remains so you can restore the source and refresh.
- **Interactive Pivot analysis**
  Open a Pivot tab from a file or saved SQL View to arrange row, column, and value fields, choose aggregations, and explore totals, filters, sorting, and drill-down details. A drill-down can be saved as a SQL View of the matching source records.


## Getting Started
- **Open a Parquet or CSV file**
  Drag and drop a file into the window, or select **Choose File…**.
  CSV files are converted to Parquet for use in the application. If necessary, select the appropriate text encoding when importing a CSV file.
- **Browse, sort, and filter data**
  View data in a table, sort columns, and use filters to narrow down the displayed rows.
- **Run SQL queries**
  Opened files can be queried in the SQL editor. Read-only analytical queries such as `SELECT`, `WITH`, `PIVOT`, and `UNPIVOT` are supported.
- **Explore with Pivot**
  Use **Open Pivot in New Tab** on a source table or View, then drag fields into the row, column, and value areas. Pivot configurations are saved with the workspace; use **Refresh** to reload source data. The client-side source row limit is configurable in Settings (default: 10,000 rows; maximum: 500,000). For larger sources, filter the data in a SQL View first.

## Important Notes
- **Source files are read-only**
  DuckView does not modify the Parquet or CSV files you open.
- **Data-modifying SQL is not supported**
  Statements such as `INSERT`, `UPDATE`, `DELETE`, `CREATE`, and `DROP` cannot be executed.
- **Query results are temporary**
  Results from SQL queries, including `PIVOT` and `UNPIVOT`, are available for viewing within the app only. To keep a result, use **Export…** to save it as a Parquet or CSV file.
- **Export results to persist them**
  Query results and transformed data are not written back to the original file. Export them if you need to retain or reuse them.
- **Client-side Pivot numeric precision**
  Pivot aggregation uses JavaScript numbers, which represent integers exactly only from `-(2^53 - 1)` to `2^53 - 1`. DuckDB `BIGINT`, `UBIGINT`, `HUGEINT`, `UHUGEINT`, and `UINT128` values outside that range cannot be used as exact Pivot measures. Before loading selected integer measures, DuckView checks for out-of-range values and whether a `SUM` could exceed the safe range; it stops the load rather than silently showing an imprecise result. Floating-point values and decimals converted to JavaScript numbers may still round. Exact full-range integer aggregation (and exact fractional averages) requires a separate high-precision implementation; use DuckDB SQL for calculations that need that precision.


## License & Acknowledgments
DuckView's own source code is licensed under the [MIT License](LICENSE). It is based on [ParquetView](https://github.com/Alyetama/parquetview) (Copyright © Alyetama); we are grateful for its original Tauri architecture.

The interactive Pivot uses a modified [streamlit-pivot-table](https://github.com/streamlit/streamlit-pivot-table), licensed under the Apache License, Version 2.0. Its [license](licenses/streamlit-pivot-table/LICENSE) and [third-party notices](licenses/streamlit-pivot-table/NOTICES) are provided in the `licenses/streamlit-pivot-table/` directory and included with application releases. Changes to the upstream source are maintained as a [patch](src/patches/streamlit_pivot_table-0.6.0.patch).
