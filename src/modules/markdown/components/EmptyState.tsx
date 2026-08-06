import { FileText } from 'lucide-react';
import { THEME } from '@/constants/theme';

export function EmptyState() {
  return (
    <div className="flex-1 flex items-center justify-center" style={{ color: THEME.TEXT_DISABLED }}>
      <div className="text-center">
        <div
          className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4 mx-auto"
          style={{ backgroundColor: THEME.BG_TERTIARY }}
        >
          <FileText size={32} className="opacity-50" />
        </div>
        <p className="font-medium" style={{ color: THEME.TEXT_SECONDARY }}>
          选择一个笔记或创建新笔记
        </p>
        <p className="text-sm mt-1" style={{ color: THEME.TEXT_DISABLED }}>
          Ctrl+N 新建笔记 · Ctrl+F 搜索笔记
        </p>
      </div>
    </div>
  );
}
