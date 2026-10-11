import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { createGroqProxy, resolveGroqServerKey } from './server/groqProxy'

function groqProxyPlugin(): Plugin {
  const attach = (middlewares: { use: (handler: ReturnType<typeof createGroqProxy>) => void }, mode: string) => {
    middlewares.use(createGroqProxy({
      getServerKey: () => resolveGroqServerKey(loadEnv(mode, process.cwd(), '')),
    }))
  }

  return {
    name: 'groq-stt-proxy',
    configureServer(server) {
      attach(server.middlewares, server.config.mode)
    },
    configurePreviewServer(server) {
      attach(server.middlewares, server.config.mode)
    },
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), groqProxyPlugin()],
  // Client bundles may only see non-secret settings. Groq credentials stay in
  // the Node process that serves /api/stt and are never assigned to import.meta.env.
  envPrefix: ['VITE_DEFAULT_', 'VITE_DEBUG_'],
  server: { port: 3000 },
})
