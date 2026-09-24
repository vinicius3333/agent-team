import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"

export default defineConfig({
  root: "client",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./client/src", import.meta.url)) } },
  build: { outDir: "../dist/client", emptyOutDir: true },
  test: { root: ".", include: ["tests/**/*.test.{ts,tsx}"] },
})
