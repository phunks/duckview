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
        rolldownOptions: {
            output: {
                codeSplitting: {
                    groups: [
                        {
                            name: 'monaco-editor-core',
                            test: (id) => id.includes('monaco-editor') || id.includes('monaco-sql-languages'),
                            priority: 100,
                        },
                    ],
                },
            },
        },
        chunkSizeWarningLimit: 1500,
    },
});
