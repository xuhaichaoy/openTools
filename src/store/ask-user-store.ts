import { create } from "zustand";
import type { AskUserQuestion, AskUserAnswers } from "@/plugins/builtin/SmartAgent/core/default-tools";

export type AskUserSource = "agent" | "cluster" | "actor_dialog";

export interface AskUserState {
  /** 当前弹窗数据，null 表示无弹窗 */
  dialog: {
    questions: AskUserQuestion[];
    resolve: (answers: AskUserAnswers) => void;
    /** 来源模式 */
    source: AskUserSource;
    /** 任务描述 / 用户原始 query */
    taskDescription?: string;
  } | null;

  /** 打开弹窗 */
  open: (params: {
    questions: AskUserQuestion[];
    source: AskUserSource;
    taskDescription?: string;
  }) => Promise<AskUserAnswers>;

  /** 提交答案并关闭 */
  submit: (answers: AskUserAnswers) => void;

  /** 取消（返回空答案） */
  dismiss: () => void;
}

export const useAskUserStore = create<AskUserState>((set, get) => ({
  dialog: null,

  open: ({ questions, source, taskDescription }) =>
    new Promise<AskUserAnswers>((resolve) => {
      set({
        dialog: { questions, resolve, source, taskDescription },
      });
    }),

  submit: (answers) => {
    const { dialog } = get();
    if (dialog) {
      dialog.resolve(answers);
      set({ dialog: null });
    }
  },

  dismiss: () => {
    const { dialog } = get();
    if (dialog) {
      const empty: AskUserAnswers = {};
      for (const q of dialog.questions) empty[q.id] = "";
      dialog.resolve(empty);
      set({ dialog: null });
    }
  },
}));
