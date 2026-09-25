// Persist only the Pivot definition; query sessions and Arrow data are transient.
export function savedPivotTabs(tabs, activeTabId) {
  const pivotTabs = [];
  let activeTabRef = null;

  for (const tab of tabs) {
    if (tab.kind !== "pivot") continue;

    const index = pivotTabs.length;
    pivotTabs.push({
      title: tab.title,
      sourceName: tab.sourceName,
      sourceIsView: tab.sourceIsView,
      standaloneConfig: tab.standaloneConfig ?? null,
    });
    if (tab.id === activeTabId) activeTabRef = { kind: "pivot", index };
  }

  return { pivotTabs, activeTabRef };
}

export function restoredPivotDefinitions(snapshot) {
  if (!Array.isArray(snapshot?.pivotTabs)) return [];

  return snapshot.pivotTabs.flatMap((item, index) => {
    if (typeof item?.sourceName !== "string" || !item.sourceName.trim()) {
      return [];
    }
    const config = item.standaloneConfig;
    // Reject malformed saved configurations instead of passing them to React.
    const standaloneConfig = config && typeof config === "object" &&
        config.version === 1 && Array.isArray(config.rows) &&
        Array.isArray(config.columns) && Array.isArray(config.values) &&
        config.aggregation && typeof config.aggregation === "object"
      ? config
      : undefined;

    return [{
      index,
      sourceName: item.sourceName.trim(),
      sourceIsView: item.sourceIsView === true,
      title: typeof item.title === "string" && item.title.trim()
        ? item.title
        : `Pivot: ${item.sourceName.trim()}`,
      standaloneConfig,
    }];
  });
}
