import { Component, type ReactNode, type ErrorInfo } from 'react';

interface PluginErrorBoundaryProps {
  children: ReactNode;
  onBack: () => void;
}

interface PluginErrorBoundaryState {
  hasError: boolean;
}

/**
 * 插件视图错误边界：捕获懒加载 chunk 失败与渲染异常，
 * 显示「加载失败 + 返回启动器」，详细错误进 console（不静默吞）。
 * 壳以 key=插件 id 重挂载本组件，插件切换时自动复位。
 */
export class PluginErrorBoundary extends Component<PluginErrorBoundaryProps, PluginErrorBoundaryState> {
  state: PluginErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): PluginErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[plugins] 插件视图加载/渲染失败:', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="h-full flex flex-col items-center justify-center gap-3">
          <p className="text-sm text-app-text-secondary">插件加载失败</p>
          <button
            onClick={this.props.onBack}
            className="px-3 py-1.5 rounded-lg text-sm text-app-text-secondary hover:text-app-text-primary bg-app-bg-elevated/50 hover:bg-app-bg-elevated transition-colors cursor-pointer"
          >
            返回启动器
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
