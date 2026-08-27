import { HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

/**
 * 全局语法高亮样式。
 * 颜色全部引用 editor.css 里定义的 --cm-* CSS 变量（paint 时解析），
 * 因此深/浅主题切换零 JS 参与，随 data-theme 自动翻转。
 *
 * 注意规则顺序：markdown 结构规则在前，代码 token 规则在后。
 * HighlightStyle 同优先级时后者覆盖前者，保证代码块内嵌语言的
 * keyword/string 等颜色盖过 CodeText 的 monospace 基色。
 */
export const appHighlightStyle = HighlightStyle.define([
  // ---- Markdown 结构 ----
  { tag: t.heading1, color: 'var(--cm-text-primary)', fontWeight: '600', fontSize: '26px' },
  { tag: t.heading2, color: 'var(--cm-text-primary)', fontWeight: '600', fontSize: '22px' },
  { tag: t.heading3, color: 'var(--cm-text-primary)', fontWeight: '600', fontSize: '18px' },
  { tag: t.heading4, color: 'var(--cm-text-primary)', fontWeight: '600', fontSize: '16px' },
  { tag: [t.heading5, t.heading6], color: 'var(--cm-text-primary)', fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--cm-accent-blue-light)' },
  { tag: t.url, color: 'var(--cm-text-tertiary)' },
  { tag: t.quote, color: 'var(--cm-text-tertiary)' },
  // CodeText / InlineCode 的基色；行内代码的粉色 chip 由 livePreview 装饰类覆盖
  { tag: t.monospace, color: 'var(--cm-text-primary)' },
  // 所有标记符号（# * > ` 等）淡显
  { tag: t.processingInstruction, color: 'var(--cm-text-disabled)' },
  // CodeInfo（fence 后的语言名）与 LinkLabel
  { tag: t.labelName, color: 'var(--cm-accent-cyan)' },
  { tag: t.contentSeparator, color: 'var(--cm-border-emphasis)' },
  { tag: t.escape, color: 'var(--cm-accent-amber)' },

  // ---- 代码 token（嵌套语言高亮）----
  { tag: [t.comment, t.blockComment, t.lineComment, t.docComment], color: 'var(--cm-hl-comment)', fontStyle: 'italic' },
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword], color: 'var(--cm-hl-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character, t.docString], color: 'var(--cm-hl-string)' },
  { tag: [t.number, t.integer, t.float, t.bool, t.null, t.atom, t.unit], color: 'var(--cm-hl-number)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName, t.standard(t.variableName)], color: 'var(--cm-hl-function)' },
  { tag: [t.className, t.typeName, t.namespace, t.typeOperator], color: 'var(--cm-hl-type)' },
  { tag: [t.attributeName], color: 'var(--cm-hl-attr)' },
  { tag: [t.tagName], color: 'var(--cm-hl-tag)' },
  { tag: [t.variableName, t.propertyName], color: 'var(--cm-hl-variable)' },
  { tag: [t.operator], color: 'var(--cm-hl-operator)' },
  { tag: [t.punctuation, t.separator, t.squareBracket, t.paren, t.brace, t.angleBracket], color: 'var(--cm-hl-punctuation)' },
  { tag: [t.meta, t.annotation, t.documentMeta], color: 'var(--cm-hl-punctuation)' },
  { tag: [t.heading], color: 'var(--cm-text-primary)', fontWeight: '600' },
  { tag: [t.invalid], color: 'var(--cm-accent-red)' },
]);
