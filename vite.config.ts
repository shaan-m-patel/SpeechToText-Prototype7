import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react()],
    server: { port: 3000 },
    define: {
      'import.meta.env.VITE_GROQ_P7_KEY': JSON.stringify(env.GROQ_P7_KEY || env.VITE_GROQ_P7_KEY || ''),
      'import.meta.env.VITE_DEFAULT_LANGUAGE': JSON.stringify(env.VITE_DEFAULT_LANGUAGE || 'en'),
    },
  }
})
