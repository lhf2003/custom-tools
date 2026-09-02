import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { buildExtensions } from '@/modules/markdown/editor/extensions';
import '@/index.css';
import '@/modules/markdown/styles/editor.css';

// 与用户笔记同形态：minified 单行 JSON；另附多行 JSON 与 shell 作对照
const doc = [
  '# JSON 渲染验证',
  '',
  '```json',
  '{"records":[{"endDate":"","acceptTime":"2021-11-18 16:27:44","appNo":"0124061233794843","state":"BACKED","acptBusiName":"停气流程"}],"total":1,"pageSize":0,"pageNum":0,"pages":0}',
  '```',
  '',
  '```json',
  '{',
  '  "name": "nervis",',
  '  "total": 1',
  '}',
  '```',
  '',
  '```shell',
  "curl --header 'Content-Type: application/json' https://example.com",
  '```',
  '',
  '```jsonc',
  '{',
  '  // jsonc 注释与尾逗号',
  '  "name": "nervis",',
  '  "total": 1,',
  '}',
  '```',
  '',
  '```json',
  '{bad json',
  '```',
  '',
].join('\n');

const view = new EditorView({
  state: EditorState.create({
    doc,
    extensions: buildExtensions({ onDocChange: () => {} }),
  }),
  parent: document.getElementById('editor')!,
});

(window as unknown as { __cmView: EditorView }).__cmView = view;
