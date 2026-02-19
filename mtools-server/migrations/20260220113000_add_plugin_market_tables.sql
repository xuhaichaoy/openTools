-- Plugin submission queue (developer uploads -> manual review)
CREATE TABLE IF NOT EXISTS plugin_submissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    file_name TEXT NOT NULL,
    package_size_bytes BIGINT NOT NULL,
    manifest_json JSONB,
    status TEXT NOT NULL DEFAULT 'pending_review', -- pending_review, rejected, approved, published
    review_note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plugin_submissions_user_created
ON plugin_submissions(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_plugin_submissions_status_created
ON plugin_submissions(status, created_at DESC);

-- Published plugin market catalog
CREATE TABLE IF NOT EXISTS plugin_market_apps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    submission_id UUID REFERENCES plugin_submissions(id) ON DELETE SET NULL,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    tag TEXT NOT NULL DEFAULT '工具',
    version TEXT NOT NULL DEFAULT '0.0.0',
    installs BIGINT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'published', -- draft, published, archived
    icon_url TEXT,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plugin_market_apps_status_installs
ON plugin_market_apps(status, installs DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_plugin_market_apps_name
ON plugin_market_apps(name);
