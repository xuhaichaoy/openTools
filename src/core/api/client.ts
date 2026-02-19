import { useAuthStore } from "@/store/auth-store";
import { getServerUrl } from "@/store/server-store";
import { handleError } from "@/core/errors";

interface RequestOptions extends RequestInit {
  params?: Record<string, string | number | undefined>;
  skipAuth?: boolean;
}

export interface ApiErrorOptions {
  status: number;
  code: string;
  message: string;
  details?: unknown;
  path: string;
}

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  path: string;

  constructor(options: ApiErrorOptions) {
    super(options.message);
    this.name = "ApiError";
    this.status = options.status;
    this.code = options.code;
    this.details = options.details;
    this.path = options.path;
  }
}

export function assertResponseShape<T>(
  value: unknown,
  guard: (input: unknown) => input is T,
  path: string,
  message = "Invalid response shape",
): T {
  if (guard(value)) {
    return value;
  }

  throw new ApiError({
    status: 200,
    code: "INVALID_RESPONSE_SHAPE",
    message,
    details: value,
    path,
  });
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

async function parseBody(response: Response): Promise<{
  parsed: any;
  rawText: string;
  parseError: Error | null;
}> {
  const rawText = await response.text();
  if (!rawText) {
    return { parsed: null, rawText: "", parseError: null };
  }

  try {
    const parsed = JSON.parse(rawText);
    return { parsed, rawText, parseError: null };
  } catch (error) {
    return {
      parsed: null,
      rawText,
      parseError: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

function buildApiError(
  path: string,
  status: number,
  parsed: any,
  rawText: string,
  fallbackCode: string,
  fallbackMessage: string,
): ApiError {
  const code =
    typeof parsed?.code === "string" && parsed.code.trim().length > 0
      ? parsed.code
      : fallbackCode;
  const message =
    typeof parsed?.message === "string" && parsed.message.trim().length > 0
      ? parsed.message
      : typeof parsed?.error === "string" && parsed.error.trim().length > 0
        ? parsed.error
        : rawText || fallbackMessage;

  return new ApiError({
    status,
    code,
    message,
    details: parsed?.details,
    path,
  });
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

  let response: Response;
  try {
    response = await fetch(url, {
      ...rest,
      headers: {
        ...defaultHeaders,
        ...headers,
      },
    });
  } catch (error) {
    throw new ApiError({
      status: 0,
      code: "NETWORK_ERROR",
      message: error instanceof Error ? error.message : "Network error",
      details: error,
      path,
    });
  }

  // 401 → 自动尝试 refresh
  if (response.status === 401 && !retried && !skipAuth) {
    const refreshed = await tryRefreshToken();
    if (refreshed) {
      return request<T>(path, options, true);
    }
    logout();
    window.dispatchEvent(new CustomEvent("open-login-modal"));
    throw new ApiError({
      status: 401,
      code: "UNAUTHORIZED",
      message: "Unauthorized",
      path,
    });
  }

  if (response.status === 401) {
    logout();
    window.dispatchEvent(new CustomEvent("open-login-modal"));
    throw new ApiError({
      status: 401,
      code: "UNAUTHORIZED",
      message: "Unauthorized",
      path,
    });
  }

  const { parsed, rawText, parseError } = await parseBody(response);

  if (!response.ok) {
    throw buildApiError(
      path,
      response.status,
      parsed,
      rawText,
      `HTTP_${response.status}`,
      "Request failed",
    );
  }

  if (response.status === 204 || rawText.length === 0) {
    return undefined as T;
  }

  if (parseError) {
    throw new ApiError({
      status: response.status,
      code: "INVALID_JSON_RESPONSE",
      message: `Invalid JSON response: ${parseError.message}`,
      details: rawText,
      path,
    });
  }

  return parsed as T;
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
