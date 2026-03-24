CREATE TABLE IF NOT EXISTS team_data_sources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    db_type TEXT NOT NULL,
    host TEXT,
    port INTEGER,
    database_name TEXT,
    username_encrypted TEXT,
    password_encrypted TEXT,
    connection_string_encrypted TEXT,
    export_alias TEXT,
    export_default_schema TEXT,
    max_export_rows BIGINT NOT NULL DEFAULT 10000,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID NOT NULL REFERENCES users(id),
    updated_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_team_data_sources_team_updated
    ON team_data_sources(team_id, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_team_data_sources_team_name
    ON team_data_sources(team_id, name);

CREATE TABLE IF NOT EXISTS team_export_datasets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    source_id UUID NOT NULL REFERENCES team_data_sources(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    description TEXT,
    entity_name TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    schema_name TEXT,
    time_field TEXT,
    default_fields_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    fields_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID NOT NULL REFERENCES users(id),
    updated_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_team_export_datasets_team_updated
    ON team_export_datasets(team_id, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_team_export_datasets_team_name
    ON team_export_datasets(team_id, display_name);

CREATE INDEX IF NOT EXISTS idx_team_export_datasets_source
    ON team_export_datasets(source_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS team_data_export_previews (
    preview_token TEXT PRIMARY KEY,
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_id UUID NOT NULL REFERENCES team_data_sources(id) ON DELETE CASCADE,
    dataset_id UUID NOT NULL REFERENCES team_export_datasets(id) ON DELETE CASCADE,
    intent_json JSONB NOT NULL,
    source_kind TEXT NOT NULL,
    canonical_query TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_team_data_export_previews_team_user
    ON team_data_export_previews(team_id, user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_team_data_export_previews_expires
    ON team_data_export_previews(expires_at);
