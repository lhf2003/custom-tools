import {
  parse as parseJsonc,
  format as formatJsonc,
  applyEdits,
  type ParseError,
} from 'jsonc-parser';

/**
 * 代码块就地格式化（JSON 家族专用）。
 * 引擎与 json_formatter 插件同为 jsonc-parser：容错注释/尾逗号，
 * format 只规整空白，不动内容（注释、键序、尾逗号全部保留）。
 */

export type JsonFormatResult =
  | { ok: true; text: string }
  | { ok: false; line: number; col: number };

/** 字符偏移 → 1 起始的行列（与 JsonFormatterView 的 banner 口径一致） */
function offsetToLineCol(text: string, offset: number): { line: number; col: number } {
  let line = 1;
  let col = 1;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) {
    if (text[i] === '\n') {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, col };
}

export function formatJsonCode(code: string): JsonFormatResult {
  const errors: ParseError[] = [];
  parseJsonc(code, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    return { ok: false, ...offsetToLineCol(code, errors[0].offset) };
  }
  const edits = formatJsonc(code, undefined, { tabSize: 2, insertSpaces: true });
  return { ok: true, text: applyEdits(code, edits) };
}
