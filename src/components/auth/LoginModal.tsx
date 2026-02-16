import { useState, useEffect } from "react";
import { X, Phone, Mail, Github, Chrome, Loader2 } from "lucide-react";
import { api } from "@/core/api/client";
import { useAuthStore } from "@/store/auth-store";

export function LoginModal() {
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"phone" | "email">("phone");
  const [isLoading, setIsLoading] = useState(false);

  // Form states
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [email, setEmail] = useState("");
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
        res = await api.post("/auth/email/login", { email, password });
      }

      login(res.user, res.access_token, res.refresh_token);
      setIsOpen(false);
    } catch (err: any) {
      setErrorMsg(err.message || "登录失败");
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
        className="bg-[var(--color-bg)] w-[400px] rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden animate-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)]">
          <h2 className="text-xl font-bold text-[var(--color-text)]">
            登录 / 注册
          </h2>
          <button
            onClick={() => setIsOpen(false)}
            className="p-1 hover:bg-[var(--color-bg-secondary)] rounded-full transition-colors"
          >
            <X className="w-5 h-5 text-[var(--color-text-secondary)]" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex p-1 gap-1 bg-[var(--color-bg-secondary)] mx-6 mt-6 rounded-lg">
          <button
            onClick={() => setActiveTab("phone")}
            className={`flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-md transition-all ${
              activeTab === "phone"
                ? "bg-[var(--color-bg)] text-[var(--color-text)] shadow-sm"
                : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
            }`}
          >
            <Phone className="w-4 h-4" />
            手机号
          </button>
          <button
            onClick={() => setActiveTab("email")}
            className={`flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-md transition-all ${
              activeTab === "email"
                ? "bg-[var(--color-bg)] text-[var(--color-text)] shadow-sm"
                : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
            }`}
          >
            <Mail className="w-4 h-4" />
            邮箱
          </button>
        </div>

        {/* Form Content */}
        <div className="p-6">
          {activeTab === "phone" ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-xs font-medium text-[var(--color-text-secondary)] uppercase">
                  手机号
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-[var(--color-text-secondary)] border-r border-[var(--color-border)] pr-2">
                    +86
                  </span>
                  <input
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="请输入手机号"
                    className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-2 pl-14 pr-4 outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all text-sm"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-xs font-medium text-[var(--color-text-secondary)] uppercase">
                  验证码
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="6 位验证码"
                    className="flex-1 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-2 px-4 outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all text-sm"
                  />
                  <button
                    onClick={handleSendCode}
                    disabled={countdown > 0 || !phone}
                    className="px-4 py-2 bg-indigo-500 hover:bg-indigo-600 text-white text-xs font-medium rounded-lg transition-colors whitespace-nowrap disabled:opacity-50 min-w-[90px]"
                  >
                    {countdown > 0 ? `${countdown}s` : "获取验证码"}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-xs font-medium text-[var(--color-text-secondary)] uppercase">
                  邮箱地址
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@example.com"
                  className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-2 px-4 outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all text-sm"
                />
              </div>
              <div className="space-y-2">
                <label className="text-xs font-medium text-[var(--color-text-secondary)] uppercase">
                  密码
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="输入密码"
                  className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-2 px-4 outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all text-sm"
                />
              </div>
            </div>
          )}

          {errorMsg && (
            <div className="mt-3 text-xs text-red-500 bg-red-500/10 rounded-lg px-3 py-2">
              {errorMsg}
            </div>
          )}

          <button
            onClick={handleLogin}
            disabled={
              isLoading ||
              (activeTab === "phone" ? !phone || !code : !email || !password)
            }
            className="w-full mt-6 bg-indigo-500 hover:bg-indigo-600 text-white font-bold py-3 rounded-lg shadow-lg shadow-indigo-500/20 transition-all transform active:scale-[0.98] flex items-center justify-center gap-2"
          >
            {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
            {activeTab === "phone" ? "进入 51ToolBox" : "登录"}
          </button>
        </div>

        {/* OAuth Section */}
        <div className="px-6 pb-8">
          <div className="relative flex items-center gap-4 py-2">
            <div className="flex-1 h-px bg-[var(--color-border)]"></div>
            <span className="text-[10px] text-[var(--color-text-secondary)] uppercase font-bold tracking-wider">
              其他登录方式
            </span>
            <div className="flex-1 h-px bg-[var(--color-border)]"></div>
          </div>

          <div className="flex justify-center gap-4 mt-4">
            <button className="p-3 rounded-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] hover:bg-[var(--color-bg-tertiary)] transition-colors group">
              <Github className="w-5 h-5 text-[var(--color-text)] group-hover:scale-110 transition-transform" />
            </button>
            <button className="p-3 rounded-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] hover:bg-[var(--color-bg-tertiary)] transition-colors group">
              <Chrome className="w-5 h-5 text-[var(--color-text)] group-hover:scale-110 transition-transform" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
