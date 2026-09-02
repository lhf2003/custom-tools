import type { Extension } from '@codemirror/state';
import { EditorState } from '@codemirror/state';
import { EditorView, drawSelection, keymap, placeholder as cmPlaceholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { indentUnit, LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { appHighlightStyle } from './theme';
import { codeBlockPlugin } from './codeBlockPlugin';
import { livePreviewPlugin } from './livePreview';
import {
  insertLink,
  toggleBold,
  toggleInlineCode,
  toggleItalic,
  toggleStrikethrough,
} from './commands';

// language-data 的 JSON 条目只认 json/json5，不认 VSCode 习惯写法 jsonc。
// 补一条映射到同一 lang-json 懒加载 chunk（Vite 会把两条 import 合并为同一异步块）。
const jsoncLanguage = LanguageDescription.of({
  name: 'JSONC',
  alias: ['jsonc'],
  load: () => import('@codemirror/lang-json').then((m) => m.json()),
});

interface BuildExtensionsOptions {
  placeholder?: string;
  onDocChange: (text: string) => void;
}

export function buildExtensions({ placeholder, onDocChange }: BuildExtensionsOptions): Extension {
  return [
    history(),
    drawSelection(),
    EditorState.allowMultipleSelections.of(true),
    indentUnit.of('    '),
    // codeLanguages：fence 语言名 → 懒加载子语言包，代码块内嵌高亮
    markdown({ base: markdownLanguage, codeLanguages: [...languages, jsoncLanguage] }),
    syntaxHighlighting(appHighlightStyle),
    search({ top: true }),
    highlightSelectionMatches(),
    EditorView.lineWrapping,
    codeBlockPlugin,
    livePreviewPlugin,
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onDocChange(update.state.doc.toString());
    }),
    keymap.of([
      { key: 'Mod-b', run: toggleBold },
      { key: 'Mod-i', run: toggleItalic },
      { key: 'Mod-Shift-x', run: toggleStrikethrough },
      { key: 'Mod-e', run: toggleInlineCode },
      { key: 'Mod-k', run: insertLink },
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      indentWithTab,
    ]),
    placeholder ? cmPlaceholder(placeholder) : [],
  ];
}
