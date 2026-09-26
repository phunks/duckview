/** Classify Pivot messages by meaning, not by the dataset-specific numbers in their text. */
export function pivotNoticeId(message: string): string | null {
    if (/Virtualization enabled\.$/.test(message)) return "pivot-virtualization-enabled";
    if (/Virtualization recommended\.$/.test(message)) return "pivot-virtualization-recommended";
    if (message.startsWith("Pivot computation took ")) return "pivot-compute-budget";
    if (message.startsWith("Render took ")) return "pivot-render-budget";
    if (message.startsWith("Column cardinality (")) return "pivot-columns-truncated";
    if (message.includes("column values exceed cardinality cap")) return "pivot-column-cardinality";
    // Unknown messages remain independently dismissible rather than hiding unrelated warnings.
    return `pivot-warning:${message}`;
}

export type PivotNotice = { message: string; id: string | null; autoClose?: boolean };

/** Forward new pivot warnings to the host UI without changing the embedded renderer. */
export function watchPivotWarnings(host: HTMLElement, onWarning: (notices: PivotNotice[]) => void): () => void {
    const seen = new Set<string>();
    const report = () => {
        const banner = host.querySelector('[data-testid="pivot-warning-banner"]');
        if (!banner) return;

        const newWarnings = Array.from(banner.children, (child) => child.textContent?.trim() ?? "")
            .filter((message) => message !== "" && !seen.has(message));
        if (newWarnings.length === 0) return;

        newWarnings.forEach((message) => seen.add(message));
        const groups = new Map<string | null, string[]>();
        newWarnings.forEach((message) => {
            const id = pivotNoticeId(message);
            groups.set(id, [...(groups.get(id) ?? []), message]);
        });
        onWarning(Array.from(groups, ([id, messages]) => ({
            id,
            message: messages.join("\n"),
            ...(id === "pivot-virtualization-enabled" ? { autoClose: true } : {}),
        })));
    };

    const observer = new MutationObserver(report);
    observer.observe(host, { childList: true, characterData: true, subtree: true });
    report();
    return () => observer.disconnect();
}