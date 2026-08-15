import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MousePointerClick } from 'lucide-react';
import { parseActionMessage } from './a2ui/action';
import { UserRichBubble } from './RichMessageView';
import type { ChatMessage } from './sessionUtils';

/** 把助手文本切成正文段与内心独白段（<aside>…</aside>）。
 *  未闭合的 <aside> 按「到本行末尾」处理——流式途中标记尚未到达时样式不断裂。
 *  代码中的 <aside> 是字面量，跳过不解析——模型在示例代码里写 <aside> 时
 *  正文不能被劫持成灰色斜体：块级围栏（行首 ```）整行跳过；
 *  行内代码按 CommonMark 反引号 run 配对（双反引号跨度内的单反引号是字面量）。 */
function splitAsides(text: string): { aside: boolean; text: string }[] {
  const parts: { aside: boolean; text: string }[] = [];
  let current: { aside: boolean; text: string } | null = null;
  let inCode = false;
  const flush = () => {
    if (current && current.text.length > 0) parts.push(current);
    current = null;
  };
  const emit = (chunk: string, aside: boolean) => {
    if (chunk.length === 0) return;
    if (!current) {
      current = { aside, text: chunk };
      return;
    }
    if (current.aside === aside) {
      current.text += chunk;
      return;
    }
    flush();
    current = { aside, text: chunk };
  };
  for (const rawLine of text.split('\n')) {
    if (/^\s*```/.test(rawLine)) {
      inCode = !inCode;
      emit(rawLine + '\n', false);
      continue;
    }
    if (inCode) {
      emit(rawLine + '\n', false);
      continue;
    }
    let rest = rawLine;
    let isAside = false;
    // 行内代码开启所用的反引号数；0 = 不在行内代码中。行尾强制复位：
    // 模型输出的行内代码几乎不跨行，孤反引号不该把后续所有 <aside> 吞成明文
    let inlineDelim = 0;
    while (rest.length > 0) {
      if (rest[0] === '`') {
        const run = /^`+/.exec(rest)?.[0] ?? '';
        if (inlineDelim === 0) inlineDelim = run.length;
        else if (run.length === inlineDelim) inlineDelim = 0;
        emit(run, isAside);
        rest = rest.slice(run.length);
        continue;
      }
      if (inlineDelim > 0) {
        // 行内代码内：整体跳过直到下一个反引号 run（其中的 <aside> 是字面量）
        const idx = rest.indexOf('`');
        if (idx === -1) {
          emit(rest, isAside);
          break;
        }
        emit(rest.slice(0, idx), isAside);
        rest = rest.slice(idx);
        continue;
      }
      // 反引号与标签谁更靠前谁先处理：行内代码开启符在标签前时
      // 不能被 indexOf(tag) 直接跳过，否则跨度内的 <aside> 又被劫持
      const tickIdx = rest.indexOf('`');
      const tag = isAside ? '</aside>' : '<aside>';
      const tagIdx = rest.indexOf(tag);
      if (tagIdx === -1) {
        emit(rest, isAside);
        break;
      }
      if (tickIdx !== -1 && tickIdx < tagIdx) {
        emit(rest.slice(0, tickIdx), isAside);
        rest = rest.slice(tickIdx);
        continue;
      }
      if (tagIdx > 0) emit(rest.slice(0, tagIdx), isAside);
      rest = rest.slice(tagIdx + tag.length);
      isAside = !isAside;
    }
    emit('\n', isAside);
  }
  flush();
  return parts;
}

/** 助手消息渲染：正文走 Markdown，独白段（心声）渲染为灰小斜体。
 *  memo：流式期间只有流式气泡的 text 变化，历史气泡跳过 ReactMarkdown 全量重 parse */
export const AssistantContent = memo(function AssistantContent({ text }: { text: string }) {
  return (
    <>
      {splitAsides(text).map((p, i) =>
        p.aside ? (
          <div
            key={i}
            className="my-1.5 pl-3 text-white/45 text-xs italic whitespace-pre-wrap"
          >
            {p.text}
          </div>
        ) : (
          <ReactMarkdown key={i} remarkPlugins={[remarkGfm]}>
            {p.text}
          </ReactMarkdown>
        ),
      )}
    </>
  );
});

/** 用户消息气泡：界面操作回传渲染为紧凑胶囊（协议 JSON 不上屏，落库原文不变），
 *  rich 附件消息走图片网格 + 文件卡片，其余为普通气泡；
 *  均开放文本选择（根容器 select-none，气泡单独放开） */
export function UserMessageBubble({
  content,
  contentType,
}: {
  content: string;
  contentType?: ChatMessage['contentType'];
}) {
  const action = parseActionMessage(content);
  if (action) {
    return (
      <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-zinc-700/40 border border-zinc-600/40 text-xs text-zinc-400 select-text">
        <MousePointerClick className="w-3 h-3 shrink-0" />
        点击了「{action.label}」
      </div>
    );
  }
  if (contentType === 'rich') {
    return <UserRichBubble content={content} />;
  }
  return (
    <div className="max-w-[80%] px-3 py-2 rounded-xl bg-white/10 text-sm text-zinc-100 break-words select-text">
      {content}
    </div>
  );
}
