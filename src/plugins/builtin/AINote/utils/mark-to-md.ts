/**
 * Mark 转 Markdown 工具函数
 * 来源: note-gen 的 markToMarkdown 逻辑
 */

import type { Mark } from "@/core/database/marks";

/** 将单个 Mark 转换为 Markdown 片段 */
export function markToMarkdown(mark: Mark): string {
  const time = new Date(mark.createdAt).toLocaleString("zh-CN");
  const tags =
    mark.tags.length > 0
      ? `\n> 标签: ${mark.tags.map((t) => `\`${t}\``).join(" ")}`
      : "";

  switch (mark.type) {
    case "text":
      return `### 📝 文本记录 (${time})${tags}\n\n${mark.content}\n`;

    case "image":
      return `### 🖼️ 图片 (${time})${tags}\n\n![image](${mark.content})\n`;

    case "link":
      return `### 🔗 链接 (${time})${tags}\n\n[${mark.title || mark.content}](${mark.content})\n`;

    case "file":
      return `### 📄 文件 (${time})${tags}\n\n文件路径: \`${mark.content}\`\n`;

    case "recording":
      return `### 🎙️ 录音 (${time})${tags}\n\n${mark.content}\n`;

    case "todo":
      return `### ☑️ 待办 (${time})${tags}\n\n- [ ] ${mark.content}\n`;

    case "scan":
      return `### 📷 扫描内容 (${time})${tags}\n\n${mark.content}\n`;

    default:
      return `### 📌 记录 (${time})${tags}\n\n${mark.content}\n`;
  }
}

/** 将多个 Mark 转换为完整的 Markdown 文档 */
export function marksToMarkdown(marks: Mark[], title?: string): string {
  const header = title ? `# ${title}\n\n` : "";
  const summary = `> 共 ${marks.length} 条录入记录\n> 时间范围: ${formatDateRange(marks)}\n\n---\n\n`;
  const body = marks.map(markToMarkdown).join("\n---\n\n");
  return `${header}${summary}${body}`;
}

function formatDateRange(marks: Mark[]): string {
  if (marks.length === 0) return "-";
  const sorted = [...marks].sort((a, b) => a.createdAt - b.createdAt);
  const first = new Date(sorted[0].createdAt).toLocaleDateString("zh-CN");
  const last = new Date(
    sorted[sorted.length - 1].createdAt,
  ).toLocaleDateString("zh-CN");
  return first === last ? first : `${first} ~ ${last}`;
}

/** 笔记生成模板 */
export interface NoteTemplate {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
}

export const NOTE_TEMPLATES: NoteTemplate[] = [
  {
    id: "summary",
    name: "总结归纳",
    description: "将碎片化内容整理为结构化摘要",
    systemPrompt: `你是一个专业的笔记整理助手。请将用户提供的碎片化录入内容整理成一篇结构清晰的 Markdown 笔记。
要求：
1. 提取关键信息，去除冗余
2. 按主题分类组织
3. 使用恰当的标题层级
4. 保留重要的细节和数据
5. 添加简短的总结
6. 输出纯 Markdown 格式`,
  },
  {
    id: "article",
    name: "文章润色",
    description: "将零散内容扩写为流畅文章",
    systemPrompt: `你是一个写作助手。请将用户提供的碎片化内容扩写成一篇通顺、有逻辑的文章。
要求：
1. 保持原有信息的准确性
2. 添加合理的过渡和连接
3. 语言流畅自然
4. 使用 Markdown 格式
5. 适当添加小标题`,
  },
  {
    id: "todo-list",
    name: "待办清单",
    description: "提取行动项整理为待办清单",
    systemPrompt: `请从用户提供的内容中提取所有行动项和待办事项，整理为一个清晰的待办清单。
要求：
1. 使用 Markdown 复选框格式 (- [ ])
2. 按优先级或类别分组
3. 每项简洁明了
4. 标注截止时间（如果有）`,
  },
  {
    id: "meeting",
    name: "会议纪要",
    description: "整理为标准会议纪要格式",
    systemPrompt: `请将用户提供的内容整理为一份标准的会议纪要。
格式要求：
1. 会议概要
2. 讨论要点
3. 决议事项
4. 行动计划（负责人、截止时间）
5. 下次会议安排
使用 Markdown 格式输出。`,
  },
];
