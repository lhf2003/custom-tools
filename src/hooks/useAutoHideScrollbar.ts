import { useEffect } from 'react';

/** 静止多久后隐藏滚动条（ms） */
const HIDE_DELAY_MS = 900;
/** <html> 上的滚动中标记类，CSS 据此淡入 thumb */
const SCROLLING_CLASS = 'is-scrolling';

/**
 * 全局滚动条自动隐藏：监听捕获阶段的 scroll（scroll 不冒泡，嵌套容器只能靠捕获），
 * 任意容器滚动时给 <html> 加 .is-scrolling，静止 HIDE_DELAY_MS 后移除。
 * 显隐与淡入淡出由 index.css 的 ::-webkit-scrollbar-thumb 规则承担。
 */
export function useAutoHideScrollbar(): void {
  useEffect(() => {
    const root = document.documentElement;
    let hideTimer: number | undefined;

    const handleScroll = () => {
      root.classList.add(SCROLLING_CLASS);
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => {
        root.classList.remove(SCROLLING_CLASS);
      }, HIDE_DELAY_MS);
    };

    document.addEventListener('scroll', handleScroll, true);
    return () => {
      document.removeEventListener('scroll', handleScroll, true);
      window.clearTimeout(hideTimer);
      root.classList.remove(SCROLLING_CLASS);
    };
  }, []);
}
