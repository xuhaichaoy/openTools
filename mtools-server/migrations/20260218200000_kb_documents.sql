-- 知识库文档云端存储表
CREATE TABLE IF NOT EXISTS kb_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- 'personal' = 个人知识库, 'team' = 团队知识库
    owner_type TEXT NOT NULL CHECK (owner_type IN ('personal', 'team')),
    -- personal 时为 user_id, team 时为 team_id
    owner_id UUID NOT NULL,
    uploader_id UUID NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    format TEXT NOT NULL DEFAULT 'txt',
    size BIGINT NOT NULL DEFAULT 0,
    -- 服务端存储路径（相对于 upload_dir）
    file_path TEXT NOT NULL,
    content TEXT,
    tags TEXT[] DEFAULT '{}',
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kb_docs_owner ON kb_documents(owner_type, owner_id);
CREATE INDEX IF NOT EXISTS idx_kb_docs_uploader ON kb_documents(uploader_id);
