import { create } from "zustand";
import { persist } from "zustand/middleware";
import { tauriPersistStorage } from "@/core/storage";

export interface User {
  id: string;
  phone?: string;
  email?: string;
  username: string;
  avatar_url?: string;
  plan: "free" | "pro";
  plan_expires_at?: string | null;
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

function normalizeUser(user: User | null): User | null {
  if (!user) return null;
  return {
    ...user,
    plan: user.plan === "pro" ? "pro" : "free",
  };
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      token: null,
      refreshToken: null,
      isLoggedIn: false,

      setUser: (user) => {
        const normalized = normalizeUser(user);
        set({ user: normalized, isLoggedIn: !!normalized });
      },
      setToken: (token) => set({ token }),
      setRefreshToken: (refreshToken) => set({ refreshToken }),

      login: (user, token, refreshToken) => {
        const normalized = normalizeUser(user);
        set({
          user: normalized,
          token,
          refreshToken: refreshToken ?? null,
          isLoggedIn: !!normalized,
        });
      },

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
      storage: tauriPersistStorage("auth.json", "认证数据"),
    },
  ),
);
