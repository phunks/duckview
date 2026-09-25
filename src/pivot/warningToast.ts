/** Forward new pivot warnings to the host UI without changing the embedded renderer. */
export function watchPivotWarnings(host: HTMLElement, onWarning: (message: string) => void): () => void {
    const seen = new Set<string>();
    const report = () => {
        const banner = host.querySelector('[data-testid="pivot-warning-banner"]');
        if (!banner) return;

        const newWarnings = Array.from(banner.children, (child) => child.textContent?.trim() ?? "")
            .filter((message) => message !== "" && !seen.has(message));
        if (newWarnings.length === 0) return;

        newWarnings.forEach((message) => seen.add(message));
        onWarning(newWarnings.join("\n"));
    };

    const observer = new MutationObserver(report);
    observer.observe(host, { childList: true, characterData: true, subtree: true });
    report();
    return () => observer.disconnect();
}