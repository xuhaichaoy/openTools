import { create } from "zustand";
import { persist, createJSONStorage, type StateStorage } from "zustand/middleware";
import { load } from "@tauri-apps/plugin-store";
import { handleError } from "@/core/errors";

const DEFAULT_SERVER_URL = "http://localhost:3000";

interface ServerState {
  serverUrl: string;
  setServerUrl: (url: string) => void;
  getBaseUrl: () => string;
}

let storePromise: ReturnType<typeof load> | null = null;
function getStore() {
  if (!storePromise) {
    storePromise = load("server-settings.json", { autoSave: true });
  }
  return storePromise;
}

const tauriStorage: StateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    try {
      const store = await getStore();
      return (await store.get<string>(name)) ?? null;
    } catch (e) {
      handleError(e, { context: "读取服务器配置", silent: true });
      return null;
    }
  },
  setItem: async (name: string, value: string): Promise<void> => {
    try {
      const store = await getStore();
      await store.set(name, value);
      await store.save();
    } catch (e) {
      handleError(e, { context: "保存服务器配置", silent: true });
    }
  },
  removeItem: async (name: string): Promise<void> => {
    try {
      const store = await getStore();
      await store.delete(name);
      await store.save();
    } catch (e) {
      handleError(e, { context: "删除服务器配置", silent: true });
    }
  },
};

export const useServerStore = create<ServerState>()(
  persist(
    (set, get) => ({
      serverUrl: DEFAULT_SERVER_URL,
      setServerUrl: (url: string) => {
        const normalized = url.replace(/\/+$/, "");
        set({ serverUrl: normalized || DEFAULT_SERVER_URL });
      },
      getBaseUrl: () => get().serverUrl || DEFAULT_SERVER_URL,
    }),
    {
      name: "mtools-server-settings",
      storage: createJSONStorage(() => tauriStorage),
    },
  ),
);

/** 快捷获取当前后端地址（非 hook 场景使用） */
export function getServerUrl(): string {
  return useServerStore.getState().serverUrl || DEFAULT_SERVER_URL;
}
