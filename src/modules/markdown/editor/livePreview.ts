import type { EditorState, Extension, Range } from '@codemirror/state';
import { StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';

/**
 * 即时渲染装饰插件（v1 克制范围）：
 * - 任务列表 checkbox：光标不在标记上时替换为真实复选框，点击回写 [ ]/[x]
 * - 分隔线：光标不在该行时替换为通栏横线
 * - 引用块：行装饰（左侧竖条 + 纱层底），光标在内也保持（不抢编辑）
 * - 一/二级标题：行装饰底部分隔线（字号字重由 HighlightStyle 负责）
 * - 行内代码：chip 装饰（粉底色），反引号由 HighlightStyle 淡显
 * 链接/表格/图片保持源码态（明确的范围裁剪）。
 */

class TaskCheckboxWidget extends WidgetType {
  readonly checked: boolean;
  readonly from: number;
  readonly to: number;

  constructor(checked: boolean, from: number, to: number) {
    super();
    this.checked = checked;
    this.from = from;
    this.to = to;
  }

  override eq(other: TaskCheckboxWidget): boolean {
    return other.checked === this.checked && other.from === this.from && other.to === this.to;
  }

  override toDOM(view: EditorView): HTMLElement {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'cm-task-checkbox';
    checkbox.checked = this.checked;
    checkbox.setAttribute('aria-label', this.checked ? '标记为未完成' : '标记为完成');
    // 点击复选框不抢编辑器焦点，直接回写源文本
    checkbox.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    checkbox.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      view.dispatch({
        changes: { from: this.from, to: this.to, insert: this.checked ? '[ ]' : '[x]' },
        userEvent: 'input',
      });
    });
    return checkbox;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

class HorizontalRuleWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }

  override toDOM(): HTMLElement {
    const div = document.createElement('div');
    div.className = 'cm-hr-widget';
    return div;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

function buildLiveDecorations(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const doc = state.doc;
  const selectionIntersects = (from: number, to: number): boolean =>
    state.selection.ranges.some((r) => r.from <= to && r.to >= from);

  syntaxTree(state).iterate({
    enter(node) {
      switch (node.name) {
        case 'TaskMarker': {
          if (selectionIntersects(node.from, node.to)) return false;
          const checked = /[xX]/.test(state.sliceDoc(node.from, node.to));
          ranges.push(
            Decoration.replace({
              widget: new TaskCheckboxWidget(checked, node.from, node.to),
            }).range(node.from, node.to),
          );
          return false;
        }
        case 'HorizontalRule': {
          if (selectionIntersects(node.from, node.to)) return false;
          ranges.push(
            Decoration.replace({ widget: new HorizontalRuleWidget(), block: true }).range(
              node.from,
              node.to,
            ),
          );
          return false;
        }
        case 'Blockquote': {
          const firstLine = doc.lineAt(node.from);
          const lastLine = doc.lineAt(node.to);
          for (let n = firstLine.number; n <= lastLine.number; n++) {
            const line = doc.line(n);
            ranges.push(Decoration.line({ class: 'cm-quote-line' }).range(line.from));
          }
          return true; // 继续下降，引用内的行内格式照常装饰
        }
        case 'ATXHeading1':
        case 'ATXHeading2':
        case 'ATXHeading3':
        case 'ATXHeading4':
        case 'ATXHeading5':
        case 'ATXHeading6': {
          const line = doc.lineAt(node.from);
          // 一/二级标题行底部分隔线（字号字重由 HighlightStyle 负责）
          if (node.name === 'ATXHeading1' || node.name === 'ATXHeading2') {
            const level = node.name === 'ATXHeading1' ? '1' : '2';
            ranges.push(Decoration.line({ class: `cm-heading-line-${level}` }).range(line.from));
          }
          // 光标不在标题行时隐藏 # 标记（连同标记后一个空格），进入行即恢复源码
          if (!selectionIntersects(node.from, node.to)) {
            const mark = node.node.getChild('HeaderMark');
            if (mark) {
              ranges.push(
                Decoration.replace({}).range(mark.from, Math.min(mark.to + 1, node.to)),
              );
            }
          }
          return true;
        }
        case 'InlineCode': {
          ranges.push(Decoration.mark({ class: 'cm-inlinecode-chip' }).range(node.from, node.to));
          return false;
        }
        default:
          return true;
      }
    },
  });

  return Decoration.set(ranges, true);
}

/**
 * 即时渲染装饰 StateField（块级装饰禁止走 ViewPlugin，同 codeBlockPlugin）。
 */
const livePreviewField = StateField.define<DecorationSet>({
  create: (state) => buildLiveDecorations(state),
  update: (value, tr) => {
    if (
      tr.docChanged ||
      tr.selection ||
      syntaxTree(tr.state) !== syntaxTree(tr.startState)
    ) {
      return buildLiveDecorations(tr.state);
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export const livePreviewPlugin: Extension = livePreviewField;
