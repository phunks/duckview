import { afterEach, describe, expect, it, vi } from "vitest";
import { pivotNoticeId, watchPivotWarnings } from "./warningToast.ts";

const flushMutations = async () => {
    await Promise.resolve();
};

describe("watchPivotWarnings", () => {
    const hosts = [];

    afterEach(() => {
        hosts.forEach((host) => host.remove());
        hosts.length = 0;
    });

    it("reports new warnings once, including warnings added after mount", async () => {
        const host = document.createElement("div");
        hosts.push(host);
        document.body.appendChild(host);
        const onWarning = vi.fn();
        const stop = watchPivotWarnings(host, onWarning);

        host.innerHTML = '<div data-testid="pivot-warning-banner"><div>1,794 rows exceed the 500-row DOM budget. Virtualization enabled.</div></div>';
        await flushMutations();
        expect(onWarning).toHaveBeenCalledWith([{ message: "1,794 rows exceed the 500-row DOM budget. Virtualization enabled.", id: "pivot-virtualization-enabled", autoClose: true }]);

        host.querySelector('[data-testid="pivot-warning-banner"]').innerHTML += "<div>Showing first 1,000 columns.</div>";
        await flushMutations();
        expect(onWarning).toHaveBeenCalledTimes(2);
        expect(onWarning).toHaveBeenLastCalledWith([{ message: "Showing first 1,000 columns.", id: "pivot-warning:Showing first 1,000 columns." }]);

        host.innerHTML = '<div data-testid="pivot-warning-banner"><div>1,794 rows exceed the 500-row DOM budget. Virtualization enabled.</div></div>';
        await flushMutations();
        expect(onWarning).toHaveBeenCalledTimes(2);

        stop();
        host.innerHTML = '<div data-testid="pivot-warning-banner"><div>Another warning</div></div>';
        await flushMutations();
        expect(onWarning).toHaveBeenCalledTimes(2);
    });

    it("groups simultaneous messages into one toast and ignores unrelated changes", async () => {
        const host = document.createElement("div");
        hosts.push(host);
        host.innerHTML = '<div data-testid="pivot-warning-banner"><div>First</div><div>Second</div></div>';
        const onWarning = vi.fn();
        const stop = watchPivotWarnings(host, onWarning);

        expect(onWarning).toHaveBeenCalledWith([
            { message: "First", id: "pivot-warning:First" },
            { message: "Second", id: "pivot-warning:Second" },
        ]);
        host.appendChild(document.createElement("table"));
        await flushMutations();
        expect(onWarning).toHaveBeenCalledTimes(1);
        stop();
    });

    it("distinguishes virtualization info, performance advice, and data truncation", () => {
        expect(pivotNoticeId("917 rows exceed the 500-row DOM budget. Virtualization enabled.")).toBe("pivot-virtualization-enabled");
        expect(pivotNoticeId("Total cells (399,370) exceeds DOM budget (50,000). Virtualization enabled.")).toBe("pivot-virtualization-enabled");
        expect(pivotNoticeId("399,370 cells exceed DOM budget (50,000). Virtualization recommended.")).toBe("pivot-virtualization-recommended");
        expect(pivotNoticeId("Pivot computation took 786ms (budget: 500ms). Consider reducing data size.")).toBe("pivot-compute-budget");
        expect(pivotNoticeId("Column cardinality (1,234) exceeds limit (1,000). Showing first 1,000 columns.")).toBe("pivot-columns-truncated");
    });

    it("reports simultaneous Pivot notices by meaning without merging info and advice", () => {
        const host = document.createElement("div");
        hosts.push(host);
        host.innerHTML = `<div data-testid="pivot-warning-banner">
            <div>Total cells (399,370) exceeds DOM budget (50,000). Virtualization enabled.</div>
            <div>Pivot computation took 786ms (budget: 500ms). Consider reducing data size.</div>
            <div>399,370 cells exceed DOM budget (50,000). Virtualization recommended.</div>
        </div>`;
        const onWarning = vi.fn();
        const stop = watchPivotWarnings(host, onWarning);
        expect(onWarning).toHaveBeenCalledWith([
            { message: "Total cells (399,370) exceeds DOM budget (50,000). Virtualization enabled.", id: "pivot-virtualization-enabled", autoClose: true },
            { message: "Pivot computation took 786ms (budget: 500ms). Consider reducing data size.", id: "pivot-compute-budget" },
            { message: "399,370 cells exceed DOM budget (50,000). Virtualization recommended.", id: "pivot-virtualization-recommended" },
        ]);
        stop();
    });
});