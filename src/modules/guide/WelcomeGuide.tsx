import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ClipboardList, FileText, KeyRound, MessageCircle, Rocket, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useGuideStore } from './store';
import { CAPABILITIES } from './registry';
import type { CapabilityItem } from './types';

const CAPABILITY_ICONS: Record<CapabilityItem['icon'], LucideIcon> = {
  rocket: Rocket,
  clipboard: ClipboardList,
  key: KeyRound,
  note: FileText,
  sparkles: Sparkles,
  message: MessageCircle,
};

/** 退场时长：与 transition duration-200 对齐，状态推进由定时器驱动（不依赖动画事件） */
const FINISH_DELAY_MS = 200;

/** 唤起快捷键键帽：全页唯一的视觉主角 */
function KeyCap({ label, wide }: { label: string; wide?: boolean }) {
  return (
    <kbd
      className={`${wide ? 'px-5' : 'px-3.5'} py-2 rounded-lg bg-app-bg-elevated border border-app-border-subtle text-lg font-mono text-app-text-primary leading-none`}
    >
      {label}
    </kbd>
  );
}

function CapabilityRow({ item, hero }: { item: CapabilityItem; hero?: boolean }) {
  const Icon = CAPABILITY_ICONS[item.icon];
  return (
    <div className="flex items-baseline gap-2.5 min-w-0">
      <Icon className="w-3.5 h-3.5 text-app-text-tertiary flex-shrink-0 self-center" />
      <span className={`text-sm text-app-text-primary flex-shrink-0 ${hero ? 'font-medium' : ''}`}>
        {item.name}
      </span>
      <span className="text-xs text-app-text-tertiary truncate">{item.description}</span>
    </div>
  );
}

/**
 * 首启欢迎页：接管主窗口（800×500），单页三级视觉权重——
 * 唤起键帽（主角）→ 能力地图（配角）→ 品牌（最轻）。
 * 展示期间挂起失焦隐藏（blur hold），Enter/Esc/点击均完成并写入已读。
 * 进退场用 Tailwind 核心 transition 实现（项目未装 tailwindcss-animate，animate-* 类不生效）；
 * 完成推进由 setTimeout 驱动，不把状态收敛挂在 animationend 上。
 */
export function WelcomeGuide() {
  const completeWelcome = useGuideStore((s) => s.completeWelcome);
  const [entered, setEntered] = useState(false);
  const [leaving, setLeaving] = useState(false);

  // 欢迎页期间挂起 hide-on-blur：教学不能被一次误触切走；
  // hold 是内存态，进程退出自然复位，不污染用户设置
  useEffect(() => {
    invoke('set_blur_hold', { hold: true }).catch((err: unknown) => {
      console.error('[guide] failed to hold blur:', err);
    });
    return () => {
      invoke('set_blur_hold', { hold: false }).catch((err: unknown) => {
        console.error('[guide] failed to release blur hold:', err);
      });
    };
  }, []);

  // 入场：首帧透明缩放 → 下一帧归位，transition 播放（双帧保险）
  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const finish = useCallback(() => {
    if (leaving) return;
    setLeaving(true);
    // 状态推进由定时器驱动：无论 transition 是否生效（系统 reduce 等），完成逻辑都可靠收敛
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.setTimeout(() => void completeWelcome(), reduced ? 0 : FINISH_DELAY_MS);
  }, [leaving, completeWelcome]);

  // Enter 开始 / Esc 跳过（同路径：看完即完成）。capture 拦截，
  // 避免 App 级 Esc（切视图/隐藏窗口）在欢迎页期间生效
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [finish]);

  // 互斥三段：未入场 / 已入场(300ms) / 退场(200ms)，避免 duration 类冲突
  const motionClass = leaving
    ? 'opacity-0 scale-[0.98] duration-200'
    : entered
      ? 'opacity-100 scale-100 duration-300'
      : 'opacity-0 scale-[0.98] duration-300';

  // 两列三行：启动器居首格（阅读顺序首位），font-medium 轻强调
  const [first, ...rest] = CAPABILITIES;

  return (
    <div
      className={`w-full h-full flex flex-col items-center justify-center rounded-lg overflow-hidden panel-glass transition-all ease-out motion-reduce:transition-none ${motionClass}`}
    >
      {/* 品牌区：最轻，文字标识与关于页一致 */}
      <div className="flex items-baseline gap-2">
        <h1 className="text-sm font-semibold text-app-text-primary tracking-wide">FlowHub</h1>
        <span className="text-xs text-app-text-tertiary">桌面效率中枢</span>
      </div>

      {/* 主角区：唤起键帽 */}
      <div className="mt-10 flex items-center gap-2.5">
        <KeyCap label="Alt" />
        <span className="text-app-text-disabled text-sm">+</span>
        <KeyCap label="Space" wide />
      </div>
      <p className="mt-4 text-sm text-app-text-secondary">任何时候，一键唤起</p>
      <p className="mt-1 text-xs text-app-text-tertiary">这几乎是你唯一需要记住的快捷键</p>

      {/* 能力地图：配角，两列三行整齐网格 */}
      <div className="mt-9 grid grid-cols-2 gap-x-10 gap-y-3">
        <CapabilityRow item={first} hero />
        {rest.map((item) => (
          <CapabilityRow key={item.name} item={item} />
        ))}
      </div>

      {/* 操作区：全屏唯一 Primary */}
      <button
        type="button"
        autoFocus
        onClick={finish}
        className="mt-10 px-5 py-2 rounded-lg bg-app-status-info text-white text-sm hover:bg-app-status-info-deep transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-app-brand-primary/60"
      >
        开始使用
      </button>
      <p className="mt-3 text-[10px] text-app-text-disabled">Enter 开始 · Esc 跳过</p>
    </div>
  );
}
