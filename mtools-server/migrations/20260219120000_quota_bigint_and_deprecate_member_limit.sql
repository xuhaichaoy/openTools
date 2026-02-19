-- Normalize quota and usage numeric columns to BIGINT for stable Rust i64 decode.
ALTER TABLE IF EXISTS team_ai_quota_policy
    ALTER COLUMN monthly_limit_tokens TYPE BIGINT
    USING monthly_limit_tokens::BIGINT;

ALTER TABLE IF EXISTS team_ai_member_quota_adjustments
    ALTER COLUMN extra_tokens TYPE BIGINT
    USING extra_tokens::BIGINT;

ALTER TABLE IF EXISTS team_ai_usage_logs
    ALTER COLUMN prompt_tokens TYPE BIGINT
    USING COALESCE(prompt_tokens, 0)::BIGINT,
    ALTER COLUMN completion_tokens TYPE BIGINT
    USING COALESCE(completion_tokens, 0)::BIGINT;

-- Keep legacy field for compatibility but mark it as deprecated.
COMMENT ON COLUMN team_ai_configs.member_token_limit
IS 'DEPRECATED: replaced by team monthly quota policy + monthly member adjustments. Kept only for backward compatibility.';
