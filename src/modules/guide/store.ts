import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { GUIDE_TIPS } from './registry';
import type { GuideTipDef } from './types';

/** settings 表 KV 键 */
const KEY_ONBOARDING_DONE = 'guide.onboarding_completed';
const KEY_SEEN_TIPS = 'guide.seen_tips';
const KEY_LAST_VERSION = 'guide.last_version';

interface GuideState {
  /** init 完成（首启判定未就绪前，App 只渲染主题底色，避免启动器闪切欢迎页） */
  ready: boolean;
  /** 欢迎页是否已完成（含跳过） */
  welcomeDone: boolean;
  /** 当前待展示气泡，同时至多一条 */
  activeTip: GuideTipDef | null;
  /** 已读提示集合（id → true），内存镜像 guide.seen_tips */
  seenTips: Record<string, true>;

  /** 冷启动一次性初始化：读标记、迁移老用户、登记版本 */
  init: () => Promise<void>;
  /** 欢迎页完成（开始使用 / Esc 跳过同路径） */
  completeWelcome: () => Promise<void>;
  /** 设置入口「重新查看欢迎页」 */
  replayWelcome: () => void;
  /** 视图切换时触发该视图的首条未读气泡；跨视图残留气泡静默清除（不标已读） */
  maybeShowTipFor: (view: string) => void;
  /** 关闭当前气泡；markSeen=true 写入已读集合 */
  dismissActiveTip: (markSeen: boolean) => Promise<void>;
  /** 设置入口「重置功能提示」，返回清除的条数 */
  resetTips: () => Promise<number>;
}

const getSetting = (key: string): Promise<string | null> =>
  invoke<string | null>('get_setting', { key });

const setSetting = (key: string, value: string): Promise<void> =>
  invoke('set_setting', { key, value });

function parseSeen(raw: string | null): Record<string, true> {
  if (!raw) return {};
  try {
    const ids: unknown = JSON.parse(raw);
    if (!Array.isArray(ids)) return {};
    const seen: Record<string, true> = {};
    for (const id of ids) {
      if (typeof id === 'string') seen[id] = true;
    }
    return seen;
  } catch {
    return {};
  }
}

export const useGuideStore = create<GuideState>((set, get) => ({
  ready: false,
  welcomeDone: true,
  activeTip: null,
  seenTips: {},

  init: async () => {
    try {
      const currentVersion = await getVersion();
      const [onboardingRaw, seenRaw, lastVersion] = await Promise.all([
        getSetting(KEY_ONBOARDING_DONE),
        getSetting(KEY_SEEN_TIPS),
        getSetting(KEY_LAST_VERSION),
      ]);

      let seenTips = parseSeen(seenRaw);
      const welcomeDone = onboardingRaw === '1';

      // 老用户迁移：引导系统上线前就在用（有完成标记但无版本记录）→
      // 存量提示全部静默已读，不打扰已在用的人；之后的新版本提示正常触发
      if (welcomeDone && lastVersion === null) {
        seenTips = { ...seenTips };
        for (const tip of GUIDE_TIPS) seenTips[tip.id] = true;
        await setSetting(KEY_SEEN_TIPS, JSON.stringify(Object.keys(seenTips)));
      }

      // 版本登记只在变化时写；lastVersion 预留给将来「版本区间」判定
      if (lastVersion !== currentVersion) {
        await setSetting(KEY_LAST_VERSION, currentVersion);
      }

      set({ ready: true, welcomeDone, seenTips });
    } catch (err) {
      // 存储不可用时宁可不弹引导，也不阻塞主界面；下次启动自然重试
      console.error('[guide] init failed, guide disabled this session:', err);
      set({ ready: true, welcomeDone: true });
    }
  },

  completeWelcome: async () => {
    set({ welcomeDone: true });
    try {
      await setSetting(KEY_ONBOARDING_DONE, '1');
    } catch (err) {
      console.error('[guide] failed to persist onboarding flag:', err);
    }
  },

  replayWelcome: () => {
    set({ welcomeDone: false, activeTip: null });
  },

  maybeShowTipFor: (view: string) => {
    const { ready, welcomeDone, activeTip, seenTips } = get();
    if (!ready || !welcomeDone) return;
    if (activeTip) {
      // 视图切走而气泡未关：静默清除，不写已读（用户没看到内容）
      if (activeTip.view !== view) set({ activeTip: null });
      return;
    }
    const tip = GUIDE_TIPS.find((t) => t.view === view && !seenTips[t.id]);
    if (tip) set({ activeTip: tip });
  },

  dismissActiveTip: async (markSeen: boolean) => {
    const { activeTip, seenTips } = get();
    if (!activeTip) return;
    set({ activeTip: null });
    if (!markSeen) return;

    const next = { ...seenTips, [activeTip.id]: true as const };
    set({ seenTips: next });
    try {
      await setSetting(KEY_SEEN_TIPS, JSON.stringify(Object.keys(next)));
    } catch (err) {
      console.error('[guide] failed to persist seen tip:', err);
    }
  },

  resetTips: async () => {
    const count = Object.keys(get().seenTips).length;
    set({ seenTips: {}, activeTip: null });
    try {
      await setSetting(KEY_SEEN_TIPS, '[]');
    } catch (err) {
      console.error('[guide] failed to persist tips reset:', err);
    }
    return count;
  },
}));
