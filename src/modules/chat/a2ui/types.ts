// A2UI v0.9 协议类型（与后端 a2ui.rs 校验器、render_ui 工具描述对齐）

export interface A2uiTheme {
  primaryColor?: string;
  iconUrl?: string;
  agentDisplayName?: string;
}

export interface A2uiComponentDef {
  id: string;
  component: string;
  weight?: number;
  [prop: string]: unknown;
}

export interface A2uiMessage {
  version: string;
  createSurface?: {
    surfaceId: string;
    catalogId?: string;
    theme?: A2uiTheme;
    sendDataModel?: boolean;
  };
  updateComponents?: { surfaceId: string; components: A2uiComponentDef[] };
  updateDataModel?: { surfaceId: string; path?: string; value?: unknown };
  deleteSurface?: { surfaceId: string };
}

/** jarvis:surface 事件负载 / chat_messages(content_type='a2ui') 的 content 结构 */
export interface SurfacePayload {
  sessionId?: number;
  surfaceId: string;
  messages: A2uiMessage[];
}

/** 消息数组应用后的 surface 快照（组件表 + 服务端数据模型） */
export interface SurfaceState {
  surfaceId: string;
  created: boolean;
  deleted: boolean;
  theme?: A2uiTheme;
  sendDataModel: boolean;
  components: Record<string, A2uiComponentDef>;
  dataModel: unknown;
}

/** 动态值：字面量 | 数据绑定 | 函数调用（checks/formatString 的 args 同构） */
export type DynamicValue =
  | string
  | number
  | boolean
  | null
  | { path: string }
  | { call: string; args?: Record<string, unknown> };

export interface A2uiCheck {
  call?: string;
  condition?: { call: string; args?: Record<string, unknown> };
  args?: Record<string, unknown>;
  message?: string;
}

export interface A2uiAction {
  event?: {
    name: string;
    context?: Record<string, unknown>;
  };
}
