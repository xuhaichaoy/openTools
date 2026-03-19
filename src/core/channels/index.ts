export type {
  IMChannel,
  ChannelConfig,
  ChannelType,
  ChannelStatus,
  ChannelIncomingMessage,
  ChannelOutgoingMessage,
  MessageHandler,
} from "./types";

export { DingTalkChannel } from "./dingtalk-channel";
export type { DingTalkConfig } from "./dingtalk-channel";

export { FeishuChannel } from "./feishu-channel";
export type { FeishuConfig } from "./feishu-channel";

export { ChannelManager, getChannelManager } from "./channel-manager";
export {
  CHANNEL_STORAGE_KEY,
  loadSavedChannels,
  normalizeChannelConfig,
  saveSavedChannels,
} from "./channel-persistence";
export type { SavedChannelEntry } from "./channel-persistence";
