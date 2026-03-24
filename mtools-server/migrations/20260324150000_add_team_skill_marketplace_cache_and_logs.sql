CREATE TABLE IF NOT EXISTS team_skill_marketplace_cache (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    provider TEXT NOT NULL DEFAULT 'clawhub',
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    latest_version TEXT,
    versions_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    author TEXT,
    tags_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    icon_url TEXT,
    raw_metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(team_id, provider, slug)
);

CREATE INDEX IF NOT EXISTS idx_team_skill_marketplace_cache_team_provider
    ON team_skill_marketplace_cache(team_id, provider, last_synced_at DESC);

CREATE TABLE IF NOT EXISTS team_skill_install_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    published_skill_id UUID NOT NULL REFERENCES team_published_skills(id) ON DELETE CASCADE,
    action TEXT NOT NULL DEFAULT 'install',
    status TEXT NOT NULL,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_team_skill_install_logs_team_skill_created
    ON team_skill_install_logs(team_id, published_skill_id, created_at DESC);

CREATE TABLE IF NOT EXISTS team_skill_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    provider TEXT,
    skill_slug TEXT,
    skill_version TEXT,
    published_skill_id UUID REFERENCES team_published_skills(id) ON DELETE SET NULL,
    detail_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_team_skill_audit_logs_team_created
    ON team_skill_audit_logs(team_id, created_at DESC);
