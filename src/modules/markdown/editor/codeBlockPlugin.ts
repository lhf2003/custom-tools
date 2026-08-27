import type { EditorState, Extension, Range } from '@codemirror/state';
import { EditorSelection, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';

/**
 * 代码块即时渲染插件。
 * - 光标（任一 selection range）与块相交：fence 行显示源码，全块仅加行装饰，
 *   Enter/Tab/IME 全部是 CM6 原生行为，零拦截。
 * - 光标在块外：开 fence 行内容【内联】替换为 header 行（语言 chip + 复制按钮），
 *   闭 fence 行内容内联隐藏（空行封底），块体行加等宽字体 + scrim 背景。
 *
 * 关键设计：折叠/展开两态【几何完全一致】——fence 行始终占位同一行高，
 * 只是内容在「header 行」与「源码行」之间切换。若用块级 widget 替换 fence 行
 * （两态高度不同），点击手势 mousedown 定位、mouseup 落定的间隙布局会跳一行，
 * 导致「两个代码块之间的文字行点不准」——内联替换是唯一治本方案。
 * 块体语法高亮由 lang-markdown 的 codeLanguages 嵌套解析直接提供。
 */

const COPY_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const CHECK_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

class CodeBlockHeaderWidget extends WidgetType {
  readonly lang: string;
  readonly code: string;
  /** 源码中语言名的末尾位置（点击 header 时光标投递点，便于直接改语言） */
  readonly codeInfoEnd: number;

  constructor(lang: string, code: string, codeInfoEnd: number) {
    super();
    this.lang = lang;
    this.code = code;
    this.codeInfoEnd = codeInfoEnd;
  }

  override eq(other: CodeBlockHeaderWidget): boolean {
    return (
      other.lang === this.lang &&
      other.code === this.code &&
      other.codeInfoEnd === this.codeInfoEnd
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'cm-codeblock-header';
    // 点击 header（除复制按钮外）：展开块并把光标放到语言名末尾，直接可改
    bar.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('.cm-codeblock-copy')) return;
      e.preventDefault();
      e.stopPropagation();
      view.dispatch({ selection: EditorSelection.cursor(this.codeInfoEnd) });
      view.focus();
    });

    const langEl = document.createElement('span');
    langEl.className = 'cm-codeblock-lang';
    langEl.textContent = this.lang || 'text';
    langEl.title = '点击修改语言';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cm-codeblock-copy';
    btn.title = '复制代码';
    btn.setAttribute('aria-label', '复制代码');
    btn.innerHTML = COPY_ICON;
    // mousedown 拦截：复制行为绝不把焦点/光标带进编辑器块内
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      navigator.clipboard
        .writeText(this.code)
        .then(() => {
          btn.classList.add('is-copied');
          btn.innerHTML = CHECK_ICON;
          setTimeout(() => {
            btn.classList.remove('is-copied');
            btn.innerHTML = COPY_ICON;
          }, 1200);
        })
        .catch((err: unknown) => {
          console.error('[CodeBlock] 复制失败:', err);
        });
    });

    bar.appendChild(langEl);
    bar.appendChild(btn);
    return bar;
  }

  // 编辑器完全忽略落在 header 上的事件（不移动光标、不展开块）
  override ignoreEvent(): boolean {
    return true;
  }
}

function buildCodeBlockDecorations(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const doc = state.doc;
  const selectionIntersects = (from: number, to: number): boolean =>
    state.selection.ranges.some((r) => r.from <= to && r.to >= from);

  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'FencedCode') return true;

      const { from, to } = node;
      const openLine = doc.lineAt(from);
      const closeLine = doc.lineAt(to);
      // 闭合判定：少于两个 CodeMark 说明 fence 未闭合（文档尾部的 ```）
      const closed = node.node.getChildren('CodeMark').length >= 2;
      const singleLine = openLine.number === closeLine.number;
      // 块体行区间（仅闭合且跨行时才有意义）
      const bodyStart = openLine.number + 1;
      const bodyEnd = closed ? closeLine.number - 1 : closeLine.number;
      const active = selectionIntersects(from, to);

      // 展开态：光标在块内或单行块，fence 行显示源码，全块统一行装饰
      if (active || singleLine) {
        for (let n = openLine.number; n <= closeLine.number; n++) {
          const line = doc.line(n);
          let cls = 'cm-codeblock-line cm-codeblock-source';
          if (n === openLine.number) cls += ' cm-codeblock-first';
          if (n === closeLine.number) cls += ' cm-codeblock-last';
          ranges.push(Decoration.line({ class: cls }).range(line.from));
        }
        return false;
      }

      // 折叠态（与展开态几何一致：fence 行始终占位同一行高，仅内容切换）
      const codeInfo = node.node.getChild('CodeInfo');
      const lang = codeInfo ? state.sliceDoc(codeInfo.from, codeInfo.to).trim() : '';
      // 无语言名时光标落到开 fence 标记之后，可直接输入语言
      const codeInfoEnd = codeInfo ? codeInfo.to : (node.node.getChild('CodeMark')?.to ?? openLine.to);
      const codeTo = closed ? closeLine.from - 1 : to;
      const code = state.sliceDoc(Math.min(openLine.to + 1, codeTo), Math.max(codeTo, openLine.to + 1));

      // 开 fence 行：内容内联替换为 header 行（行高不变，卡片顶盖由行装饰承担）
      ranges.push(
        Decoration.replace({ widget: new CodeBlockHeaderWidget(lang, code, codeInfoEnd) }).range(
          openLine.from,
          openLine.to,
        ),
      );
      ranges.push(
        Decoration.line({ class: 'cm-codeblock-line cm-codeblock-first' }).range(openLine.from),
      );

      // 块体行
      for (let n = bodyStart; n <= bodyEnd; n++) {
        const line = doc.line(n);
        let cls = 'cm-codeblock-line';
        if (!closed && n === bodyEnd) cls += ' cm-codeblock-last';
        ranges.push(Decoration.line({ class: cls }).range(line.from));
      }

      // 闭 fence 行：内容内联隐藏，空行封底（行高不变）
      if (closed) {
        ranges.push(Decoration.replace({}).range(closeLine.from, closeLine.to));
        ranges.push(
          Decoration.line({ class: 'cm-codeblock-line cm-codeblock-last' }).range(closeLine.from),
        );
      }
      return false;
    },
  });

  // sort: true —— RangeSetBuilder 要求有序输入，统一交给 Decoration.set 排序
  return Decoration.set(ranges, true);
}

/**
 * 代码块装饰 StateField。
 * 必须用 StateField 而非 ViewPlugin：CM6 禁止 ViewPlugin 提供块级装饰
 * （block widget / block replace），会抛
 * "Block decorations may not be specified via plugins"。
 * 后台解析推进、选区变化、文档变化都会以 transaction 形式经过 update。
 */
const codeBlockField = StateField.define<DecorationSet>({
  create: (state) => buildCodeBlockDecorations(state),
  update: (value, tr) => {
    if (
      tr.docChanged ||
      tr.selection ||
      syntaxTree(tr.state) !== syntaxTree(tr.startState)
    ) {
      return buildCodeBlockDecorations(tr.state);
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export const codeBlockPlugin: Extension = codeBlockField;
