import { pivotStatusFor } from "./status.js";

const DISMISSED_TOASTS_KEY = "duckview.dismissedToasts";
const INFO_DURATION_MS = 5000;
const LOADED_PIVOT_STATUS_ID = "pivot-rows-loaded";

/** Manage persistent, dismissible notices without changing the Pivot data. */
export function createNotificationCenter({ stack, toast, toastMessage, toastClose, toastDismiss, pivotStatus, pivotMessage, pivotDismiss, pivotClose, anchorFor, storage = localStorage }) {
  let activePivot = null;
  const dismissed = new WeakMap();
  let suppressed = new Set();
  let toastTimer = null;
  let warningId = null;
  const pivotNotices = [];
  let showingPivotNotice = false;
  let pivotTimer = null;
  let displayedPivot = null;
  let displayedSignature = null;
  try {
    const saved = JSON.parse(storage.getItem(DISMISSED_TOASTS_KEY) || "[]");
    if (Array.isArray(saved)) suppressed = new Set(saved.filter((id) => typeof id === "string"));
  } catch (_) {
    // Invalid or unavailable storage should not prevent notifications.
  }

  const displayToast = (message, id, fromPivot = false, autoClose = id === null) => {
    clearTimeout(toastTimer);
    warningId = id;
    showingPivotNotice = fromPivot;
    toastMessage.textContent = message;
    toastDismiss.classList.toggle("hidden", id === null);
    toast.setAttribute("role", autoClose ? "status" : "alert");
    toast.classList.remove("hidden");
    sync();
    if (autoClose) toastTimer = setTimeout(hideToast, INFO_DURATION_MS);
  };
  const showNextPivotNotice = () => {
    while (pivotNotices.length) {
      const { message, id, autoClose } = pivotNotices.shift();
      if (id === null || !suppressed.has(id)) {
        displayToast(message, id, true, autoClose ?? id === null);
        return;
      }
    }
  };
  const hideToast = () => {
    clearTimeout(toastTimer);
    toastTimer = null;
    warningId = null;
    showingPivotNotice = false;
    toast.classList.add("hidden");
    sync();
    showNextPivotNotice();
  };
  const persist = () => {
    try {
      if (suppressed.size) storage.setItem(DISMISSED_TOASTS_KEY, JSON.stringify([...suppressed]));
      else storage.removeItem(DISMISSED_TOASTS_KEY);
    } catch (_) {
      // Continue suppressing for this session even if persistence is unavailable.
    }
  };

  const position = () => {
    const top = anchorFor().getBoundingClientRect().bottom + 8;
    stack.style.top = `${top}px`;
    stack.style.maxHeight = `max(0px, calc(100vh - ${top + 12}px))`;
  };
  const sync = () => {
    stack.classList.toggle("hidden", toast.classList.contains("hidden") && pivotStatus.classList.contains("hidden"));
    position();
  };
  const updatePivotStatus = (tab) => {
    if (activePivot !== tab) return;
    const status = pivotStatusFor(tab);
    const signature = `${status.className}\0${status.text}`;
    const changed = displayedPivot !== tab || displayedSignature !== signature;
    if (changed) {
      clearTimeout(pivotTimer);
      pivotTimer = null;
      if (displayedPivot === tab && displayedSignature !== signature) dismissed.delete(tab);
      displayedPivot = tab;
      displayedSignature = signature;
    }
    const alreadyDismissed = dismissed.get(tab) === signature;
    const loaded = Boolean(tab.arrowTable && !tab.loading && !tab.error);
    pivotDismiss.classList.toggle("hidden", !loaded);
    pivotStatus.className = `${status.className} notification${alreadyDismissed || (loaded && suppressed.has(LOADED_PIVOT_STATUS_ID)) ? " hidden" : ""}`;
    pivotMessage.textContent = status.text;
    sync();
    if (changed && !alreadyDismissed && loaded && !suppressed.has(LOADED_PIVOT_STATUS_ID)) {
      pivotTimer = setTimeout(() => {
        pivotTimer = null;
        if (activePivot !== tab || displayedSignature !== signature) return;
        dismissed.set(tab, signature);
        pivotStatus.classList.add("hidden");
        sync();
      }, INFO_DURATION_MS);
    }
  };

  toastClose.addEventListener("click", hideToast);
  toastDismiss.addEventListener("click", () => {
    if (warningId !== null) {
      suppressed.add(warningId);
      persist();
      hideToast();
    }
  });
  pivotClose.addEventListener("click", () => {
    if (!activePivot) return;
    clearTimeout(pivotTimer);
    pivotTimer = null;
    const status = pivotStatusFor(activePivot);
    dismissed.set(activePivot, `${status.className}\0${status.text}`);
    pivotStatus.classList.add("hidden");
    sync();
  });
  pivotDismiss.addEventListener("click", () => {
    if (!activePivot?.arrowTable || activePivot.loading || activePivot.error) return;
    suppressed.add(LOADED_PIVOT_STATUS_ID);
    persist();
    clearTimeout(pivotTimer);
    pivotTimer = null;
    pivotStatus.classList.add("hidden");
    sync();
  });
  window.addEventListener("resize", position);

  return {
    reposition: position,
    showToast(message, id = null) {
      if (id !== null && suppressed.has(id)) return;
      displayToast(message, id);
    },
    showPivotNotices(notices) {
      pivotNotices.push(...notices.filter(({ id }) => id === null || !suppressed.has(id)));
      if (toast.classList.contains("hidden")) showNextPivotNotice();
    },
    resetDismissedToasts() {
      suppressed.clear();
      persist();
    },
    setActivePivot(tab) {
      if (activePivot !== tab) {
        pivotNotices.length = 0;
        if (showingPivotNotice) {
          clearTimeout(toastTimer);
          toastTimer = null;
          warningId = null;
          showingPivotNotice = false;
          toast.classList.add("hidden");
        }
        clearTimeout(pivotTimer);
        pivotTimer = null;
        displayedPivot = null;
        displayedSignature = null;
      }
      activePivot = tab;
      if (tab) updatePivotStatus(tab);
      else {
        pivotStatus.classList.add("hidden");
        sync();
      }
    },
    updatePivotStatus,
  };
}