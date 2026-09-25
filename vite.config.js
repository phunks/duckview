import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
    root: "src",
    clearScreen: false,
    plugins: [react()],
    // PivotRoot is imported from the embedded streamlit-pivot-table checkout.
    // That checkout can have its own node_modules directory, which would
    // otherwise resolve a second React instance and make hooks fail at runtime.
    resolve: {
        dedupe: ["react", "react-dom"],
    },
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
                    if (id.includes("/src/pivot/")) {
                        return "react-pivot";
                    }
                },
            },
        },
        chunkSizeWarningLimit: 1500,
    },
    test: {
        include: ["**/*.test.{js,jsx,ts,tsx}"],
        globals: true,
        environment: "jsdom",
        setupFiles: ["./ext/streamlit-pivot-table/streamlit_pivot/frontend/src/test/setup.ts"],
    },
});
