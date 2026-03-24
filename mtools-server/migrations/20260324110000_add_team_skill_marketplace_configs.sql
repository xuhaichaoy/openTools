CREATE TABLE IF NOT EXISTS team_skill_marketplace_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    provider TEXT NOT NULL DEFAULT 'clawhub',
    site_url TEXT NOT NULL,
    registry_url TEXT NOT NULL,
    api_token TEXT NOT NULL DEFAULT '',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID NOT NULL REFERENCES users(id),
    updated_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(team_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_team_skill_marketplace_configs_team_updated
    ON team_skill_marketplace_configs(team_id, provider, updated_at DESC);
