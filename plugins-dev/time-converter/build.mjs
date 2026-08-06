// 构建 @time 日期转换插件：TS → IIFE bundle（依赖打平）+ 拷贝 plugin.json 到 dist/
// 产物 dist/ 整体拷入 FlowHub 插件目录（app_data/plugins/time-converter/）
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
copyFileSync('plugin.json', 'dist/plugin.json');

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  outfile: 'dist/plugin.js',
  logLevel: 'info',
});

console.log('✓ built dist/plugin.js + dist/plugin.json');
