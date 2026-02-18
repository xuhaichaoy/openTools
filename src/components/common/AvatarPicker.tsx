import { useState, useRef } from "react";
import { Camera, Check, Loader2 } from "lucide-react";
import { useAuthStore } from "@/store/auth-store";
import { getServerUrl } from "@/store/server-store";
import { resolveAvatarUrl } from "@/utils/avatar";

const BRAND = "#F28F36";

const DEFAULT_AVATARS = [
  { id: "cat", emoji: "🐱", bg: "#FFE0B2" },
  { id: "dog", emoji: "🐶", bg: "#C8E6C9" },
  { id: "fox", emoji: "🦊", bg: "#FFCCBC" },
  { id: "bear", emoji: "🐻", bg: "#D7CCC8" },
  { id: "panda", emoji: "🐼", bg: "#F5F5F5" },
  { id: "rabbit", emoji: "🐰", bg: "#F8BBD0" },
  { id: "koala", emoji: "🐨", bg: "#B3E5FC" },
  { id: "lion", emoji: "🦁", bg: "#FFF9C4" },
  { id: "tiger", emoji: "🐯", bg: "#FFE0B2" },
  { id: "owl", emoji: "🦉", bg: "#D1C4E9" },
  { id: "whale", emoji: "🐳", bg: "#B2EBF2" },
  { id: "unicorn", emoji: "🦄", bg: "#F3E5F5" },
  { id: "robot", emoji: "🤖", bg: "#CFD8DC" },
  { id: "alien", emoji: "👽", bg: "#C8E6C9" },
  { id: "rocket", emoji: "🚀", bg: "#BBDEFB" },
  { id: "star", emoji: "⭐", bg: "#FFF9C4" },
];

/**
 * Encodes a default avatar as a data URI (SVG with emoji).
 * This avoids needing static image files.
 */
function defaultAvatarUrl(avatar: (typeof DEFAULT_AVATARS)[number]): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="20" fill="${avatar.bg}"/>
    <text x="50" y="58" text-anchor="middle" dominant-baseline="central" font-size="52">${avatar.emoji}</text>
  </svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

interface AvatarPickerProps {
  value: string;
  onChange: (url: string) => void;
}

export function AvatarPicker({ value, onChange }: AvatarPickerProps) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      setUploadError("请选择图片文件");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setUploadError("图片不能超过 2MB");
      return;
    }

    setUploading(true);
    setUploadError("");
    try {
      const formData = new FormData();
      formData.append("avatar", file);

      const { token } = useAuthStore.getState();
      const baseUrl = getServerUrl();
      const res = await fetch(`${baseUrl}/v1/users/me/avatar`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "上传失败");
      }

      const data = await res.json();
      onChange(data.avatar_url);
    } catch (err: any) {
      setUploadError(err?.message || "上传失败");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const isDefaultAvatar = value.startsWith("data:image/svg+xml");
  const currentDefaultId = isDefaultAvatar
    ? DEFAULT_AVATARS.find((a) => defaultAvatarUrl(a) === value)?.id
    : null;

  return (
    <div className="space-y-3">
      <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
        选择头像
      </label>

      {/* 当前头像预览 */}
      <div className="flex items-center gap-3">
        <div className="w-14 h-14 rounded-xl overflow-hidden border-2 border-[var(--color-border)] shrink-0 flex items-center justify-center bg-[var(--color-bg-secondary)]">
          {value ? (
            <img src={resolveAvatarUrl(value)} alt="头像" className="w-full h-full object-cover" />
          ) : (
            <span className="text-2xl">😀</span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs text-[var(--color-text)]">
            {isDefaultAvatar ? "默认头像" : value ? "自定义头像" : "未设置"}
          </p>
          {value && (
            <button
              onClick={() => onChange("")}
              className="text-[10px] text-red-400 hover:text-red-500 mt-0.5"
            >
              移除头像
            </button>
          )}
        </div>
      </div>

      {/* 默认头像网格 */}
      <div>
        <p className="text-[10px] text-[var(--color-text-secondary)] mb-1.5">预设头像</p>
        <div className="grid grid-cols-8 gap-1.5">
          {DEFAULT_AVATARS.map((avatar) => {
            const url = defaultAvatarUrl(avatar);
            const selected = currentDefaultId === avatar.id;
            return (
              <button
                key={avatar.id}
                onClick={() => onChange(url)}
                className="relative w-9 h-9 rounded-lg overflow-hidden border-2 transition-all hover:scale-110"
                style={{
                  borderColor: selected ? BRAND : "transparent",
                  boxShadow: selected ? `0 0 0 1px ${BRAND}` : "none",
                }}
              >
                <img src={url} alt={avatar.emoji} className="w-full h-full" />
                {selected && (
                  <div
                    className="absolute inset-0 flex items-center justify-center"
                    style={{ background: `${BRAND}40` }}
                  >
                    <Check className="w-3.5 h-3.5 text-white" />
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* 上传自定义头像 */}
      <div>
        <p className="text-[10px] text-[var(--color-text-secondary)] mb-1.5">自定义上传</p>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          onChange={handleFileChange}
          className="hidden"
        />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-dashed border-[var(--color-border)] text-xs text-[var(--color-text-secondary)] hover:border-[#F28F36]/50 hover:text-[#F28F36] transition-all disabled:opacity-50"
        >
          {uploading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Camera className="w-3.5 h-3.5" />
          )}
          {uploading ? "上传中…" : "选择图片（≤2MB）"}
        </button>
        {uploadError && (
          <p className="text-[10px] text-red-500 mt-1">{uploadError}</p>
        )}
      </div>
    </div>
  );
}
