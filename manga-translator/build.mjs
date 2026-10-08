// Сборка сайта: node build.mjs [--watch] [--serve]
// Результат — папка dist/ (index.html + app.js + app.css), её можно выложить на любой статический хостинг.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const serve = process.argv.includes('--serve');

mkdirSync('dist', { recursive: true });
cpSync('public', 'dist', { recursive: true });

const options = {
  entryPoints: { app: 'src/main.tsx' },
  bundle: true,
  outdir: 'dist',
  format: 'esm',
  target: ['es2020', 'chrome100', 'firefox100', 'safari15'],
  jsx: 'automatic',
  minify: !watch,
  sourcemap: watch,
  loader: { '.css': 'css' },
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
  // NODE_PATH позволяет брать пакеты из общей папки, если node_modules не установлены локально
  nodePaths: process.env.NODE_PATH ? process.env.NODE_PATH.split(':') : [],
  logLevel: 'info',
};

if (watch || serve) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  if (serve) {
    const { port } = await ctx.serve({ servedir: 'dist', port: 5173 });
    console.log(`Открой http://localhost:${port}`);
  }
} else {
  await esbuild.build(options);
}
