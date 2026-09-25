// src/data/arrowIpcConnector.ts
import { tableFromIPC, type Table } from "apache-arrow";

export const DEFAULT_ARROW_PAGE_SIZE = 200;
export const MAX_ARROW_PAGE_SIZE = 10_000;

export type ArrowQueryPage = {
    table: Table;
    offset: number;
    hasMore: boolean;
    payloadBytes: number;
    fetchAndReadMs: number;
    decodeMs: number;
    contentType: string | null;
};

export type FetchArrowQueryPageOptions = {
    queryId: string;
    offset?: number;
    limit?: number;
    signal?: AbortSignal;
};

function pageSize(limit: number): number {
    return Math.max(1, Math.min(limit, MAX_ARROW_PAGE_SIZE));
}

function queryPageUrl(queryId: string, offset: number, limit: number): string {
    const encodedQueryId = encodeURIComponent(queryId);

    return (
        `pivot-data://localhost/query/${encodedQueryId}` +
        `?offset=${offset}&limit=${limit}`
    );
}

async function responseError(response: Response): Promise<Error> {
    const text = await response.text().catch(() => "");
    const message = text.trim();

    return new Error(
        message ||
        `Could not load query data: ${response.status} ${response.statusText}`,
    );
}

/**
 * Fetch one Arrow IPC page from a query session.
 *
 * The backend includes one look-ahead row (`limit + 1`) so the client can
 * determine whether another page exists. The returned table excludes that
 * look-ahead row; consumers can aggregate/render it safely.
 */
export async function fetchArrowQueryPage({
                                              queryId,
                                              offset = 0,
                                              limit = DEFAULT_ARROW_PAGE_SIZE,
                                              signal,
                                          }: FetchArrowQueryPageOptions): Promise<ArrowQueryPage> {
    const effectiveLimit = pageSize(limit);
    const url = queryPageUrl(queryId, offset, effectiveLimit);
    const fetchStartedAt = performance.now();

    const response = await fetch(url, { signal });

    if (!response.ok) {
        throw await responseError(response);
    }

    const ipcBuffer = await response.arrayBuffer();
    const receivedAt = performance.now();
    const decodeStartedAt = performance.now();

    const decodedTable = tableFromIPC(new Uint8Array(ipcBuffer));
    const hasMore = decodedTable.numRows > effectiveLimit;
    const table = hasMore
        ? decodedTable.slice(0, effectiveLimit)
        : decodedTable;

    const decodedAt = performance.now();

    const result: ArrowQueryPage = {
        table,
        offset,
        hasMore,
        payloadBytes: ipcBuffer.byteLength,
        fetchAndReadMs: receivedAt - fetchStartedAt,
        decodeMs: decodedAt - decodeStartedAt,
        contentType: response.headers.get("content-type"),
    };

    console.info("Arrow IPC page timing (ms)", {
        queryId,
        offset,
        rows: table.numRows,
        hasMore,
        contentType: result.contentType,
        fetchAndRead: Math.round(result.fetchAndReadMs),
        arrowDecode: Math.round(result.decodeMs),
        payloadBytes: result.payloadBytes,
        payloadMiB: Number(
            (result.payloadBytes / (1024 * 1024)).toFixed(3),
        ),
    });

    return result;
}