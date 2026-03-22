import { useState, useEffect } from "react";
import { X, Mail, Loader2 } from "lucide-react";
import { api } from "@/core/api/client";
import { useAuthStore } from "@/store/auth-store";

const BRAND = "#F28F36";

export function LoginModal() {
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"phone" | "email">("email");
  const [isRegistering, setIsRegistering] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  // Form states
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const [countdown, setCountdown] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");
  const { login } = useAuthStore();

  useEffect(() => {
    const handleOpen = () => setIsOpen(true);
    window.addEventListener("open-login-modal", handleOpen);
    return () => window.removeEventListener("open-login-modal", handleOpen);
  }, []);

  useEffect(() => {
    let timer: any;
    if (countdown > 0) {
      timer = setInterval(() => setCountdown((c) => c - 1), 1000);
    }
    return () => clearInterval(timer);
  }, [countdown]);

  const handleSendCode = async () => {
    if (!phone || countdown > 0) return;
    setErrorMsg("");
    try {
      await api.post("/auth/sms/send", { phone });
      setCountdown(60);
    } catch (err: any) {
      setErrorMsg(err.message || "发送验证码失败");
    }
  };

  const handleLogin = async () => {
    setIsLoading(true);
    setErrorMsg("");
    try {
      let res: any;
      if (activeTab === "phone") {
        res = await api.post("/auth/sms/verify", { phone, code });
      } else {
        if (isRegistering) {
          res = await api.post("/auth/email/register", {
            email,
            password,
            username: username || undefined,
          });
        } else {
          res = await api.post("/auth/email/login", { email, password });
        }
      }

      login(res.user, res.access_token, res.refresh_token);
      setIsOpen(false);
    } catch (err: any) {
      setErrorMsg(err.message || (isRegistering ? "注册失败" : "登录失败"));
    } finally {
      setIsLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={() => setIsOpen(false)}
    >
      <div
        className="bg-[var(--color-bg)] w-[380px] rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden animate-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--color-border)]">
          <h2 className="text-lg font-bold text-[var(--color-text)]">
            {isRegistering ? "创建账号" : "登录 / 注册"}
          </h2>
          <button
            onClick={() => setIsOpen(false)}
            className="p-1 hover:bg-[var(--color-bg-secondary)] rounded-full transition-colors"
          >
            <X className="w-5 h-5 text-[var(--color-text-secondary)]" />
          </button>
        </div>

        {/* Tabs - 手机号登录暂时隐藏 */}

        {/* Form Content */}
        <div className="p-5">
            <div className="space-y-3">
              {isRegistering && (
                <div className="space-y-1.5">
                  <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
                    昵称
                  </label>
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="你的昵称"
                    className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-2 px-4 outline-none focus:ring-2 transition-all text-sm"
                    style={{ "--tw-ring-color": `${BRAND}20` } as any}
                  />
                </div>
              )}
              <div className="space-y-1.5">
                <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
                  邮箱地址
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@example.com"
                  className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-2 px-4 outline-none focus:ring-2 transition-all text-sm"
                  style={{ "--tw-ring-color": `${BRAND}20` } as any}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
                  密码
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="输入密码"
                  className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-2 px-4 outline-none focus:ring-2 transition-all text-sm"
                  style={{ "--tw-ring-color": `${BRAND}20` } as any}
                />
              </div>

              <div className="flex justify-end">
                <button
                  onClick={() => setIsRegistering(!isRegistering)}
                  className="text-[10px] font-medium transition-colors"
                  style={{ color: BRAND }}
                >
                  {isRegistering ? "已有账号？去登录" : "没有账号？去注册"}
                </button>
              </div>
            </div>

          {errorMsg && (
            <div className="mt-2 text-xs text-red-500 bg-red-500/10 rounded-lg px-3 py-1.5">
              {errorMsg === "Unauthorized" && !isRegistering
                ? "账号或密码错误，请注册新账号"
                : errorMsg}
            </div>
          )}

          <button
            onClick={handleLogin}
            disabled={isLoading || !email || !password}
            className="w-full mt-4 text-white font-bold py-2.5 rounded-lg shadow-lg transition-all transform active:scale-[0.98] flex items-center justify-center gap-2 text-sm"
            style={{
              backgroundColor: BRAND,
              boxShadow: `${BRAND}33 0px 8px 16px`,
            }}
          >
            {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
            {isRegistering ? "立即注册" : "登录"}
          </button>
        </div>

        {/* OAuth Section */}
        {/* <div className="px-5 pb-6">
          <div className="relative flex items-center gap-4 py-1">
            <div className="flex-1 h-px bg-[var(--color-border)]"></div>
            <span className="text-[10px] text-[var(--color-text-secondary)] uppercase font-bold tracking-wider">
              其他登录方式
            </span>
            <div className="flex-1 h-px bg-[var(--color-border)]"></div>
          </div>

          <div className="flex justify-center gap-3 mt-3">
            <button className="p-2.5 rounded-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] hover:bg-[var(--color-bg-tertiary)] transition-colors group">
              <Github className="w-4 h-4 text-[var(--color-text)] group-hover:scale-110 transition-transform" />
            </button>
            <button className="p-2.5 rounded-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] hover:bg-[var(--color-bg-tertiary)] transition-colors group">
              <Chrome className="w-4 h-4 text-[var(--color-text)] group-hover:scale-110 transition-transform" />
            </button>
          </div>
        </div> */}
      </div>
    </div>
  );
}

export default LoginModal;
