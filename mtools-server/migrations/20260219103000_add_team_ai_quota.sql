-- 团队 AI 月额度策略
CREATE TABLE IF NOT EXISTS team_ai_quota_policy (
    team_id UUID PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
    monthly_limit_tokens BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE team_ai_quota_policy
IS 'Team-level monthly AI token quota policy. 0 means unlimited.';

COMMENT ON COLUMN team_ai_quota_policy.monthly_limit_tokens
IS 'Base monthly quota tokens for each member in the team.';

-- 团队成员月度加额（仅当月）
CREATE TABLE IF NOT EXISTS team_ai_member_quota_adjustments (
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    month_key CHAR(7) NOT NULL, -- YYYY-MM
    extra_tokens BIGINT NOT NULL DEFAULT 0,
    updated_by UUID NOT NULL REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (team_id, user_id, month_key)
);

COMMENT ON TABLE team_ai_member_quota_adjustments
IS 'Per-member monthly extra token adjustments. Effective only for month_key.';

-- 查询优化索引
CREATE INDEX IF NOT EXISTS idx_team_ai_usage_month_user
ON team_ai_usage_logs(team_id, user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_team_quota_adjustments_lookup
ON team_ai_member_quota_adjustments(team_id, month_key, user_id);
