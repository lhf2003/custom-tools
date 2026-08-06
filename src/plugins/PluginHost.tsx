import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ComponentType, type LazyExoticComponent } from 'react';
import { Loader2 } from 'lucide-react';
import { TopNavigationBar } from '@/components/TopNavigationBar';
import { MenuPanel } from '@/components/ActionMenu';
import type { MenuItem } from '@/types';
import { PluginErrorBoundary } from './PluginErrorBoundary';
import type { ViewPlugin } from './types';

const EMPTY_MENU_ITEMS: MenuItem[] = [];
// 无菜单插件的兜底 hook：保证 PluginHost 无条件调用、满足 hooks 规则
const useEmptyMenuItems = (): MenuItem[] => EMPTY_MENU_ITEMS;

// 模块级 lazy 缓存：跨 PluginHost 重挂载存活。
// 已加载插件的 lazy 组件内部缓存 Resolved，切换回该插件时渲染同步完成、零挂起零闪烁；
// 避免 key 重挂载后重建 lazy 实例导致的 suspend→resolve 微任务周期闪帧。
const lazyViewCache = new Map<string, LazyExoticComponent<ComponentType>>();

function getLazyView(plugin: ViewPlugin): LazyExoticComponent<ComponentType> {
  let view = lazyViewCache.get(plugin.id);
  if (!view) {
    view = lazy(plugin.load);
    lazyViewCache.set(plugin.id, view);
  }
  return view;
}

interface PluginHostProps {
  plugin: ViewPlugin;
  /** 壳统一追加的公共菜单项（置顶/设置/关于），拼在插件自有项之后 */
  commonMenuItems: MenuItem[];
  onBack: () => void;
}

/**
 * 插件宿主：导航栏（manifest 同步数据，即时渲染）+ 内容区懒加载视图。
 * 壳以 key=plugin.id 重挂载本组件，因此 useMenuItems 在单次挂载内身份稳定，
 * 满足 hooks 无条件调用规则。
 */
export function PluginHost({ plugin, commonMenuItems, onBack }: PluginHostProps) {
  const useMenuItems = plugin.nav.useMenuItems ?? useEmptyMenuItems;
  const pluginMenuItems = useMenuItems();
  const menuItems = useMemo(
    () => [...pluginMenuItems, ...commonMenuItems],
    [pluginMenuItems, commonMenuItems]
  );

  // 右键浮层菜单：优先 useContextMenuItems（条目级子集），缺省回退完整菜单
  const useContextMenuItems = plugin.nav.useContextMenuItems ?? useEmptyMenuItems;
  const contextMenuPluginItems = useContextMenuItems();
  const contextMenuItems = useMemo(
    () => [...contextMenuPluginItems, ...commonMenuItems],
    [contextMenuPluginItems, commonMenuItems]
  );

  const LazyView = getLazyView(plugin);

  // 右键菜单（nav.contextMenu 开启时）：与动作菜单同一内容，在光标处浮出
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // 点击菜单外 / Esc 关闭
  useEffect(() => {
    if (!contextMenu) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [contextMenu]);

  const handleContextMenu = (e: React.MouseEvent) => {
    // 输入框/文本域内保留 WebView 原生编辑菜单（剪切/复制/粘贴）
    if ((e.target as HTMLElement).closest('input, textarea')) return;
    e.preventDefault();
    const MENU_WIDTH = 240;
    const menuHeight = contextMenuItems.length * 37 + 20;
    setContextMenu({
      x: Math.min(e.clientX, window.innerWidth - MENU_WIDTH),
      y: Math.min(e.clientY, window.innerHeight - menuHeight),
    });
  };

  return (
    <>
      <div className="relative z-50">
        <TopNavigationBar
          title={plugin.nav.title}
          menuItems={menuItems}
          onBack={onBack}
          menuLabel={plugin.nav.menuLabel}
        />
      </div>
      <main
        className="flex-1 overflow-hidden isolate"
        onContextMenu={plugin.nav.contextMenu ? handleContextMenu : undefined}
      >
        <PluginErrorBoundary onBack={onBack}>
          <Suspense
            fallback={
              <div className="h-full flex items-center justify-center">
                <Loader2 size={20} className="animate-spin text-app-text-tertiary" />
              </div>
            }
          >
            <LazyView />
          </Suspense>
        </PluginErrorBoundary>
      </main>

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-[100] min-w-[220px] bg-app-bg-primary/80 border border-app-border rounded-xl shadow-2xl animate-in fade-in duration-150"
          style={{
            left: contextMenu.x,
            top: contextMenu.y,
            WebkitBackdropFilter: 'blur(20px)',
            backdropFilter: 'blur(20px)',
          }}
        >
          <MenuPanel
            items={contextMenuItems}
            onItemClick={(item) => {
              if (!item.disabled) {
                item.onClick();
                setContextMenu(null);
              }
            }}
          />
        </div>
      )}
    </>
  );
}
