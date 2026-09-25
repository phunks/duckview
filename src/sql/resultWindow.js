export const RESULT_ROW_HEIGHT = 30;
export const RESULT_HEADER_HEIGHT = 34;
const OVERSCAN = 12;

export function resultWindow(rowCount, scrollTop, viewportHeight) {
  const visibleCount = Math.max(1, Math.ceil(viewportHeight / RESULT_ROW_HEIGHT));
  const firstVisible = Math.min(
    Math.max(0, rowCount - visibleCount),
    Math.max(0, Math.floor((scrollTop - RESULT_HEADER_HEIGHT) / RESULT_ROW_HEIGHT)),
  );
  const start = Math.max(0, Math.min(rowCount, firstVisible - OVERSCAN));
  const end = Math.min(
    rowCount,
    firstVisible + visibleCount + OVERSCAN,
  );
  return {
    start,
    end,
    top: start * RESULT_ROW_HEIGHT,
    bottom: (rowCount - end) * RESULT_ROW_HEIGHT,
  };
}