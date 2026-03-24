CREATE TABLE IF NOT EXISTS team_published_skills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    provider TEXT NOT NULL DEFAULT 'clawhub',
    slug TEXT NOT NULL,
    version TEXT NOT NULL DEFAULT '',
    display_name TEXT NOT NULL,
    description TEXT,
    skill_md TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    published_by UUID NOT NULL REFERENCES users(id),
    updated_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(team_id, provider, slug, version)
);

CREATE INDEX IF NOT EXISTS idx_team_published_skills_team_active
    ON team_published_skills(team_id, is_active, updated_at DESC);
