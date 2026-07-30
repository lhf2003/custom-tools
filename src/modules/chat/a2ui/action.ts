// 界面操作回传消息的格式定义：生成（A2uiSurface dispatchAction）与解析
//（ChatView 气泡渲染）同源，格式只此一处——改格式时两侧不会脱节。
//
// 消息走正常聊天发送链路并原样落库（模型需要完整的 action+上下文 JSON），
// 前端展示层用 parseActionMessage 识别后渲染成紧凑胶囊，协议细节不上屏。

export interface ActionMessageInfo {
  /** 按钮文本（展示用） */
  label: string;
  /** action 名（模型语义用） */
  name: string;
}

const ACTION_RE = /^用户操作：点击了「(.+?)」\(action: ([^)]+)\)/;

/** 组装一条界面操作回传消息（按钮点击 → 聊天发送链路） */
export function formatActionMessage(
  label: string | undefined,
  name: string,
  context: Record<string, unknown>,
  dataModel: unknown,
  sendDataModel: boolean,
): string {
  const lines = [`用户操作：点击了「${label ?? name}」(action: ${name})`];
  if (Object.keys(context).length > 0) {
    lines.push(`上下文：${JSON.stringify(context, null, 2)}`);
  }
  if (sendDataModel) {
    lines.push(`界面当前数据：${JSON.stringify(dataModel, null, 2)}`);
  }
  return lines.join('\n');
}

/** 识别界面操作回传消息；命中返回展示信息，未命中返回 null */
export function parseActionMessage(content: string): ActionMessageInfo | null {
  const m = ACTION_RE.exec(content);
  return m ? { label: m[1], name: m[2] } : null;
}
