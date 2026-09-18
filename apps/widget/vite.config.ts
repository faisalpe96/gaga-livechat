import { defineConfig } from 'vite';
import { fileURLToPath } from 'url';
import path from 'path';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  esbuild: {
    jsxFactory: 'h',
    jsxFragment: 'Fragment',
  },
  build: {
    outDir: path.resolve(currentDir, 'dist'),
    emptyOutDir: true,
    lib: {
      entry: path.resolve(currentDir, 'src/main.ts'),
      name: 'GagaChat',
      formats: ['es', 'umd', 'iife'],
      fileName: (format) => (format === 'iife' ? 'widget.js' : `widget.${format}.js`),
    },
    rollupOptions: {
      output: {
        extend: true,
      },
    },
    minify: 'esbuild',
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production'),
  },
});
