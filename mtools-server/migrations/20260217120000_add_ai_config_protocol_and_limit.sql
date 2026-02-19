-- Add protocol and member_token_limit columns to team_ai_configs
ALTER TABLE team_ai_configs
ADD COLUMN IF NOT EXISTS protocol TEXT NOT NULL DEFAULT 'openai';

ALTER TABLE team_ai_configs
ADD COLUMN IF NOT EXISTS member_token_limit INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN team_ai_configs.protocol
IS 'API protocol: openai or anthropic';

COMMENT ON COLUMN team_ai_configs.member_token_limit
IS 'Daily token limit per member. 0 means unlimited';
