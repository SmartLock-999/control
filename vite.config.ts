import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');

  // VITE_REPO_NAME 由 GitHub Actions 傳入（等於 repo 名稱，例如 "control"）
  // 本機開發時不會有這個變數，所以 base 為 "/"
  const base = env.VITE_REPO_NAME
    ? `/${env.VITE_REPO_NAME}/`
    : '/';

  return {
    base,
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY || ''),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
