/**
 * @time 日期转换插件（二期验收用例 A：手写验市场链路）。
 * 功能：时间戳（秒/毫秒）↔ 日期互转；@time 打开时自动带入参数；
 * 设置项：日期格式、时间戳精度（主应用 schema 渲染，经 ctx.invoke 读写）。
 */
type Ctx = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>; getPayload: () => unknown };

/** 与 plugin.json 逐字段一致（协议要求） */
const MANIFEST = {
  id: 'time-converter',
  name: '日期转换',
  version: '0.1.0',
  author: 'LHF',
  description: '时间戳与日期互转，支持秒/毫秒精度',
  aliases: ['time', 'date', 'timestamp', '时间', '日期'],
  main: 'plugin.js',
  runtime: 'frontend',
  permissions: [],
  triggers: [{ keyword: '@time', argHint: '时间戳或日期' }],
  shortcuts: [{ id: 'open', key: 'Ctrl+Shift+T', label: '打开日期转换' }],
  settings: [
    { key: 'format', label: '日期格式', type: 'select', options: ['YYYY-MM-DD HH:mm:ss', 'YYYY/MM/DD HH:mm', 'MM-DD HH:mm'], default: 'YYYY-MM-DD HH:mm:ss' },
    { key: 'ms', label: '时间戳精度', type: 'select', options: ['秒 (10位)', '毫秒 (13位)'], default: '秒 (10位)' },
  ],
};

const FORMATS: Record<string, { ymd: string; hm: string }> = {
  'YYYY-MM-DD HH:mm:ss': { ymd: '-', hm: ':' },
  'YYYY/MM/DD HH:mm': { ymd: '/', hm: ':' },
  'MM-DD HH:mm': { ymd: '-', hm: ':' },
};

/** 输出格式模板：2026-08-06 14:30:45 */
function formatDate(date: Date, format: string): string {
  const parts = FORMATS[format] ?? FORMATS['YYYY-MM-DD HH:mm:ss'];
  const p = (n: number) => String(n).padStart(2, '0');
  const ymd = format.startsWith('YYYY')
    ? `${date.getFullYear()}${parts.ymd}${p(date.getMonth() + 1)}${parts.ymd}${p(date.getDate())}`
    : `${p(date.getMonth() + 1)}${parts.ymd}${p(date.getDate())}`;
  const hms = parts.hm === ':' ? `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}` : `${p(date.getHours())}:${p(date.getMinutes())}`;
  return `${ymd} ${hms}`;
}

/** 解析输入：纯数字 → 秒/毫秒时间戳；否则日期字符串 → Date（失败返回 null） */
function parseInput(input: string, preferMs: boolean): { date: Date; isMs: boolean } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^\d{9,13}$/.test(trimmed)) {
    const num = Number(trimmed);
    const isMs = trimmed.length >= 12;
    return { date: new Date(isMs ? num : num * 1000), isMs };
  }
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return null;
  return { date, isMs: preferMs };
}

function renderView(container: HTMLElement, ctx: Ctx): void {
  const pluginId = MANIFEST.id;
  const settingsKey = (key: string) => `plugins.${pluginId}.${key}`;
  let format = 'YYYY-MM-DD HH:mm:ss';
  let preferMs = false;

  // 读取设置（失败用默认值；无 Node 环境，纯前端逻辑）
  const loadSettings = async (): Promise<void> => {
    const storedFormat = await ctx.invoke('get_setting', { key: settingsKey('format') });
    const storedMs = await ctx.invoke('get_setting', { key: settingsKey('ms') });
    if (typeof storedFormat === 'string' && storedFormat) format = storedFormat;
    preferMs = storedMs === '毫秒 (13位)';
  };

  container.innerHTML = `
    <div class="tc-root">
      <input class="tc-input" type="text" placeholder="输入时间戳或日期，如 1786000000 或 2026-08-06 14:30" spellcheck="false" />
      <div class="tc-result">
        <div class="tc-row"><span class="tc-label">日期</span><span class="tc-value tc-date"></span></div>
        <div class="tc-row"><span class="tc-label">时间戳</span><span class="tc-value tc-ts"></span></div>
        <div class="tc-row"><span class="tc-label">现在</span><span class="tc-value tc-now"></span></div>
      </div>
      <style>
        .tc-root { display: flex; flex-direction: column; gap: 12px; padding: 16px; font-size: 12px; color: var(--app-text-primary, #e4e4e7); }
        .tc-input {
          width: 100%; padding: 8px 12px; border-radius: 8px; font-size: 12px;
          background: var(--app-bg-tertiary, rgba(255,255,255,0.04));
          border: 1px solid var(--app-border-default, rgba(255,255,255,0.1));
          color: var(--app-text-primary, #e4e4e7); outline: none; box-sizing: border-box;
        }
        .tc-input:focus { border-color: var(--app-status-info, #3b82f6); }
        .tc-input::placeholder { color: var(--app-text-placeholder, rgba(228,228,231,0.4)); }
        .tc-result { display: flex; flex-direction: column; gap: 6px; }
        .tc-row { display: flex; align-items: center; gap: 10px; padding: 6px 12px; border-radius: 8px; background: rgba(255,255,255,0.03); }
        .tc-label { width: 48px; flex-shrink: 0; font-size: 12px; color: var(--app-text-tertiary, rgba(228,228,231,0.5)); }
        .tc-value { font-family: 'Fira Code', Consolas, monospace; font-size: 12px; word-break: break-all; }
      </style>
    </div>
  `;

  const input = container.querySelector<HTMLInputElement>('.tc-input')!;
  const dateEl = container.querySelector<HTMLElement>('.tc-date')!;
  const tsEl = container.querySelector<HTMLElement>('.tc-ts')!;
  const nowEl = container.querySelector<HTMLElement>('.tc-now')!;

  const refresh = (): void => {
    const parsed = parseInput(input.value, preferMs);
    if (parsed) {
      dateEl.textContent = formatDate(parsed.date, format);
      tsEl.textContent = parsed.isMs
        ? String(parsed.date.getTime())
        : String(Math.floor(parsed.date.getTime() / 1000));
      if (!parsed.isMs) tsEl.textContent += '（秒）';
    } else {
      dateEl.textContent = '—';
      tsEl.textContent = input.value.trim() ? '无法解析（支持纯数字时间戳或标准日期字符串）' : '—';
    }
    nowEl.textContent = `${formatDate(new Date(), format)} / ${Math.floor(Date.now() / 1000)}`;
  };

  input.addEventListener('input', refresh);
  window.setInterval(refresh, 1000);
  void loadSettings().then(refresh);

  // @time 打开时带入参数（payload = trigger 剩余文本）
  const payload = ctx.getPayload();
  if (typeof payload === 'string' && payload.trim()) {
    input.value = payload.trim();
    refresh();
    input.focus();
    input.select();
  } else {
    input.focus();
  }
}

window.flowhubPlugin = {
  manifest: MANIFEST,
  view: { mount: renderView },
};
