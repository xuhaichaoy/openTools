import { invoke } from "@tauri-apps/api/core";
import { addMemoryFromAgent } from "./memory-store";

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

const MIN_MESSAGES_FOR_SUMMARY = 4;
const MAX_MESSAGES_TO_SUMMARIZE = 40;

export async function summarizeConversation(
  messages: ChatMessage[],
  conversationId?: string,
): Promise<string | null> {
  const userAssistantMessages = messages.filter(
    (m) => m.role === "user" || m.role === "assistant",
  );

  if (userAssistantMessages.length < MIN_MESSAGES_FOR_SUMMARY) return null;

  const recentMessages = userAssistantMessages.slice(-MAX_MESSAGES_TO_SUMMARIZE);
  const transcript = recentMessages
    .map((m) => `${m.role === "user" ? "用户" : "AI"}: ${m.content.slice(0, 300)}`)
    .join("\n");

  const summaryPrompt = `请从以下对话中提取关键信息，特别是：
1. 用户表达的偏好或习惯
2. 关键的事实或决定
3. 用户的工作目标或项目需求

对话内容：
${transcript}

请用简洁的要点列表输出，只返回关键信息，不要冗余。如果没有值得记忆的信息，返回"无"。`;

  try {
    const response = await invoke<string>("ai_chat", {
      messages: JSON.stringify([
        { role: "system", content: "你是一个信息提取助手，专注于从对话中提取值得长期记忆的关键信息。" },
        { role: "user", content: summaryPrompt },
      ]),
      model: null,
      temperature: 0.3,
    });

    const summary = typeof response === "string" ? response : JSON.stringify(response);

    if (!summary || summary.trim() === "无" || summary.length < 10) {
      return null;
    }

    await addMemoryFromAgent(
      `对话摘要 (${new Date().toLocaleDateString()})`,
      summary.slice(0, 500),
      "conversation_summary",
    );

    return summary;
  } catch {
    return null;
  }
}
