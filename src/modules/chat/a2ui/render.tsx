// 渲染上下文与组件分发：数据模型读写、路径解析（含模板相对路径）、action 回传。

import { createContext, useContext } from 'react';
import { joinPath, resolvePointer } from './pointer';
import { resolveDynamic, type EvalCtx } from './functions';
import type { SurfaceState } from './types';
import { LayoutComponent, LAYOUT_TYPES } from './components/layout';
import { DisplayComponent, DISPLAY_TYPES } from './components/display';
import { InputComponent, INPUT_TYPES } from './components/input';

export interface A2uiContextValue {
  surface: SurfaceState;
  /** 当前数据模型（服务端数据 + 本地双向绑定编辑） */
  data: unknown;
  setValue: (absPath: string, value: unknown) => void;
  /** 按钮 action 回传：name + 已解析的 context（+ sendDataModel 时附全量数据） */
  dispatchAction: (name: string, contextSpec?: Record<string, unknown>, label?: string) => void;
}

export const A2uiContext = createContext<A2uiContextValue | null>(null);

/** 模板作用域（List 逐项渲染时子树内的相对路径基准，'' 表示根作用域） */
export const ScopeContext = createContext('');

export function useA2ui() {
  const ctx = useContext(A2uiContext);
  const scopePath = useContext(ScopeContext);
  if (!ctx) throw new Error('A2uiContext missing');
  const evalCtx: EvalCtx = {
    resolvePath: (path) => resolvePointer(ctx.data, joinPath(scopePath, path)),
  };
  return {
    ...ctx,
    scopePath,
    evalCtx,
    resolve: (spec: unknown) => resolveDynamic(spec, evalCtx),
    resolvePath: evalCtx.resolvePath,
    setBoundValue: (path: string, value: unknown) =>
      ctx.setValue(joinPath(scopePath, path), value),
  };
}

/** 按 component 类型分发渲染。未知类型渲染占位（后端白名单已拦截，理论不可达） */
export function RenderComponent({ id }: { id: string }) {
  const { surface } = useA2ui();
  const def = surface.components[id];
  if (!def) return null;
  if (LAYOUT_TYPES.has(def.component)) return <LayoutComponent def={def} />;
  if (DISPLAY_TYPES.has(def.component)) return <DisplayComponent def={def} />;
  if (INPUT_TYPES.has(def.component)) return <InputComponent def={def} />;
  return (
    <div className="text-xs text-zinc-500 italic">不支持的组件：{def.component}</div>
  );
}
