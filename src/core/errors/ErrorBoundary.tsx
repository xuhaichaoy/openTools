import { Component, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * 全局错误边界 — 包裹整个应用，防止未捕获的 React 渲染错误导致白屏。
 * 与 PluginErrorBoundary 的区别：这是最后一道防线，只在极端情况下触发。
 */
export class GlobalErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("🔴 [GlobalErrorBoundary] 应用级未捕获错误:", error, errorInfo);
  }

  handleReload = () => {
    window.location.reload();
  };

  handleDismiss = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen w-screen flex flex-col items-center justify-center p-8 text-center bg-[var(--color-bg)] text-[var(--color-text)] select-none">
          <div className="w-20 h-20 bg-red-500/10 rounded-full flex items-center justify-center mb-6">
            <AlertTriangle className="w-10 h-10 text-red-500" />
          </div>
          <h1 className="text-lg font-bold mb-2">应用遇到了问题</h1>
          <p className="text-sm text-[var(--color-text-secondary)] mb-2 max-w-md">
            发生了一个未预期的错误，请尝试重新加载。
          </p>
          <p className="text-xs text-[var(--color-text-secondary)] mb-6 max-w-md opacity-60 break-all">
            {this.state.error?.message || "Unknown error"}
          </p>
          <div className="flex items-center gap-3">
            <button
              onClick={this.handleReload}
              className="flex items-center gap-2 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors text-sm font-medium"
            >
              <RefreshCw className="w-4 h-4" />
              重新加载
            </button>
            <button
              onClick={this.handleDismiss}
              className="px-5 py-2.5 border border-[var(--color-border)] hover:bg-[var(--color-bg-secondary)] rounded-lg transition-colors text-sm"
            >
              尝试继续
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
