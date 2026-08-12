import { invoke } from '@tauri-apps/api/core';

/**
 * 语音播报公共入口(Moss 流式 TTS)。
 * 开关/Key/音频设备裁决全部收口在 Rust 端(moss_tts_speak 静默跳过),
 * 前端触发点无脑调、失败静默——播报是增强体验,不反过来打扰。
 */

/** markdown → 口语文本:代码段/标记符号念出来全是噪音,播报前剥掉 */
export function stripForSpeech(text: string): string {
  return (
    text
      .replace(/```[\s\S]*?(```|$)/g, ' ') // fenced code 整段剔除(含未闭合)
      .replace(/`([^`]*)`/g, '$1') // 行内 code 留文字
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // 图片留 alt
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接留文字
      .replace(/^\s{0,3}#{1,6}\s*/gm, '') // 标题符号
      .replace(/^\s{0,3}>\s?/gm, '') // 引用符号
      .replace(/^\s*[-*+]\s+/gm, '') // 无序列表
      .replace(/^\s*\d{1,3}\.\s+/gm, '') // 有序列表
      .replace(/^[ \t|:-]+$/gm, '') // 表格分隔行
      .replace(/\|/g, ' ') // 表格竖线
      .replace(/\*\*([^*]*)\*\*/g, '$1')
      .replace(/\*([^*]*)\*/g, '$1')
      .replace(/~~([^~]*)~~/g, '$1')
      .replace(/(^|\s)_{1,2}([^_]+)_{1,2}/g, '$1$2')
      .replace(/<\/?aside>/g, '') // 内心独白:剥标签留内容(蛐蛐也是贾维斯的话)
      .replace(/<[^>]+>/g, '') // 其他 HTML 标签
      .replace(/[ \t]*\n[ \t]*/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/** 播报纯文本(toast 文案等本身干净的文本)。返回 Promise:手动触发场景靠 catch 清播放态 */
export function speakText(text: string): Promise<void> {
  const t = text.trim();
  if (!t) return Promise.resolve();
  return invoke('moss_tts_speak', { text: t });
}

/** 播报 markdown 文本(聊天回复):先剥标记再念 */
export function speakMarkdown(markdown: string): Promise<void> {
  return speakText(stripForSpeech(markdown));
}

/** 停止当前播报(toast 关闭/发新消息/取消生成时) */
export function stopSpeech(): void {
  invoke('moss_tts_stop').catch(() => {});
}
