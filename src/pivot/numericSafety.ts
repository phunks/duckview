export type ClientPivotValueRange = {
    column: string;
    sourceType: string;
    aggregation: string;
    checked: boolean;
    unsafeValueCount: number;
    sampleUnsafeValue: string | null;
    sumChecked: boolean;
    unsafeSum: boolean;
    sumAbsValue: string | null;
};

type PivotTabForNumericSafety = {
    standaloneConfig?: {
        values?: string[];
        aggregation?: Record<string, string>;
        value_sources?: Record<string, string>;
    };
};

export function selectedStandalonePivotValues(
    pivotTab: PivotTabForNumericSafety,
): Array<{ column: string; aggregation: string }> {
    const config = pivotTab.standaloneConfig;

    return (config?.values ?? []).map((id) => ({
        column: config?.value_sources?.[id] ?? id,
        aggregation: config?.aggregation?.[id] ?? "sum",
    }));
}

export function clientPivotRangeError(range: ClientPivotValueRange): string {
    if (range.unsafeValueCount > 0) {
        return [
            `Value field "${range.column}" contains integers outside JavaScript's exact integer range.`,
            "",
            `Source type: ${range.sourceType}`,
            `Detected unsafe values: ${range.unsafeValueCount.toLocaleString()}`,
            `Example value: ${range.sampleUnsafeValue ?? "unavailable"}`,
            "",
            "Client-side Pivot supports exact integers only from",
            "-9,007,199,254,740,991 to 9,007,199,254,740,991.",
        ].join("\n");
    }

    return [
        `SUM of "${range.column}" can exceed JavaScript's exact integer range.`,
        "",
        `Source type: ${range.sourceType}`,
        `Sum of absolute input values: ${range.sumAbsValue ?? "unavailable"}`,
        "Safe integer limit: 9,007,199,254,740,991",
        "",
        "Individual values are representable, but Pivot totals or subtotals",
        "may lose integer precision in client-side aggregation.",
    ].join("\n");
}