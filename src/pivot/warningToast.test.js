import { afterEach, describe, expect, it, vi } from "vitest";
import { watchPivotWarnings } from "./warningToast.ts";

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
        expect(onWarning).toHaveBeenCalledWith("1,794 rows exceed the 500-row DOM budget. Virtualization enabled.");

        host.querySelector('[data-testid="pivot-warning-banner"]').innerHTML += "<div>Showing first 1,000 columns.</div>";
        await flushMutations();
        expect(onWarning).toHaveBeenCalledTimes(2);
        expect(onWarning).toHaveBeenLastCalledWith("Showing first 1,000 columns.");

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

        expect(onWarning).toHaveBeenCalledWith("First\nSecond");
        host.appendChild(document.createElement("table"));
        await flushMutations();
        expect(onWarning).toHaveBeenCalledTimes(1);
        stop();
    });
});