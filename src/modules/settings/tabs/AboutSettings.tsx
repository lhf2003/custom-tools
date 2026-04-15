import { Info } from 'lucide-react';

export function AboutSettings() {
  return (
    <>
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-teal-500/30 to-teal-600/20 flex items-center justify-center">
          <Info size={20} className="text-teal-400" />
        </div>
        <div>
          <h2 className="text-white text-lg font-semibold">关于我们</h2>
          <p className="text-white/40 text-xs">应用信息与致谢</p>
        </div>
      </div>

      <div className="space-y-4">
        {/* 应用信息 */}
        <div className="rounded-xl p-5 border border-white/10 bg-white/[0.02] flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center flex-shrink-0 overflow-hidden">
            <img src="/favicon.svg" alt="FlowHub Logo" className="w-full h-full" />
          </div>
          <div>
            <h3 className="text-white text-base font-semibold">FlowHub</h3>
            <p className="text-white/40 text-xs mt-0.5">版本 0.3.3</p>
            <p className="text-white/30 text-xs mt-1">Windows 效率启动器</p>
          </div>
        </div>

        {/* 简介 */}
        <div className="rounded-xl p-4 border border-white/10 bg-white/[0.02]">
          <p className="text-white/70 text-sm font-medium mb-2">关于本应用</p>
          <p className="text-white/45 text-xs leading-relaxed">
            FlowHub 是一款面向 Windows 的效率工具启动器，提供应用模糊搜索、剪贴板历史、
            密码管理、Markdown 笔记、文件搜索、JSON 格式化和 AI 对话等功能，旨在让日常操作更快捷流畅。
          </p>
        </div>

        {/* 技术栈 */}
        <div className="rounded-xl p-4 border border-white/10 bg-white/[0.02]">
          <p className="text-white/70 text-sm font-medium mb-3">技术栈</p>
          <div className="flex flex-wrap gap-2">
            {['Tauri 2.0', 'Rust', 'React 18', 'TypeScript', 'Vite', 'Tailwind CSS', 'SQLite', 'nucleo'].map(
              (tech) => (
                <span
                  key={tech}
                  className="px-2.5 py-1 text-xs rounded-lg bg-white/5 text-white/50 border border-white/10"
                >
                  {tech}
                </span>
              ),
            )}
          </div>
        </div>

        {/* 隐私声明 */}
        <div className="rounded-xl p-4 border border-white/10 bg-white/[0.02]">
          <p className="text-white/70 text-sm font-medium mb-2">隐私声明</p>
          <p className="text-white/45 text-xs leading-relaxed">
            本应用所有数据（剪贴板历史、密码、笔记、AI 配置）均仅存储在本地，不会上传至任何服务器。
            AI 功能需要用户自行配置第三方大模型接口密钥。
          </p>
        </div>
      </div>
    </>
  );
}
