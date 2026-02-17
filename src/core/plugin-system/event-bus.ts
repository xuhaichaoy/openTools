/**
 * 插件事件总线 — 基于 BroadcastChannel 的插件间通信
 *
 * 用于插件之间的数据共享和事件通知。
 * 例如：截图插件发出截图数据 → OCR 插件接收并识别文字
 */

const CHANNEL_NAME = "mtools-plugin-bus";

/** 事件载荷结构 */
export interface PluginEvent<T = unknown> {
  type: string;
  source: string; // 发送者插件 id
  payload: T;
  timestamp: number;
}

/** 预定义事件类型 */
export const PluginEventTypes = {
  /** 截图完成 — payload: { imageBase64: string, rect?: { x, y, w, h } } */
  SCREENSHOT_CAPTURED: "screenshot:captured",
  /** OCR 识别完成 — payload: { text: string, blocks: OcrBlock[] } */
  OCR_RESULT: "ocr:result",
  /** 文字提取 — payload: { text: string } */
  TEXT_EXTRACTED: "text:extracted",
  /** 快速录入新增 — payload: Mark */
  MARK_CREATED: "mark:created",
  /** 笔记生成完成 — payload: { fileName: string, content: string } */
  NOTE_GENERATED: "note:generated",
  /** 同步状态变化 — payload: { status, provider, message } */
  SYNC_STATUS: "sync:status",
  /** 贴图请求 — payload: { imageBase64: string } */
  DING_REQUEST: "ding:request",
  /** 翻译请求 — payload: { text: string, from?: string, to?: string } */
  TRANSLATE_REQUEST: "translate:request",
  /** 翻译结果 — payload: { text: string, translated: string, engine: string } */
  TRANSLATE_RESULT: "translate:result",
} as const;

type EventHandler<T = unknown> = (event: PluginEvent<T>) => void;

/** 复用的发送通道单例，避免每次 emit 都创建/销毁 BroadcastChannel */
let _emitChannel: BroadcastChannel | null = null;
function getEmitChannel(): BroadcastChannel {
  if (!_emitChannel) {
    _emitChannel = new BroadcastChannel(CHANNEL_NAME);
  }
  return _emitChannel;
}

/**
 * 发送插件事件（fire-and-forget）
 */
export function emitPluginEvent<T = unknown>(
  type: string,
  source: string,
  payload: T,
): void {
  const event: PluginEvent<T> = {
    type,
    source,
    payload,
    timestamp: Date.now(),
  };
  getEmitChannel().postMessage(event);
}

/**
 * 监听插件事件
 * @returns 取消监听的函数
 */
export function onPluginEvent<T = unknown>(
  type: string,
  handler: EventHandler<T>,
): () => void {
  const bc = new BroadcastChannel(CHANNEL_NAME);
  bc.onmessage = (e: MessageEvent) => {
    const event = e.data as PluginEvent<T>;
    if (event?.type === type) {
      handler(event);
    }
  };
  return () => bc.close();
}

/**
 * 监听多种插件事件
 * @returns 取消监听的函数
 */
export function onPluginEvents(
  handlers: Record<string, EventHandler>,
): () => void {
  const bc = new BroadcastChannel(CHANNEL_NAME);
  bc.onmessage = (e: MessageEvent) => {
    const event = e.data as PluginEvent;
    if (event?.type && handlers[event.type]) {
      handlers[event.type](event);
    }
  };
  return () => bc.close();
}

/**
 * 一次性监听插件事件（收到一次后自动取消）
 */
export function oncePluginEvent<T = unknown>(
  type: string,
  handler: EventHandler<T>,
  timeoutMs = 30000,
): () => void {
  const bc = new BroadcastChannel(CHANNEL_NAME);
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    bc.close();
  };

  bc.onmessage = (e: MessageEvent) => {
    const event = e.data as PluginEvent<T>;
    if (event?.type === type) {
      handler(event);
      cleanup();
    }
  };

  // 超时自动清理
  timer = setTimeout(cleanup, timeoutMs);

  return cleanup;
}
