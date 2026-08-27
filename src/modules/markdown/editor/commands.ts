import { EditorSelection } from '@codemirror/state';
import type { ChangeSpec, EditorState, StateCommand } from '@codemirror/state';

/**
 * 工具栏/快捷键格式化命令。全部是 changeByRange 的纯文本变换，
 * 不依赖语法树，选区/光标两种形态都可用。
 */

/** 行内成对标记切换（**、*、~~、`）：无选区插一对光标居中，有选区包/解包 */
function toggleInlineMark(mark: string): StateCommand {
  return ({ state, dispatch }) => {
    const changes = state.changeByRange((range) => {
      if (range.empty) {
        return {
          changes: { from: range.from, insert: mark + mark },
          range: EditorSelection.cursor(range.from + mark.length),
        };
      }
      const { from, to } = range;
      const before = state.sliceDoc(Math.max(0, from - mark.length), from);
      const after = state.sliceDoc(to, Math.min(state.doc.length, to + mark.length));
      if (before === mark && after === mark) {
        return {
          changes: [
            { from: from - mark.length, to: from },
            { from: to, to: to + mark.length },
          ],
          range: EditorSelection.range(from - mark.length, to - mark.length),
        };
      }
      const selected = state.sliceDoc(from, to);
      if (
        selected.startsWith(mark) &&
        selected.endsWith(mark) &&
        selected.length > mark.length * 2
      ) {
        const inner = selected.slice(mark.length, selected.length - mark.length);
        return {
          changes: { from, to, insert: inner },
          range: EditorSelection.range(from, from + inner.length),
        };
      }
      return {
        changes: { from, to, insert: mark + selected + mark },
        range: EditorSelection.range(from + mark.length, to + mark.length),
      };
    });
    dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input' }));
    return true;
  };
}

export const toggleBold = toggleInlineMark('**');
export const toggleItalic = toggleInlineMark('*');
export const toggleStrikethrough = toggleInlineMark('~~');
export const toggleInlineCode = toggleInlineMark('`');

const RE_TASK = /^\s*[-*+]\s+\[[ xX]\]\s+/;
const RE_BULLET = /^\s*[-*+]\s+(?!\[[ xX]\]\s)/;
const RE_ORDERED = /^\s*\d+\.\s+/;
const RE_QUOTE = /^\s*>\s?/;

interface SelectedLine {
  from: number;
  text: string;
}

function collectSelectedLines(state: EditorState): SelectedLine[] {
  const seen = new Set<number>();
  const lines: SelectedLine[] = [];
  for (const range of state.selection.ranges) {
    const fromLine = state.doc.lineAt(range.from).number;
    const toLine = state.doc.lineAt(range.to).number;
    for (let n = fromLine; n <= toLine; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      const line = state.doc.line(n);
      lines.push({ from: line.from, text: line.text });
    }
  }
  return lines;
}

/** 行前缀切换：全部已带前缀则统一去除，否则先剥掉其它列表/引用前缀再加 */
function linePrefixCommand(
  prefixRe: RegExp,
  makePrefix: (index: number) => string,
  stripRes: RegExp[],
): StateCommand {
  return ({ state, dispatch }) => {
    const lines = collectSelectedLines(state);
    if (lines.length === 0) return false;
    const allHave = lines.every((l) => prefixRe.test(l.text));
    const changes: ChangeSpec[] = lines.map((l, i) => {
      if (allHave) {
        const prefixLen = l.text.match(prefixRe)?.[0].length ?? 0;
        return { from: l.from, to: l.from + prefixLen };
      }
      let stripped = l.text;
      for (const re of stripRes) stripped = stripped.replace(re, '');
      return { from: l.from, to: l.from + l.text.length, insert: makePrefix(i) + stripped };
    });
    dispatch(state.update({ changes, scrollIntoView: true, userEvent: 'input' }));
    return true;
  };
}

export const toggleBulletList = linePrefixCommand(RE_BULLET, () => '- ', [RE_TASK, RE_ORDERED]);
export const toggleOrderedList = linePrefixCommand(RE_ORDERED, (i) => `${i + 1}. `, [
  RE_TASK,
  RE_BULLET,
]);
export const toggleTaskList = linePrefixCommand(RE_TASK, () => '- [ ] ', [RE_BULLET, RE_ORDERED]);
export const toggleBlockquote = linePrefixCommand(RE_QUOTE, () => '> ', []);

const RE_HEADING = /^#{1,6}\s+/;

/** 标题级别切换：选中行全部已是该级别则还原为普通段落 */
export function setHeading(level: number): StateCommand {
  return ({ state, dispatch }) => {
    const lines = collectSelectedLines(state);
    if (lines.length === 0) return false;
    const target = `${'#'.repeat(level)} `;
    const allTarget = lines.every((l) => l.text.startsWith(target));
    const changes: ChangeSpec[] = lines.map((l) => {
      const stripped = l.text.replace(RE_HEADING, '');
      return {
        from: l.from,
        to: l.from + l.text.length,
        insert: allTarget ? stripped : target + stripped,
      };
    });
    dispatch(state.update({ changes, scrollIntoView: true, userEvent: 'input' }));
    return true;
  };
}

/** 代码块：有选区则包裹，无选区插入空块光标居中 */
export const insertCodeBlock: StateCommand = ({ state, dispatch }) => {
  const changes = state.changeByRange((range) => {
    const selected = state.sliceDoc(range.from, range.to);
    if (selected) {
      const insert = `\`\`\`\n${selected}\n\`\`\``;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.cursor(range.from + insert.length),
      };
    }
    const insert = '```\n\n```\n';
    return {
      changes: { from: range.from, insert },
      range: EditorSelection.cursor(range.from + 4),
    };
  });
  dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input' }));
  return true;
};

/** 链接：选区作链接文字，插入后选中 URL 占位便于直接输入 */
export const insertLink: StateCommand = ({ state, dispatch }) => {
  const range = state.selection.main;
  const selected = state.sliceDoc(range.from, range.to);
  const text = selected || '链接文字';
  const url = 'https://';
  const insert = `[${text}](${url})`;
  const urlStart = range.from + text.length + 3;
  dispatch(
    state.update({
      changes: { from: range.from, to: range.to, insert },
      selection: EditorSelection.range(urlStart, urlStart + url.length),
      scrollIntoView: true,
      userEvent: 'input',
    }),
  );
  return true;
};

const TABLE_SNIPPET = '\n| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n|  |  |  |\n';

/** 表格：在光标处插入 3x2 骨架，光标落到第一个表头单元格 */
export const insertTable: StateCommand = ({ state, dispatch }) => {
  const range = state.selection.main;
  dispatch(
    state.update({
      changes: { from: range.from, to: range.to, insert: TABLE_SNIPPET },
      selection: EditorSelection.cursor(range.from + 3),
      scrollIntoView: true,
      userEvent: 'input',
    }),
  );
  return true;
};

/** 分隔线 */
export const insertHorizontalRule: StateCommand = ({ state, dispatch }) => {
  const range = state.selection.main;
  const insert = '\n\n---\n\n';
  dispatch(
    state.update({
      changes: { from: range.from, to: range.to, insert },
      selection: EditorSelection.cursor(range.from + insert.length),
      scrollIntoView: true,
      userEvent: 'input',
    }),
  );
  return true;
};
