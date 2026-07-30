import { useState, useEffect, useRef } from 'react';
import { ChevronDown } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectGroup {
  /** 分组标题（如提供商名）；为空则选项直出不带分组头 */
  label?: string;
  options: SelectOption[];
}

interface CustomSelectProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  icon?: React.ReactNode;
  /** 平铺选项（与 groups 二选一；options 优先） */
  options?: SelectOption[];
  /** 分组选项（如模型按提供商分组） */
  groups?: SelectGroup[];
  /** 选项超过 8 个自动开启搜索（如百炼等模型大户），可显式覆盖 */
  searchable?: boolean;
  /** 下拉菜单附加类名，默认与触发按钮同宽（w-full） */
  menuClassName?: string;
}

/**
 * 设置页通用下拉框：键盘全可达（↑↓/Enter/Esc）、选项多时自动带搜索、
 * 空间不足自动上翻。交互色用 Action Blue（DESIGN.md 操作色），选中态文字用 Indigo Light。
 */
export function CustomSelect({
  value,
  onChange,
  placeholder = '请选择',
  disabled = false,
  className = '',
  icon,
  options,
  groups,
  searchable,
  menuClassName = 'w-full',
}: CustomSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [searchQuery, setSearchQuery] = useState('');
  const [dropdownPosition, setDropdownPosition] = useState<'top' | 'bottom'>('bottom');
  const [dropdownMaxHeight, setDropdownMaxHeight] = useState(192);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // 统一成分组结构，渲染与键盘导航共用一份扁平淡出索引
  const normalizedGroups: SelectGroup[] =
    options !== undefined ? [{ options }] : (groups ?? []);
  const allOptions = normalizedGroups.flatMap((g) => g.options);
  const totalCount = allOptions.length;
  const isSearchable = searchable ?? totalCount > 8;
  const query = searchQuery.trim().toLowerCase();

  const matches = (opt: SelectOption) =>
    !query ||
    opt.label.toLowerCase().includes(query) ||
    opt.value.toLowerCase().includes(query);
  const filteredGroups: SelectGroup[] = normalizedGroups
    .map((g) => ({ ...g, options: g.options.filter(matches) }))
    .filter((g) => g.options.length > 0);
  const filteredOptions = filteredGroups.flatMap((g) => g.options);

  const selectedOption = allOptions.find((opt) => opt.value === value);

  // 打开时初始化：清空搜索、高亮当前选中项。放在打开动作里而不是 effect 里——
  // options 每次渲染都是新数组引用，依赖它的 effect 会反复把高亮重置回选中项
  const openSelect = () => {
    setSearchQuery('');
    const selectedIndex = filteredOptions.findIndex((opt) => opt.value === value);
    setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : 0);
    setIsOpen(true);
  };

  // 打开后聚焦搜索框（键盘优先：展开即可输入）
  useEffect(() => {
    if (isOpen && isSearchable) searchInputRef.current?.focus();
  }, [isOpen, isSearchable]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // 输入搜索词后，高亮回到第一个匹配项
  useEffect(() => {
    if (query) setHighlightedIndex(0);
  }, [query]);

  // 键盘导航时保证高亮项滚入可视区
  useEffect(() => {
    if (!isOpen || highlightedIndex < 0) return;
    listRef.current
      ?.querySelector(`[data-option-index="${highlightedIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex, isOpen]);

  // Calculate dropdown position based on available space
  useEffect(() => {
    if (isOpen && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const itemHeight = 36; // Estimated height per option
      const padding = 8; // py-1 = 4px * 2
      const estimatedHeight = Math.min(totalCount * itemHeight + padding, 192);

      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;

      // If space below is insufficient and space above is sufficient, expand upward
      if (spaceBelow < estimatedHeight && spaceAbove > estimatedHeight) {
        setDropdownPosition('top');
        setDropdownMaxHeight(Math.min(spaceAbove - 16, 192));
      } else {
        setDropdownPosition('bottom');
        setDropdownMaxHeight(Math.min(spaceBelow - 16, 192));
      }
    }
  }, [isOpen, totalCount]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    // 焦点在搜索框时：字母/空格留给输入框，这里只处理导航与确认键
    const typingInSearch = e.target instanceof HTMLInputElement;

    switch (e.key) {
      case 'Enter':
        e.preventDefault();
        if (isOpen && highlightedIndex >= 0 && filteredOptions[highlightedIndex]) {
          onChange(filteredOptions[highlightedIndex].value);
          setIsOpen(false);
          triggerRef.current?.focus();
        } else if (!typingInSearch) {
          if (isOpen) setIsOpen(false);
          else openSelect();
        }
        break;
      case ' ':
        if (typingInSearch) break;
        e.preventDefault();
        if (isOpen && highlightedIndex >= 0 && filteredOptions[highlightedIndex]) {
          onChange(filteredOptions[highlightedIndex].value);
          setIsOpen(false);
          triggerRef.current?.focus();
        } else {
          if (isOpen) setIsOpen(false);
          else openSelect();
        }
        break;
      case 'Escape':
        setIsOpen(false);
        if (typingInSearch) triggerRef.current?.focus();
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (!isOpen) {
          openSelect();
        } else {
          setHighlightedIndex((prev) =>
            prev < filteredOptions.length - 1 ? prev + 1 : prev
          );
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!isOpen) {
          openSelect();
        } else {
          setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : prev));
        }
        break;
    }
  };

  // 渲染分组：分组头 + 选项，选项索引沿用全局扁平淡出序号
  let optionIndex = -1;
  const renderOption = (option: SelectOption) => {
    optionIndex += 1;
    const index = optionIndex;
    return (
      <button
        key={option.value}
        type="button"
        data-option-index={index}
        onClick={() => {
          onChange(option.value);
          setIsOpen(false);
        }}
        disabled={option.disabled}
        onMouseEnter={() => setHighlightedIndex(index)}
        className={`
          w-full px-3 py-2 text-left text-sm transition-colors duration-150
          ${option.disabled
            ? 'text-app-text-disabled cursor-not-allowed'
            : 'text-app-text-secondary hover:text-app-text-primary hover:bg-white/10 cursor-pointer'
          }
          ${value === option.value ? 'bg-white/5 text-app-brand-primary-light' : ''}
          ${highlightedIndex === index && !option.disabled ? 'bg-white/10' : ''}
        `}
      >
        {option.label}
      </button>
    );
  };

  return (
    <div
      ref={containerRef}
      className={`relative ${className}`}
      onKeyDown={handleKeyDown}
      tabIndex={disabled ? -1 : 0}
    >
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (disabled) return;
          if (isOpen) setIsOpen(false);
          else openSelect();
        }}
        disabled={disabled}
        className={`
          w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm
          border transition-all duration-200 ease-out
          ${disabled
            ? 'bg-app-bg-tertiary/50 border-app-border-subtle text-app-text-disabled cursor-not-allowed'
            : 'bg-app-bg-tertiary border-app-border text-app-text-primary hover:border-app-border-emphasis focus:border-app-status-info focus:ring-2 focus:ring-app-status-info/20 cursor-pointer'
          }
          ${isOpen ? 'border-app-status-info ring-2 ring-app-status-info/20' : ''}
        `}
      >
        {icon && <span className="text-app-text-tertiary">{icon}</span>}
        <span className={`flex-1 text-left truncate ${!selectedOption ? 'text-app-text-placeholder' : ''}`}>
          {selectedOption?.label || placeholder}
        </span>
        <ChevronDown
          size={14}
          className={`text-app-text-tertiary transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>

      {/* Dropdown Menu */}
      <div
        className={`
          absolute z-50 py-1 rounded-lg overflow-hidden
          bg-app-bg-elevated
          border border-app-border-emphasis shadow-xl shadow-black/50
          transition-all duration-200 ease-out
          ${menuClassName}
          ${dropdownPosition === 'top'
            ? 'bottom-full mb-1 origin-bottom'
            : 'top-full mt-1 origin-top'
          }
          ${isOpen ? 'opacity-100 scale-100 translate-y-0' : 'opacity-0 scale-95 pointer-events-none'}
          ${dropdownPosition === 'top' && !isOpen ? 'translate-y-2' : ''}
          ${dropdownPosition === 'bottom' && !isOpen ? '-translate-y-2' : ''}
        `}
      >
        {isOpen && isSearchable && (
          <div className="px-2 pb-1.5 mb-1 border-b border-white/10">
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="输入以筛选…"
              className="w-full bg-transparent text-app-text-primary text-sm px-1 py-1 outline-none placeholder:text-app-text-placeholder"
            />
          </div>
        )}
        <div
          ref={listRef}
          style={{ maxHeight: dropdownMaxHeight }}
          className="overflow-y-auto scrollbar-thin scrollbar-thumb-zinc-600 scrollbar-track-transparent"
        >
          {filteredOptions.length === 0 ? (
            <div className="px-3 py-2 text-app-text-placeholder text-sm text-center">
              {query ? '无匹配结果' : '暂无选项'}
            </div>
          ) : (
            filteredGroups.map((group, gi) => (
              <div key={group.label ?? gi}>
                {group.label && (
                  <div className="px-3 pt-1.5 pb-0.5 text-xs text-app-text-tertiary">
                    {group.label}
                  </div>
                )}
                {group.options.map(renderOption)}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
