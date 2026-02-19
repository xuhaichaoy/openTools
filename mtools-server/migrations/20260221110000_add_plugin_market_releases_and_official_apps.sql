CREATE TABLE IF NOT EXISTS plugin_market_releases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id UUID NOT NULL REFERENCES plugin_market_apps(id) ON DELETE CASCADE,
    version TEXT NOT NULL,
    package_file_path TEXT NOT NULL,
    package_sha256 CHAR(64) NOT NULL,
    package_size_bytes BIGINT NOT NULL,
    status TEXT NOT NULL DEFAULT 'published', -- draft, published, archived
    created_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(app_id, version)
);

CREATE INDEX IF NOT EXISTS idx_plugin_market_releases_app_status_created
ON plugin_market_releases(app_id, status, created_at DESC);

ALTER TABLE plugin_market_apps
ADD COLUMN IF NOT EXISTS is_official BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE plugin_market_apps
ADD COLUMN IF NOT EXISTS current_release_id UUID NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'plugin_market_apps_current_release_fk'
    ) THEN
        ALTER TABLE plugin_market_apps
        ADD CONSTRAINT plugin_market_apps_current_release_fk
        FOREIGN KEY (current_release_id)
        REFERENCES plugin_market_releases(id)
        ON DELETE SET NULL;
    END IF;
END
$$;

INSERT INTO plugin_market_apps (slug, name, description, tag, version, status, installs, is_official)
VALUES
  ('dev-toolbox', '开发工具箱', 'JSON 格式化、时间戳转换、Base64 编解码', '工具', '1.0.0', 'published', 0, TRUE),
  ('note-hub', '笔记中心', '速记、AI 笔记、Markdown 编辑', '效率', '1.0.0', 'published', 0, TRUE),
  ('qr-code', '二维码', '二维码/条形码识别与生成', '工具', '1.0.0', 'published', 0, TRUE),
  ('image-search', '以图搜图', '反向图片搜索 + AI 图片理解', '工具', '1.0.0', 'published', 0, TRUE),
  ('system-actions', '系统操作', '一键执行常用系统动作', '系统', '1.0.0', 'published', 0, TRUE),
  ('snippets', '快捷短语', '文本片段管理，支持静态模板和 AI 动态生成', '工具', '1.0.0', 'published', 0, TRUE),
  ('bookmarks', '网页书签', '书签管理，支持 Chrome/Firefox 导入', '工具', '1.0.0', 'published', 0, TRUE)
ON CONFLICT (slug) DO UPDATE
SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  tag = EXCLUDED.tag,
  version = EXCLUDED.version,
  is_official = EXCLUDED.is_official,
  status = 'published',
  updated_at = NOW();
