import { create } from "zustand";
import { persist, createJSONStorage, type StateStorage } from "zustand/middleware";
import { load } from "@tauri-apps/plugin-store";
import { handleError } from "@/core/errors";

export interface User {
  id: string;
  phone?: string;
  email?: string;
  username: string;
  avatar_url?: string;
  plan: "free" | "pro" | "team";
  energy: number;
  registered_at?: string;
}

interface AuthState {
  user: User | null;
  token: string | null;
  refreshToken: string | null;
  isLoggedIn: boolean;
  setUser: (user: User | null) => void;
  setToken: (token: string | null) => void;
  setRefreshToken: (refreshToken: string | null) => void;
  login: (user: User, token: string, refreshToken?: string) => void;
  logout: () => void;
  updateEnergy: (energy: number) => void;
}

// Tauri Store 实例缓存
let storePromise: ReturnType<typeof load> | null = null;
function getStore() {
  if (!storePromise) {
    storePromise = load("auth.json", { autoSave: true });
  }
  return storePromise;
}

// 基于 tauri-plugin-store 的安全存储适配器
const tauriStorage: StateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    try {
      const store = await getStore();
      const value = await store.get<string>(name);
      return value ?? null;
    } catch (e) {
      handleError(e, { context: "读取认证数据", silent: true });
      return null;
    }
  },
  setItem: async (name: string, value: string): Promise<void> => {
    try {
      const store = await getStore();
      await store.set(name, value);
      await store.save();
    } catch (e) {
      handleError(e, { context: "保存认证数据", silent: true });
    }
  },
  removeItem: async (name: string): Promise<void> => {
    try {
      const store = await getStore();
      await store.delete(name);
      await store.save();
    } catch (e) {
      handleError(e, { context: "删除认证数据", silent: true });
    }
  },
};

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      token: null,
      refreshToken: null,
      isLoggedIn: false,

      setUser: (user) => set({ user, isLoggedIn: !!user }),
      setToken: (token) => set({ token }),
      setRefreshToken: (refreshToken) => set({ refreshToken }),

      login: (user, token, refreshToken) =>
        set({
          user,
          token,
          refreshToken: refreshToken ?? null,
          isLoggedIn: true,
        }),

      logout: () =>
        set({
          user: null,
          token: null,
          refreshToken: null,
          isLoggedIn: false,
        }),

      updateEnergy: (energy) =>
        set((state) =>
          state.user ? { user: { ...state.user, energy } } : {},
        ),
    }),
    {
      name: "mtools-auth",
      storage: createJSONStorage(() => tauriStorage),
    },
  ),
);
