// 交互组件：Button / CheckBox / TextField / Slider / ChoicePicker / DateTimeInput
// 输入组件与数据模型双向绑定：写入即时更新本地模型，随 Button action 回传给模型。

import { useId, type ReactNode } from 'react';
import { evalChecks, toDisplayString } from '../functions';
import { RenderComponent, useA2ui } from '../render';
import type { A2uiAction, A2uiComponentDef } from '../types';

export const INPUT_TYPES = new Set([
  'Button', 'CheckBox', 'TextField', 'Slider', 'ChoicePicker', 'DateTimeInput',
]);

const INPUT_CLS =
  'w-full bg-white/5 border border-white/10 rounded-lg px-2.5 py-1.5 text-sm text-zinc-200 outline-none focus:border-indigo-500/50 placeholder-app-text-placeholder';

function Label({
  text,
  htmlFor,
  children,
}: {
  text: string;
  htmlFor?: string;
  children?: ReactNode;
}) {
  if (!text) return children ? <>{children}</> : null;
  return (
    // Label 是通用 wrapper：调用方通过 children 传入关联控件，并同步传入 htmlFor/id。
    // eslint-disable-next-line jsx-a11y/label-has-for
    <label htmlFor={htmlFor} className="block text-xs text-app-text-tertiary mb-1">
      {text}
      {children}
    </label>
  );
}

/** 校验失败提示（checks 或 validationRegexp） */
function useValidation(def: A2uiComponentDef) {
  const { evalCtx } = useA2ui();
  const checkResult = evalChecks(def.checks, evalCtx);
  if (!checkResult.ok) return checkResult;
  if (typeof def.validationRegexp === 'string' && def.value) {
    const v = toDisplayString(
      typeof def.value === 'object' && def.value !== null && 'path' in def.value
        ? evalCtx.resolvePath((def.value as { path: string }).path)
        : '',
    );
    if (v) {
      try {
        if (!new RegExp(def.validationRegexp).test(v)) {
          return { ok: false, message: '格式不正确' };
        }
      } catch {
        // 非法正则按不校验处理（模型产出错误不该拖垮渲染）
      }
    }
  }
  return { ok: true };
}

function Button({ def }: { def: A2uiComponentDef }) {
  const { dispatchAction, evalCtx, surface, resolve } = useA2ui();
  const child = typeof def.child === 'string' ? def.child : null;
  const variant = typeof def.variant === 'string' ? def.variant : 'default';
  const checkResult = evalChecks(def.checks, evalCtx);
  const action = def.action as A2uiAction | undefined;

  // 按钮文案（action 回传时引用，让模型知道用户点了哪个）
  const childDef = child ? surface.components[child] : undefined;
  const label =
    (childDef ? toDisplayString(resolve(childDef.text)) : '') ||
    (action?.event?.name ?? '按钮');

  const cls =
    variant === 'primary'
      ? // 系统规定 Primary 用 Action Blue（#2563eb 白字 5.17:1）；indigo 留给选中/品牌时刻
        'bg-blue-600 hover:bg-blue-700 text-white rounded-lg px-3 py-1.5'
      : variant === 'borderless'
        ? 'text-indigo-300 hover:text-indigo-200 px-1 py-0.5'
        : 'border border-white/15 bg-white/5 hover:bg-white/10 rounded-lg px-3 py-1.5';

  return (
    <button
      disabled={!checkResult.ok}
      title={checkResult.ok ? undefined : checkResult.message}
      onClick={() => {
        if (action?.event?.name) {
          dispatchAction(action.event.name, action.event.context, label);
        }
      }}
      className={`inline-flex items-center gap-1.5 text-sm transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${cls}`}
    >
      {child ? <RenderComponent id={child} /> : label}
    </button>
  );
}

function CheckBox({ def }: { def: A2uiComponentDef }) {
  const id = useId();
  const { resolve, resolvePath, setBoundValue } = useA2ui();
  const path = (def.value as { path?: string } | undefined)?.path;
  const label = toDisplayString(resolve(def.label));
  const checked = path ? Boolean(resolvePath(path)) : false;
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-sm text-zinc-300 cursor-pointer">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => path && setBoundValue(path, e.target.checked)}
        className="accent-indigo-500 w-3.5 h-3.5"
      />
      {label}
    </label>
  );
}

function TextField({ def }: { def: A2uiComponentDef }) {
  const id = useId();
  const { resolve, resolvePath, setBoundValue } = useA2ui();
  const path = (def.value as { path?: string } | undefined)?.path;
  const label = toDisplayString(resolve(def.label));
  const validation = useValidation(def);
  const multiline = def.variant === 'longText';
  const value = path ? toDisplayString(resolvePath(path)) : '';
  return (
    <div>
      <Label text={label} htmlFor={id}>
        {multiline ? (
          <textarea
            id={id}
            value={value}
            rows={3}
            onChange={(e) => path && setBoundValue(path, e.target.value)}
            className={`${INPUT_CLS} resize-none`}
          />
        ) : (
          <input
            id={id}
            type="text"
            value={value}
            onChange={(e) => path && setBoundValue(path, e.target.value)}
            className={INPUT_CLS}
          />
        )}
      </Label>
      {!validation.ok && <div className="text-xs text-red-400 mt-1">{validation.message}</div>}
    </div>
  );
}

function Slider({ def }: { def: A2uiComponentDef }) {
  const id = useId();
  const { resolve, resolvePath, setBoundValue } = useA2ui();
  const path = (def.value as { path?: string } | undefined)?.path;
  const label = toDisplayString(resolve(def.label));
  const min = typeof def.min === 'number' ? def.min : 0;
  const max = typeof def.max === 'number' ? def.max : 100;
  const raw = path ? resolvePath(path) : undefined;
  const value = typeof raw === 'number' ? raw : min;
  // 模型把非数字数据绑到 Slider 时降级为文本展示（坏滑块比文字更难看）
  if (raw !== undefined && typeof raw !== 'number') {
    return (
      <div>
        <Label text={label} />
        <div className="text-sm text-zinc-300">{toDisplayString(raw)}</div>
      </div>
    );
  }
  return (
    <div>
      <Label text={label ? `${label}：${value}` : String(value)} htmlFor={id}>
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          value={value}
          onChange={(e) => path && setBoundValue(path, Number(e.target.value))}
          className="w-full accent-indigo-500"
        />
      </Label>
    </div>
  );
}

interface ChoiceOption {
  label?: unknown;
  value?: unknown;
}

function ChoicePicker({ def }: { def: A2uiComponentDef }) {
  const { resolve, resolvePath, setBoundValue } = useA2ui();
  const path = (def.value as { path?: string } | undefined)?.path;
  const label = toDisplayString(resolve(def.label));
  const multiple = def.variant === 'multipleSelection';
  const options = (Array.isArray(def.options) ? def.options : []) as ChoiceOption[];
  const current = path ? resolvePath(path) : undefined;

  const isSelected = (opt: ChoiceOption): boolean => {
    const v = resolve(opt.value ?? opt.label);
    return multiple
      ? Array.isArray(current) && current.includes(v)
      : current === v;
  };

  const toggle = (opt: ChoiceOption) => {
    if (!path) return;
    const v = resolve(opt.value ?? opt.label);
    if (multiple) {
      const arr = Array.isArray(current) ? [...current] : [];
      const idx = arr.indexOf(v);
      const next = idx >= 0 ? arr.filter((_, i) => i !== idx) : [...arr, v];
      setBoundValue(path, next);
    } else {
      setBoundValue(path, v);
    }
  };

  return (
    <div>
      <Label text={label} />
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt, i) => {
          const selected = isSelected(opt);
          return (
            <button
              key={i}
              onClick={() => toggle(opt)}
              className={`text-xs px-2.5 py-1 rounded-lg border transition-colors cursor-pointer ${
                selected
                  ? 'bg-indigo-500/20 border-indigo-500/50 text-indigo-200'
                  : 'bg-white/5 border-white/10 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {toDisplayString(resolve(opt.label))}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DateTimeInput({ def }: { def: A2uiComponentDef }) {
  const id = useId();
  const { resolve, resolvePath, setBoundValue } = useA2ui();
  const path = (def.value as { path?: string } | undefined)?.path;
  const label = toDisplayString(resolve(def.label));
  const enableDate = def.enableDate !== false;
  const enableTime = def.enableTime === true;
  const type = enableDate && enableTime ? 'datetime-local' : enableTime && !enableDate ? 'time' : 'date';
  const value = path ? toDisplayString(resolvePath(path)) : '';
  return (
    <div>
      <Label text={label} htmlFor={id}>
        <input
          id={id}
          type={type}
          value={value}
          min={typeof def.min === 'string' ? def.min : undefined}
          max={typeof def.max === 'string' ? def.max : undefined}
          onChange={(e) => path && setBoundValue(path, e.target.value)}
          className={`${INPUT_CLS} [color-scheme:dark]`}
        />
      </Label>
    </div>
  );
}

export function InputComponent({ def }: { def: A2uiComponentDef }) {
  switch (def.component) {
    case 'Button':
      return <Button def={def} />;
    case 'CheckBox':
      return <CheckBox def={def} />;
    case 'TextField':
      return <TextField def={def} />;
    case 'Slider':
      return <Slider def={def} />;
    case 'ChoicePicker':
      return <ChoicePicker def={def} />;
    case 'DateTimeInput':
      return <DateTimeInput def={def} />;
    default:
      return null;
  }
}
