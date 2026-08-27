import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [tailwindcss(), vue()],
  base: './',
server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Un único bundle de 1,8 MB hacía que Android tardase segundos en pintar
    // algo. Separado, el arranque solo parsea Vue + PrimeVue + la pestaña abierta.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('@supabase')) return 'vendor-supabase'
          if (id.includes('zod')) return 'vendor-zod'
        },
      },
    },
    chunkSizeWarningLimit: 900,
  }
})
