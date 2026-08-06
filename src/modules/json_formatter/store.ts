import { create } from 'zustand';

/**
 * JSON 格式化插件的工作文本：跨视图切换存活（视图卸载不丢内容）。
 * 插件自有状态，与壳的打开载荷通道（appStore.payloads）分离——
 * 载荷只负责「打开时注入」，之后的编辑归这里。
 */
interface JsonFormatterState {
  text: string;
  setText: (text: string) => void;
}

export const useJsonFormatterStore = create<JsonFormatterState>((set) => ({
  text: '',
  setText: (text) => set({ text }),
}));
