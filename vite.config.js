import { defineConfig } from "vite";

export default defineConfig({
    root: "src",
    clearScreen: false,
    server: {
        host: "127.0.0.1",
        port: 1420,
        strictPort: true,
        hmr: {
            protocol: "ws",
            host: "127.0.0.1",
            clientPort: 1420,
        },
    },
    build: {
        outDir: "../dist",
        emptyOutDir: true,
        rollupOptions: {
            output: {
                manualChunks(id) {
                    if (
                        id.includes("monaco-editor") ||
                        id.includes("monaco-sql-languages")
                    ) {
                        return "monaco-editor-core";
                    }
                },
            },
        },
        chunkSizeWarningLimit: 1500,
    },
});
