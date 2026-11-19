import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  server: {
    // 默认只绑回环：局域网暴露的 dev server 曾是 esbuild CVE 的利用面；
    // 需要手机真机联调时用 `npm run dev -- --host` 显式打开
    host: '127.0.0.1',
    port: 5173,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  }
});
