import { defineConfig } from 'vite';
import { resolve } from 'path';

// IIFE format requires a single entry per Vite build. The package script
// invokes this config twice, once per vendor, via BOOKMARKLET_ENTRY.
const entry = process.env.BOOKMARKLET_ENTRY;
if (entry !== 'amazon' && entry !== 'apple') {
  throw new Error(
    `BOOKMARKLET_ENTRY must be set to "amazon" or "apple" (got: ${String(entry)}).`,
  );
}

export default defineConfig({
  // Disable publicDir copy: outDir is a child of the default publicDir
  // (`public/`), so Vite would otherwise copy site assets into the bundle dir.
  publicDir: false,
  build: {
    outDir: 'public/bookmarklets',
    emptyOutDir: false,
    rollupOptions: {
      input: resolve(__dirname, `src/bookmarklets/${entry}.ts`),
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
