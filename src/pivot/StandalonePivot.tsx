import { tableFromArrays, type Table } from "apache-arrow";
import { StrictMode, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import PivotRoot, {
    type PivotRootProps,
    type PivotStateCallback,
} from "../ext/streamlit-pivot-table/streamlit_pivot/frontend/src/PivotRoot";
import type {
    CellClickPayload,
    ColumnTypeMap,
    DateGrain,
    PivotConfigV1,
    PivotTableData,
} from "../ext/streamlit-pivot-table/streamlit_pivot/frontend/src/engine/types";
import { abbreviateFieldLabel } from "./labels";
import { watchPivotWarnings, type PivotNotice } from "./warningToast";
import React from "react";

export type StandalonePivotMountOptions = {
    dataframe?: Table;
    initialConfig?: PivotConfigV1;
    instanceKey?: string;
    onConfigChange?: (config: PivotConfigV1) => void;
    onWarning?: (notices: PivotNotice[]) => void;
    onCreateDrilldownView?: (event: React.MouseEvent, payload: CellClickPayload, config: PivotConfigV1, columnTypes: ColumnTypeMap, adaptiveDateGrains?: Record<string, DateGrain>) => void;
};

export type StandalonePivotHandle = {
    update: (options: StandalonePivotMountOptions) => void;
    unmount: () => void;
};

const roots = new WeakMap<HTMLElement, Root>();

export const FIXED_PIVOT_TABLE = tableFromArrays({
    region: ["East", "East", "West", "West", "North", "South"],
    year: [2023, 2024, 2023, 2024, 2024, 2024],
    category: [
        "Hardware",
        "Software",
        "Hardware",
        "Software",
        "Software",
        "Hardware",
    ],
    revenue: [1200, 1800, 900, 2100, 750, 1100],
    units: [12, 18, 9, 21, 8, 11],
});

export const FIXED_PIVOT_CONFIG: PivotConfigV1 = {
    version: 1,
    rows: ["region"],
    columns: ["year"],
    values: ["revenue"],
    aggregation: {
        revenue: "sum",
    },
    show_totals: true,
    empty_cell_value: "-",
    interactive: true,
};

const EMPTY_PIVOT_CONFIG: PivotConfigV1 = {
    version: 1,
    rows: [],
    columns: [],
    values: [],
    aggregation: {},
    show_totals: true,
    empty_cell_value: "-",
    interactive: true,
};

function defaultConfigFor(
    dataframe: Table,
    initialConfig: PivotConfigV1 | undefined,
): PivotConfigV1 {
    if (initialConfig) {
        return initialConfig;
    }

    return dataframe === FIXED_PIVOT_TABLE
        ? FIXED_PIVOT_CONFIG
        : EMPTY_PIVOT_CONFIG;
}

function labelsFor(table: Table): Record<string, string> {
    return Object.fromEntries(
        table.schema.fields.map((field) => [
            field.name,
            abbreviateFieldLabel(field.name),
        ]),
    );
}

function withDisplayLabels(config: PivotConfigV1, table: Table): PivotConfigV1 {
    return {
        ...config,
        field_labels: {
            ...config.field_labels,
            ...labelsFor(table),
        },
    };
}

type StandalonePivotViewProps = Required<
    Pick<StandalonePivotMountOptions, "instanceKey">
> &
    StandalonePivotMountOptions;

function StandalonePivotView({
                                 dataframe = FIXED_PIVOT_TABLE,
                                 initialConfig,
                                 instanceKey,
                                 onConfigChange,
                                  onCreateDrilldownView,
                             }: StandalonePivotViewProps) {
    const configuredInitialState = useMemo(
        () =>
            withDisplayLabels(
                defaultConfigFor(dataframe, initialConfig),
                dataframe,
            ),
        [dataframe, initialConfig],
    );

    const [config, setConfig] = useState<PivotConfigV1>(
        configuredInitialState,
    );

    useEffect(() => {
        setConfig(configuredInitialState);
    }, [configuredInitialState]);

    const handlePivotConfigChange = useCallback(
        (nextConfig: PivotConfigV1) => {
            const labeledConfig = withDisplayLabels(nextConfig, dataframe);

            setConfig(labeledConfig);
            onConfigChange?.(labeledConfig);
        },
        [dataframe, onConfigChange],
    );

    const setStateValue = useCallback<PivotStateCallback>((key, value) => {
        if (key === "config") {
            return;
        }

        console.debug("Standalone Pivot state event", { key, value });
    }, []);

    const setTriggerValue = useCallback<PivotStateCallback>((key, value) => {
        console.debug("Standalone Pivot trigger event", { key, value });
    }, []);

    const pivotProps = useMemo<PivotRootProps & PivotTableData>(
        () => ({
            instanceKey,
            dataframe,
            config,
            height: null,
            max_height: undefined,
            execution_mode: "client_only",
            source_row_count: dataframe.numRows,
            setStateValue,
            setTriggerValue,
            onConfigChange: handlePivotConfigChange,
            onCreateDrilldownView,
        }),
        [
            config,
            dataframe,
            handlePivotConfigChange,
            onCreateDrilldownView,
            instanceKey,
            setStateValue,
            setTriggerValue,
        ],
    );

    return <PivotRoot {...pivotProps} />;
}

function renderStandalonePivot(
    host: HTMLElement,
    options: StandalonePivotMountOptions,
): void {
    const root = roots.get(host);

    if (!root) {
        throw new Error("Standalone Pivot root has not been created.");
    }

    root.render(
        <StrictMode>
            <StandalonePivotView
                dataframe={options.dataframe}
                initialConfig={options.initialConfig}
                instanceKey={options.instanceKey ?? "duckview-fixed-arrow-pivot"}
                onConfigChange={options.onConfigChange}
                onCreateDrilldownView={options.onCreateDrilldownView}
            />
        </StrictMode>,
    );
}


export function mountStandalonePivot(
    host: HTMLElement,
    options: StandalonePivotMountOptions = {},
): StandalonePivotHandle {
    let root = roots.get(host);

    if (!root) {
        root = createRoot(host);
        roots.set(host, root);
    }

    renderStandalonePivot(host, options);
    const stopWatchingWarnings = options.onWarning
        ? watchPivotWarnings(host, options.onWarning)
        : () => {};

    return {
        update(nextOptions) {
            renderStandalonePivot(host, nextOptions);
        },
        unmount() {
            stopWatchingWarnings();
            const activeRoot = roots.get(host);
            if (!activeRoot) {
                return;
            }

            activeRoot.unmount();
            roots.delete(host);
            host.replaceChildren();
        },
    };
}