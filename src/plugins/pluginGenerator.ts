import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import * as acorn from 'acorn';

/**
 * AI 生成插件管线（二期设计第 8 节）：
 * 描述 → 流式生成（步骤回显）→ 结构/语法校验（失败带错误重试 1 次）→ 预览 → 试运行 → 安装。
 * 生成调用复用陪伴场景模型（Rust generate_plugin），私有 system prompt 在 Rust 侧，不进前端。
 */

/** 生成步骤（system prompt 固定步骤链，与 <step name="..."> 标记对应） */
export type GenStepName = 'manifest' | 'view' | 'style' | 'verify';

export const GEN_STEP_LABELS: Record<GenStepName, string> = {
  manifest: '正在生成插件框架…',
  view: '正在编写视图逻辑…',
  style: '正在按设计规范排版…',
  verify: '正在自校验…',
};

/** 生成产物：plugin.json + plugin.js 文件块 */
export interface GeneratedPluginFiles {
  manifestJson: string;
  bundleCode: string;
  /** 4 步生成说明（步骤回显内容，展示在结果面板） */
  steps: Partial<Record<GenStepName, string>>;
}

/**
 * 流式生成插件。onStep 每检测到步骤标记回调一次；invoke resolve 时返回完整产物。
 * 校验失败自动带错误重试 1 次（Rust 侧无法感知校验结果，重试由本函数发起）。
 */
export async function generatePlugin(
  description: string,
  onStep: (step: GenStepName) => void,
  onRetry: (reason: string) => void
): Promise<GeneratedPluginFiles> {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const text = await streamGenerate(description, onStep);
      return parseGeneratedFiles(text);
    } catch (err) {
      // 只有校验类错误重试（生成/网络错误直接抛）
      if (!(err instanceof GenValidationError) || attempt >= 2) throw err;
      onRetry(err.message);
    }
  }
}

/** 流式收集全文：invoke generate_plugin + 监听 plugin_gen:chunk 拼装 */
async function streamGenerate(
  description: string,
  onStep: (step: GenStepName) => void
): Promise<string> {
  let text = '';
  const unlisten = await listen<string>('plugin_gen:chunk', (event) => {
    text += event.payload;
    // 增量解析步骤标记：<step name="manifest"> 出现即进入该步
    for (const name of GEN_STEP_ORDER) {
      if (text.includes(`<step name="${name}">`)) onStep(name);
    }
  });
  try {
    return await invoke<string>('generate_plugin', { description });
  } finally {
    unlisten();
  }
}

const GEN_STEP_ORDER: GenStepName[] = ['manifest', 'view', 'style', 'verify'];

/** 校验失败信号（区别于网络/API 错误）：携带原因，触发重试 */
class GenValidationError extends Error {}

/** 解析 LLM 输出：抽取 4 步说明 + 两个文件块；缺块/结构非法 → GenValidationError */
export function parseGeneratedFiles(text: string): GeneratedPluginFiles {
  const steps: Partial<Record<GenStepName, string>> = {};
  for (const name of GEN_STEP_ORDER) {
    const match = text.match(new RegExp(`<step name="${name}">([\\s\\S]*?)</step>`));
    if (match) steps[name] = match[1].trim();
  }

  const manifestJson = extractFileBlock(text, 'plugin.json');
  const bundleCode = extractFileBlock(text, 'plugin.js');
  if (manifestJson === null || bundleCode === null) {
    throw new GenValidationError('生成结果缺少 plugin.json 或 plugin.js 文件块，无法安装');
  }

  // 结构校验：manifest 必须是合法 JSON 且含必填字段（重试 1 次的触发点）
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(manifestJson) as Record<string, unknown>;
  } catch {
    throw new GenValidationError('plugin.json 不是合法 JSON，已自动重试');
  }
  for (const field of ['id', 'name', 'version', 'main', 'runtime', 'permissions'] as const) {
    if (!(field in manifest)) {
      throw new GenValidationError(`plugin.json 缺少必填字段「${field}」，已自动重试`);
    }
  }
  // 语法校验：bundle 必须是合法 JS（acorn，浏览器环境无 Node）
  try {
    acorn.parse(bundleCode, { ecmaVersion: 2022, allowReturnOutsideFunction: false });
  } catch (err) {
    throw new GenValidationError(`plugin.js 语法错误：${err instanceof Error ? err.message : String(err)}，已自动重试`);
  }

  return { manifestJson, bundleCode, steps };
}

/** 提取 ---FILE:<name>--- 到下一个 ---FILE:---（或文本末尾）之间的内容 */
function extractFileBlock(text: string, name: string): string | null {
  const startMarker = `---FILE:${name}---`;
  const start = text.indexOf(startMarker);
  if (start === -1) return null;
  const contentStart = start + startMarker.length;
  const next = text.indexOf('---FILE:', contentStart);
  const end = next === -1 ? text.length : text.lastIndexOf('\n', next) === -1 ? next : text.lastIndexOf('\n', next);
  // 去掉首尾空行
  return text
    .slice(contentStart, end)
    .replace(/^\s*\n/, '')
    .replace(/\s+$/, '');
}
