/**
 * 翻译引擎核心 — 多引擎翻译服务
 * 来源: eSearch 的 xtranslator 思路
 */

export interface TranslateResult {
  text: string;
  translated: string;
  from: string;
  to: string;
  engine: string;
  confidence?: number;
}

export interface TranslateEngine {
  name: string;
  id: string;
  translate(text: string, from: string, to: string): Promise<TranslateResult>;
}

/** Google 翻译 (免费 API) */
export const googleTranslate: TranslateEngine = {
  name: "Google 翻译",
  id: "google",
  async translate(text, from, to) {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url);
    const data = await res.json();
    const translated = (data[0] as [string][])
      .map((item: [string]) => item[0])
      .join("");
    return { text, translated, from, to, engine: "google" };
  },
};

/** AI 翻译（使用 MToolsAI） */
export function createAITranslateEngine(
  chatFn: (messages: { role: string; content: string }[]) => Promise<string>,
): TranslateEngine {
  return {
    name: "AI 翻译",
    id: "ai",
    async translate(text, from, to) {
      const langMap: Record<string, string> = {
        zh: "中文",
        en: "英文",
        ja: "日文",
        ko: "韩文",
        fr: "法文",
        de: "德文",
        es: "西班牙文",
        auto: "源语言",
      };
      const prompt = `将以下${langMap[from] || from}文本翻译为${langMap[to] || to}，只输出翻译结果，不要解释：\n\n${text}`;
      const translated = await chatFn([{ role: "user", content: prompt }]);
      return { text, translated, from, to, engine: "ai" };
    },
  };
}

/** 可用的翻译引擎列表 */
export const engines: TranslateEngine[] = [googleTranslate];

/** 获取支持的语言列表 */
export const LANGUAGES = [
  { code: "auto", name: "自动检测" },
  { code: "zh", name: "中文" },
  { code: "en", name: "英文" },
  { code: "ja", name: "日文" },
  { code: "ko", name: "韩文" },
  { code: "fr", name: "法文" },
  { code: "de", name: "德文" },
  { code: "es", name: "西班牙文" },
  { code: "ru", name: "俄文" },
  { code: "pt", name: "葡萄牙文" },
];

/** 执行翻译 */
export async function translate(
  text: string,
  from: string,
  to: string,
  engineId: string = "google",
): Promise<TranslateResult> {
  const engine = engines.find((e) => e.id === engineId) ?? engines[0];
  return engine.translate(text, from, to);
}
