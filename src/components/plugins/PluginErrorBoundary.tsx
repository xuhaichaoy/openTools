import React, { Component, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

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

  handleReset = () => {
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
          <button
            onClick={this.handleReset}
            className="flex items-center gap-2 px-4 py-2 bg-[var(--color-item-hover)] hover:bg-[var(--color-item-hover-active)] rounded-lg transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            重试
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
