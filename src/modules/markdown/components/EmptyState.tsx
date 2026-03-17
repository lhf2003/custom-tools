import { FileText } from 'lucide-react';

export function EmptyState() {
  return (
    <div className="flex-1 flex items-center justify-center text-zinc-500">
      <div className="text-center">
        <div className="w-16 h-16 rounded-2xl bg-zinc-700/30 flex items-center justify-center mb-4 mx-auto">
          <FileText size={32} className="opacity-50" />
        </div>
        <p className="text-zinc-300 font-medium">选择一个笔记或创建新笔记</p>
        <p className="text-sm mt-1 text-zinc-500">支持 Markdown 格式</p>
      </div>
    </div>
  );
}
