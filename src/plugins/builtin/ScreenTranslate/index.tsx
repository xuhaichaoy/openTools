import React, { useState, useCallback, useEffect } from "react";
import {
  Languages,
  ArrowRightLeft,
  Copy,
  Check,
  Loader2,
  Camera,
  Clipboard,
  Volume2,
} from "lucide-react";
import {
  translate,
  LANGUAGES,
  type TranslateResult,
} from "@/core/translate/index";
import {
  onPluginEvent,
  emitPluginEvent,
  PluginEventTypes,
} from "@/core/plugin-system/event-bus";

const ScreenTranslatePlugin: React.FC<{ onBack?: () => void }> = ({
  onBack,
}) => {
  const [sourceText, setSourceText] = useState("");
  const [translatedText, setTranslatedText] = useState("");
  const [fromLang, setFromLang] = useState("auto");
  const [toLang, setToLang] = useState("zh");
  const [engineId, setEngineId] = useState("google");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [history, setHistory] = useState<TranslateResult[]>([]);

  const doTranslate = useCallback(
    async (text?: string) => {
      const input = text ?? sourceText;
      if (!input.trim()) return;
      setLoading(true);
      setError(null);
      try {
        const result = await translate(input.trim(), fromLang, toLang, engineId);
        setTranslatedText(result.translated);
        setHistory((prev) => [result, ...prev.slice(0, 19)]);
        emitPluginEvent(PluginEventTypes.TRANSLATE_RESULT, "screen-translate", result);
      } catch (e) {
        setError(`翻译失败: ${e}`);
      } finally {
        setLoading(false);
      }
    },
    [sourceText, fromLang, toLang, engineId],
  );

  const swapLanguages = useCallback(() => {
    if (fromLang === "auto") return;
    const tmp = fromLang;
    setFromLang(toLang);
    setToLang(tmp);
    setSourceText(translatedText);
    setTranslatedText(sourceText);
  }, [fromLang, toLang, sourceText, translatedText]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(translatedText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [translatedText]);

  const handlePasteAndTranslate = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setSourceText(text);
        doTranslate(text);
      }
    } catch {
      setError("无法读取剪贴板");
    }
  }, [doTranslate]);

  // 监听 OCR 结果事件，自动翻译
  useEffect(() => {
    const unsub = onPluginEvent<{ text: string }>(
      PluginEventTypes.OCR_RESULT,
      (event) => {
        if (event.payload.text) {
          setSourceText(event.payload.text);
          doTranslate(event.payload.text);
        }
      },
    );
    return unsub;
  }, [doTranslate]);

  // 监听翻译请求事件
  useEffect(() => {
    const unsub = onPluginEvent<{ text: string; from?: string; to?: string }>(
      PluginEventTypes.TRANSLATE_REQUEST,
      (event) => {
        const { text, from, to } = event.payload;
        if (from) setFromLang(from);
        if (to) setToLang(to);
        setSourceText(text);
        doTranslate(text);
      },
    );
    return unsub;
  }, [doTranslate]);

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)] text-[var(--color-text)]">
      {/* 头部 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-2">
          {onBack && (
            <button
              onClick={onBack}
              className="p-1 hover:bg-[var(--color-bg-secondary)] rounded-md transition-colors"
            >
              ←
            </button>
          )}
          <Languages className="w-5 h-5 text-rose-500" />
          <h2 className="font-semibold">屏幕翻译</h2>
        </div>

        {/* 引擎选择 */}
        <select
          value={engineId}
          onChange={(e) => setEngineId(e.target.value)}
          className="text-sm bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-md px-2 py-1"
        >
          <option value="google">Google 翻译</option>
          <option value="ai">AI 翻译</option>
        </select>
      </div>

      {/* 语言选择栏 */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--color-border)]">
        <select
          value={fromLang}
          onChange={(e) => setFromLang(e.target.value)}
          className="flex-1 text-sm bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-md px-2 py-1.5"
        >
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.name}
            </option>
          ))}
        </select>
        <button
          onClick={swapLanguages}
          disabled={fromLang === "auto"}
          className="p-1.5 rounded-md hover:bg-[var(--color-bg-secondary)] transition-colors disabled:opacity-30"
        >
          <ArrowRightLeft className="w-4 h-4" />
        </button>
        <select
          value={toLang}
          onChange={(e) => setToLang(e.target.value)}
          className="flex-1 text-sm bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-md px-2 py-1.5"
        >
          {LANGUAGES.filter((l) => l.code !== "auto").map((l) => (
            <option key={l.code} value={l.code}>
              {l.name}
            </option>
          ))}
        </select>
      </div>

      {/* 翻译区域 */}
      <div className="flex-1 flex gap-0 overflow-hidden">
        {/* 源文本 */}
        <div className="flex-1 flex flex-col border-r border-[var(--color-border)]">
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]/30">
            <span className="text-xs text-[var(--color-text-secondary)]">
              原文
            </span>
            <div className="flex gap-1">
              <button
                onClick={handlePasteAndTranslate}
                className="p-1 rounded hover:bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]"
                title="粘贴并翻译"
              >
                <Clipboard className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
          <textarea
            value={sourceText}
            onChange={(e) => setSourceText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                doTranslate();
              }
            }}
            placeholder="输入或粘贴要翻译的文本... (Cmd+Enter 翻译)"
            className="flex-1 p-3 bg-transparent resize-none text-sm focus:outline-none"
          />
          <div className="px-3 py-2 border-t border-[var(--color-border)] flex justify-end">
            <button
              onClick={() => doTranslate()}
              disabled={!sourceText.trim() || loading}
              className="px-4 py-1.5 bg-rose-500 text-white rounded-lg hover:bg-rose-600 transition-colors text-sm font-medium disabled:opacity-50"
            >
              {loading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                "翻译"
              )}
            </button>
          </div>
        </div>

        {/* 译文 */}
        <div className="flex-1 flex flex-col">
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]/30">
            <span className="text-xs text-[var(--color-text-secondary)]">
              译文
            </span>
            {translatedText && (
              <button
                onClick={handleCopy}
                className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded hover:bg-[var(--color-bg-secondary)]"
              >
                {copied ? (
                  <Check className="w-3 h-3 text-green-500" />
                ) : (
                  <Copy className="w-3 h-3" />
                )}
              </button>
            )}
          </div>
          <div className="flex-1 p-3 overflow-auto">
            {error && (
              <p className="text-red-500 text-sm">{error}</p>
            )}
            {loading && (
              <div className="flex items-center gap-2 text-[var(--color-text-secondary)]">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-sm">翻译中...</span>
              </div>
            )}
            {translatedText && !loading && (
              <p className="text-sm leading-relaxed whitespace-pre-wrap">
                {translatedText}
              </p>
            )}
            {!translatedText && !loading && !error && (
              <p className="text-[var(--color-text-secondary)] text-sm">
                翻译结果将显示在这里
              </p>
            )}
          </div>
        </div>
      </div>

      {/* 历史记录 */}
      {history.length > 0 && (
        <div className="border-t border-[var(--color-border)] max-h-32 overflow-auto">
          <div className="px-3 py-1.5 text-xs text-[var(--color-text-secondary)] bg-[var(--color-bg-secondary)]/30">
            最近翻译
          </div>
          {history.slice(0, 5).map((item, i) => (
            <button
              key={i}
              onClick={() => {
                setSourceText(item.text);
                setTranslatedText(item.translated);
              }}
              className="w-full px-3 py-1.5 text-left text-xs hover:bg-[var(--color-bg-secondary)] transition-colors truncate"
            >
              <span className="text-[var(--color-text-secondary)]">
                {item.text.slice(0, 30)}
              </span>
              <span className="mx-1">→</span>
              <span>{item.translated.slice(0, 30)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default ScreenTranslatePlugin;
