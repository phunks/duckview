const DEFAULT_MAX_GRAPHEMES = 36;
const DEFAULT_HEAD_GRAPHEMES = 18;

function graphemes(value: string): string[] {
    if (typeof Intl.Segmenter === "function") {
        return Array.from(
            new Intl.Segmenter(undefined, {
                granularity: "grapheme",
            }).segment(value),
            ({ segment }) => segment,
        );
    }

    return Array.from(value);
}

export function abbreviateFieldLabel(
    value: string,
    maxGraphemes = DEFAULT_MAX_GRAPHEMES,
    headGraphemes = DEFAULT_HEAD_GRAPHEMES,
): string {
    const segments = graphemes(value);

    if (segments.length <= maxGraphemes) {
        return value;
    }

    const head = Math.max(1, Math.min(headGraphemes, maxGraphemes - 2));
    const tail = Math.max(1, maxGraphemes - head - 1);

    return `${segments.slice(0, head).join("")}…${segments
        .slice(-tail)
        .join("")}`;
}