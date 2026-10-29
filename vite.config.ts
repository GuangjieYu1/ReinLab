import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true, proxy:{'/backend':{target:'http://127.0.0.1:3001',changeOrigin:false,rewrite:path=>path.replace(/^\/backend/,'')}} },
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
