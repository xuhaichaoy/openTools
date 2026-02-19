-- Seed builtin-market apps: these are shipped in binary but require explicit install in app.
INSERT INTO plugin_market_apps (slug, name, description, tag, version, status, installs)
VALUES
  ('snippets', '快捷短语', '文本片段管理，支持静态模板和 AI 动态生成', '工具', '1.0.0', 'published', 0),
  ('image-search', '以图搜图', '反向图片搜索 + AI 图片理解', '工具', '1.0.0', 'published', 0),
  ('bookmarks', '网页书签', '书签管理，支持 Chrome/Firefox 导入', '工具', '1.0.0', 'published', 0)
ON CONFLICT (slug) DO UPDATE
SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  tag = EXCLUDED.tag,
  version = EXCLUDED.version,
  status = 'published',
  updated_at = NOW();
