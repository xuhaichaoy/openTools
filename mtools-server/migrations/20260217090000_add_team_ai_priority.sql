-- Add priority for manual failover order in team AI configs
ALTER TABLE team_ai_configs
ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 1000;

-- Backfill deterministic order within each team/model group
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY team_id, model_name
      ORDER BY created_at DESC, id ASC
    ) AS rn
  FROM team_ai_configs
)
UPDATE team_ai_configs t
SET priority = ranked.rn
FROM ranked
WHERE t.id = ranked.id;

CREATE INDEX IF NOT EXISTS idx_team_ai_configs_order
ON team_ai_configs(team_id, model_name, is_active, priority, created_at DESC);

COMMENT ON COLUMN team_ai_configs.priority
IS 'Lower number means higher priority within the same model_name group';
