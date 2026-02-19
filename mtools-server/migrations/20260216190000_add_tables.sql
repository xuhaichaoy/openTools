-- 第三方登录绑定
CREATE TABLE IF NOT EXISTS auth_providers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,         -- github, google, wechat
    provider_uid TEXT NOT NULL,
    provider_email TEXT,
    access_token TEXT,
    refresh_token TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(provider, provider_uid)
);
CREATE INDEX IF NOT EXISTS idx_auth_providers_user ON auth_providers(user_id);

-- AI 能量消费流水
CREATE TABLE IF NOT EXISTS ai_energy_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount BIGINT NOT NULL,          -- 正数=充值，负数=消耗
    balance_after BIGINT NOT NULL,
    model TEXT,
    prompt_tokens BIGINT,
    completion_tokens BIGINT,
    source TEXT NOT NULL DEFAULT 'platform',  -- platform, voucher, purchase, gift
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_energy_logs_user ON ai_energy_logs(user_id, created_at DESC);

-- 平台模型费率表
CREATE TABLE IF NOT EXISTS ai_model_pricing (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_id TEXT NOT NULL UNIQUE,
    model_name TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'deepseek',
    input_price_per_1k NUMERIC(10,4) NOT NULL DEFAULT 1.0,
    output_price_per_1k NUMERIC(10,4) NOT NULL DEFAULT 2.0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 设备管理
CREATE TABLE IF NOT EXISTS devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_name TEXT NOT NULL,
    device_type TEXT,          -- desktop, mobile, web
    os TEXT,
    last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);

-- 团队 AI Key 配置（加密存储）
CREATE TABLE IF NOT EXISTS team_ai_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    config_name TEXT NOT NULL DEFAULT 'default',
    base_url TEXT NOT NULL,
    api_key TEXT NOT NULL,       -- 生产环境应做加密
    model_name TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_team_ai_configs_team ON team_ai_configs(team_id);

-- 团队 AI 用量日志
CREATE TABLE IF NOT EXISTS team_ai_usage_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    config_id UUID REFERENCES team_ai_configs(id),
    model TEXT,
    prompt_tokens BIGINT NOT NULL DEFAULT 0,
    completion_tokens BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_team_usage_team ON team_ai_usage_logs(team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_team_usage_user ON team_ai_usage_logs(user_id, created_at DESC);

-- 团队公开资源关系
CREATE TABLE IF NOT EXISTS team_shared_resources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id),
    resource_type TEXT NOT NULL,    -- knowledge_base, workflow
    resource_id TEXT NOT NULL,
    resource_name TEXT,
    shared_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(team_id, resource_type, resource_id)
);
CREATE INDEX IF NOT EXISTS idx_team_shared_team ON team_shared_resources(team_id, resource_type);

-- 代金券 (stub)
CREATE TABLE IF NOT EXISTS vouchers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT NOT NULL UNIQUE,
    energy_amount BIGINT NOT NULL DEFAULT 0,
    max_uses INTEGER NOT NULL DEFAULT 1,
    used_count INTEGER NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 订单 (stub)
CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    order_type TEXT NOT NULL,      -- energy_purchase, subscription
    amount_cents INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',  -- pending, paid, cancelled, refunded
    energy_amount BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    paid_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at DESC);

-- 订阅 (stub)
CREATE TABLE IF NOT EXISTS subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    plan TEXT NOT NULL DEFAULT 'free',
    status TEXT NOT NULL DEFAULT 'active',  -- active, cancelled, expired
    starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);

-- 升级 ai_energy 表的 balance 列到 BIGINT
ALTER TABLE ai_energy ALTER COLUMN balance TYPE BIGINT;
ALTER TABLE ai_energy ALTER COLUMN total_purchased TYPE BIGINT;
ALTER TABLE ai_energy ALTER COLUMN total_consumed TYPE BIGINT;

-- 插入默认模型定价
INSERT INTO ai_model_pricing (model_id, model_name, provider, input_price_per_1k, output_price_per_1k) VALUES
    ('deepseek-chat', 'DeepSeek Chat', 'deepseek', 1.0, 2.0),
    ('deepseek-reasoner', 'DeepSeek Reasoner', 'deepseek', 4.0, 16.0)
ON CONFLICT (model_id) DO NOTHING;
