# DuckView
Parquet file viewer and SQL editor.


![Screenshot](.github/images/window.png)

DuckView is a powerful, modern Parquet file viewer and SQL editor built with Tauri and DuckDB.
It started as a complete rewrite and expansion of the excellent parquetview (an OSX Parquet viewer),
supercharging it with multi-tab support and analytical capabilities.

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
