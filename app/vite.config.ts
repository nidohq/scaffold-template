import { fileURLToPath } from "node:url"
import react from "@vitejs/plugin-react"
import { defineConfig, loadEnv } from "vite"
import { nodePolyfills } from "vite-plugin-node-polyfills"
import wasm from "vite-plugin-wasm"

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
	plugins: [
		react(),
		nodePolyfills({
			include: ["buffer"],
			globals: {
				Buffer: true,
			},
		}),
		wasm(),
	],
	build: {
		target: "esnext",
	},
	resolve: {
		// Generated clients can carry their own install (see
		// scripts/link-clients.mjs); one SDK copy keeps XDR types compatible.
		dedupe: ["@stellar/stellar-sdk"],
	},
	optimizeDeps: {
		exclude: ["@stellar/stellar-xdr-json"],
	},
	define: {
		global: "window",
	},
	envPrefix: "PUBLIC_",
	server: {
		// One fixed port per app (PORT in the root .env): Nido sessions live in
		// the origin's localStorage, so a server that drifted to another port
		// would have none. Fail loudly instead.
		port:
			Number(
				loadEnv(mode, fileURLToPath(new URL("..", import.meta.url)), "").PORT,
			) || 5173,
		strictPort: true,
		proxy: {
			"/friendbot": {
				target: "http://localhost:8000/friendbot",
				changeOrigin: true,
			},
		},
	},
}))
