import { defineConfig } from 'vite';
import { resolve } from 'path';

const entry = process.env.EXT_ENTRY;
if (entry !== 'content' && entry !== 'background' && entry !== 'options') {
  throw new Error(`EXT_ENTRY must be "content" | "background" | "options" (got: ${String(entry)}).`);
}

export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist-extension',
    emptyOutDir: false,
    rollupOptions: {
      input: resolve(__dirname, `src/extension/${entry}.ts`),
      output: {
        format: 'iife',
        entryFileNames: `${entry}.js`,
        inlineDynamicImports: true,
      },
    },
    minify: 'esbuild',
    target: 'es2020',
  },
});
