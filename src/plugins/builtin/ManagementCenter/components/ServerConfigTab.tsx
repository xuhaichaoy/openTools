import { useState } from "react";
import { Server, Check, AlertCircle, Loader2 } from "lucide-react";
import { useServerStore } from "@/store/server-store";
import { handleError } from "@/core/errors";

const BRAND = "#F28F36";

export function ServerConfigTab() {
  const { serverUrl, setServerUrl } = useServerStore();
  const [inputUrl, setInputUrl] = useState(serverUrl);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<"ok" | "fail" | null>(null);
  const [saved, setSaved] = useState(false);

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const url = inputUrl.replace(/\/+$/, "");
      const res = await fetch(`${url}/health`, { method: "GET" });
      setTestResult(res.ok ? "ok" : "fail");
    } catch (e) {
      handleError(e, { context: "测试服务器连接" });
      setTestResult("fail");
    } finally {
      setTesting(false);
    }
  };

  const handleSave = () => {
    setServerUrl(inputUrl);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="max-w-xl mx-auto space-y-4">
      <div>
        <h2 className="text-sm font-semibold">服务器地址</h2>
        <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
          配置 mTools 后端服务器地址。支持私有部署和公共服务。
        </p>
      </div>

      <div className="bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] p-4 space-y-3">
        <div>
          <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
            后端地址
          </label>
          <input
            type="url"
            value={inputUrl}
            onChange={(e) => {
              setInputUrl(e.target.value);
              setTestResult(null);
              setSaved(false);
            }}
            placeholder="http://localhost:3000"
            className="mt-1 w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-2 px-3 text-xs outline-none focus:ring-2 transition-all text-[var(--color-text)]"
            style={{ "--tw-ring-color": `${BRAND}30` } as any}
          />
        </div>

        {testResult === "ok" && (
          <div className="flex items-center gap-1.5 text-green-500 text-[10px]">
            <Check className="w-3 h-3" />
            连接成功
          </div>
        )}
        {testResult === "fail" && (
          <div className="flex items-center gap-1.5 text-red-500 text-[10px]">
            <AlertCircle className="w-3 h-3" />
            连接失败，请检查地址是否正确
          </div>
        )}

        <div className="flex gap-2">
          <button
            onClick={handleTest}
            disabled={testing || !inputUrl}
            className="flex-1 py-2 rounded-lg border border-[var(--color-border)] text-xs font-medium hover:bg-[var(--color-bg-secondary)] transition-all flex items-center justify-center gap-1.5 disabled:opacity-40"
          >
            {testing ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Server className="w-3.5 h-3.5" />
            )}
            测试连接
          </button>
          <button
            onClick={handleSave}
            disabled={!inputUrl}
            className="flex-1 py-2 rounded-lg text-white text-xs font-semibold transition-all flex items-center justify-center gap-1.5 disabled:opacity-40"
            style={{ background: BRAND }}
          >
            {saved ? (
              <>
                <Check className="w-3.5 h-3.5" />
                已保存
              </>
            ) : (
              "保存设置"
            )}
          </button>
        </div>
      </div>

      <div className="bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] p-4">
        <h3 className="text-xs font-semibold mb-1">关于私有部署</h3>
        <p className="text-[10px] text-[var(--color-text-secondary)] leading-relaxed">
          mTools 支持私有部署后端服务。使用 Docker Compose
          即可快速部署包含数据库、缓存的完整后端。
          部署后将上方地址修改为你的服务器地址即可。
        </p>
      </div>
    </div>
  );
}
