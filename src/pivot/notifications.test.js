import { afterEach, describe, expect, it, vi } from "vitest";
import { createNotificationCenter } from "./notifications.js";

const setup = () => {
  const anchor = document.createElement("div");
  anchor.getBoundingClientRect = () => ({ bottom: 124 });
  const stack = document.createElement("div");
  stack.className = "hidden";
  stack.innerHTML = `
    <div class="pivot-status notification hidden"><span></span><button class="dismiss hidden" type="button">Dismiss</button><button class="close" type="button">×</button></div>
    <div class="toast notification hidden"><span></span><button class="dismiss hidden" type="button">Dismiss</button><button class="close" type="button">×</button></div>`;
  document.body.append(anchor, stack);
  const [pivotStatus, toast] = stack.children;
  const center = createNotificationCenter({
    stack, toast, toastMessage: toast.querySelector("span"), toastClose: toast.querySelector(".close"),
    toastDismiss: toast.querySelector(".dismiss"),
    pivotStatus, pivotMessage: pivotStatus.querySelector("span"), pivotDismiss: pivotStatus.querySelector(".dismiss"), pivotClose: pivotStatus.querySelector(".close"),
    anchorFor: () => anchor,
  });
  return { anchor, stack, pivotStatus, toast, center };
};

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("notification center", () => {
  it("dismisses only loaded Pivot status across tabs and reloads, without hiding errors or other notices", () => {
    vi.useFakeTimers();
    const { pivotStatus, toast, center } = setup();
    const first = { arrowTable: { numRows: 917 } };
    center.setActivePivot(first);
    expect(pivotStatus.querySelector(".dismiss").classList.contains("hidden")).toBe(false);
    center.showToast("Other warning", "other-warning");
    pivotStatus.querySelector(".dismiss").click();
    expect(pivotStatus.classList.contains("hidden")).toBe(true);
    expect(toast.classList.contains("hidden")).toBe(false);
    expect(JSON.parse(localStorage.getItem("duckview.dismissedToasts"))).toEqual(["pivot-rows-loaded"]);
    first.loading = true;
    center.updatePivotStatus(first);
    expect(pivotStatus.classList.contains("hidden")).toBe(false);
    expect(pivotStatus.querySelector(".dismiss").classList.contains("hidden")).toBe(true);
    first.loading = false;
    first.arrowTable = { numRows: 918 };
    center.updatePivotStatus(first);
    expect(pivotStatus.classList.contains("hidden")).toBe(true);
    center.setActivePivot({ error: "Source failed" });
    expect(pivotStatus.classList.contains("hidden")).toBe(false);
    center.setActivePivot({ arrowTable: { numRows: 12 } });
    expect(pivotStatus.classList.contains("hidden")).toBe(true);
    const restored = setup();
    restored.center.setActivePivot({ arrowTable: { numRows: 917 } });
    expect(restored.pivotStatus.classList.contains("hidden")).toBe(true);
    center.resetDismissedToasts();
    center.setActivePivot({ arrowTable: { numRows: 13 } });
    expect(pivotStatus.classList.contains("hidden")).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(pivotStatus.classList.contains("hidden")).toBe(true);
  });

  it("auto-closes info after five seconds, replaces text safely, and follows the header", () => {
    vi.useFakeTimers();
    const { anchor, stack, toast, center } = setup();
    center.showToast("First");
    expect(stack.style.top).toBe("132px");
    expect(toast.classList.contains("hidden")).toBe(false);
    anchor.getBoundingClientRect = () => ({ bottom: 200 });
    center.reposition();
    expect(stack.style.top).toBe("208px");
    center.showToast("<second>");
    expect(toast.querySelector("span").textContent).toBe("<second>");
    expect(toast.querySelector("span").children).toHaveLength(0);
    expect(toast.querySelector(".dismiss").classList.contains("hidden")).toBe(true);
    vi.advanceTimersByTime(4999);
    expect(toast.classList.contains("hidden")).toBe(false);
    vi.advanceTimersByTime(1);
    expect(toast.classList.contains("hidden")).toBe(true);
    center.showToast("Next");
    toast.querySelector(".close").click();
    expect(stack.classList.contains("hidden")).toBe(true);
  });

  it("keeps warnings visible, closes them temporarily with × and suppresses by stable ID with Dismiss", () => {
    vi.useFakeTimers();
    const { toast, center } = setup();
    center.showToast("File one failed", "file-open-error");
    expect(toast.querySelector(".dismiss").classList.contains("hidden")).toBe(false);
    expect(toast.getAttribute("role")).toBe("alert");
    vi.advanceTimersByTime(10000);
    expect(toast.classList.contains("hidden")).toBe(false);
    toast.querySelector(".close").click();
    center.showToast("File two failed", "file-open-error");
    expect(toast.classList.contains("hidden")).toBe(false);
    toast.querySelector(".dismiss").click();
    expect(toast.classList.contains("hidden")).toBe(true);
    expect(JSON.parse(localStorage.getItem("duckview.dismissedToasts"))).toEqual(["file-open-error"]);
    center.showToast("File three failed", "file-open-error");
    expect(toast.classList.contains("hidden")).toBe(true);
    center.showToast("Other failure", "file-pick-error");
    expect(toast.classList.contains("hidden")).toBe(false);
  });

  it("cancels an info timer when a warning arrives and leaves the current notice intact when another is suppressed", () => {
    vi.useFakeTimers();
    const { toast, center } = setup();
    center.showToast("Temporary info");
    vi.advanceTimersByTime(4000);
    center.showToast("Persistent warning", "persistent-warning");
    vi.advanceTimersByTime(5000);
    expect(toast.classList.contains("hidden")).toBe(false);
    expect(toast.querySelector("span").textContent).toBe("Persistent warning");
    toast.querySelector(".dismiss").click();
    center.showToast("Another warning", "different-warning");
    center.showToast("Should be suppressed", "persistent-warning");
    expect(toast.querySelector("span").textContent).toBe("Another warning");
    expect(toast.classList.contains("hidden")).toBe(false);
  });

  it("queues Pivot notices independently and dismissing one does not suppress the others", () => {
    vi.useFakeTimers();
    const { toast, center } = setup();
    const notices = [
      { message: "Virtualization enabled.", id: "pivot-virtualization-enabled", autoClose: true },
      { message: "Compute budget exceeded.", id: "pivot-compute-budget" },
      { message: "Virtualization recommended.", id: "pivot-virtualization-recommended" },
    ];
    center.showPivotNotices(notices);
    expect(toast.textContent).toContain("Virtualization enabled.");
    expect(toast.querySelector(".dismiss").classList.contains("hidden")).toBe(false);
    expect(toast.getAttribute("role")).toBe("status");
    vi.advanceTimersByTime(5000);
    expect(toast.querySelector("span").textContent).toBe("Compute budget exceeded.");
    toast.querySelector(".dismiss").click();
    expect(toast.querySelector("span").textContent).toBe("Virtualization recommended.");
    expect(JSON.parse(localStorage.getItem("duckview.dismissedToasts"))).toEqual(["pivot-compute-budget"]);
    toast.querySelector(".close").click();
    center.showPivotNotices(notices);
    expect(toast.querySelector("span").textContent).toBe("Virtualization enabled.");
    vi.advanceTimersByTime(5000);
    expect(toast.querySelector("span").textContent).toBe("Virtualization recommended.");
  });

  it("dismisses virtualization-enabled notices persistently without hiding recommendations", () => {
    vi.useFakeTimers();
    const notices = [
      { message: "917 rows exceed the 500-row DOM budget. Virtualization enabled.", id: "pivot-virtualization-enabled", autoClose: true },
      { message: "399,370 cells exceed DOM budget (50,000). Virtualization recommended.", id: "pivot-virtualization-recommended" },
    ];
    const first = setup();
    first.center.showPivotNotices(notices);
    first.toast.querySelector(".dismiss").click();
    expect(first.toast.querySelector("span").textContent).toBe(notices[1].message);
    expect(JSON.parse(localStorage.getItem("duckview.dismissedToasts"))).toEqual(["pivot-virtualization-enabled"]);

    const second = setup();
    second.center.showPivotNotices([
      { message: "Total cells (399,370) exceeds DOM budget (50,000). Virtualization enabled.", id: "pivot-virtualization-enabled", autoClose: true },
      notices[1],
    ]);
    expect(second.toast.querySelector("span").textContent).toBe(notices[1].message);
    vi.advanceTimersByTime(10000);
    expect(second.toast.classList.contains("hidden")).toBe(false);
    second.center.resetDismissedToasts();
    second.toast.querySelector(".close").click();
    second.center.showPivotNotices([notices[0]]);
    expect(second.toast.querySelector("span").textContent).toBe(notices[0].message);
    vi.advanceTimersByTime(5000);
    expect(second.toast.classList.contains("hidden")).toBe(true);
  });

  it("persists suppression per Pivot advice category across notification centers", () => {
    const first = setup();
    first.center.showPivotNotices([{ message: "Compute budget exceeded.", id: "pivot-compute-budget" }]);
    first.toast.querySelector(".dismiss").click();
    const second = setup();
    second.center.showPivotNotices([
      { message: "Compute budget exceeded again.", id: "pivot-compute-budget" },
      { message: "Virtualization recommended.", id: "pivot-virtualization-recommended" },
    ]);
    expect(second.toast.querySelector("span").textContent).toBe("Virtualization recommended.");
    second.center.resetDismissedToasts();
    second.toast.querySelector(".close").click();
    second.center.showPivotNotices([{ message: "Compute budget exceeded again.", id: "pivot-compute-budget" }]);
    expect(second.toast.querySelector("span").textContent).toBe("Compute budget exceeded again.");
  });

  it("drops queued Pivot notices when the Pivot tab changes", () => {
    const { toast, center } = setup();
    center.setActivePivot({ loading: true });
    center.showPivotNotices([
      { message: "First warning", id: "pivot-compute-budget" },
      { message: "Old tab warning", id: "pivot-virtualization-recommended" },
    ]);
    center.setActivePivot({ loading: true });
    expect(toast.classList.contains("hidden")).toBe(true);
    center.showPivotNotices([{ message: "New tab warning", id: "pivot-virtualization-recommended" }]);
    expect(toast.querySelector("span").textContent).toBe("New tab warning");
  });

  it("loads suppressed types across instances and resets them without changing other settings", () => {
    localStorage.setItem("duckview.settings", JSON.stringify({ theme: "dark" }));
    const first = setup();
    first.center.showToast("Warning", "pivot-warning");
    first.toast.querySelector(".dismiss").click();
    const second = setup();
    second.center.showToast("Different text", "pivot-warning");
    expect(second.toast.classList.contains("hidden")).toBe(true);
    second.center.resetDismissedToasts();
    expect(localStorage.getItem("duckview.dismissedToasts")).toBe(null);
    expect(JSON.parse(localStorage.getItem("duckview.settings"))).toEqual({ theme: "dark" });
    second.center.showToast("Different text", "pivot-warning");
    expect(second.toast.classList.contains("hidden")).toBe(false);
  });

  it("ignores invalid saved IDs and continues when storage is unavailable", () => {
    localStorage.setItem("duckview.dismissedToasts", '{bad');
    const { center, toast } = setup();
    center.showToast("Error", "safe-id");
    expect(toast.classList.contains("hidden")).toBe(false);
    const storage = { getItem: () => { throw new Error("unavailable"); }, setItem: () => { throw new Error("unavailable"); }, removeItem: () => { throw new Error("unavailable"); } };
    const stack = document.createElement("div");
    stack.innerHTML = '<div><span></span><button class="dismiss"></button><button class="close"></button></div><div><span></span><button class="dismiss"></button><button class="close"></button></div>';
    const [pivotStatus, unavailableToast] = stack.children;
    const fallback = createNotificationCenter({ stack, toast: unavailableToast, toastMessage: unavailableToast.querySelector("span"), toastClose: unavailableToast.querySelector(".close"), toastDismiss: unavailableToast.querySelector(".dismiss"), pivotStatus, pivotMessage: pivotStatus.querySelector("span"), pivotDismiss: pivotStatus.querySelector(".dismiss"), pivotClose: pivotStatus.querySelector(".close"), anchorFor: () => document.body, storage });
    fallback.showToast("Error", "safe-id");
    unavailableToast.querySelector(".dismiss").click();
    fallback.showToast("Error again", "safe-id");
    expect(unavailableToast.classList.contains("hidden")).toBe(true);
  });

  it("dismisses only the current Pivot status and restores it after a real status change", () => {
    const { stack, pivotStatus, toast, center } = setup();
    const tab = { arrowTable: { numRows: 4 } };
    center.setActivePivot(tab);
    expect(pivotStatus.textContent).toContain("4 Arrow rows loaded");
    center.showToast("Warning", "pivot-warning");
    pivotStatus.querySelector(".close").click();
    tab.standaloneConfig = { rows: ["age"] };
    center.updatePivotStatus(tab);
    expect(pivotStatus.classList.contains("hidden")).toBe(true);
    expect(toast.classList.contains("hidden")).toBe(false);

    center.setActivePivot(null);
    center.setActivePivot(tab);
    expect(pivotStatus.classList.contains("hidden")).toBe(true);
    tab.loading = true;
    center.updatePivotStatus(tab);
    expect(pivotStatus.classList.contains("hidden")).toBe(false);
    expect(pivotStatus.textContent).toContain("Loading Pivot source");
    tab.loading = false;
    tab.error = "Source unavailable";
    center.updatePivotStatus(tab);
    expect(pivotStatus.classList.contains("error")).toBe(true);
    expect(stack.classList.contains("hidden")).toBe(false);
  });

  it("auto-closes loaded Pivot status after five seconds without restarting the timer on repeated updates", () => {
    vi.useFakeTimers();
    const { stack, pivotStatus, toast, center } = setup();
    const tab = { arrowTable: { numRows: 917 } };
    center.setActivePivot(tab);
    center.showToast("Other warning", "other-warning");
    vi.advanceTimersByTime(4000);
    tab.standaloneConfig = { rows: ["age"] };
    center.updatePivotStatus(tab);
    vi.advanceTimersByTime(999);
    expect(pivotStatus.classList.contains("hidden")).toBe(false);
    vi.advanceTimersByTime(1);
    expect(pivotStatus.classList.contains("hidden")).toBe(true);
    expect(toast.classList.contains("hidden")).toBe(false);
    expect(stack.classList.contains("hidden")).toBe(false);
    center.updatePivotStatus(tab);
    center.setActivePivot(null);
    center.setActivePivot(tab);
    expect(pivotStatus.classList.contains("hidden")).toBe(true);
  });

  it("leaves loading and error visible and cancels obsolete loaded timers on status changes", () => {
    vi.useFakeTimers();
    const { pivotStatus, center } = setup();
    const tab = { loading: true, arrowTable: { numRows: 20 } };
    center.setActivePivot(tab);
    vi.advanceTimersByTime(10000);
    expect(pivotStatus.classList.contains("hidden")).toBe(false);
    tab.loading = false;
    center.updatePivotStatus(tab);
    vi.advanceTimersByTime(3000);
    tab.error = "Source failed";
    center.updatePivotStatus(tab);
    vi.advanceTimersByTime(10000);
    expect(pivotStatus.classList.contains("hidden")).toBe(false);
    expect(pivotStatus.classList.contains("error")).toBe(true);
    tab.error = null;
    center.updatePivotStatus(tab);
    vi.advanceTimersByTime(5000);
    expect(pivotStatus.classList.contains("hidden")).toBe(true);
    tab.loading = true;
    center.updatePivotStatus(tab);
    expect(pivotStatus.classList.contains("hidden")).toBe(false);
    tab.loading = false;
    center.updatePivotStatus(tab);
    expect(pivotStatus.classList.contains("hidden")).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(pivotStatus.classList.contains("hidden")).toBe(true);
  });

  it("cancels loaded status timers when switching tabs or closing manually", () => {
    vi.useFakeTimers();
    const { pivotStatus, center } = setup();
    const first = { arrowTable: { numRows: 1 } };
    const second = { arrowTable: { numRows: 2 } };
    center.setActivePivot(first);
    vi.advanceTimersByTime(3000);
    center.setActivePivot(second);
    vi.advanceTimersByTime(2000);
    expect(pivotStatus.textContent).toContain("2 Arrow rows loaded");
    expect(pivotStatus.classList.contains("hidden")).toBe(false);
    pivotStatus.querySelector(".close").click();
    center.setActivePivot(first);
    vi.advanceTimersByTime(4999);
    expect(pivotStatus.classList.contains("hidden")).toBe(false);
    vi.advanceTimersByTime(1);
    expect(pivotStatus.classList.contains("hidden")).toBe(true);
    center.setActivePivot(second);
    expect(pivotStatus.classList.contains("hidden")).toBe(true);
  });

  it("switches Pivot tabs without showing a previous tab's status", () => {
    const { pivotStatus, center } = setup();
    const first = { error: "First error" };
    const second = { arrowTable: { numRows: 10 } };
    center.setActivePivot(first);
    center.setActivePivot(second);
    center.updatePivotStatus(first);
    expect(pivotStatus.textContent).toContain("10 Arrow rows loaded");
    center.setActivePivot(null);
    expect(pivotStatus.classList.contains("hidden")).toBe(true);
  });
});