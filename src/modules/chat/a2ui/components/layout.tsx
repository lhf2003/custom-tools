// 布局组件：Row / Column / List / Card / Tabs / Divider / Modal

import { useState } from 'react';
import { X } from 'lucide-react';
import { toDisplayString } from '../functions';
import { resolvePointer } from '../pointer';
import { RenderComponent, ScopeContext, useA2ui } from '../render';
import type { A2uiComponentDef } from '../types';

export const LAYOUT_TYPES = new Set(['Row', 'Column', 'List', 'Card', 'Tabs', 'Divider', 'Modal']);

const JUSTIFY: Record<string, string> = {
  start: 'justify-start',
  center: 'justify-center',
  end: 'justify-end',
  spaceBetween: 'justify-between',
  spaceAround: 'justify-around',
  spaceEvenly: 'justify-evenly',
};

const ALIGN: Record<string, string> = {
  start: 'items-start',
  center: 'items-center',
  end: 'items-end',
  stretch: 'items-stretch',
};

interface ChildListProps {
  ids: string[];
  /** Row 的子项不可压缩：CJK 文本 min-content 只有一字符宽，
   *  默认 shrink 会把「2.6 小时」这类短数值挤到折行 */
  noShrink?: boolean;
}

/** 固定子组件列表（weight 仅对 Row/Column 直接子级生效，由父级包 flexGrow） */
function Children({ ids, noShrink }: ChildListProps) {
  const { surface } = useA2ui();
  return (
    <>
      {ids.map((cid) => {
        const weight = surface.components[cid]?.weight;
        const cls =
          typeof weight === 'number' ? 'min-w-0' : noShrink ? 'min-w-0 shrink-0' : 'min-w-0';
        return (
          <div
            key={cid}
            className={cls}
            style={typeof weight === 'number' ? { flexGrow: weight } : undefined}
          >
            <RenderComponent id={cid} />
          </div>
        );
      })}
    </>
  );
}

function Row({ def }: { def: A2uiComponentDef }) {
  const ids = Array.isArray(def.children) ? (def.children as string[]) : [];
  const justify = JUSTIFY[String(def.justify)] ?? 'justify-start';
  const align = ALIGN[String(def.align)] ?? 'items-center';
  return (
    <div className={`flex flex-row gap-2 ${justify} ${align}`}>
      <Children ids={ids} noShrink />
    </div>
  );
}

function Column({ def }: { def: A2uiComponentDef }) {
  const ids = Array.isArray(def.children) ? (def.children as string[]) : [];
  const justify = JUSTIFY[String(def.justify)] ?? 'justify-start';
  const align = ALIGN[String(def.align)] ?? 'items-stretch';
  return (
    <div className={`flex flex-col gap-1.5 ${justify} ${align}`}>
      <Children ids={ids} />
    </div>
  );
}

/** List：固定 id 列表，或 {"path","componentId"} 模板按数据逐项渲染（相对路径作用域） */
function ListView({ def }: { def: A2uiComponentDef }) {
  const { data } = useA2ui();
  const horizontal = def.direction === 'horizontal';
  const align = ALIGN[String(def.align)] ?? 'items-stretch';
  const cls = horizontal
    ? `flex flex-row gap-2 overflow-x-auto ${align}`
    : `flex flex-col gap-1.5 max-h-64 overflow-y-auto ${align}`;

  const children = def.children;
  if (Array.isArray(children)) {
    return (
      <div className={cls}>
        <Children ids={children as string[]} />
      </div>
    );
  }

  const template = children as { path?: string; componentId?: string } | undefined;
  const items = template?.path ? resolvePointer(data, template.path) : undefined;
  if (!template?.componentId || !Array.isArray(items)) return null;
  return (
    <div className={cls}>
      {items.map((_, i) => (
        <ScopeContext.Provider key={i} value={`${template.path}/${i}`}>
          <RenderComponent id={template.componentId as string} />
        </ScopeContext.Provider>
      ))}
    </div>
  );
}

function Card({ def }: { def: A2uiComponentDef }) {
  const child = typeof def.child === 'string' ? def.child : null;
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-3">
      {child && <RenderComponent id={child} />}
    </div>
  );
}

interface TabDef {
  title?: unknown;
  child?: string;
}

function Tabs({ def }: { def: A2uiComponentDef }) {
  const { resolve } = useA2ui();
  const tabs = (Array.isArray(def.tabs) ? def.tabs : []) as TabDef[];
  const [active, setActive] = useState(0);
  const current = tabs[Math.min(active, tabs.length - 1)];
  return (
    <div>
      <div className="flex gap-3 border-b border-white/10 mb-2">
        {tabs.map((t, i) => (
          <button
            key={i}
            onClick={() => setActive(i)}
            className={`pb-1.5 text-xs transition-colors cursor-pointer ${
              i === active
                ? 'text-indigo-300 border-b-2 border-indigo-400 -mb-px'
                : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {toDisplayString(resolve(t.title))}
          </button>
        ))}
      </div>
      {current?.child && <RenderComponent id={current.child} />}
    </div>
  );
}

function Divider({ def }: { def: A2uiComponentDef }) {
  if (def.axis === 'vertical') {
    return <div className="w-px self-stretch bg-white/10" />;
  }
  return <hr className="border-white/10 my-1" />;
}

/** Modal：trigger 为触发组件（通常 Button），点击后内容以浮层呈现 */
function Modal({ def }: { def: A2uiComponentDef }) {
  const [open, setOpen] = useState(false);
  const trigger = typeof def.trigger === 'string' ? def.trigger : null;
  const content = typeof def.content === 'string' ? def.content : null;
  return (
    <>
      {trigger && (
        <div onClick={() => setOpen(true)} className="inline-block">
          <RenderComponent id={trigger} />
        </div>
      )}
      {open && content && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setOpen(false)}
        >
          <div
            className="relative max-w-sm w-full mx-4 rounded-xl border border-white/10 bg-zinc-800 p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setOpen(false)}
              className="absolute top-2 right-2 text-zinc-500 hover:text-zinc-300 cursor-pointer"
              aria-label="关闭"
            >
              <X className="w-4 h-4" />
            </button>
            <RenderComponent id={content} />
          </div>
        </div>
      )}
    </>
  );
}

export function LayoutComponent({ def }: { def: A2uiComponentDef }) {
  switch (def.component) {
    case 'Row':
      return <Row def={def} />;
    case 'Column':
      return <Column def={def} />;
    case 'List':
      return <ListView def={def} />;
    case 'Card':
      return <Card def={def} />;
    case 'Tabs':
      return <Tabs def={def} />;
    case 'Divider':
      return <Divider def={def} />;
    case 'Modal':
      return <Modal def={def} />;
    default:
      return null;
  }
}
