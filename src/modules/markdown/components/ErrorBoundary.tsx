import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Error caught by boundary:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback || (
          <div className="p-4 text-center text-zinc-500">
            <p className="text-red-400 text-sm mb-2">加载出错</p>
            <button
              onClick={() => this.setState({ hasError: false })}
              className="text-sm text-blue-400 hover:text-blue-300 transition-colors cursor-pointer"
            >
              重试
            </button>
          </div>
        )
      );
    }

    return this.props.children;
  }
}
