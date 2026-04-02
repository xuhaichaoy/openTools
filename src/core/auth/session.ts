import { createLogger } from "@/core/logger";
import { handleError } from "@/core/errors";
import { getServerUrl } from "@/store/server-store";
import { useAuthStore } from "@/store/auth-store";

const log = createLogger("AuthSession");

export const AUTH_TOKEN_MAX_AGE_MS = 20 * 60 * 1000;
export const AUTH_SESSION_KEEPALIVE_INTERVAL_MS = 10 * 60 * 1000;

const FATAL_REFRESH_STATUS = new Set([400, 401, 403]);
const FATAL_REFRESH_PATTERNS = [
  /invalid[\s_-]*refresh/i,
  /refresh[\s_-]*token.*expired/i,
  /invalid[\s_-]*token/i,
  /unauthorized/i,
  /forbidden/i,
];

let refreshPromise: Promise<AuthRefreshResult> | null = null;

export interface AuthRefreshResult {
  ok: boolean;
  refreshed: boolean;
  fatal: boolean;
  accessToken: string | null;
  status?: number;
  error?: string;
}

interface RefreshAuthSessionOptions {
  reason?: string;
  promptOnFailure?: boolean;
  logoutOnFatal?: boolean;
}

interface EnsureFreshAuthTokenOptions extends RefreshAuthSessionOptions {
  force?: boolean;
  maxAgeMs?: number;
}

function promptReLogin(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("open-login-modal"));
  }
}

function getCurrentToken(): string | null {
  const token = String(useAuthStore.getState().token || "").trim();
  return token || null;
}

function isFatalRefreshFailure(status: number, payload: string): boolean {
  if (FATAL_REFRESH_STATUS.has(status)) return true;
  return FATAL_REFRESH_PATTERNS.some((pattern) => pattern.test(payload));
}

function coerceRefreshError(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (payload instanceof Error) return payload.message;
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

export function getAuthTokenAgeMs(): number | null {
  const token = getCurrentToken();
  if (!token) return null;
  const updatedAt = useAuthStore.getState().tokenUpdatedAt;
  if (!updatedAt || !Number.isFinite(updatedAt)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Date.now() - updatedAt);
}

export async function refreshAuthSession(
  options: RefreshAuthSessionOptions = {},
): Promise<AuthRefreshResult> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const auth = useAuthStore.getState();
    const refreshToken = String(auth.refreshToken || "").trim();
    if (!refreshToken) {
      log.warn("Skip refresh: missing refresh token", { reason: options.reason ?? "unspecified" });
      return {
        ok: false,
        refreshed: false,
        fatal: false,
        accessToken: getCurrentToken(),
        error: "missing_refresh_token",
      } satisfies AuthRefreshResult;
    }

    const refreshUrl = `${getServerUrl()}/v1/auth/refresh`;
    const startedAt = Date.now();
    try {
      log.info("Refreshing auth session", {
        reason: options.reason ?? "unspecified",
        hasAccessToken: Boolean(getCurrentToken()),
      });

      const response = await fetch(refreshUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });

      if (!response.ok) {
        const raw = await response.text().catch(() => "");
        const fatal = isFatalRefreshFailure(response.status, raw);
        log.warn("Auth refresh rejected", {
          reason: options.reason ?? "unspecified",
          status: response.status,
          fatal,
          elapsedMs: Date.now() - startedAt,
          preview: raw.slice(0, 240),
        });

        if (fatal && options.logoutOnFatal !== false) {
          useAuthStore.getState().logout();
          if (options.promptOnFailure !== false) {
            promptReLogin();
          }
        }

        return {
          ok: false,
          refreshed: false,
          fatal,
          accessToken: getCurrentToken(),
          status: response.status,
          error: raw || `refresh_http_${response.status}`,
        } satisfies AuthRefreshResult;
      }

      const data = await response.json().catch((error) => {
        throw new Error(`invalid_refresh_response: ${coerceRefreshError(error)}`);
      });
      if (!data?.access_token || !data?.user) {
        log.warn("Auth refresh returned incomplete payload", {
          reason: options.reason ?? "unspecified",
          elapsedMs: Date.now() - startedAt,
          hasAccessToken: Boolean(data?.access_token),
          hasUser: Boolean(data?.user),
        });
        return {
          ok: false,
          refreshed: false,
          fatal: false,
          accessToken: getCurrentToken(),
          error: "invalid_refresh_payload",
        } satisfies AuthRefreshResult;
      }

      useAuthStore.getState().login(
        data.user,
        data.access_token,
        data.refresh_token ?? refreshToken,
      );
      log.info("Auth refresh completed", {
        reason: options.reason ?? "unspecified",
        elapsedMs: Date.now() - startedAt,
      });
      return {
        ok: true,
        refreshed: true,
        fatal: false,
        accessToken: String(data.access_token),
      } satisfies AuthRefreshResult;
    } catch (error) {
      handleError(error, { context: "刷新登录会话", silent: true });
      log.warn("Auth refresh failed", {
        reason: options.reason ?? "unspecified",
        elapsedMs: Date.now() - startedAt,
        error: coerceRefreshError(error),
      });
      return {
        ok: false,
        refreshed: false,
        fatal: false,
        accessToken: getCurrentToken(),
        error: coerceRefreshError(error),
      } satisfies AuthRefreshResult;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

export async function ensureFreshAuthToken(
  options: EnsureFreshAuthTokenOptions = {},
): Promise<string | null> {
  const currentToken = getCurrentToken();
  const refreshToken = String(useAuthStore.getState().refreshToken || "").trim();
  if (!refreshToken) return currentToken;

  const maxAgeMs = options.maxAgeMs ?? AUTH_TOKEN_MAX_AGE_MS;
  const tokenAgeMs = getAuthTokenAgeMs();
  const shouldRefresh =
    options.force === true
    || !currentToken
    || tokenAgeMs === null
    || tokenAgeMs >= maxAgeMs;

  if (!shouldRefresh) {
    return currentToken;
  }

  const refreshed = await refreshAuthSession(options);
  return refreshed.accessToken ?? currentToken;
}
