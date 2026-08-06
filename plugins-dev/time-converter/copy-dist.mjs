// 把 dist/ 拷入 FlowHub 插件目录（%APPDATA%\com.flowhub.app\plugins\<id>\）
// 手动安装市场链路的最后一步（Rust 扫描从该目录发现插件）
import { cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const pluginId = 'time-converter';
const dest = join(homedir(), 'AppData', 'Roaming', 'com.flowhub.app', 'plugins', pluginId);
rmSync(dest, { recursive: true, force: true });
cpSync('dist', dest, { recursive: true });
console.log(`✓ installed to ${dest}`);
