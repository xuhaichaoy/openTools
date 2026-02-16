import React, { Component, type ReactNode } from "react";
import { AlertTriangle, RefreshCw, ArrowLeft } from "lucide-react";

interface Props {
  children: ReactNode;
  pluginId?: string;
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class PluginErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error(
      `[Plugin Error] Plugin ${this.props.pluginId} crashed:`,
      error,
      errorInfo,
    );
  }

  /** 仅重置错误状态，让子组件重新渲染（真正的重试） */
  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  /** 返回首页（重置状态 + 导航回主页） */
  handleBack = () => {
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-full w-full flex flex-col items-center justify-center p-6 text-center select-none">
          <div className="w-16 h-16 bg-red-500/10 rounded-full flex items-center justify-center mb-4">
            <AlertTriangle className="w-8 h-8 text-red-500" />
          </div>
          <h2 className="text-xl font-bold mb-2">插件运行出错</h2>
          <p className="text-[var(--color-text-secondary)] mb-6 max-w-md break-words">
            {this.state.error?.message || "未知错误"}
          </p>
          <div className="flex items-center gap-3">
            <button
              onClick={this.handleRetry}
              className="flex items-center gap-2 px-4 py-2 bg-orange-500/10 hover:bg-orange-500/20 text-orange-500 rounded-lg transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
              重试
            </button>
            <button
              onClick={this.handleBack}
              className="flex items-center gap-2 px-4 py-2 bg-[var(--color-item-hover)] hover:bg-[var(--color-item-hover-active)] text-[var(--color-text-secondary)] rounded-lg transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              返回首页
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
