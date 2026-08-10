import { useEffect } from 'react';

/** 静止多久后隐藏滚动条（ms） */
const HIDE_DELAY_MS = 900;
/** 滚动源容器上的滚动中标记类，CSS 据此淡入该容器自己的 thumb */
const SCROLLING_CLASS = 'is-scrolling';

/**
 * 滚动条自动隐藏（按容器隔离）：监听捕获阶段的 scroll（scroll 不冒泡，嵌套容器只能靠捕获），
 * 给产生滚动的容器自身加 .is-scrolling（页面级滚动 target 是 Document，回退到 <html>），
 * 静止 HIDE_DELAY_MS 后移除。各容器显隐互不干扰——滚动左侧目录不会点亮右侧内容区的滚动条。
 * 显隐与淡入淡出由 index.css / vditor.css 的 ::-webkit-scrollbar-thumb 规则承担。
 */
export function useAutoHideScrollbar(): void {
  useEffect(() => {
    // 每个滚动容器各自的隐藏定时器（Map 而非 WeakMap：cleanup 需要遍历）
    const hideTimers = new Map<Element, number>();

    const handleScroll = (e: Event) => {
      // 页面级滚动（html/body 溢出）target 是 Document，滚动条属于 <html> 自身
      const el =
        e.target instanceof Document ? document.documentElement : (e.target as Element);
      if (!(el instanceof Element)) return;
      el.classList.add(SCROLLING_CLASS);
      window.clearTimeout(hideTimers.get(el));
      hideTimers.set(
        el,
        window.setTimeout(() => {
          el.classList.remove(SCROLLING_CLASS);
          hideTimers.delete(el);
        }, HIDE_DELAY_MS)
      );
    };

    document.addEventListener('scroll', handleScroll, true);
    return () => {
      document.removeEventListener('scroll', handleScroll, true);
      hideTimers.forEach((timer, el) => {
        window.clearTimeout(timer);
        el.classList.remove(SCROLLING_CLASS);
      });
      hideTimers.clear();
    };
  }, []);
}
