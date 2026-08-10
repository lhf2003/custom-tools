import { useEffect, useRef, type ComponentType } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { Package } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { WINDOW_SIZE } from '@/constants/window';
import { immediateResize } from '@/utils/tauri';
import { listExternalPluginIds, registerExternalPlugins, unregisterExternalPlugins } from './registry';
import { syncPluginShortcuts } from './pluginShortcuts';
import type { ViewPlugin } from './types';

/**
 * 外部插件：磁盘 plugin.json + IIFE bundle（uTools 式全局注册）。
 * 加载器：Rust 扫描元数据 → 注册表合流（仅启用的插件）；首次打开时
 * Rust 读 bundle → new Function 执行 → 读 window.flowhubPlugin → 命令式 mount。
 */

/** 外部插件 manifest（对应 Rust ExternalPluginManifest，snake_case → camelCase） */
export interface ExternalPluginManifest {
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  icon?: string;
  aliases: string[];
  main: string;
  runtime: string;
  permissions: string[];
  triggers: { keyword: string; argHint?: string }[];
  shortcuts: { id: string; key: string; label: string }[];
  settings: {
    key: string;
    label: string;
    type: 'text' | 'number' | 'toggle' | 'select';
    options?: string[];
    default?: string;
    placeholder?: string;
  }[];
}

/** Rust PluginScanItem */
export interface PluginScanItem {
  manifest: ExternalPluginManifest | null;
  error: string | null;
  dir_path: string;
}

/** 插件运行上下文：主应用暴露给外部插件的受控 API */
export interface ExternalPluginContext {
  /** 调用主应用 Tauri command（信任模型：同权限） */
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  /** 读取打开时投递的载荷（trigger 参数等）。消费式：与内置插件的 usePluginPayload 同语义 */
  getPayload: () => unknown;
}

/** IIFE bundle 注册的插件模块（window.flowhubPlugin） */
export interface FlowhubPluginModule {
  manifest: ExternalPluginManifest;
  view: {
    mount: (container: HTMLElement, ctx: ExternalPluginContext) => void;
    unmount?: () => void;
  };
  /** 预留：复杂插件自绘配置 UI（二期仅协议位） */
  renderSettings?: (container: HTMLElement, ctx: ExternalPluginContext) => void;
}

declare global {
  interface Window {
    flowhubPlugin?: FlowhubPluginModule;
  }
}

/**
 * 完整刷新外部插件：扫描 → 读启用状态 → 注销旧的 → 合流启用的。
 * App 挂载与插件管理器操作后共用，保证注册表与磁盘/设置一致。
 */
export async function refreshExternalPlugins(): Promise<PluginScanItem[]> {
  const items = await invoke<PluginScanItem[]>('scan_plugins');
  const enabledIds = new Set<string>();
  for (const item of items) {
    if (!item.manifest) continue;
    const enabled = await invoke<string | null>('get_setting', {
      key: `plugins.${item.manifest.id}.enabled`,
    });
    if (enabled === '1') enabledIds.add(item.manifest.id);
  }
  unregisterExternalPlugins(listExternalPluginIds());
  const registered: ViewPlugin[] = [];
  for (const item of items) {
    if (item.manifest && enabledIds.has(item.manifest.id)) {
      registered.push(adaptExternalPlugin(item.manifest, item.dir_path));
    }
  }
  registerExternalPlugins(registered);
  // 快捷键贡献点：启用插件的 shortcuts 注册进系统（冲突进模块级缓存，await 保证
  // 返回时冲突表已最新，市场 tab 直接读）
  await syncPluginShortcuts();
  return items;
}

/** 设置外部插件启用状态（写 settings 表 KV） */
export async function setPluginEnabled(id: string, enabled: boolean): Promise<void> {
  await invoke('set_setting', {
    key: `plugins.${id}.enabled`,
    value: enabled ? '1' : '0',
  });
}

/** 读取外部插件是否已信任（首次启用确认过） */
export async function isPluginTrusted(id: string): Promise<boolean> {
  const trusted = await invoke<string | null>('get_setting', {
    key: `plugins.${id}.trusted`,
  });
  return trusted === '1';
}

/** 标记插件已信任（首次启用确认后写入） */
export async function markPluginTrusted(id: string): Promise<void> {
  await invoke('set_setting', {
    key: `plugins.${id}.trusted`,
    value: '1',
  });
}

/** 读取并执行插件 bundle，返回 mount/unmount */
async function loadExternalModule(pluginId: string): Promise<Pick<FlowhubPluginModule, 'view'>> {
  // 重置上次注册（避免同名残留）；断言绕过 TS 流分析的 undefined 窄化
  window.flowhubPlugin = undefined;
  const code = await invoke<string>('read_plugin_bundle', { pluginId });
  // eslint-disable-next-line no-new-func
  new Function(code)();
  const mod = window.flowhubPlugin as FlowhubPluginModule | undefined;
  if (!mod || !mod.view || typeof mod.view.mount !== 'function') {
    throw new Error('插件 bundle 未注册有效视图（缺少 window.flowhubPlugin.view.mount）');
  }
  return mod;
}

/** 外部插件视图的 React 包装：命令式挂载进容器，卸载时 unmount */
function createExternalViewComponent(pluginId: string): ComponentType {
  return function ExternalPluginView() {
    const containerRef = useRef<HTMLDivElement>(null);
    const unmountRef = useRef<(() => void) | null>(null);

    useEffect(() => {
      // 插件窗口规范：打开插件视图时立即对齐内置工具视图尺寸（820×600），
      // 与内置视图 mount 时 immediateResize 同策略（取消挂起的 debounced resize，避免 DWM 合成层脱节）
      immediateResize(WINDOW_SIZE.PLUGIN.height, WINDOW_SIZE.PLUGIN.width);
      let cancelled = false;
      let mounted = false;
      loadExternalModule(pluginId)
        .then((mod) => {
          if (cancelled || !containerRef.current) return;
          mod.view.mount(containerRef.current, {
            invoke,
            getPayload: () => useAppStore.getState().consumePayload(pluginId),
          });
          mounted = true;
          unmountRef.current = mod.view.unmount ?? null;
        })
        .catch((err: unknown) => {
          console.error(`[plugins] 外部插件「${pluginId}」加载失败:`, err);
        });

      return () => {
        cancelled = true;
        if (mounted) unmountRef.current?.();
      };
    }, [pluginId]);

    // panel-glass：主窗口透明，内置视图根容器均以 --app-panel-bg 铺玻璃面板底
    // （随主题/透明度滑杆）。外部插件视图不假设插件自带背景，宿主兜底铺底，
    // 与内置视图视觉一致；插件自身铺的背景会覆盖本层（子层在上）。
    return <div ref={containerRef} className="w-full h-full panel-glass" />;
  };
}

/** 外部插件 icon：图片（asset URL）包装为组件，兼容 LucideIcon 的 className/size（插件视图与设置导航共用） */
export function createExternalIconComponent(dirPath: string, iconFile: string): ComponentType<{ className?: string; size?: number | string }> {
  const src = convertFileSrc(`${dirPath}\\${iconFile}`);
  return function ExternalPluginIcon(props: { className?: string; size?: number | string }) {
    return (
      <img
        src={src}
        alt=""
        className={props.className}
        style={{ width: props.size ?? 16, height: props.size ?? 16, objectFit: 'contain' }}
        draggable={false}
      />
    );
  };
}

/** 适配器：外部 manifest → 标准 ViewPlugin（PluginHost 与上层零改动） */
function adaptExternalPlugin(manifest: ExternalPluginManifest, dirPath: string): ViewPlugin {
  return {
    kind: 'view',
    id: manifest.id,
    name: manifest.name,
    icon: manifest.icon ? createExternalIconComponent(dirPath, manifest.icon) : Package,
    aliases: manifest.aliases ?? [],
    description: manifest.description,
    // 外部插件排内置之后（内置 order 0-6，外部从 100 起）
    order: 100,
    triggers: (manifest.triggers ?? []).map((t) => ({
      keyword: t.keyword,
      argHint: t.argHint,
    })),
    load: () =>
      Promise.resolve({
        default: createExternalViewComponent(manifest.id),
      }),
    nav: {
      title: manifest.name,
    },
  };
}
