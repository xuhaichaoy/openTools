-- Subscription fields for teams
ALTER TABLE teams
ADD COLUMN IF NOT EXISTS subscription_plan TEXT NOT NULL DEFAULT 'trial',
ADD COLUMN IF NOT EXISTS subscription_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS subscription_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Normalize legacy user plan values
UPDATE users
SET plan = 'pro'
WHERE plan = 'team';

-- Backfill legacy teams into trial mode
UPDATE teams
SET subscription_plan = COALESCE(NULLIF(subscription_plan, ''), 'trial'),
    subscription_started_at = created_at,
    subscription_expires_at = COALESCE(subscription_expires_at, created_at + INTERVAL '3 days'),
    subscription_updated_at = NOW()
WHERE subscription_plan = 'trial'
  OR subscription_plan IS NULL
  OR subscription_plan = '';

-- Guard rails for team subscription semantics
ALTER TABLE teams
DROP CONSTRAINT IF EXISTS chk_teams_subscription_plan;

ALTER TABLE teams
ADD CONSTRAINT chk_teams_subscription_plan
CHECK (subscription_plan IN ('trial', 'pro'));

ALTER TABLE teams
DROP CONSTRAINT IF EXISTS chk_teams_trial_requires_expiry;

ALTER TABLE teams
ADD CONSTRAINT chk_teams_trial_requires_expiry
CHECK (subscription_plan <> 'trial' OR subscription_expires_at IS NOT NULL);

COMMENT ON COLUMN teams.subscription_plan
IS 'Team subscription plan: trial|pro';

COMMENT ON COLUMN teams.subscription_expires_at
IS 'NULL means non-expiring for pro plan.';

-- Team workflow templates (server-side shared workflow body)
CREATE TABLE IF NOT EXISTS team_workflow_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    icon TEXT,
    category TEXT,
    workflow_json JSONB NOT NULL,
    version BIGINT NOT NULL DEFAULT 1,
    created_by UUID NOT NULL REFERENCES users(id),
    updated_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_team_workflow_templates_team_updated
ON team_workflow_templates(team_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_team_workflow_templates_team_creator
ON team_workflow_templates(team_id, created_by);
