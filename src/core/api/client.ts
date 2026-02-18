import { useAuthStore } from "@/store/auth-store";
import { getServerUrl } from "@/store/server-store";
import { handleError } from "@/core/errors";

interface RequestOptions extends RequestInit {
  params?: Record<string, string | number | undefined>;
  skipAuth?: boolean;
}

let isRefreshing = false;
let refreshPromise: Promise<boolean> | null = null;

async function tryRefreshToken(): Promise<boolean> {
  if (isRefreshing && refreshPromise) {
    return refreshPromise;
  }
  isRefreshing = true;
  refreshPromise = (async () => {
    try {
      const { refreshToken } = useAuthStore.getState();
      if (!refreshToken) return false;

      const baseUrl = getServerUrl();
      const res = await fetch(`${baseUrl}/v1/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });

      if (!res.ok) return false;

      const data = await res.json();
      useAuthStore.getState().login(
        data.user,
        data.access_token,
        data.refresh_token,
      );
      return true;
    } catch (e) {
      handleError(e, { context: "刷新Token", silent: true });
      return false;
    } finally {
      isRefreshing = false;
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

async function request<T>(
  path: string,
  options: RequestOptions = {},
  retried = false,
): Promise<T> {
  const { token, logout } = useAuthStore.getState();
  const { params, headers, skipAuth, ...rest } = options;

  const baseUrl = getServerUrl();
  let url = `${baseUrl}/v1${path}`;
  if (params) {
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) searchParams.append(key, value.toString());
    });
    url += `?${searchParams.toString()}`;
  }

  const defaultHeaders: Record<string, string> = {};
  const isFormData = rest.body instanceof FormData;
  if (!isFormData) {
    defaultHeaders["Content-Type"] = "application/json";
  }

  if (token && !skipAuth) {
    defaultHeaders["Authorization"] = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    ...rest,
    headers: {
      ...defaultHeaders,
      ...headers,
    },
  });

  // 401 → 自动尝试 refresh
  if (response.status === 401 && !retried && !skipAuth) {
    const refreshed = await tryRefreshToken();
    if (refreshed) {
      return request<T>(path, options, true);
    }
    logout();
    window.dispatchEvent(new CustomEvent("open-login-modal"));
    throw new Error("Unauthorized");
  }

  if (response.status === 401) {
    logout();
    window.dispatchEvent(new CustomEvent("open-login-modal"));
    throw new Error("Unauthorized");
  }

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }

  return data as T;
}

export const api = {
  get: <T>(path: string, params?: Record<string, any>) =>
    request<T>(path, { method: "GET", params }),
  post: <T>(path: string, body?: any) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body) }),
  put: <T>(path: string, body?: any) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  patch: <T>(path: string, body?: any) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
  upload: <T>(path: string, formData: FormData) =>
    request<T>(path, { method: "POST", body: formData }),
};
