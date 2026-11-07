import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  // Relative base so the build works at https://<user>.github.io/<repo>/.
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
});
