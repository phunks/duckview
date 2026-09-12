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


## Getting Started
- **Open a Parquet or CSV file**
  Drag and drop a file into the window, or select **Choose File…**.
  CSV files are converted to Parquet for use in the application. If necessary, select the appropriate text encoding when importing a CSV file.
- **Browse, sort, and filter data**
  View data in a table, sort columns, and use filters to narrow down the displayed rows.
- **Run SQL queries**
  Opened files can be queried in the SQL editor. Read-only analytical queries such as `SELECT`, `WITH`, `PIVOT`, and `UNPIVOT` are supported.

## Important Notes
- **Source files are read-only**
  DuckView does not modify the Parquet or CSV files you open.
- **Data-modifying SQL is not supported**
  Statements such as `INSERT`, `UPDATE`, `DELETE`, `CREATE`, and `DROP` cannot be executed.
- **Query results are temporary**
  Results from SQL queries, including `PIVOT` and `UNPIVOT`, are available for viewing within the app only. To keep a result, use **Export…** to save it as a Parquet or CSV file.
- **Export results to persist them**
  Query results and transformed data are not written back to the original file. Export them if you need to retain or reuse them.

## License & Acknowledgments
This project is licensed under the MIT License - see the LICENSE file for details.
This project is a heavily modified and expanded derivative work based on [ParquetView](https://github.com/Alyetama/parquetview) (Copyright © Alyetama).
We are incredibly grateful for their initial Tauri architectural design which made this project possible.

## License
The source code is licensed MIT. The website content is licensed CC BY 4.0,see LICENSE.
