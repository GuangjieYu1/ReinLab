import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (['/node_modules/react/', '/node_modules/react-dom/', '/node_modules/scheduler/'].some(name => id.includes(name))) return 'react-runtime';
        },
      },
    },
  },
});
