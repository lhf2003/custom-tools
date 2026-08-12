import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  ClipboardPaste,
  Copy,
  ExternalLink,
  Languages,
  Link2,
  Scissors,
  TextSelect,
} from 'lucide-react';
import { MenuPanel } from './ActionMenu';
import { useAppStore } from '@/stores/appStore';
import { useToastStore } from '@/stores/toastStore';
import type { MenuItem } from '@/types';

interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

interface GlobalContextMenuProps {
  /** 空白区域兜底项（窗口置顶/设置/关于），由壳组装传入 */
  fallbackItems: MenuItem[];
}

type EditableElement = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

/** 选区 API 仅对这些 input type 有效（selectionStart/setSelectionRange 可用） */
const SELECTABLE_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'password']);

/** 命中的可编辑元素：input/textarea（只读/禁用不算）或 contenteditable */
function resolveEditable(target: HTMLElement): EditableElement | null {
  const el = target.closest(
    'input, textarea, [contenteditable]:not([contenteditable="false"])',
  );
  if (!el) return null;
  if (el instanceof HTMLTextAreaElement) {
    return el.readOnly || el.disabled ? null : el;
  }
  if (el instanceof HTMLInputElement) {
    if (el.readOnly || el.disabled) return null;
    return SELECTABLE_INPUT_TYPES.has(el.type || 'text') ? el : null;
  }
  return el as HTMLElement;
}

/** 输入类元素的当前选区；contenteditable 走 window.getSelection */
function fieldSelection(el: EditableElement): { text: string; start: number; end: number } {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    return { text: el.value.slice(start, end), start, end };
  }
  return { text: window.getSelection()?.toString() ?? '', start: 0, end: 0 };
}

/**
 * 在可编辑元素中插入文本（替换指定选区）。
 * 优先 execCommand('insertText')：走真实输入管线，React 受控组件能收到 input 事件；
 * 兜底原生 value setter + input 事件（React 受控 input 的标准解）。
 */
function insertIntoEditable(
  el: EditableElement,
  text: string,
  range: { start: number; end: number },
): void {
  el.focus();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.setSelectionRange(range.start, range.end);
  }
  if (document.execCommand('insertText', false, text)) return;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const proto =
      el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (!setter) return;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    setter.call(el, el.value.slice(0, start) + text + el.value.slice(end));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    const caret = start + text.length;
    el.setSelectionRange(caret, caret);
  }
}

/**
 * 全局右键菜单：接管主窗口所有未被模块自处理的 contextmenu，
 * 按命中目标构建上下文项（可编辑 > 链接 > 选中文本 > 空白兜底）。
 * 笔记树/插件导航/密码分类等自有菜单已 preventDefault，这里经 defaultPrevented 跳过。
 */
export function GlobalContextMenu({ fallbackItems }: GlobalContextMenuProps) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { addToast } = useToastStore();

  const close = useCallback(() => setMenu(null), []);

  const copyText = useCallback(
    (text: string) => {
      navigator.clipboard.writeText(text).catch((err: unknown) => {
        addToast({ type: 'error', title: '复制失败', message: String(err) });
      });
    },
    [addToast],
  );

  const buildItems = useCallback(
    (target: HTMLElement): MenuItem[] => {
      // 1. 可编辑元素：剪切/复制/粘贴/全选
      const editable = resolveEditable(target);
      if (editable) {
        const sel = fieldSelection(editable);
        const isPassword = editable instanceof HTMLInputElement && editable.type === 'password';
        const hasSelection = sel.text.length > 0;
        return [
          {
            id: 'cut',
            label: '剪切',
            icon: Scissors,
            shortcut: 'Ctrl+X',
            disabled: !hasSelection || isPassword,
            onClick: () => {
              navigator.clipboard
                .writeText(sel.text)
                .then(() => insertIntoEditable(editable, '', sel))
                .catch((err: unknown) => {
                  addToast({ type: 'error', title: '剪切失败', message: String(err) });
                });
            },
          },
          {
            id: 'copy',
            label: '复制',
            icon: Copy,
            shortcut: 'Ctrl+C',
            disabled: !hasSelection || isPassword,
            onClick: () => copyText(sel.text),
          },
          {
            id: 'paste',
            label: '粘贴',
            icon: ClipboardPaste,
            shortcut: 'Ctrl+V',
            onClick: () => {
              // WebView2 中 navigator.clipboard.readText 受权限约束不可靠，走后端读
              invoke<string | null>('read_clipboard_text')
                .then((text) => {
                  if (!text) {
                    addToast({ type: 'info', title: '剪贴板为空' });
                    return;
                  }
                  insertIntoEditable(editable, text, sel);
                })
                .catch((err: unknown) => {
                  addToast({ type: 'error', title: '粘贴失败', message: String(err) });
                });
            },
          },
          {
            id: 'select-all',
            label: '全选',
            icon: TextSelect,
            shortcut: 'Ctrl+A',
            separator: true,
            onClick: () => {
              editable.focus();
              if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
                editable.select();
              } else {
                document.execCommand('selectAll');
              }
            },
          },
        ];
      }

      // 2. 链接：在浏览器打开/复制链接
      const anchor = target.closest('a');
      const href = anchor?.getAttribute('href') ?? '';
      if (anchor && /^https?:\/\//.test(href)) {
        return [
          {
            id: 'open-link',
            label: '在浏览器打开',
            icon: ExternalLink,
            onClick: () => {
              invoke('open_external_url', { url: href }).catch((err: unknown) => {
                addToast({ type: 'error', title: '打开链接失败', message: String(err) });
              });
            },
          },
          {
            id: 'copy-link',
            label: '复制链接',
            icon: Link2,
            onClick: () => copyText(href),
          },
        ];
      }

      // 3. 页面选中文本：复制/翻译所选
      const selection = window.getSelection()?.toString() ?? '';
      if (selection) {
        return [
          {
            id: 'copy',
            label: '复制',
            icon: Copy,
            shortcut: 'Ctrl+C',
            onClick: () => copyText(selection),
          },
          {
            id: 'translate-selection',
            label: '翻译所选',
            icon: Languages,
            onClick: () => useAppStore.getState().openPluginView('translate', selection),
          },
        ];
      }

      // 4. 空白区域：壳传入的通用项（窗口置顶/设置/关于）
      return fallbackItems;
    },
    [fallbackItems, addToast, copyText],
  );

  // 全局接管 contextmenu：模块自有菜单已 preventDefault 的不重复接管
  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      e.preventDefault();
      // 右键落在已打开的菜单上：不重建，保持原菜单（与原生行为一致）
      if (menuRef.current?.contains(target)) return;
      setMenu({ x: e.clientX, y: e.clientY, items: buildItems(target) });
    };
    window.addEventListener('contextmenu', handleContextMenu);
    return () => window.removeEventListener('contextmenu', handleContextMenu);
  }, [buildItems]);

  // 关闭路径：点外部/Escape/滚动/失焦/缩放，与原生菜单一致
  // （失焦同时覆盖启动器失焦隐藏后菜单滞留的情形）
  useEffect(() => {
    if (!menu) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) close();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // 捕获阶段拦截 + stopPropagation：菜单是顶层浮层，Escape 只关菜单，
      // 不再落到壳的 Escape 处理（返回启动器/隐藏窗口）
      e.stopPropagation();
      close();
    };
    window.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu, close]);

  // 渲染后按实测尺寸钳制进视口；数值无变化时返回 prev 防收敛重入（同 PluginHost 右键菜单）
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const overflowX = menu.x + rect.width - window.innerWidth;
    const overflowY = menu.y + rect.height - window.innerHeight;
    if (overflowX <= 0 && overflowY <= 0) return;
    setMenu((prev) => {
      if (!prev) return prev;
      const x = Math.max(8, prev.x - Math.max(0, overflowX));
      const y = Math.max(8, prev.y - Math.max(0, overflowY));
      if (x === prev.x && y === prev.y) return prev;
      return { ...prev, x, y };
    });
  }, [menu]);

  // 菜单容器 mousedown 一律 preventDefault：不抢输入框焦点、不清选区，剪切/粘贴/全选才有作用目标
  useEffect(() => {
    const el = menuRef.current;
    if (!menu || !el) return;
    const preventDefault = (e: MouseEvent) => e.preventDefault();
    el.addEventListener('mousedown', preventDefault);
    return () => el.removeEventListener('mousedown', preventDefault);
  }, [menu]);

  if (!menu) return null;

  return (
    <div
      ref={menuRef}
      className="fixed z-[1000] min-w-[220px] max-w-[calc(100vw-16px)] bg-app-bg-primary/80 border border-app-border rounded-xl shadow-lg animate-in fade-in duration-150"
      style={{
        left: menu.x,
        top: menu.y,
        WebkitBackdropFilter: 'blur(20px)',
        backdropFilter: 'blur(20px)',
      }}
    >
      <MenuPanel
        items={menu.items}
        onItemClick={(item) => {
          item.onClick();
          close();
        }}
      />
    </div>
  );
}
