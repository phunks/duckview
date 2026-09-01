"use strict";

// ---- Tauri bridge (withGlobalTauri) ----------------------------------------
const invoke = window.__TAURI__.core.invoke;
const listen = window.__TAURI__.event.listen;

// ---- Layout constants (ROW_H mirrors the --row-h CSS var) -------------------
let ROW_H = 30; // updated by the density setting
const HEADER_H = 34;
const GUTTER_W = 66;
const PAGE = 200; // rows fetched per backend request
const BUFFER = 8; // extra rows rendered above/below the viewport
const SEARCH_CAP = 100000; // must match SEARCH_CAP in main.rs

// ---- DOM --------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const viewport = $("viewport");
const grid = $("grid");
const headerRow = $("headerRow");
const spacer = $("spacer");
const rows = $("rows");
const emptyEl = $("empty");
const tableWrap = $("tableWrap");
const statusBar = $("statusBar");
const statLeft = $("statLeft");
const statCenter = $("statCenter");
const statRight = $("statRight");
const fileNameEl = $("fileName");
const tabBar = $("tabBar");
const sqlWorkspace = $("sqlWorkspace");
const sqlTitle = $("sqlTitle");
const sqlTables = $("sqlTables");
const sqlInput = $("sqlInput");
const sqlRunBtn = $("sqlRunBtn");
const sqlExportBtn = $("sqlExportBtn");
const sqlError = $("sqlError");
const sqlResultTitle = $("sqlResultTitle");
const sqlResultStatus = $("sqlResultStatus");
const sqlResultTabs = $("sqlResultTabs");
const sqlResultBody = $("sqlResultBody");
const metaBtn = $("metaBtn");
const metaPanel = $("metaPanel");
const metaBackdropEl = $("metaBackdropEl");
const metaClose = $("metaClose");
const metaBody = $("metaBody");
const dropOverlay = $("dropOverlay");
const loading = $("loading");
const loadingText = $("loadingText");
const toast = $("toast");
// Advanced filter
const advBtn = $("advBtn");
const advBadge = $("advBadge");
const advPanel = $("advPanel");
const advBackdrop = $("advBackdrop");
const advConditions = $("advConditions");
const advAdd = $("advAdd");
const advClear = $("advClear");
const advApply = $("advApply");
const advCombine = $("advCombine");
// Settings
const settingsBtn = $("settingsBtn");
const settingsWin = $("settingsWin");
const settingsBackdrop = $("settingsBackdrop");
const settingsClose = $("settingsClose");
const exportFormatWin = $("exportFormatWin");
const exportFormatBackdrop = $("exportFormatBackdrop");
const exportFormatClose = $("exportFormatClose");
const exportParquetBtn = $("exportParquetBtn");
const exportCsvBtn = $("exportCsvBtn");
const csvImportWin = $("csvImportWin");
const csvImportPath = $("csvImportPath");
const csvImportClose = $("csvImportClose");
const csvImportCancelBtn = $("csvImportCancelBtn");
const csvImportSaveBtn = $("csvImportSaveBtn");
const appMenuBtn = $("appMenuBtn");
const appMenu = $("appMenu");
const appMenuBackdrop = $("appMenuBackdrop");
const menuOpenBtn = $("menuOpenBtn");
const menuSettingsBtn = $("menuSettingsBtn");
const setTheme = $("setTheme");
const setDensity = $("setDensity");
const setFont = $("setFont");
const setAutoFit = $("setAutoFit");
const setCase = $("setCase");

// ---- State ------------------------------------------------------------------
let currentPath = null;
let fileMeta = null;
let colWidths = [];
let gridWidth = 0;
let resizeState = null;
let suppressHeaderClick = false;
let totalRows = 0;
let sortState = null; // { column, ascending }
let filterState = null; // { query, column }
let truncated = false;
let viewToken = 0; // bumped on every view change to discard stale fetches

let cache = new Map(); // pageIndex -> { rows, indices }
let pending = new Set(); // pageIndex currently fetching
let edits = new Map(); // "globalRow:col" -> edited string (session-local, not saved to file)

const tabs = new Map();
const tabIdByPath = new Map();
let activeTabId = null;

let editingEl = null;
let editingKey = null;
let editingFileOrig = "";
let rafPending = false;
let sqlTabNumber = 0;
let pendingCsvImportPath = null;


function createTab(path, meta) {
  return {
    id: `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    kind: "parquet",
    path,
    meta,
    colWidths: null,
    sortState: null,
    filterState: null,
    truncated: false,
    totalRows: meta.num_rows,
    cache: new Map(),
    pending: new Set(),
    edits: new Map(),
    scrollTop: 0,
    viewToken: 0,
  };
}

function createSqlTab() {
  sqlTabNumber += 1;

  return {
    id: `sql-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    kind: "sql",
    number: sqlTabNumber,
    title: `SQL ${sqlTabNumber}`,
    sql: "SELECT 1;",
    error: null,
    results: new Map(),
    activeResultKey: null,
    nextResultNumber: 1,
    resultStatus: "Run a query to see results.",
  };
}

function sqlIdentifier(fileName) {
  return fileName
      .replace(/\.[^.]+$/, "")
      .replace(/[^A-Za-z0-9_]/g, "_")
      .replace(/^[^A-Za-z_]/, "_")
      .toLowerCase();
}

function sqlStatementAtCursor(sql, cursor) {
  const statements = [];
  let start = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (lineComment) {
      if (ch === "\n") lineComment = false;
      continue;
    }

    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        i++;
      }
      continue;
    }

    if (quote) {
      if (ch === quote) {
        if (next === quote) {
          i++;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (ch === "-" && next === "-") {
      lineComment = true;
      i++;
      continue;
    }

    if (ch === "/" && next === "*") {
      blockComment = true;
      i++;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }

    if (ch === ";") {
      statements.push({ start, end: i });
      start = i + 1;
    }
  }

  if (start < sql.length || !statements.length) {
    statements.push({ start, end: sql.length });
  }

  const statementIndex = statements.findIndex(
      (statement, index) =>
          cursor >= statement.start &&
          (cursor <= statement.end || index === statements.length - 1)
  );

  const index = statementIndex >= 0 ? statementIndex : statements.length - 1;
  const statement = statements[index];
  const text = sql.slice(statement.start, statement.end).trim();

  return {
    sql: text,
    number: index + 1,
    count: statements.length,
  };
}

function sqlUsesDynamicResultShape(sql) {
  const normalized = sql
      .replace(/--.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .toUpperCase();

  // return /\bPIVOT\b|\bUNPIVOT\b/.test(normalized);
  return false;
}

function runSql() {
  const tab = activeTab();
  if (!tab || tab.kind !== "sql") return;

  tab.sql = sqlInput.value;

  const statement = sqlStatementAtCursor(
      tab.sql,
      sqlInput.selectionStart
  );

  if (!statement.sql) {
    tab.error = "Place your cursor on the SQL statement you want to execute.";
    sqlError.textContent = tab.error;
    sqlError.classList.remove("hidden");
    return;
  }

  const resultNumber = tab.nextResultNumber++;
  const resultKey =
      `result-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const result = {
    id: resultKey,
    number: resultNumber,
    title: `Result ${resultNumber}`,
    sql: statement.sql,
    queryId: null,
    tableName: null,
    columns: null,
    rows: null,
    offset: 0,
    hasMore: false,
    error: null,
    closed: false,
    transientOnly: sqlUsesDynamicResultShape(statement.sql),
    status: `Result ${resultNumber} is running…`,
  };

  tab.results.set(resultKey, result);
  tab.activeResultKey = resultKey;
  tab.error = null;

  sqlRunBtn.disabled = true;
  sqlExportBtn.disabled = true;
  renderSqlResultTabs(tab);
  renderActiveSqlResult(tab);

  (async () => {
    const startedAt = performance.now();
    try {
      const start = await invoke("execute_duckdb_query", {
        sql: result.sql,
      });
      const preparedAt = performance.now();
      const page = await invoke("get_duckdb_query_rows", {
        queryId: start.query_id,
        offset: 0,
        limit: PAGE,
      });
      const rowsAt = performance.now();

      result.queryId = start.query_id;
      result.columns = start.columns;
      result.rows = page.rows;
      result.offset = page.offset;
      result.hasMore = page.has_more;
      result.status = page.rows.length
          ? `Showing rows 1–${page.rows.length}${page.has_more ? "+" : ""} · Saving table…`
          : "No rows returned · Saving table…";

      if (activeTabId === tab.id && tab.activeResultKey === resultKey) {
        renderSqlResultTabs(tab);
        renderActiveSqlResult(tab);
      }
      const renderedAt = performance.now();
      console.info("SQL timing (ms)", {
        prepare: Math.round(preparedAt - startedAt),
        fetchRows: Math.round(rowsAt - preparedAt),
        render: Math.round(renderedAt - rowsAt),
      });

      if (result.transientOnly) {
        result.status = page.rows.length
            ? `Showing rows 1–${page.rows.length}${page.hasMore ? "+" : ""} · Temporary result`
            : "No rows returned · Temporary result";

        if (activeTabId === tab.id && tab.activeResultKey === resultKey) {
          renderSqlResultTabs(tab);
          renderActiveSqlResult(tab);
        }
        return;
      }

      const tableName = `sql_${tab.number}_result_${result.number}`;

      try {
        const table = await invoke("register_duckdb_query_as_table", {
          queryId: result.queryId,
          tableName,
        });
        const materializedAt = performance.now();
        console.info("SQL result-table timing (ms)", {
          createTempTable: Math.round(materializedAt - renderedAt),
          total: Math.round(materializedAt - startedAt),
        });

        result.tableName = table.name;
        result.status = page.rows.length
            ? `${table.name}: showing rows 1–${page.rows.length}${page.has_more ? "+" : ""}`
            : `${table.name}: no rows returned.`;

        if (result.closed) {
          await invoke("remove_duckdb_result_table", {
            tableName: result.tableName,
          });
          return;
        }

        if (activeTab()?.kind === "sql") {
          await renderSqlTables();
        }

        if (activeTabId !== tab.id || tab.activeResultKey !== resultKey) {
          return;
        }

        renderSqlResultTabs(tab);
        renderActiveSqlResult(tab);
      } catch (error) {
        result.status = page.rows.length
            ? `Showing rows 1–${page.rows.length}${page.hasMore ? "+" : ""} · Table save failed.`
            : "No rows returned · Table save failed.";
        result.tableError = String(error);
        showToast(`Could not add ${tableName} to Views: ${error}`);

        if (activeTabId === tab.id && tab.activeResultKey === resultKey) {
          renderActiveSqlResult(tab);
        }
      }
    } catch (error) {
      result.error = String(error);
      result.status = "Query failed.";

      if (activeTabId !== tab.id || tab.activeResultKey !== resultKey) {
        return;
      }

      renderSqlResultTabs(tab);
      renderActiveSqlResult(tab);
    } finally {
      if (activeTabId === tab.id) {
        sqlRunBtn.disabled = false;
      }
    }
  })();
}

sqlInput.addEventListener("input", () => {
  const tab = activeTab();
  if (tab?.kind === "sql") tab.sql = sqlInput.value;
});

function openExportFormatDialog() {
  const tab = activeTab();
  const result = activeSqlResult(tab);
  if (!tab || tab.kind !== "sql" || !result?.queryId) return;

  exportFormatWin.classList.add("open");
  exportFormatBackdrop.classList.add("open");
  exportParquetBtn.focus();
}

function closeExportFormatDialog() {
  exportFormatWin.classList.remove("open");
  exportFormatBackdrop.classList.remove("open");
}

function openCsvImportDialog(path) {
  pendingCsvImportPath = path;
  csvImportPath.textContent = path;
  csvImportWin.classList.add("open");
  exportFormatBackdrop.classList.add("open");
  csvImportSaveBtn.focus();
}

function closeCsvImportDialog() {
  pendingCsvImportPath = null;
  csvImportWin.classList.remove("open");
  exportFormatBackdrop.classList.remove("open");
}

async function saveCsvAsParquet() {
  const csvPath = pendingCsvImportPath;
  if (!csvPath) return;

  closeCsvImportDialog();
  setLoading(true, "Converting CSV to Parquet…");

  try {
    const parquetPath = await invoke("import_csv_as_parquet", { path: csvPath });
    if (parquetPath) await openParquetPath(parquetPath);
  } catch (error) {
    showToast("Couldn’t import CSV: " + error);
  } finally {
    setLoading(false);
  }
}

function isCsvPath(path) {
  return path.toLowerCase().endsWith(".csv");
}

async function exportSql(format) {
  const tab = activeTab();
  const result = activeSqlResult(tab);
  if (!tab || tab.kind !== "sql" || !result?.queryId) return;

  closeExportFormatDialog();

  sqlExportBtn.disabled = true;
  sqlRunBtn.disabled = true;

  const oldText = sqlExportBtn.textContent;
  sqlExportBtn.textContent = "Exporting…";
  result.status = `Exporting full result as ${format.toUpperCase()}…`;
  sqlResultStatus.textContent = result.status;

  try {
    const path = await invoke("export_duckdb_query", {
      queryId: result.queryId,
      format,
    });

    if (path) {
      result.status = `Exported ${format.toUpperCase()} to ${path}`;
    } else {
      result.status = "Export cancelled.";
    }

    if (activeTab() === tab && activeSqlResult(tab) === result) {
      sqlResultStatus.textContent = result.status;
    }
  } catch (error) {
    result.error = String(error);
    result.status = "Export failed.";

    if (activeTab() === tab && activeSqlResult(tab) === result) {
      sqlResultStatus.textContent = result.status;
      sqlError.textContent = result.error;
      sqlError.classList.remove("hidden");
    }
  } finally {
    sqlExportBtn.textContent = oldText;
    sqlExportBtn.disabled = !result.queryId;
    sqlRunBtn.disabled = false;
  }
}

sqlExportBtn.addEventListener("click", openExportFormatDialog);
exportParquetBtn.addEventListener("click", () => exportSql("parquet"));
exportCsvBtn.addEventListener("click", () => exportSql("csv"));
exportFormatClose.addEventListener("click", closeExportFormatDialog);
exportFormatBackdrop.addEventListener("click", () => {
  closeExportFormatDialog();
  closeCsvImportDialog();
});
csvImportClose.addEventListener("click", closeCsvImportDialog);
csvImportCancelBtn.addEventListener("click", closeCsvImportDialog);
csvImportSaveBtn.addEventListener("click", saveCsvAsParquet);

function openAppMenu() {
  appMenu.classList.remove("hidden");
  appMenuBackdrop.classList.add("open");
}
function closeAppMenu() {
  appMenu.classList.add("hidden");
  appMenuBackdrop.classList.remove("open");
}

appMenuBtn.addEventListener("click", () => {
  if (appMenu.classList.contains("hidden")) openAppMenu();
  else closeAppMenu();
});
appMenuBackdrop.addEventListener("click", closeAppMenu);
menuOpenBtn.addEventListener("click", () => {
  closeAppMenu();
  pickFile();
});
menuSettingsBtn.addEventListener("click", () => {
  closeAppMenu();
  openSettings();
});

function activeTab() {
  return activeTabId ? tabs.get(activeTabId) || null : null;
}

function saveActiveTabState() {
  const tab = activeTab();
  if (!tab) return;

  tab.scrollTop = viewport.scrollTop;
  tab.colWidths = fileMeta ? [...colWidths] : null;
  tab.sortState = sortState;
  tab.filterState = filterState;
  tab.truncated = truncated;
  tab.totalRows = totalRows;
  tab.cache = cache;
  tab.pending = pending;
  tab.edits = edits;
  tab.viewToken = viewToken;
}

function restoreTabState(tab) {
  activeTabId = tab.id;

  if (tab.kind === "sql") {
    restoreSqlTab(tab);
  } else {
    restoreParquetTab(tab);
  }

  renderTabs();
}

function restoreParquetTab(tab) {
  currentPath = tab.path;
  fileMeta = tab.meta;
  colWidths = tab.colWidths ? [...tab.colWidths] : [];
  sortState = tab.sortState;
  filterState = tab.filterState;
  truncated = tab.truncated;
  totalRows = tab.totalRows;
  cache = tab.cache;
  pending = tab.pending;
  edits = tab.edits;
  viewToken = tab.viewToken;

  document.title = `DuckView — ${fileMeta.file_name}`;
  emptyEl.classList.add("hidden");
  sqlWorkspace.classList.add("hidden");
  tableWrap.classList.remove("hidden");
  statusBar.classList.remove("hidden");
  metaBtn.classList.remove("hidden");
  advBtn.classList.remove("hidden");
  tabBar.classList.remove("hidden");

  syncAdvancedUiFromFilterState();
  computeColWidths();
  renderHeader();
  buildMetaPanel();
  updateSpacer();

  requestAnimationFrame(() => {
    viewport.scrollTop = tab.scrollTop;
    renderRows();
    updateStatus();
  });
}

function restoreSqlTab(tab) {
  currentPath = null;
  fileMeta = null;
  editingEl = null;

  document.title = `DuckView — ${tab.title}`;
  emptyEl.classList.add("hidden");
  tableWrap.classList.add("hidden");
  statusBar.classList.add("hidden");
  metaBtn.classList.add("hidden");
  advBtn.classList.add("hidden");
  sqlWorkspace.classList.remove("hidden");
  tabBar.classList.remove("hidden");

  sqlTitle.textContent = tab.title;
  sqlInput.value = tab.sql;
  sqlError.textContent = "";
  sqlError.classList.add("hidden");

  void renderSqlTables();

  renderSqlResultTabs(tab);
  renderActiveSqlResult(tab);
}

async function renderSqlTables() {
  sqlTables.innerHTML =
      '<div class="sql-empty-tables">Loading tables…</div>';

  try {
    const tables = await invoke("list_duckdb_tables");

    if (activeTab()?.kind !== "sql") return;

    if (!tables.length) {
      sqlTables.innerHTML =
          '<div class="sql-empty-tables">Open a data file to query it.</div>';
      return;
    }

    const compareNames = (left, right) =>
        left.name.localeCompare(right.name, undefined, {
          numeric: true,
          sensitivity: "base",
        });

    const dataTables = tables
        .filter((table) => !table.is_view)
        .sort(compareNames);
    const views = tables
        .filter((table) => table.is_view)
        .sort(compareNames);

    sqlTables.innerHTML = "";
    const appendGroup = (title, entries) => {
      if (!entries.length) return;

      const heading = document.createElement("div");
      heading.className = "sql-table-group-title";
      heading.textContent = title;
      sqlTables.appendChild(heading);

      for (const table of entries) {
        const button = document.createElement("button");
        button.className = "sql-table-item";
        button.type = "button";
        button.textContent = table.name;
        button.title = `${table.name}\n${table.path}`;

        button.addEventListener("click", () => insertSqlText(table.name));
        sqlTables.appendChild(button);
      }
    };

    appendGroup("Tables", dataTables);
    appendGroup("Views", views);
  } catch (error) {
    sqlTables.innerHTML =
        `<div class="sql-empty-tables">${escapeHtml(String(error))}</div>`;
  }
}

function insertSqlText(text) {
  const tab = activeTab();
  if (!tab || tab.kind !== "sql") return;

  const start = sqlInput.selectionStart;
  const end = sqlInput.selectionEnd;
  sqlInput.setRangeText(text, start, end, "end");
  tab.sql = sqlInput.value;
  sqlInput.focus();
}

function selectSqlResult(tab, key) {
  if (!tab.results.has(key)) return;

  tab.activeResultKey = key;
  tab.error = null;
  renderSqlResultTabs(tab);
  renderActiveSqlResult(tab);
}

function activeSqlResult(tab) {
  if (!tab?.activeResultKey) return null;
  return tab.results.get(tab.activeResultKey) || null;
}

async function closeAllSqlResults(tab) {
  const results = Array.from(tab.results.values());

  for (const result of results) {
    result.closed = true;
  }

  tab.results.clear();
  tab.activeResultKey = null;

  await Promise.all(
      results
          .filter((result) => result.tableName)
          .map((result) =>
              invoke("remove_duckdb_result_table", {
                tableName: result.tableName,
              }).catch((error) => {
                console.warn(`Could not remove ${result.tableName}:`, error);
              })
          )
  );
}

async function closeSqlResult(tab, key) {
  const result = tab.results.get(key);
  if (!result) return;

  result.closed = true;
  const wasActive = tab.activeResultKey === key;

  tab.results.delete(key);

  if (wasActive) {
    tab.activeResultKey =
        Array.from(tab.results.keys()).at(-1) || null;
  }

  if (activeTab() === tab) {
    renderSqlResultTabs(tab);
    renderActiveSqlResult(tab);
  }

  if (!result.tableName) return;

  try {
    await invoke("remove_duckdb_result_table", {
      tableName: result.tableName,
    });
  } catch (error) {
    showToast(`Could not remove ${result.tableName}: ${error}`);
  } finally {
    if (activeTab()?.kind === "sql") {
      await renderSqlTables();
    }
  }
}

function renderSqlResultTabs(tab) {
  sqlResultTabs.innerHTML = "";

  if (!tab.results.size) {
    sqlResultTabs.classList.add("hidden");
    return;
  }

  sqlResultTabs.classList.remove("hidden");

  for (const [key, result] of tab.results) {
    const item = document.createElement("div");
    item.className =
        `sql-result-tab${key === tab.activeResultKey ? " active" : ""}` +
        `${result.error ? " failed" : ""}` +
        `${result.transientOnly ? " transient" : ""}`;

    const select = document.createElement("button");
    select.className = "sql-result-tab-select";
    select.type = "button";
    select.textContent = result.title;
    select.title = result.transientOnly
        ? `${result.sql}\n\nTemporary result: export as Parquet to keep it.`
        : result.sql;
    select.addEventListener("click", () => selectSqlResult(tab, key));

    const close = document.createElement("button");
    close.className = "sql-result-tab-close";
    close.type = "button";
    close.textContent = "×";
    close.title = `close ${result.title}`;
    close.setAttribute("aria-label", `close ${result.title}`);
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      void closeSqlResult(tab, key);
    });

    item.append(select, close);
    sqlResultTabs.appendChild(item);
  }
}

function renderActiveSqlResult(tab) {
  const result = activeSqlResult(tab);

  if (!result) {
    sqlResultTitle.textContent = "Result";
    sqlResultStatus.textContent = "Run a query to see results.";
    sqlError.classList.add("hidden");
    sqlExportBtn.disabled = true;
    renderSqlPlaceholder();
    return;
  }

  sqlResultTitle.textContent = result.title;
  sqlResultStatus.textContent = result.status;
  sqlExportBtn.disabled = !result.queryId;

  sqlError.textContent = result.error || "";
  sqlError.classList.toggle("hidden", !result.error);

  if (result.error) {
    sqlResultBody.innerHTML =
        '<div class="sql-result-empty">Query failed. See the error above.</div>';
  } else if (result.columns?.length) {
    renderSqlResults(result);
  } else {
    renderSqlPlaceholder();
  }
}

function renderSqlPlaceholder() {
  sqlResultBody.innerHTML =
      '<div class="sql-result-empty">Write a query above, then press <kbd>⌘</kbd><kbd>↵</kbd>.</div>';
}

function renderSqlResults(result) {
  if (!result.columns?.length) {
    renderSqlPlaceholder();
    return;
  }

  let html = '<table class="sql-result-grid"><thead><tr>';
  for (const column of result.columns) {
    html += `<th title="${escapeHtml(column.type || "value")}">${escapeHtml(column.name)}</th>`;
  }
  html += "</tr></thead><tbody>";

  for (const row of result.rows || []) {
    html += "<tr>";
    for (const value of row) {
      if (value === null || value === undefined) {
        html += '<td class="sql-null">null</td>';
      } else {
        const escaped = escapeHtml(value);
        html += `<td title="${escaped}">${escaped}</td>`;
      }
    }
    html += "</tr>";
  }

  html += "</tbody></table>";
  sqlResultBody.innerHTML = html;
}

function renderTabs() {
  tabBar.innerHTML = "";

  for (const tab of tabs.values()) {
    const el = document.createElement("div");
    el.className = `file-tab${tab.id === activeTabId ? " active" : ""}`;
    el.setAttribute("role", "button");
    el.tabIndex = 0;

    const title = tab.kind === "sql" ? tab.title : tab.meta.file_name;
    el.title = tab.kind === "sql" ? title : tab.path;

    const name = document.createElement("span");
    name.className = "file-tab-name";
    name.textContent = title;

    const close = document.createElement("button");
    close.className = "file-tab-close";
    close.type = "button";
    close.title = `close ${title}`;
    close.setAttribute("aria-label", `close ${title}`);
    close.textContent = "×";

    el.addEventListener("click", () => switchTab(tab.id));
    el.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        switchTab(tab.id);
      }
    });
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      closeTab(tab.id);
    });

    el.append(name, close);
    tabBar.appendChild(el);
  }

  const addSql = document.createElement("button");
  addSql.className = "file-tab sql-new-tab";
  addSql.type = "button";
  addSql.title = "New SQL tab";
  addSql.textContent = "+ SQL";
  addSql.addEventListener("click", createAndOpenSqlTab);
  tabBar.appendChild(addSql);

  requestAnimationFrame(() => {
    tabBar.querySelector(".file-tab.active")?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "nearest",
    });
  });
}

function createAndOpenSqlTab() {
  if (activeTab()) saveActiveTabState();

  const tab = createSqlTab();
  tabs.set(tab.id, tab);

  closeAdvanced();
  closeMeta();
  restoreTabState(tab);
}

function switchTab(tabId) {
  const next = tabs.get(tabId);
  if (!next || tabId === activeTabId) return;

  if (editingEl) commitEdit();
  saveActiveTabState();
  closeAdvanced();
  closeMeta();
  restoreTabState(next);
}

async function closeTab(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return;

  const wasActive = tabId === activeTabId;
  if (wasActive && editingEl) commitEdit();

  if (tab.kind === "sql") {
    await closeAllSqlResults(tab);
  }

  tabs.delete(tabId);

  if (tab.kind === "parquet") {
    tabIdByPath.delete(tab.path);
    await invoke("close_file", { path: tab.path }).catch(() => {});
  }

  if (!tabs.size) {
    activeTabId = null;
    currentPath = null;
    fileMeta = null;
    cache = new Map();
    pending = new Set();
    edits = new Map();

    emptyEl.classList.remove("hidden");
    tableWrap.classList.add("hidden");
    statusBar.classList.add("hidden");
    metaBtn.classList.add("hidden");
    advBtn.classList.add("hidden");
    tabBar.classList.add("hidden");
    fileNameEl.textContent = "";
    document.title = "DuckView";
    closeAdvanced();
    closeMeta();
    return;
  }

  if (wasActive) {
    restoreTabState(tabs.values().next().value);
  } else {
    renderTabs();
  }

  if (activeTab()?.kind === "sql") {
    await renderSqlTables();
  }
}



// ---- Helpers ----------------------------------------------------------------
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[m]
  );
}

function humanSize(b) {
  if (b < 1024) return b + " B";
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  let n = b;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n < 10 ? 2 : 1) + " " + u[i];
}

function setLoading(on, text) {
  if (text) loadingText.textContent = text;
  loading.classList.toggle("hidden", !on);
}

let toastTimer = null;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 4800);
}

// ---- Open a file ------------------------------------------------------------
async function openPath(path) {
  if (isCsvPath(path)) {
    openCsvImportDialog(path);
    return;
  }

  await openParquetPath(path);
}

async function openParquetPath(path) {
  const existingTabId = tabIdByPath.get(path);
  if (existingTabId) {
    switchTab(existingTabId);
    return;
  }

  setLoading(true, "Reading file…");
  try {
    const meta = await invoke("open_file", { path });
    if (tabs.has(activeTabId)) saveActiveTabState();

    const tab = createTab(path, meta);
    tabs.set(tab.id, tab);
    tabIdByPath.set(path, tab.id);

    closeAdvanced();
    closeMeta();
    restoreTabState(tab);

    await loadPage(0, true);
    renderRows();
    updateStatus();
  } catch (e) {
    showToast("Couldn’t open file: " + e);
  } finally {
    setLoading(false);
  }
}

async function pickFile() {
  try {
    const path = await invoke("pick_file");
    if (path) await openPath(path);
  } catch (e) {
    showToast(String(e));
  }
}

// ---- Column sizing ----------------------------------------------------------
function updateGridWidth() {
  gridWidth = GUTTER_W + colWidths.reduce((sum, width) => sum + width, 0);
  grid.style.width = gridWidth + "px";
}

function computeColWidths() {
  if (colWidths.length === fileMeta.columns.length) {
    updateGridWidth();
    return;
  }

  // Natural (content-based) width per column.
  const natural = fileMeta.columns.map((c) => {
    const chars = Math.max(c.name.length, (c.type || "").length + 3);
    return Math.min(340, Math.max(120, chars * 8 + 40));
  });
  const naturalTotal = natural.reduce((a, b) => a + b, 0);
  const avail = Math.max(0, viewport.clientWidth - GUTTER_W);

  if (settings.autoFit && naturalTotal > 0 && naturalTotal < avail) {
    // Room to spare: stretch columns proportionally so the grid fills the
    // window — no blank gap on the right.
    const scale = avail / naturalTotal;
    colWidths = natural.map((w) => Math.floor(w * scale));
    const used = colWidths.reduce((a, b) => a + b, 0);
    colWidths[colWidths.length - 1] += avail - used; // absorb rounding
  } else {
    // Columns already exceed the window: keep natural widths, scroll sideways.
    colWidths = natural;
  }
  updateGridWidth();
}

// ---- Rendering --------------------------------------------------------------
function renderHeader() {
  let html = '<div class="h-cell gutter">#</div>';
  fileMeta.columns.forEach((c, i) => {
    let ind = "";
    if (sortState && sortState.column === i)
      ind = `<span class="sort-ind">${sortState.ascending ? "▲" : "▼"}</span>`;
    html += `<div class="h-cell" style="width:${colWidths[i]}px" data-col="${i}" title="${escapeHtml(c.name)} · ${escapeHtml(c.type)}">
      <div class="h-name">${escapeHtml(c.name)}${ind}</div>
      <div class="h-type">${escapeHtml(c.type)}</div>
      <div class="column-resizer" data-resize-col="${i}" title="Drag to resize column" role="separator" aria-orientation="vertical"></div>
    </div>`;
  });
  html += '<div class="h-cell filler"></div>';
  headerRow.innerHTML = html;
  headerRow.style.width = "100%";
  updateGridWidth();

  headerRow.querySelectorAll(".h-cell[data-col]").forEach((el) => {
    el.addEventListener("click", () => {
      if (suppressHeaderClick) {
        suppressHeaderClick = false;
        return;
      }
      onHeaderClick(parseInt(el.dataset.col, 10));
    });
  });

  headerRow.querySelectorAll(".column-resizer").forEach((handle) => {
    handle.addEventListener("pointerdown", startColumnResize);
  });
}

function startColumnResize(event) {
  const col = parseInt(event.currentTarget.dataset.resizeCol, 10);
  if (Number.isNaN(col)) return;

  event.preventDefault();
  event.stopPropagation();

  resizeState = {
    col,
    startX: event.clientX,
    startWidth: colWidths[col],
  };

  document.body.classList.add("resizing-column");
  window.addEventListener("pointermove", resizeColumn);
  window.addEventListener("pointerup", finishColumnResize, { once: true });
}

function resizeColumn(event) {
  if (!resizeState) return;

  const width = Math.min(
      1000,
      Math.max(80, resizeState.startWidth + event.clientX - resizeState.startX)
  );

  colWidths[resizeState.col] = width;
  updateGridWidth();

  const header = headerRow.querySelector(
      `.h-cell[data-col="${resizeState.col}"]`
  );
  if (header) header.style.width = `${width}px`;

  scheduleRender();
}

function finishColumnResize() {
  if (!resizeState) return;

  resizeState = null;
  document.body.classList.remove("resizing-column");
  window.removeEventListener("pointermove", resizeColumn);

  const tab = activeTab();
  if (tab?.kind === "parquet") tab.colWidths = [...colWidths];

  suppressHeaderClick = true;
}

function updateSpacer() {
  spacer.style.height = totalRows * ROW_H + "px";
}

function getRow(i) {
  const p = Math.floor(i / PAGE);
  const page = cache.get(p);
  if (!page) return null;
  return page.rows[i - p * PAGE] ?? null;
}

// Global (file) row index for display row i — stable across sort/filter.
function getGindex(i) {
  const p = Math.floor(i / PAGE);
  const page = cache.get(p);
  if (!page) return null;
  return page.indices[i - p * PAGE] ?? null;
}

function renderRows() {
  if (!fileMeta) return;
  if (editingEl) return; // don't rebuild while a cell editor is open
  const vpH = viewport.clientHeight;
  const first = Math.max(0, Math.floor(viewport.scrollTop / ROW_H) - BUFFER);
  const visCount = Math.ceil(vpH / ROW_H) + BUFFER * 2;
  const last = Math.min(totalRows, first + visCount);
  const ncols = fileMeta.columns.length;

  let html = "";
  for (let i = first; i < last; i++) {
    const rec = getRow(i);
    const g = getGindex(i);
    const alt = i % 2 ? " alt" : "";
    html += `<div class="data-row${alt}" style="top:${i * ROW_H}px">`;
    html += `<div class="gutter">${(i + 1).toLocaleString()}</div>`;
    if (rec) {
      for (let c = 0; c < ncols; c++) {
        const w = colWidths[c];
        const key = g + ":" + c;
        const hasEdit = g !== null && edits.has(key);
        const val = hasEdit ? edits.get(key) : rec[c];
        const attrs = `data-r="${i}" data-c="${c}"`;
        if (!hasEdit && (val === null || val === undefined)) {
          html += `<div class="cell null" style="width:${w}px" ${attrs}>null</div>`;
        } else {
          let cls = fileMeta.columns[c].numeric ? "cell num" : "cell";
          if (hasEdit) cls += " edited";
          const esc = escapeHtml(val);
          html += `<div class="${cls}" style="width:${w}px" title="${esc}" ${attrs}>${esc}</div>`;
        }
      }
    } else {
      for (let c = 0; c < ncols; c++) {
        html += `<div class="cell null" style="width:${colWidths[c]}px">…</div>`;
      }
    }
    html += '<div class="cell filler"></div>';
    html += "</div>";
  }
  rows.innerHTML = html;
  ensureVisibleLoaded(first, last);
}

function scheduleRender() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    renderRows();
  });
}

// ---- Paging -----------------------------------------------------------------
function ensureVisibleLoaded(first, last) {
  if (last <= first) return;
  const startPage = Math.floor(first / PAGE);
  const endPage = Math.floor((last - 1) / PAGE);
  for (let p = startPage; p <= endPage; p++) {
    if (!cache.has(p) && !pending.has(p)) {
      loadPage(p).then((changed) => {
        if (changed) scheduleRender();
      });
    }
  }
}

async function loadPage(pageIndex, force) {
  const tab = activeTab();
  if (!tab) return false;
  if (!force && (tab.cache.has(pageIndex) || tab.pending.has(pageIndex))) return false;
  if (tab.pending.has(pageIndex)) return false;

  tab.pending.add(pageIndex);
  const token = tab.viewToken;

  try {
    const resp = await invoke("get_rows", {
      path: tab.path,
      offset: pageIndex * PAGE,
      limit: PAGE,
      sort: tab.sortState,
      filter: tab.filterState,
    });

    if (token !== tab.viewToken) return false;

    tab.cache.set(pageIndex, { rows: resp.rows, indices: resp.indices });
    tab.totalRows = resp.total_rows;
    tab.truncated = resp.truncated;

    if (tab.id === activeTabId) {
      totalRows = tab.totalRows;
      truncated = tab.truncated;
    }

    return true;
  } catch (e) {
    if (tab.id === activeTabId && token === tab.viewToken) showToast(String(e));
    return false;
  } finally {
    tab.pending.delete(pageIndex);
  }
}

// Re-fetch everything after a sort/filter change.
async function applyView() {
  const tab = activeTab();
  if (!tab) return;

  viewToken++;
  cache.clear();
  pending.clear();

  tab.viewToken = viewToken;
  tab.sortState = sortState;
  tab.filterState = filterState;
  tab.cache = cache;
  tab.pending = pending;

  const heavy = !!filterState || !!sortState;
  if (heavy) setLoading(true, filterState ? "Filtering…" : "Sorting…");
  if (!filterState) totalRows = fileMeta.num_rows;

  await loadPage(0, true);

  if (tab.id !== activeTabId) return;
  if (heavy) setLoading(false);

  totalRows = tab.totalRows;
  truncated = tab.truncated;
  viewport.scrollTop = 0;
  tab.scrollTop = 0;
  updateSpacer();
  renderRows();
  updateStatus();
}

// ---- Sorting ----------------------------------------------------------------
function onHeaderClick(colIndex) {
  if (Number.isNaN(colIndex)) return;
  if (sortState && sortState.column === colIndex) {
    sortState = sortState.ascending ? { column: colIndex, ascending: false } : null;
  } else {
    sortState = { column: colIndex, ascending: true };
  }
  renderHeader();
  applyView();
}


// ---- Status bar -------------------------------------------------------------
function updateStatus() {
  if (!fileMeta) return;
  const totalStr = fileMeta.num_rows.toLocaleString();
  if (filterState) {
    statLeft.textContent = `${totalRows.toLocaleString()} match${totalRows === 1 ? "" : "es"} of ${totalStr} rows`;
    statCenter.innerHTML = truncated
      ? `<span class="warn">Showing first ${SEARCH_CAP.toLocaleString()} matches</span>`
      : "";
  } else {
    statLeft.textContent = `${totalStr} rows × ${fileMeta.num_columns} columns`;
    statCenter.textContent = sortState
      ? `Sorted by “${fileMeta.columns[sortState.column].name}” ${sortState.ascending ? "↑" : "↓"}`
      : "";
  }
  statRight.textContent = `${humanSize(fileMeta.file_size)} · ${fileMeta.num_row_groups.toLocaleString()} row group${fileMeta.num_row_groups === 1 ? "" : "s"}`;
}

// ---- Metadata panel ---------------------------------------------------------
function buildMetaPanel() {
  const m = fileMeta;
  const row = (k, v) =>
    `<div class="meta-row"><span class="k">${k}</span><span class="v">${escapeHtml(v)}</span></div>`;
  let html = "";
  html += row("File", m.file_name);
  html += row("Size", humanSize(m.file_size));
  html += row("Rows", m.num_rows.toLocaleString());
  html += row("Columns", m.num_columns.toLocaleString());
  html += row("Row groups", m.num_row_groups.toLocaleString());
  html += row("Compression", m.compression);
  html += row("Format version", "v" + m.version);
  if (m.created_by) html += row("Created by", m.created_by);
  html += '<div class="meta-section-title">Schema</div>';
  m.columns.forEach((c) => {
    html += `<div class="schema-item"><span class="sname">${escapeHtml(c.name)}</span><span class="stype">${escapeHtml(c.type)}</span></div>`;
  });
  html += '<div class="meta-section-title">Path</div>';
  html += `<div class="meta-row"><span class="v" style="text-align:left;font-family:var(--mono);font-size:11px">${escapeHtml(m.path)}</span></div>`;
  metaBody.innerHTML = html;
}

function openMeta() {
  metaPanel.classList.add("open");
  metaBackdropEl.classList.add("open");
}
function closeMeta() {
  metaPanel.classList.remove("open");
  metaBackdropEl.classList.remove("open");
}

// ---- Cell select / inline edit ---------------------------------------------
// Double-click a cell to select its whole value (copy with ⌘C) or edit it.
// Edits are session-local overrides keyed by global row index; they are shown
// with an accent marker and are NOT written back to the .parquet file.
function startEdit(cellEl, r, c) {
  if (editingEl) commitEdit();
  const g = getGindex(r);
  if (g === null) return; // row not loaded yet
  const rec = getRow(r);
  editingFileOrig = rec && rec[c] != null ? String(rec[c]) : "";
  const key = g + ":" + c;
  const current = edits.has(key) ? edits.get(key) : editingFileOrig;

  const input = document.createElement("input");
  input.className = "cell-editor";
  input.value = current;
  cellEl.textContent = "";
  cellEl.classList.add("editing");
  cellEl.appendChild(input);
  input.focus();
  input.select(); // whole value selected → ready to copy or overtype

  editingEl = cellEl;
  editingKey = key;

  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      commitEdit();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      cancelEdit();
    }
    ev.stopPropagation(); // keep global shortcuts out of the editor
  });
  input.addEventListener("blur", commitEdit);
  viewport.addEventListener("scroll", commitEdit, { once: true });
}

function commitEdit() {
  if (!editingEl) return;
  const input = editingEl.querySelector("input");
  const val = input ? input.value : editingFileOrig;
  const key = editingKey;
  editingEl = null;
  editingKey = null;
  viewport.removeEventListener("scroll", commitEdit);
  if (val === editingFileOrig) edits.delete(key);
  else edits.set(key, val);
  scheduleRender();
}

function cancelEdit() {
  if (!editingEl) return;
  editingEl = null;
  editingKey = null;
  viewport.removeEventListener("scroll", commitEdit);
  scheduleRender();
}

rows.addEventListener("dblclick", (e) => {
  const cellEl = e.target.closest(".cell");
  if (!cellEl || cellEl.classList.contains("filler")) return;
  const r = parseInt(cellEl.dataset.r, 10);
  const c = parseInt(cellEl.dataset.c, 10);
  if (Number.isNaN(r) || Number.isNaN(c)) return;
  e.preventDefault();
  startEdit(cellEl, r, c);
});

// ---- Settings ---------------------------------------------------------------
const DEFAULT_SETTINGS = {
  theme: "auto",
  density: "default",
  font: "default",
  autoFit: true,
};
let settings = { ...DEFAULT_SETTINGS };
const DENSITY_PX = { compact: 24, default: 30, comfortable: 38 };
const FONT_PX = { small: 11, default: 12, large: 13 };

function loadSettings() {
  try {
    const raw = localStorage.getItem("duckview.settings");
    if (raw) settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (_) {
    /* ignore corrupt settings */
  }
}
function saveSettings() {
  try {
    localStorage.setItem("duckview.settings", JSON.stringify(settings));
  } catch (_) {
    /* ignore */
  }
}
function applySettings(rerender) {
  const root = document.documentElement;
  if (settings.theme === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", settings.theme);
  ROW_H = DENSITY_PX[settings.density] || 30;
  root.style.setProperty("--row-h", ROW_H + "px");
  root.style.setProperty("--cell-font", (FONT_PX[settings.font] || 12) + "px");
  if (rerender && fileMeta) {
    computeColWidths();
    renderHeader();
    updateSpacer();
    scheduleRender();
  }
}
function initSettingsControls() {
  setTheme.value = settings.theme;
  setDensity.value = settings.density;
  setFont.value = settings.font;
  setAutoFit.checked = settings.autoFit;
}
function openSettings() {
  settingsWin.classList.add("open");
  settingsBackdrop.classList.add("open");
}
function closeSettings() {
  settingsWin.classList.remove("open");
  settingsBackdrop.classList.remove("open");
}

setTheme.addEventListener("change", () => {
  settings.theme = setTheme.value;
  applySettings(false);
  saveSettings();
});
setDensity.addEventListener("change", () => {
  settings.density = setDensity.value;
  applySettings(true);
  saveSettings();
});
setFont.addEventListener("change", () => {
  settings.font = setFont.value;
  applySettings(true);
  saveSettings();
});
setAutoFit.addEventListener("change", () => {
  settings.autoFit = setAutoFit.checked;
  applySettings(true);
  saveSettings();
});

// settingsBtn.addEventListener("click", openSettings);
settingsClose.addEventListener("click", closeSettings);
settingsBackdrop.addEventListener("click", closeSettings);

// ---- Advanced filter --------------------------------------------------------
const OPERATORS = [
  { v: "contains", label: "contains" },
  { v: "not_contains", label: "does not contain" },
  { v: "equals", label: "equals" },
  { v: "not_equals", label: "not equals" },
  { v: "starts_with", label: "starts with" },
  { v: "ends_with", label: "ends with" },
  { v: "regex", label: "matches regex" },
  { v: "gt", label: "greater than (>)" },
  { v: "gte", label: "≥" },
  { v: "lt", label: "less than (<)" },
  { v: "lte", label: "≤" },
  { v: "is_null", label: "is empty" },
  { v: "is_not_null", label: "is not empty" },
];
const NO_VALUE_OPS = new Set(["is_null", "is_not_null"]);

function addConditionRow(preset) {
  const row = document.createElement("div");
  row.className = "adv-cond";
  const colOpts = fileMeta.columns
    .map((c, i) => `<option value="${i}">${escapeHtml(c.name)}</option>`)
    .join("");
  const opOpts = OPERATORS.map(
    (o) => `<option value="${o.v}">${o.label}</option>`
  ).join("");
  row.innerHTML =
    `<select class="select adv-col">${colOpts}</select>` +
    `<select class="select adv-op">${opOpts}</select>` +
    `<input class="adv-val" type="text" placeholder="value" spellcheck="false" />` +
    `<button class="adv-cs" type="button" title="Case sensitive">Aa</button>` +
    `<button class="adv-rm" type="button" title="Remove condition">✕</button>`;

  const colSel = row.querySelector(".adv-col");
  const opSel = row.querySelector(".adv-op");
  const valInp = row.querySelector(".adv-val");
  const csBtn = row.querySelector(".adv-cs");

  if (preset) {
    if (preset.column != null) colSel.value = String(preset.column);
    if (preset.op) opSel.value = preset.op;
    if (preset.value != null) valInp.value = preset.value;
    csBtn.classList.toggle("on", !!preset.case_sensitive);
  } else {
    csBtn.classList.remove("on");
  }

  const syncDisabled = () => {
    valInp.disabled = NO_VALUE_OPS.has(opSel.value);
  };
  syncDisabled();
  opSel.addEventListener("change", syncDisabled);
  csBtn.addEventListener("click", () => csBtn.classList.toggle("on"));
  row.querySelector(".adv-rm").addEventListener("click", () => {
    row.remove();
    if (!advConditions.children.length) addConditionRow();
  });
  valInp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") applyAdvanced();
  });
  advConditions.appendChild(row);
}

function gatherConditions() {
  const conds = [];
  advConditions.querySelectorAll(".adv-cond").forEach((row) => {
    const column = parseInt(row.querySelector(".adv-col").value, 10);
    const op = row.querySelector(".adv-op").value;
    const value = row.querySelector(".adv-val").value;
    const case_sensitive = row.querySelector(".adv-cs").classList.contains("on");
    if (Number.isNaN(column)) return;
    if (!NO_VALUE_OPS.has(op) && value === "") return; // skip incomplete rows
    conds.push({ column, op, value, case_sensitive });
  });
  return conds;
}

function syncAdvancedUiFromFilterState() {
  const active =
      filterState &&
      filterState.mode === "advanced" &&
      Array.isArray(filterState.conditions) &&
      filterState.conditions.length > 0;

  if (!active) {
    advCombine.value = "and";
    resetActiveAdvancedChrome(false);
    return;
  }

  advCombine.value = filterState.combine === "or" ? "or" : "and";
  resetActiveAdvancedChrome(true, filterState.conditions.length);
}

function rebuildAdvancedPanelFromFilterState() {
  advConditions.innerHTML = "";

  const active =
      filterState &&
      filterState.mode === "advanced" &&
      Array.isArray(filterState.conditions) &&
      filterState.conditions.length > 0;

  if (!active) {
    advCombine.value = "and";
    addConditionRow();
    return;
  }

  advCombine.value = filterState.combine === "or" ? "or" : "and";
  for (const condition of filterState.conditions) {
    addConditionRow(condition);
  }
}

function openAdvanced() {
  if (!fileMeta) return;
  rebuildAdvancedPanelFromFilterState();
  advPanel.classList.remove("hidden");
  advBackdrop.classList.add("open");
}
function closeAdvanced() {
  advPanel.classList.add("hidden");
  advBackdrop.classList.remove("open");
}
function resetAdvanced() {
  advConditions.innerHTML = "";
  advCombine.value = "and";
  advBtn.classList.remove("active");
  advBadge.classList.add("hidden");
  closeAdvanced();
}

function applyAdvanced() {
  const conditions = gatherConditions();
  if (!conditions.length) {
    // Nothing usable → behave like clearing.
    if (filterState && filterState.mode === "advanced") {
      filterState = null;
      applyView();
    }
    resetActiveAdvancedChrome(false);
    closeAdvanced();
    return;
  }
  filterState = { mode: "advanced", conditions, combine: advCombine.value };
  resetActiveAdvancedChrome(true, conditions.length);
  closeAdvanced();
  applyView();
}

// Toggles the toolbar chrome (badge, disabled search box) for the advanced state.
function resetActiveAdvancedChrome(active, count) {
  advBtn.classList.toggle("active", active);
  advBadge.classList.toggle("hidden", !active);
  if (active) advBadge.textContent = String(count);
}

advBtn.addEventListener("click", () => {
  if (advPanel.classList.contains("hidden")) openAdvanced();
  else closeAdvanced();
});
advBackdrop.addEventListener("click", closeAdvanced);
advAdd.addEventListener("click", () => addConditionRow());
advApply.addEventListener("click", applyAdvanced);
advClear.addEventListener("click", () => {
  advConditions.innerHTML = "";
  advCombine.value = "and";
  addConditionRow();
  const wasActive = filterState && filterState.mode === "advanced";
  resetActiveAdvancedChrome(false);
  if (wasActive) {
    filterState = null;
    applyView();
  }
});

metaBtn.addEventListener("click", () => {
  if (!fileMeta) return;
  openMeta();
});
metaClose.addEventListener("click", closeMeta);
metaBackdropEl.addEventListener("click", closeMeta);

// ---- Wiring -----------------------------------------------------------------
$("openBtn2").addEventListener("click", pickFile);
tabBar.addEventListener(
    "wheel",
    (event) => {
      if (event.deltaX === 0 && event.deltaY === 0) return;

      event.preventDefault();

      const delta = event.deltaX !== 0 ? event.deltaX : event.deltaY;
      tabBar.scrollLeft += delta;
    },
    { passive: false }
);
sqlResultTabs.addEventListener(
    "wheel",
    (event) => {
      if (event.deltaX === 0 && event.deltaY === 0) return;

      event.preventDefault();

      const delta = event.deltaX !== 0 ? event.deltaX : event.deltaY;
      sqlResultTabs.scrollLeft += delta;
    },
    { passive: false }
);
viewport.addEventListener(
    "scroll",
    () => {
      const tab = activeTab();
      if (tab) tab.scrollTop = viewport.scrollTop;
      scheduleRender();
    },
    { passive: true }
);
window.addEventListener("resize", () => {
  if (fileMeta) {
    computeColWidths();
    renderHeader();
  }
  scheduleRender();
});

window.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;

  if (mod && e.key === "Enter" && activeTab()?.kind === "sql") {
    e.preventDefault();
    runSql();
  } else if (mod && e.key.toLowerCase() === "o") {
    e.preventDefault();
    pickFile();
  } else if (mod && e.key === ",") {
    e.preventDefault();
    openSettings();
  } else if (e.key === "Escape") {
    closeExportFormatDialog();
    closeCsvImportDialog();
    closeSettings();
    closeAdvanced();
    closeMeta();
  }
});

// ---- Native file open (drag-drop, "Open With", CLI) -------------------------
listen("tauri://drag-enter", () => dropOverlay.classList.add("show"));
listen("tauri://drag-over", () => dropOverlay.classList.add("show"));
listen("tauri://drag-leave", () => dropOverlay.classList.remove("show"));
listen("tauri://drag-drop", async (e) => {
  dropOverlay.classList.remove("show");

  const paths = (e.payload?.paths || []).filter((path) => {
    const lower = path.toLowerCase();
    return lower.endsWith(".parquet") || lower.endsWith(".csv");
  });

  if (!paths.length) {
    showToast("Drop one or more .parquet or .csv files.");
    return;
  }

  for (const path of paths) {
    await openPath(path);
    if (pendingCsvImportPath) break;
  }
});

listen("open-file", (e) => {
  if (e.payload) openPath(e.payload);
});

// ---- Startup ----------------------------------------------------------------
loadSettings();
applySettings(false);
initSettingsControls();

// A file may have been passed at launch (Finder "Open With" / `open -a`).
// Retry a few times: on a cold launch the OS "Opened" event can land just
// after the first poll, so one check isn't always enough.
(async () => {
  for (const delay of [0, 400, 1200]) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    if (fileMeta) return; // a file already opened (event or earlier poll)
    try {
      const startup = await invoke("take_startup_file");
      if (startup) {
        openPath(startup);
        return;
      }
    } catch (_) {
      /* ignore */
    }
  }
})();
