import { useEffect } from "react";
import { useAuthStore } from "@/store/auth-store";
import {
  AUTH_SESSION_KEEPALIVE_INTERVAL_MS,
  ensureFreshAuthToken,
} from "@/core/auth/session";

export function useAuthSessionKeeper(): void {
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn);
  const refreshToken = useAuthStore((s) => s.refreshToken);

  useEffect(() => {
    if (!isLoggedIn || !refreshToken) return;

    const refreshSilently = (reason: string, force = false) => {
      void ensureFreshAuthToken({
        reason,
        force,
        promptOnFailure: false,
        logoutOnFatal: false,
      });
    };

    refreshSilently("session_keeper_bootstrap");

    const intervalId = window.setInterval(() => {
      refreshSilently("session_keeper_interval", true);
    }, AUTH_SESSION_KEEPALIVE_INTERVAL_MS);

    const handleFocus = () => {
      refreshSilently("session_keeper_focus");
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refreshSilently("session_keeper_visibility");
      }
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [isLoggedIn, refreshToken]);
}
