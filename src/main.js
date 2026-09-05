import * as monacoApi from "monaco-editor";
import "monaco-editor/esm/vs/basic-languages/monaco.contribution";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import {
  LanguageIdEnum,
  setupLanguageFeatures,
} from "monaco-sql-languages";
import "monaco-sql-languages/esm/languages/generic/generic.contribution";
import GenericSqlWorker from "monaco-sql-languages/esm/languages/generic/generic.worker?worker";

self.MonacoEnvironment = {
  getWorker(_, label) {
    if (label === LanguageIdEnum.GSQL) {
      return new GenericSqlWorker();
    }
    return new EditorWorker();
  },
};

setupLanguageFeatures(LanguageIdEnum.GSQL, {
  completionItems: true,
  diagnostics: true,
});

globalThis.MonacoEnvironment = {
  getWorker(_, label) {
    console.warn("Monaco worker requested:", label);

    if (label === LanguageIdEnum.GENERIC) {
      console.warn("Starting DTStack Generic SQL worker.");
      return new GenericSqlWorker();
    }

    return new EditorWorker();
  },
};

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
const appTitleEl = $("appTitle");
const fileNameEl = $("fileName");
const tabBar = $("tabBar");
const sqlWorkspace = $("sqlWorkspace");
const sqlTitle = $("sqlTitle");
const sqlTables = $("sqlTables");
const sqlEditorEl = $("sqlEditor");
const sqlEditorPane = $("sqlEditorPane");
const sqlPaneSplitter = $("sqlPaneSplitter");
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
const exportExcelCsvBtn = $("exportExcelCsvBtn");
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
const menuNewWorkspaceBtn = $("menuNewWorkspaceBtn");
const menuWorkspaceList = $("menuWorkspaceList");
const menuSaveWorkspaceAsBtn = $("menuSaveWorkspaceAsBtn");
const menuDeleteWorkspaceBtn = $("menuDeleteWorkspaceBtn");
const workspaceDialog = $("workspaceDialog");
const workspaceDialogBackdrop = $("workspaceDialogBackdrop");
const workspaceDialogTitle = $("workspaceDialogTitle");
const workspaceDialogDescription = $("workspaceDialogDescription");
const workspaceDialogInputRow = $("workspaceDialogInputRow");
const workspaceDialogInput = $("workspaceDialogInput");
const workspaceDialogClose = $("workspaceDialogClose");
const workspaceDialogCancelBtn = $("workspaceDialogCancelBtn");
const workspaceDialogConfirmBtn = $("workspaceDialogConfirmBtn");
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

const workspaceViews = new Map();

let editingEl = null;
let editingKey = null;
let editingFileOrig = "";
let rafPending = false;
let pendingCsvImportPath = null;
let sqlPaneResizeState = null;
let workspaceDialogResolve = null;

let sqlEditor = null;
let sqlCompletionTables = [];
let pendingSqlEditorValue = null;
const sqlTableColumns = new Map();
const sqlTableColumnRequests = new Map();

const SQL_KEYWORDS = [
  "SELECT",
  "FROM",
  "WHERE",
  "JOIN",
  "LEFT JOIN",
  "RIGHT JOIN",
  "FULL JOIN",
  "INNER JOIN",
  "ON",
  "GROUP BY",
  "HAVING",
  "ORDER BY",
  "LIMIT",
  "OFFSET",
  "WITH",
  "AS",
  "DISTINCT",
  "UNION",
  "UNION ALL",
  "INSERT INTO",
  "UPDATE",
  "DELETE FROM",
  "CREATE TABLE",
  "CREATE VIEW",
  "DROP TABLE",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "AND",
  "OR",
  "NOT",
  "NULL",
  "IS NULL",
  "COUNT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "COALESCE",
  "CAST",
  "DATE_TRUNC",
  "NOW",
];

const WORKSPACE_STORAGE_KEY = "duckview.workspaces.v1";
const WORKSPACE_SNAPSHOT_KEY_PREFIX = "duckview.workspace.v1:";
const LEGACY_WORKSPACE_STORAGE_KEY = "duckview.workspace.v1";
const DEFAULT_WORKSPACE_NAME = "Default";

let workspaceSaveTimer = null;
let workspaceStore = null;
let isSwitchingWorkspace = false;

function workspaceSnapshotStorageKey(workspaceId) {
  return `${WORKSPACE_SNAPSHOT_KEY_PREFIX}${workspaceId}`;
}

function emptyWorkspaceSnapshot() {
  return {
    parquetPaths: [],
    sqlTabs: [],
    savedViews: [],
    activeTabRef: null,
  };
}

function createWorkspaceId() {
  return `workspace-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createWorkspace(name) {
  return {
    id: createWorkspaceId(),
    name,
    updatedAt: Date.now(),
  };
}

function readWorkspaceSnapshot(workspaceId) {
  try {
    const raw = localStorage.getItem(workspaceSnapshotStorageKey(workspaceId));
    const snapshot = raw ? JSON.parse(raw) : null;

    return snapshot && typeof snapshot === "object"
        ? snapshot
        : emptyWorkspaceSnapshot();
  } catch (error) {
    console.warn(`Could not read workspace "${workspaceId}":`, error);
    return emptyWorkspaceSnapshot();
  }
}

function writeWorkspaceSnapshot(workspaceId, snapshot) {
  const safeSnapshot =
      snapshot && typeof snapshot === "object"
          ? snapshot
          : emptyWorkspaceSnapshot();

  try {
    localStorage.setItem(
        workspaceSnapshotStorageKey(workspaceId),
        JSON.stringify(safeSnapshot)
    );
  } catch (error) {
    console.warn(`Could not save workspace "${workspaceId}":`, error);
  }
}

function persistWorkspaceStore() {
  try {
    localStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        JSON.stringify({
          activeWorkspaceId: workspaceStore.activeWorkspaceId,
          workspaces: workspaceStore.workspaces,
        })
    );
  } catch (error) {
    console.warn("Could not save workspace list:", error);
  }
}

function isWorkspaceMetadata(workspace) {
  return (
      workspace &&
      typeof workspace.id === "string" &&
      typeof workspace.name === "string"
  );
}

function loadWorkspaceStore() {
  try {
    const stored = JSON.parse(
        localStorage.getItem(WORKSPACE_STORAGE_KEY) || "null"
    );

    const hasWorkspaceList =
        Array.isArray(stored?.workspaces) &&
        stored.workspaces.length > 0 &&
        stored.workspaces.every(isWorkspaceMetadata);

    const hasEmbeddedSnapshots =
        hasWorkspaceList &&
        stored.workspaces.some(
            (workspace) =>
                workspace.snapshot &&
                typeof workspace.snapshot === "object"
        );

    // Current format:
    // - only id / name / updatedAt for list keys
    // - save snapshot in individual workspace key
    if (
        hasWorkspaceList &&
        !hasEmbeddedSnapshots &&
        typeof stored.activeWorkspaceId === "string"
    ) {
      workspaceStore = {
        activeWorkspaceId: stored.workspaces.some(
            (workspace) => workspace.id === stored.activeWorkspaceId
        )
            ? stored.activeWorkspaceId
            : stored.workspaces[0].id,
        workspaces: stored.workspaces.map((workspace) => ({
          id: workspace.id,
          name: workspace.name,
          updatedAt: Number.isFinite(workspace.updatedAt)
              ? workspace.updatedAt
              : Date.now(),
        })),
      };
      return;
    }

    // Previous multiple workspace format:
    // Since the snapshot is embedded in the list data, move to the individual key.
    if (hasWorkspaceList && hasEmbeddedSnapshots) {
      const workspaces = stored.workspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        updatedAt: Number.isFinite(workspace.updatedAt)
            ? workspace.updatedAt
            : Date.now(),
      }));

      for (const workspace of stored.workspaces) {
        if (workspace.snapshot && typeof workspace.snapshot === "object") {
          writeWorkspaceSnapshot(workspace.id, workspace.snapshot);
        }
      }

      workspaceStore = {
        activeWorkspaceId: workspaces.some(
            (workspace) => workspace.id === stored.activeWorkspaceId
        )
            ? stored.activeWorkspaceId
            : workspaces[0].id,
        workspaces,
      };
      persistWorkspaceStore();
      return;
    }

    // The earliest single workspace format.
    const legacySnapshot = JSON.parse(
        localStorage.getItem(LEGACY_WORKSPACE_STORAGE_KEY) || "null"
    );
    const defaultWorkspace = createWorkspace(DEFAULT_WORKSPACE_NAME);

    writeWorkspaceSnapshot(defaultWorkspace.id, legacySnapshot);
    workspaceStore = {
      activeWorkspaceId: defaultWorkspace.id,
      workspaces: [defaultWorkspace],
    };
    persistWorkspaceStore();
  } catch (error) {
    console.warn("Could not load workspaces:", error);

    const defaultWorkspace = createWorkspace(DEFAULT_WORKSPACE_NAME);
    writeWorkspaceSnapshot(defaultWorkspace.id, emptyWorkspaceSnapshot());
    workspaceStore = {
      activeWorkspaceId: defaultWorkspace.id,
      workspaces: [defaultWorkspace],
    };
    persistWorkspaceStore();
  }
}

function activeWorkspace() {
  return workspaceStore?.workspaces.find(
      (workspace) => workspace.id === workspaceStore.activeWorkspaceId
  ) || null;
}

function renderWorkspaceTitle() {
  const name = activeWorkspace()?.name || "DuckView";
  appTitleEl.textContent = name;
  appTitleEl.title = `Workspace: ${name}`;
}

function closeWorkspaceDialog(result = null) {
  workspaceDialog.classList.remove("open");
  workspaceDialogBackdrop.classList.remove("open");

  const resolve = workspaceDialogResolve;
  workspaceDialogResolve = null;
  resolve?.(result);
}

function requestWorkspaceDialog({
                                  title,
                                  description,
                                  confirmLabel,
                                  initialValue = "",
                                  needsName = false,
                                }) {
  return new Promise((resolve) => {
    workspaceDialogResolve = resolve;
    workspaceDialogTitle.textContent = title;
    workspaceDialogDescription.textContent = description;
    workspaceDialogConfirmBtn.textContent = confirmLabel;
    workspaceDialogInputRow.classList.toggle("hidden", !needsName);
    workspaceDialogInput.value = initialValue;

    workspaceDialog.classList.add("open");
    workspaceDialogBackdrop.classList.add("open");

    requestAnimationFrame(() => {
      if (needsName) {
        workspaceDialogInput.focus();
        workspaceDialogInput.select();
      } else {
        workspaceDialogConfirmBtn.focus();
      }
    });
  });
}

function requestWorkspaceName(title, initialValue, confirmLabel) {
  return requestWorkspaceDialog({
    title,
    description: "Enter a name for this workspace.",
    confirmLabel,
    initialValue,
    needsName: true,
  });
}

function confirmWorkspaceAction(title, description, confirmLabel) {
  return requestWorkspaceDialog({
    title,
    description,
    confirmLabel,
    needsName: false,
  });
}

function workspaceSnapshot() {
  const parquetPaths = [];
  const sqlTabs = [];
  let activeTabRef = null;

  for (const tab of tabs.values()) {
    if (tab.kind === "parquet") {
      parquetPaths.push(tab.path);

      if (tab.id === activeTabId) {
        activeTabRef = { kind: "parquet", path: tab.path };
      }
    } else if (tab.kind === "sql") {
      const index = sqlTabs.length;
      sqlTabs.push({
        number: tab.number,
        title: tab.title,
        sql: tab.sql,
        editorPaneHeight: tab.editorPaneHeight,
      });

      if (tab.id === activeTabId) {
        activeTabRef = { kind: "sql", index };
      }
    }
  }

  return {
    parquetPaths,
    sqlTabs,
    savedViews: Array.from(workspaceViews.values()),
    activeTabRef,
  };
}

function queueWorkspaceSave() {
  if (isSwitchingWorkspace) return;

  clearTimeout(workspaceSaveTimer);
  workspaceSaveTimer = setTimeout(saveWorkspace, 600);
}

function saveWorkspace() {
  if (isSwitchingWorkspace) return;

  const workspace = activeWorkspace();
  if (!workspace) return;

  workspace.updatedAt = Date.now();
  writeWorkspaceSnapshot(workspace.id, workspaceSnapshot());
  persistWorkspaceStore();
}

async function saveWorkspaceAs() {
  const name = await requestWorkspaceName(
      "Save Workspace As",
      `${activeWorkspace()?.name || "Workspace"} copy`,
      "Save"
  );
  const trimmedName = name?.trim();

  if (!trimmedName) return;

  if (
      workspaceStore.workspaces.some(
          (workspace) =>
              workspace.name.toLocaleLowerCase() === trimmedName.toLocaleLowerCase()
      )
  ) {
    showToast("A workspace with that name already exists.");
    return;
  }

  saveWorkspace();

  const workspace = createWorkspace(trimmedName);
  writeWorkspaceSnapshot(workspace.id, workspaceSnapshot());

  workspaceStore.workspaces.push(workspace);
  workspaceStore.activeWorkspaceId = workspace.id;
  persistWorkspaceStore();
  renderWorkspaceTitle();

  showToast(`Workspace “${workspace.name}” created.`);
}

function resetWorkspaceUi() {
  activeTabId = null;
  currentPath = null;
  fileMeta = null;
  totalRows = 0;
  sortState = null;
  filterState = null;
  truncated = false;
  cache = new Map();
  pending = new Set();
  edits = new Map();
  sqlCompletionTables = [];
  sqlTableColumns.clear();
  sqlTableColumnRequests.clear();

  rows.innerHTML = "";
  headerRow.innerHTML = "";
  spacer.style.height = "0";
  fileNameEl.textContent = "";
  document.title = "DuckView";

  emptyEl.classList.remove("hidden");
  tableWrap.classList.add("hidden");
  sqlWorkspace.classList.add("hidden");
  statusBar.classList.add("hidden");
  tabBar.classList.add("hidden");
  metaBtn.classList.add("hidden");
  advBtn.classList.add("hidden");

  closeAdvanced();
  closeMeta();
}

async function clearCurrentWorkspace() {
  for (const viewName of Array.from(workspaceViews.keys())) {
    await invoke("remove_duckdb_result_table", { tableName: viewName })
        .catch(() => {});
  }
  workspaceViews.clear();

  for (const tabId of Array.from(tabs.keys())) {
    await closeTab(tabId);
  }

  tabs.clear();
  tabIdByPath.clear();
  resetWorkspaceUi();
}

async function switchWorkspace(workspaceId) {
  if (workspaceId === workspaceStore.activeWorkspaceId) return;

  const target = workspaceStore.workspaces.find(
      (workspace) => workspace.id === workspaceId
  );
  if (!target) return;

  saveWorkspace();
  clearTimeout(workspaceSaveTimer);

  isSwitchingWorkspace = true;
  try {
    await clearCurrentWorkspace();

    workspaceStore.activeWorkspaceId = target.id;
    persistWorkspaceStore();
    renderWorkspaceTitle();

    await restoreWorkspaceSnapshot(readWorkspaceSnapshot(target.id));
  } finally {
    isSwitchingWorkspace = false;
  }

  showToast(`Opened workspace “${target.name}”.`);
}

async function newWorkspace() {
  const name = await requestWorkspaceName(
      "New Workspace",
      "Untitled Workspace",
      "Create"
  );
  const trimmedName = name?.trim();

  if (!trimmedName) return;

  if (
      workspaceStore.workspaces.some(
          (workspace) =>
              workspace.name.toLocaleLowerCase() === trimmedName.toLocaleLowerCase()
      )
  ) {
    showToast("A workspace with that name already exists.");
    return;
  }

  saveWorkspace();

  const workspace = createWorkspace(trimmedName);
  writeWorkspaceSnapshot(workspace.id, emptyWorkspaceSnapshot());
  workspaceStore.workspaces.push(workspace);
  persistWorkspaceStore();

  await switchWorkspace(workspace.id);
}

async function deleteActiveWorkspace() {
  const workspace = activeWorkspace();
  if (!workspace) return;

  const confirmed = await confirmWorkspaceAction(
      "Delete Workspace",
      `Delete workspace “${workspace.name}”? This does not delete source files.`,
      "Delete"
  );
  if (!confirmed) return;

  const index = workspaceStore.workspaces.findIndex(
      (item) => item.id === workspace.id
  );
  workspaceStore.workspaces.splice(index, 1);

  if (!workspaceStore.workspaces.length) {
    const replacement = createWorkspace("Untitled Workspace");
    workspaceStore.workspaces.push(replacement);
    writeWorkspaceSnapshot(replacement.id, emptyWorkspaceSnapshot());
  }

  const nextWorkspace =
      workspaceStore.workspaces[Math.min(index, workspaceStore.workspaces.length - 1)];

  isSwitchingWorkspace = true;
  try {
    await clearCurrentWorkspace();

    localStorage.removeItem(workspaceSnapshotStorageKey(workspace.id));
    workspaceStore.activeWorkspaceId = nextWorkspace.id;
    persistWorkspaceStore();
    renderWorkspaceTitle();

    await restoreWorkspaceSnapshot(readWorkspaceSnapshot(nextWorkspace.id));
  } finally {
    isSwitchingWorkspace = false;
  }

  showToast(`Workspace “${workspace.name}” deleted.`);
}

async function restoreWorkspace() {
  loadWorkspaceStore();
  renderWorkspaceTitle();

  const workspace = activeWorkspace();
  if (!workspace) {
    resetWorkspaceUi();
    return;
  }

  await restoreWorkspaceSnapshot(readWorkspaceSnapshot(workspace.id));
}

async function restoreWorkspaceSnapshot(saved) {
  const snapshot = saved && typeof saved === "object"
      ? saved
      : emptyWorkspaceSnapshot();

  const parquetPaths = Array.isArray(snapshot.parquetPaths)
      ? snapshot.parquetPaths.filter((path) => typeof path === "string")
      : [];
  const savedViews = Array.isArray(snapshot.savedViews)
      ? snapshot.savedViews
      : [];
  const sqlTabsSaved = Array.isArray(snapshot.sqlTabs)
      ? snapshot.sqlTabs
      : [];
  const activeRef = snapshot.activeTabRef;

  resetWorkspaceUi();

  const parquetTabIds = new Map();
  for (const path of parquetPaths) {
    const exists = await invoke("parquet_file_exists", { path })
        .catch(() => false);

    if (!exists) {
      const tab = createTab(path, missingParquetMeta(path));
      tab.missing = true;
      tab.missingError = "The file no longer exists at its saved location.";
      tabs.set(tab.id, tab);
      tabIdByPath.set(path, tab.id);
      parquetTabIds.set(path, tab.id);
      continue;
    }

    try {
      const meta = await invoke("open_file", { path });
      const tab = createTab(path, meta);
      tabs.set(tab.id, tab);
      tabIdByPath.set(path, tab.id);
      parquetTabIds.set(path, tab.id);
    } catch (error) {
      const tab = createTab(path, missingParquetMeta(path));
      tab.missing = true;
      tab.missingError = String(error);
      tabs.set(tab.id, tab);
      tabIdByPath.set(path, tab.id);
      parquetTabIds.set(path, tab.id);
    }
  }

  for (const view of savedViews) {
    if (
        typeof view?.name !== "string" ||
        !view.name.trim() ||
        typeof view?.sql !== "string" ||
        !view.sql.trim()
    ) {
      continue;
    }

    const restoredView = { name: view.name.trim(), sql: view.sql };
    workspaceViews.set(restoredView.name, restoredView);

    try {
      await invoke("restore_duckdb_view", {
        viewName: restoredView.name,
        sql: restoredView.sql,
      });
    } catch (error) {
      console.warn(`Could not restore view "${restoredView.name}":`, error);
    }
  }

  const sqlTabIds = [];
  for (const item of sqlTabsSaved) {
    if (typeof item?.sql !== "string") continue;

    const tab = createSqlTab();
    tab.number = Number.isInteger(item.number) && item.number > 0
        ? item.number
        : tab.number;
    tab.title = typeof item.title === "string" && item.title.trim()
        ? item.title
        : `SQL ${tab.number}`;
    tab.sql = item.sql;
    tab.editorPaneHeight =
        Number.isFinite(item.editorPaneHeight) && item.editorPaneHeight >= 180
            ? item.editorPaneHeight
            : null;

    tabs.set(tab.id, tab);
    sqlTabIds.push(tab.id);
  }

  let tabToActivate = null;
  if (activeRef?.kind === "parquet") {
    tabToActivate = tabs.get(parquetTabIds.get(activeRef.path) || "");
  } else if (
      activeRef?.kind === "sql" &&
      Number.isInteger(activeRef.index) &&
      activeRef.index >= 0
  ) {
    tabToActivate = tabs.get(sqlTabIds[activeRef.index] || "");
  }

  tabToActivate =
      tabToActivate ||
      tabs.get(parquetTabIds.values().next().value || "") ||
      tabs.get(sqlTabIds[0] || "");

  if (tabToActivate) {
    restoreTabState(tabToActivate);

    if (tabToActivate.kind === "parquet" && !tabToActivate.missing) {
      await loadPage(0, true);
      renderRows();
      updateStatus();
    }
  }
}

function missingParquetMeta(path) {
  const file_name = path.split(/[\\/]/).pop() || path;
  return {
    path,
    file_name,
    file_size: 0,
    num_rows: 0,
    num_columns: 0,
    num_row_groups: 0,
    compression: "—",
    created_by: null,
    version: 0,
    columns: [],
  };
}

function createTab(path, meta) {
  return {
    id: `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    kind: "parquet",
    path,
    meta,
    missing: false,
    missingError: null,
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

function nextSqlTabNumber() {
  const usedNumbers = new Set(
      Array.from(tabs.values())
          .filter((tab) => tab.kind === "sql")
          .map((tab) => tab.number)
  );

  let number = 1;
  while (usedNumbers.has(number)) {
    number += 1;
  }

  return number;
}

function createSqlTab() {
  const number = nextSqlTabNumber();

  return {
    id: `sql-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    kind: "sql",
    number,
    title: `SQL ${number}`,
    sql: "SELECT 1;",
    error: null,
    results: new Map(),
    activeResultKey: null,
    nextResultNumber: 1,
    resultStatus: "Run a query to see results.",
    editorPaneHeight: null,
  };
}

function sqlIdentifier(fileName) {
  return fileName
      .replace(/\.[^.]+$/, "")
      .replace(/[^A-Za-z0-9_]/g, "_")
      .replace(/^[^A-Za-z_]/, "_")
      .toLowerCase();
}

function quoteSqlIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function sqlStatementAtCursor(sql, cursor) {
  const statements = [];
  let start = 0;
  let contentStart = null;
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
      contentStart ??= i;
      quote = ch;
      continue;
    }

    if (ch === ";") {
      statements.push({ start, end: i, contentStart });
      start = i + 1;
      contentStart = null;
      continue;
    }

    if (!/\s/.test(ch)) {
      contentStart ??= i;
    }
  }

  if (start < sql.length) {
    statements.push({ start, end: sql.length, contentStart });
  }

  if (!statements.length) {
    return {
      sql: "",
      number: 1,
      count: 0,
    };
  }

  let statementIndex = statements.findIndex(
      (statement) =>
          cursor >= statement.start &&
          cursor <= statement.end
  );

  if (
      statementIndex > 0 &&
      (
          statements[statementIndex].contentStart === null ||
          cursor < statements[statementIndex].contentStart
      )
  ) {
    statementIndex -= 1;
  }

  if (statementIndex < 0) {
    for (let index = statements.length - 1; index >= 0; index--) {
      const statement = statements[index];

      if (statement.end >= cursor) continue;

      const gap = sql.slice(statement.end + 1, cursor);
      if (!gap.trim()) {
        statementIndex = index;
        break;
      }
    }
  }

  if (statementIndex < 0) {
    statementIndex = statements.findIndex(
        (statement) => statement.start > cursor
    );
  }

  if (statementIndex < 0) {
    statementIndex = statements.length - 1;
  }

  const statement = statements[statementIndex];
  const text = sql.slice(statement.start, statement.end).trim();

  return {
    sql: text,
    number: statementIndex + 1,
    count: statements.length,
  };
}

function isDarkSqlTheme() {
  if (settings.theme === "dark") return true;
  if (settings.theme === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function sqlEditorThemeName() {
  return isDarkSqlTheme() ? "duckview-dark" : "duckview-light";
}

function syncSqlEditorTheme() {
  monacoApi.editor.setTheme(sqlEditorThemeName());
}

function sqlEditorValue() {
  return sqlEditor ? sqlEditor.getValue() : "";
}

function sqlCursorOffset() {
  if (!sqlEditor) return 0;

  const position = sqlEditor.getPosition();
  const model = sqlEditor.getModel();
  return position && model ? model.getOffsetAt(position) : 0;
}

function setSqlEditorValue(value) {
  const sql = String(value ?? "");

  if (!sqlEditor) {
    pendingSqlEditorValue = sql;
    return;
  }

  if (sqlEditor.getValue() !== sql) {
    sqlEditor.setValue(sql);
  }
}

function completionInsertText(tableName) {
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(tableName)
      ? tableName
      : quoteSqlIdentifier(tableName);
}

function unquoteSqlIdentifier(value) {
  const text = String(value || "").trim();

  if (
      text.length >= 2 &&
      ((text.startsWith('"') && text.endsWith('"')) ||
          (text.startsWith("`") && text.endsWith("`")))
  ) {
    return text.slice(1, -1).replace(/""/g, '"').replace(/``/g, "`");
  }

  return text;
}

function findSqlCompletionTable(name) {
  const normalized = unquoteSqlIdentifier(name).toLowerCase();

  return sqlCompletionTables.find(
      (table) => table.name.toLowerCase() === normalized,
  ) || null;
}

async function getSqlTableColumns(tableName) {
  const table = findSqlCompletionTable(tableName);

  if (!table) {
    return [];
  }

  if (sqlTableColumns.has(table.name)) {
    return sqlTableColumns.get(table.name);
  }

  if (!sqlTableColumnRequests.has(table.name)) {
    const request = invoke("get_duckdb_table_columns", {
      tableName: table.name,
    })
        .then((columns) => {
          sqlTableColumns.set(table.name, columns);
          return columns;
        })
        .catch((error) => {
          console.warn(
              `Could not load columns for "${table.name}":`,
              error,
          );
          return [];
        })
        .finally(() => {
          sqlTableColumnRequests.delete(table.name);
        });

    sqlTableColumnRequests.set(table.name, request);
  }

  return sqlTableColumnRequests.get(table.name);
}

function sqlAliasesFromEntities(entities, sql) {
  const aliases = new Map();

  for (const entity of entities || []) {
    if (entity.entityContextType !== "table") {
      continue;
    }

    const tableName = unquoteSqlIdentifier(entity.text);
    const alias = unquoteSqlIdentifier(entity._alias?.text);

    if (findSqlCompletionTable(tableName)) {
      aliases.set(tableName.toLowerCase(), tableName);

      if (alias) {
        aliases.set(alias.toLowerCase(), tableName);
      }
    }
  }

  const relationPattern =
      /\b(?:from|join)\s+("[^"]+"|`[^`]+`|[A-Za-z_][A-Za-z0-9_$]*)(?:\s+(?:as\s+)?([A-Za-z_][A-Za-z0-9_$]*))?/gi;

  for (const match of sql.matchAll(relationPattern)) {
    const tableName = unquoteSqlIdentifier(match[1]);
    const alias = match[2];

    if (!findSqlCompletionTable(tableName)) {
      continue;
    }

    aliases.set(tableName.toLowerCase(), tableName);

    if (
        alias &&
        !["where", "join", "left", "right", "inner", "full", "on", "group",
          "order", "limit", "having", "union"].includes(alias.toLowerCase())
    ) {
      aliases.set(alias.toLowerCase(), tableName);
    }
  }

  return aliases;
}

function sqlColumnCompletionItems(columns, tableName) {
  return columns.map((column) => ({
    label: column.name,
    kind: monacoApi.languages.CompletionItemKind.Field,
    insertText: completionInsertText(column.name),
    detail: `${tableName} · ${column.type}`,
    sortText: `0_${column.name}`,
  }));
}

function sqlCompletionService(
    model,
    position,
    _context,
    suggestions,
    entities,
    snippets,
) {
  const sql = model.getValue();
  const cursorOffset = model.getOffsetAt(position);
  const beforeCursor = sql.slice(0, cursorOffset);

  const qualifierMatch =
      /(?:"([^"]+)"|`([^`]+)`|([A-Za-z_][A-Za-z0-9_$]*))\.\s*[A-Za-z0-9_$]*$/
          .exec(beforeCursor);

  if (qualifierMatch) {
    const qualifier =
        qualifierMatch[1] || qualifierMatch[2] || qualifierMatch[3];
    const aliases = sqlAliasesFromEntities(entities, sql);
    const tableName = aliases.get(qualifier.toLowerCase());

    if (!tableName) {
      return Promise.resolve([]);
    }

    return getSqlTableColumns(tableName).then((columns) =>
        sqlColumnCompletionItems(columns, tableName)
    );
  }

  const tableContext =
      /(?:\bfrom|\bjoin)\s+(?:"[^"]*"|`[^`]*`|[A-Za-z_][A-Za-z0-9_$]*)?$/i
          .test(beforeCursor);

  const tableItems = tableContext
      ? sqlCompletionTables.map((table) => ({
        label: table.name,
        kind: monacoApi.languages.CompletionItemKind.Struct,
        insertText: completionInsertText(table.name),
        detail: table.is_view ? "DuckDB view" : "Open data table",
        sortText: `0_${table.name}`,
      }))
      : [];

  const keywordItems = (suggestions?.keywords || []).map((keyword) => ({
    label: keyword,
    kind: monacoApi.languages.CompletionItemKind.Keyword,
    detail: "SQL keyword",
    sortText: `1_${keyword}`,
  }));

  const snippetItems = (snippets || []).map((snippet) => ({
    label: snippet.label || snippet.prefix,
    kind: monacoApi.languages.CompletionItemKind.Snippet,
    insertText: snippet.insertText,
    insertTextRules:
    monacoApi.languages.CompletionItemInsertTextRule.InsertAsSnippet,
    detail: snippet.description || "SQL snippet",
    sortText: `2_${snippet.prefix}`,
  }));

  return Promise.resolve([
    ...tableItems,
    ...keywordItems,
    ...snippetItems,
  ]);
}

function initSqlEditor() {
  const createEditor = () => {
    const monaco = monacoApi;

    monaco.editor.defineTheme("duckview-light", {
      base: "vs",
      inherit: true,
      colors: {
        "editor.background": "#FFFFFF",
        "editor.foreground": "#1C1D21",
        "editor.lineHighlightBackground": "#F5F6F8",
        "editorLineNumber.foreground": "#9A9EA9",
        "editorLineNumber.activeForeground": "#EA810D",
        "editorCursor.foreground": "#EA810D",
        "editor.selectionBackground": "#D3EA6A66",
        "editor.inactiveSelectionBackground": "#3A748533",
        "editorSuggestWidget.background": "#FFFFFF",
        "editorSuggestWidget.border": "#D0D3DC",
        "editorSuggestWidget.selectedBackground": "#EAEEFF",
      },
      rules: [
        { token: "predefined", foreground: "0F766E", fontStyle: "bold" },
        { token: "predefined.sql", foreground: "0F766E", fontStyle: "bold" },
        { token: "string.sql", foreground: "087443" },
        { token: "number", foreground: "A04E00" },
        { token: "number.sql", foreground: "A04E00" },
        { token: "comment", foreground: "7A7F8A", fontStyle: "italic" },
        { token: "comment.sql", foreground: "7A7F8A", fontStyle: "italic" },
      ],
    });

    monaco.editor.defineTheme("duckview-dark", {
      base: "vs-dark",
      inherit: true,
      colors: {
        "editor.background": "#26272C",
        "editor.foreground": "#E8E9EC",
        "editor.lineHighlightBackground": "#2C2E35",
        "editorLineNumber.foreground": "#6F7480",
        "editorLineNumber.activeForeground": "#FFA06D",
        "editorCursor.foreground": "#FFA06D",
        "editor.selectionBackground": "#4395A880",
        "editor.inactiveSelectionBackground": "#43A8A04D",
        "editorSuggestWidget.background": "#26272C",
        "editorSuggestWidget.border": "#3F424B",
        "editorSuggestWidget.selectedBackground": "#2A2F4A",
      },
      "rules": [
        { token: 'type', foreground: '#577D99' },
        { token: 'type.sql', foreground: '#577D99' },
        { token: "predefined", foreground: "#7686A4", fontStyle: "bold" },
        { token: "predefined.sql", foreground: "#7686A4", fontStyle: "bold" },
        { token: 'keyword', foreground: '#acb3bc' },
        { token: 'keyword.sql', foreground: '#acb3bc' },
        { token: "string", foreground: "#83A0B7" },
        { token: "string.sql", foreground: "#83A0B7" },
        { token: "number", foreground: "#FFC66D" },
        { token: "number.sql", foreground: "#FFC66D" },
        { token: "comment", foreground: "#8C919E", fontStyle: "italic" },
        { token: "comment.sql", foreground: "#8C919E", fontStyle: "italic" },
        { token: 'operator', foreground: '#7E5151FF', fontStyle: "bold" },
        { token: 'operator.sql', foreground: '#7E5151FF', fontStyle: "bold" }
      ],
    });

    const languageReady = monaco.languages.onLanguage(
      LanguageIdEnum.GENERIC,
      () => {
        console.warn("DTStack Generic SQL language loaded.");

        setupLanguageFeatures(LanguageIdEnum.GENERIC, {
          completionItems: {
            enable: true,
            triggerCharacters: [" ", "."],
            completionService: sqlCompletionService,
          },
          diagnostics: false,
          definitions: false,
          references: false,
          hover: false,
        });

        languageReady.dispose();
      },
    );

    sqlEditor = monaco.editor.create(sqlEditorEl, {
      value: pendingSqlEditorValue || "SELECT 1;",
      language: LanguageIdEnum.GENERIC,
      theme: sqlEditorThemeName(),
      automaticLayout: true,
      fixedOverflowWidgets: true,
      fontFamily: "var(--mono)",
      fontSize: 12,
      lineHeight: 19,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      tabSize: 2,
      insertSpaces: true,
      wordWrap: "on",
      quickSuggestions: {
        other: true,
        comments: false,
        strings: false,
      },
      suggestOnTriggerCharacters: true,
      padding: {
        top: 12,
        bottom: 12,
      },
    });

    pendingSqlEditorValue = null;

    sqlEditor.onDidChangeModelContent(() => {
      const tab = activeTab();
      if (tab?.kind === "sql") {
        tab.sql = sqlEditor.getValue();
        queueWorkspaceSave();
      }
    });

    sqlEditor.addAction({
      id: "duckview.run-sql",
      label: "Run SQL at Cursor",
      keybindings: [
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
      ],
      run: () => runSql(),
    });

    sqlEditor.addAction({
      id: "duckview.trigger-sql-completion",
      label: "Trigger SQL Completion",
      keybindings: [
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI,
      ],
      run: () => {
        sqlEditor.focus();

        const model = sqlEditor.getModel();
        const action = sqlEditor.getAction("editor.action.triggerSuggest");

        console.warn("SQL completion diagnostics:", {
          modelLanguageId: model?.getLanguageId(),
          expectedLanguageId: LanguageIdEnum.GENERIC,
          modelUri: model?.uri.toString(),
          hasSuggestAction: Boolean(action),
          registeredGenericLanguage: monaco.languages
              .getLanguages()
              .some((language) => language.id === LanguageIdEnum.GENERIC),
        });

        if (!action) {
          console.warn("Monaco Suggest action is unavailable.");
          return;
        }

        Promise.resolve(action.run())
            .then(() => console.warn("Monaco Suggest action completed."))
            .catch((error) =>
                console.warn("Monaco Suggest action failed:", error)
            );
      },
    });

    const tab = activeTab();
    if (tab?.kind === "sql") {
      setSqlEditorValue(tab.sql);
    }
  };

  createEditor();
}

function sqlUsesDynamicResultShape(sql) {
  const normalized = sql
      .replace(/--.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .toUpperCase();

  // return /\bPIVOT\b|\bUNPIVOT\b/.test(normalized);
  return false;
}

function runSql(sqlOverride = null, existingViewName = null) {
  const tab = activeTab();
  if (!tab || tab.kind !== "sql" || !sqlEditor) return;

  tab.sql = sqlEditorValue();

  const statement = sqlOverride
      ? { sql: sqlOverride, number: 1, count: 1 }
      : sqlStatementAtCursor(tab.sql, sqlCursorOffset());

  if (!statement.sql) {
    tab.error = "Place your cursor on the SQL statement you want to execute.";
    sqlError.textContent = tab.error;
    sqlError.classList.remove("hidden");
    return;
  }

  const resultNumber = tab.nextResultNumber++;
  const viewName = existingViewName || `_${Date.now()}`;
  const resultKey =
      `result-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const result = {
    id: resultKey,
    number: resultNumber,
    title: viewName,
    sql: statement.sql,
    queryId: null,
    tableName: existingViewName || null,
    columns: null,
    rows: null,
    offset: 0,
    hasMore: false,
    error: null,
    closed: false,
    transientOnly: false,
    status: `${viewName} is running…`,
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
          ? `Showing rows 1–${page.rows.length}${page.has_more ? "+" : ""}`
          : "No rows returned.";

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

      if (existingViewName) {
        result.status = page.rows.length
            ? `${existingViewName}: showing rows 1–${page.rows.length}${page.hasMore ? "+" : ""}`
            : `${existingViewName}: no rows returned.`;

        if (activeTabId === tab.id && tab.activeResultKey === resultKey) {
          renderSqlResultTabs(tab);
          renderActiveSqlResult(tab);
        }
        return;
      }

      const tableName = viewName;

      try {
        const savedView = await invoke("register_duckdb_query_as_table", {
          queryId: result.queryId,
          tableName,
        });

        result.tableName = savedView.name;
        workspaceViews.set(savedView.name, {
          name: savedView.name,
          sql: result.sql,
        });
        queueWorkspaceSave();

        result.status = page.rows.length
            ? `${savedView.name}: showing rows 1–${page.rows.length}${page.hasMore ? "+" : ""}`
            : `${savedView.name}: no rows returned.`;

        queueWorkspaceSave();

        if (activeTab()?.kind === "sql") {
          await renderSqlTables();
        }

        if (activeTabId === tab.id && tab.activeResultKey === resultKey) {
          renderSqlResultTabs(tab);
          renderActiveSqlResult(tab);
        }
      } catch (error) {
        result.status = page.rows.length
            ? `Showing rows 1–${page.rows.length}${page.has_more ? "+" : ""} · View creation failed.`
            : "No rows returned · View creation failed.";
        result.tableError = String(error);

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
  csvImportEncoding.value = "utf-8";
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

  const encoding = csvImportEncoding.value;
  setLoading(true, "Converting CSV to Parquet…");

  try {
    const parquetPath = await invoke("import_csv_as_parquet", {
      path: csvPath,
      encoding,
    });

    if (parquetPath) {
      closeCsvImportDialog();
      await openParquetPath(parquetPath);
    }
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
exportExcelCsvBtn.addEventListener("click", () => exportSql("csv_excel"));
exportFormatClose.addEventListener("click", closeExportFormatDialog);
exportFormatBackdrop.addEventListener("click", () => {
  closeExportFormatDialog();
  closeCsvImportDialog();
});
csvImportClose.addEventListener("click", closeCsvImportDialog);
csvImportCancelBtn.addEventListener("click", closeCsvImportDialog);
csvImportSaveBtn.addEventListener("click", saveCsvAsParquet);

function closeAppMenu() {
  appMenu.classList.add("hidden");
  appMenuBackdrop.classList.remove("open");
}

function renderWorkspaceMenu() {
  menuWorkspaceList.innerHTML = "";

  for (const workspace of workspaceStore?.workspaces || []) {
    const button = document.createElement("button");
    button.className =
        `app-menu-workspace${workspace.id === workspaceStore.activeWorkspaceId ? " active" : ""}`;
    button.type = "button";
    button.textContent = workspace.name;
    button.title = `Open workspace “${workspace.name}”`;
    button.addEventListener("click", async () => {
      closeAppMenu();
      await switchWorkspace(workspace.id);
    });

    menuWorkspaceList.appendChild(button);
  }
}

function openAppMenu() {
  renderWorkspaceMenu();
  appMenu.classList.remove("hidden");
  appMenuBackdrop.classList.add("open");
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
menuNewWorkspaceBtn.addEventListener("click", async () => {
  closeAppMenu();
  await newWorkspace();
});
menuSaveWorkspaceAsBtn.addEventListener("click", async () => {
  closeAppMenu();
  await saveWorkspaceAs();
});
menuDeleteWorkspaceBtn.addEventListener("click", async () => {
  closeAppMenu();
  await deleteActiveWorkspace();
});
menuSettingsBtn.addEventListener("click", () => {
  closeAppMenu();
  openSettings();
});

workspaceDialogClose.addEventListener("click", () => closeWorkspaceDialog());
workspaceDialogCancelBtn.addEventListener("click", () => closeWorkspaceDialog());
workspaceDialogBackdrop.addEventListener("click", () => closeWorkspaceDialog());
workspaceDialogConfirmBtn.addEventListener("click", () => {
  const nameRequired = !workspaceDialogInputRow.classList.contains("hidden");

  if (nameRequired) {
    const name = workspaceDialogInput.value.trim();
    if (!name) {
      workspaceDialogInput.focus();
      return;
    }
    closeWorkspaceDialog(name);
    return;
  }

  closeWorkspaceDialog(true);
});
workspaceDialogInput.addEventListener("keydown", (event) => {
  if (event.isComposing || event.keyCode === 229) {
    return;
  }

  if (event.key === "Enter") {
    event.preventDefault();
    workspaceDialogConfirmBtn.click();
  }
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
  totalRows = tab.missing ? 0 : tab.totalRows;
  cache = tab.cache;
  pending = tab.pending;
  edits = tab.edits;
  viewToken = tab.viewToken;

  document.title = `DuckView — ${fileMeta.file_name}${tab.missing ? " (Missing)" : ""}`;
  emptyEl.classList.add("hidden");
  sqlWorkspace.classList.add("hidden");
  tableWrap.classList.remove("hidden");
  statusBar.classList.remove("hidden");
  metaBtn.classList.remove("hidden");
  advBtn.classList.toggle("hidden", tab.missing);
  tabBar.classList.remove("hidden");

  syncAdvancedUiFromFilterState();
  computeColWidths();
  renderHeader();
  buildMetaPanel();
  updateSpacer();

  requestAnimationFrame(() => {
    viewport.scrollTop = tab.scrollTop;
    if (!tab.missing) renderRows();
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

  applySqlPaneHeight(tab);

  sqlTitle.textContent = tab.title;
  setSqlEditorValue(tab.sql);
  sqlError.textContent = "";
  sqlError.classList.add("hidden");

  void renderSqlTables();

  renderSqlResultTabs(tab);
  renderActiveSqlResult(tab);

  requestAnimationFrame(() => {
    applySqlPaneHeight(tab);
    sqlEditor?.focus();
  });
}

function applySqlPaneHeight(tab) {
  if (!tab?.editorPaneHeight) {
    sqlWorkspace.style.removeProperty("grid-template-rows");
    return;
  }

  const splitterHeight = sqlPaneSplitter.offsetHeight || 8;
  const maxHeight = Math.max(
      180,
      sqlWorkspace.clientHeight - splitterHeight - 180
  );
  const height = Math.min(
      maxHeight,
      Math.max(180, Math.round(tab.editorPaneHeight))
  );

  tab.editorPaneHeight = height;
  sqlWorkspace.style.gridTemplateRows =
      `${height}px ${splitterHeight}px minmax(180px, 1fr)`;
}

function beginSqlPaneResize(event) {
  const tab = activeTab();
  if (!tab || tab.kind !== "sql") return;

  event.preventDefault();
  sqlPaneResizeState = {
    pointerId: event.pointerId,
    startY: event.clientY,
    startHeight: sqlEditorPane.getBoundingClientRect().height,
  };

  sqlPaneSplitter.setPointerCapture(event.pointerId);
  document.body.classList.add("resizing-sql-pane");
}

function resizeSqlPane(event) {
  if (!sqlPaneResizeState || event.pointerId !== sqlPaneResizeState.pointerId) {
    return;
  }

  const tab = activeTab();
  if (!tab || tab.kind !== "sql") return;

  tab.editorPaneHeight =
      sqlPaneResizeState.startHeight + event.clientY - sqlPaneResizeState.startY;
  applySqlPaneHeight(tab);
}

function finishSqlPaneResize(event) {
  if (!sqlPaneResizeState || event.pointerId !== sqlPaneResizeState.pointerId) {
    return;
  }

  sqlPaneResizeState = null;
  document.body.classList.remove("resizing-sql-pane");

  if (sqlPaneSplitter.hasPointerCapture(event.pointerId)) {
    sqlPaneSplitter.releasePointerCapture(event.pointerId);
  }

  queueWorkspaceSave();
}

async function removeWorkspaceView(viewName) {
  try {
    await invoke("remove_duckdb_result_table", {
      tableName: viewName,
    });
  } catch (error) {
    showToast(`Could not remove ${viewName}: ${error}`);
    return;
  }

  workspaceViews.delete(viewName);

  for (const tab of tabs.values()) {
    if (tab.kind !== "sql") continue;

    for (const [resultKey, result] of tab.results) {
      if (result.tableName !== viewName) continue;

      result.closed = true;
      tab.results.delete(resultKey);

      if (tab.activeResultKey === resultKey) {
        tab.activeResultKey = Array.from(tab.results.keys()).at(-1) || null;
      }
    }
  }

  queueWorkspaceSave();

  if (activeTab()?.kind === "sql") {
    await renderSqlTables();
    renderSqlResultTabs(activeTab());
    renderActiveSqlResult(activeTab());
  }
}

async function renderSqlTables() {
  sqlTables.innerHTML =
      '<div class="sql-empty-tables">Loading tables…</div>';

  try {
    const tables = await invoke("list_duckdb_tables");
    sqlCompletionTables = tables;

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

        const savedView = table.is_view
            ? workspaceViews.get(table.name)
            : null;
        button.title = savedView
            ? `View: ${table.name}\n\n${savedView.sql}`
            : `${table.name}\n${table.path}`;

        let singleClickTimer = null;

        button.addEventListener("click", () => {
          clearTimeout(singleClickTimer);

          singleClickTimer = setTimeout(() => {
            singleClickTimer = null;

            if (table.is_view) {
              void openViewResult(table.name);
              return;
            }

            const parquetTabId = tabIdByPath.get(table.path);
            if (parquetTabId) {
              switchTab(parquetTabId);
            } else {
              showToast(`The source tab for "${table.name}" is no longer open.`);
            }
          }, 220);
        });

        button.addEventListener("dblclick", (event) => {
          event.preventDefault();
          clearTimeout(singleClickTimer);
          singleClickTimer = null;

          insertSqlText(completionInsertText(table.name));
        });

        if (!table.is_view) {
          sqlTables.appendChild(button);
          continue;
        }

        const viewItem = document.createElement("div");
        viewItem.className = "sql-view-item";
        viewItem.appendChild(button);

        const remove = document.createElement("button");
        remove.className = "sql-view-remove";
        remove.type = "button";
        remove.textContent = "×";
        remove.title = `Delete view ${table.name}`;
        remove.setAttribute("aria-label", `Delete view ${table.name}`);
        remove.addEventListener("click", (event) => {
          event.stopPropagation();
          void removeWorkspaceView(table.name);
        });

        viewItem.appendChild(remove);
        sqlTables.appendChild(viewItem);
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
  if (!tab || tab.kind !== "sql" || !sqlEditor) return;

  const selection = sqlEditor.getSelection();
  if (!selection) return;

  sqlEditor.executeEdits("duckview-insert-table-name", [
    {
      range: selection,
      text,
      forceMoveMarkers: true,
    },
  ]);

  tab.sql = sqlEditorValue();
  queueWorkspaceSave();
  sqlEditor.focus();
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

function findOpenResultForView(viewName) {
  for (const tab of tabs.values()) {
    if (tab.kind !== "sql") continue;

    for (const [resultKey, result] of tab.results) {
      if (!result.closed && result.tableName === viewName) {
        return { tab, resultKey };
      }
    }
  }

  return null;
}

async function openViewResult(viewName) {
  const existing = findOpenResultForView(viewName);

  if (existing) {
    if (activeTabId !== existing.tab.id) {
      switchTab(existing.tab.id);
    }
    selectSqlResult(existing.tab, existing.resultKey);
    return;
  }

  runSql(
      `SELECT * FROM ${quoteSqlIdentifier(viewName)}`,
      viewName
  );
}

async function closeAllSqlResults(tab) {
  for (const result of tab.results.values()) {
    result.closed = true;
  }

  tab.results.clear();
  tab.activeResultKey = null;
}

async function closeSqlResult(tab, key) {
  const result = tab.results.get(key);
  if (!result) return;

  result.closed = true;
  const wasActive = tab.activeResultKey === key;

  tab.results.delete(key);
  queueWorkspaceSave();

  if (wasActive) {
    tab.activeResultKey =
        Array.from(tab.results.keys()).at(-1) || null;
  }

  if (activeTab() === tab) {
    renderSqlResultTabs(tab);
    renderActiveSqlResult(tab);
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
    el.className =
        `file-tab${tab.id === activeTabId ? " active" : ""}` +
        `${tab.kind === "parquet" && tab.missing ? " missing" : ""}`;
    el.setAttribute("role", "button");
    el.tabIndex = 0;

    const title = tab.kind === "sql" ? tab.title : tab.meta.file_name;
    el.title =
        tab.kind === "sql"
            ? title
            : tab.missing
                ? `${tab.path}\n(file not found — open Info to relink)`
                : tab.path;

    const name = document.createElement("span");
    name.className = "file-tab-name";
    name.textContent =
        tab.kind === "parquet" && tab.missing ? `${title} · Missing` : title;

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
  queueWorkspaceSave();

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
  queueWorkspaceSave();
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
  queueWorkspaceSave();

  if (tab.kind === "sql") {
    queueWorkspaceSave();
  }

  if (tab.kind === "parquet") {
    tabIdByPath.delete(tab.path);
    await invoke("close_file", { path: tab.path }).catch(() => {});
  }

  if (!tabs.size) {
    resetWorkspaceUi();
    renderWorkspaceTitle();
    saveWorkspace();
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
    queueWorkspaceSave();
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
  queueWorkspaceSave();
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
  const tab = activeTab();
  const missing = tab?.kind === "parquet" && tab.missing;

  const row = (k, v) =>
      `<div class="meta-row"><span class="k">${k}</span><span class="v">${escapeHtml(v)}</span></div>`;
  let html = "";
  html += row("File", m.file_name);
  if (missing) {
    html += `<div class="meta-row"><span class="k">Status</span><span class="v" style="color:#d64545">● Missing</span></div>`;
  }
  if (!missing) {
    html += row("Size", humanSize(m.file_size));
    html += row("Rows", m.num_rows.toLocaleString());
    html += row("Columns", m.num_columns.toLocaleString());
    html += row("Row groups", m.num_row_groups.toLocaleString());
    html += row("Compression", m.compression);
    html += row("Format version", "v" + m.version);
    if (m.created_by) html += row("Created by", m.created_by);
  }
  if (!missing && m.columns.length) {
    html += '<div class="meta-section-title">Schema</div>';
    m.columns.forEach((c) => {
      html += `<div class="schema-item"><span class="sname">${escapeHtml(c.name)}</span><span class="stype">${escapeHtml(c.type)}</span></div>`;
    });
  }
  html += '<div class="meta-section-title">Path</div>';
  html +=
      `<div class="meta-row" style="align-items:flex-start;gap:8px">` +
      `<span class="v" id="metaPathValue" style="text-align:left;flex:1;font-family:var(--mono);font-size:11px">${escapeHtml(m.path)}</span>` +
      `<button id="metaLocateBtn" class="btn ghost" type="button" style="flex:0 0 auto">Locate…</button>` +
      `</div>`;
  if (missing && tab?.missingError) {
    html += `<div class="meta-row"><span class="v" style="text-align:left;color:#d64545;font-size:11px">${escapeHtml(tab.missingError)}</span></div>`;
  }
  metaBody.innerHTML = html;

  document
      .getElementById("metaLocateBtn")
      ?.addEventListener("click", relinkActiveParquet);
}

async function relinkActiveParquet() {
  const tab = activeTab();
  if (!tab || tab.kind !== "parquet") return;

  let newPath;
  try {
    newPath = await invoke("pick_parquet_file");
  } catch (error) {
    showToast(String(error));
    return;
  }
  if (!newPath || newPath === tab.path) return;

  if (tabIdByPath.has(newPath) && tabIdByPath.get(newPath) !== tab.id) {
    showToast("This file is already open in another tab.");
    return;
  }

  setLoading(true, "Relinking file…");
  try {
    const meta = await invoke("open_file", { path: newPath });
    const oldPath = tab.path;

    tabIdByPath.delete(oldPath);
    tab.path = newPath;
    tab.meta = meta;
    tab.missing = false;
    tab.missingError = null;
    tab.totalRows = meta.num_rows;
    tab.cache = new Map();
    tab.pending = new Set();
    tab.edits = new Map();
    tab.sortState = null;
    tab.filterState = null;
    tab.colWidths = null;
    tab.scrollTop = 0;
    tab.viewToken += 1;
    tabIdByPath.set(newPath, tab.id);

    if (oldPath !== newPath) {
      await invoke("close_file", { path: oldPath }).catch(() => {});
    }

    if (tab.id === activeTabId) {
      currentPath = newPath;
      fileMeta = meta;
      cache = tab.cache;
      pending = tab.pending;
      edits = tab.edits;
      viewToken = tab.viewToken;
      totalRows = tab.totalRows;
      truncated = false;
      sortState = null;
      filterState = null;
      syncAdvancedUiFromFilterState();
      computeColWidths();
      renderHeader();
      buildMetaPanel();
      updateSpacer();
      await loadPage(0, true);
      renderRows();
      updateStatus();
      renderTabs();
    }
    queueWorkspaceSave();
    showToast("File relinked.");
  } catch (error) {
    showToast("Couldn’t open file: " + error);
  } finally {
    setLoading(false);
  }
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
  syncSqlEditorTheme();

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

async function refreshActiveParquetAvailability() {
  const tab = activeTab();
  if (!tab || tab.kind !== "parquet" || tab.missing) {
    return !tab?.missing;
  }

  const exists = await invoke("parquet_file_exists", { path: tab.path })
      .catch(() => false);

  if (exists) return true;

  tab.missing = true;
  tab.missingError = "The file no longer exists at its saved location.";
  tab.cache = new Map();
  tab.pending = new Set();
  tab.edits = new Map();
  tab.totalRows = 0;
  tab.truncated = false;
  tab.viewToken += 1;

  await invoke("close_file", { path: tab.path }).catch(() => {});

  if (tab.id === activeTabId) {
    restoreParquetTab(tab);
  }

  queueWorkspaceSave();
  return false;
}

metaBtn.addEventListener("click", async () => {
  if (!fileMeta) return;

  await refreshActiveParquetAvailability();

  if (fileMeta) {
    openMeta();
  }
});
metaClose.addEventListener("click", closeMeta);
metaBackdropEl.addEventListener("click", closeMeta);

// ---- Wiring -----------------------------------------------------------------
$("openBtn2").addEventListener("click", pickFile);
sqlRunBtn.addEventListener("click", () => runSql());

sqlPaneSplitter.addEventListener("pointerdown", beginSqlPaneResize);
sqlPaneSplitter.addEventListener("pointermove", resizeSqlPane);
sqlPaneSplitter.addEventListener("pointerup", finishSqlPaneResize);
sqlPaneSplitter.addEventListener("pointercancel", finishSqlPaneResize);

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
    closeWorkspaceDialog();
    closeExportFormatDialog();
    closeCsvImportDialog();
    closeSettings();
    closeAdvanced();
    closeMeta();
  }
});

window.addEventListener("beforeunload", saveWorkspace);

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
initSqlEditor();

window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (settings.theme === "auto") syncSqlEditorTheme();
});

// A file may have been passed at launch (Finder "Open With" / `open -a`).
// Retry a few times: on a cold launch the OS "Opened" event can land just
// after the first poll, so one check isn't always enough.
(async () => {
  await restoreWorkspace();

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
