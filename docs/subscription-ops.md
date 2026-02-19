# 订阅开通运维手册（SQL-only）

适用范围：
- 个人会员（仅影响个人云同步能力）
- 团队会员（影响团队公共能力：团队 AI / 团队知识库 / 团队共享模板等）

时间基准：
- 全部使用数据库服务器 UTC 时间。

## 1. 前置检查

执行前先确认团队状态：

```sql
SELECT
  id,
  name,
  subscription_plan,
  subscription_started_at,
  subscription_expires_at,
  subscription_updated_at
FROM teams
WHERE id = :team_id;
```

## 2. 团队会员开通

### 2.1 开通 1 个月

```sql
UPDATE teams
SET subscription_plan = 'pro',
    subscription_started_at = NOW(),
    subscription_expires_at = NOW() + INTERVAL '1 month',
    subscription_updated_at = NOW()
WHERE id = :team_id;
```

### 2.2 开通 6 个月

```sql
UPDATE teams
SET subscription_plan = 'pro',
    subscription_started_at = NOW(),
    subscription_expires_at = NOW() + INTERVAL '6 months',
    subscription_updated_at = NOW()
WHERE id = :team_id;
```

### 2.3 开通 1 年

```sql
UPDATE teams
SET subscription_plan = 'pro',
    subscription_started_at = NOW(),
    subscription_expires_at = NOW() + INTERVAL '1 year',
    subscription_updated_at = NOW()
WHERE id = :team_id;
```

### 2.4 永久开通

```sql
UPDATE teams
SET subscription_plan = 'pro',
    subscription_started_at = NOW(),
    subscription_expires_at = NULL,
    subscription_updated_at = NOW()
WHERE id = :team_id;
```

## 3. 到期回收（立即失效）

```sql
UPDATE teams
SET subscription_expires_at = NOW() - INTERVAL '1 second',
    subscription_updated_at = NOW()
WHERE id = :team_id;
```

## 4. 误操作回滚

如需回滚，请先查最近更新时间，再恢复到目标时间：

```sql
SELECT id, subscription_plan, subscription_started_at, subscription_expires_at, subscription_updated_at
FROM teams
WHERE id = :team_id;
```

按实际需要恢复：

```sql
UPDATE teams
SET subscription_plan = :plan,
    subscription_started_at = :started_at,
    subscription_expires_at = :expires_at,
    subscription_updated_at = NOW()
WHERE id = :team_id;
```

## 5. 个人会员（仅个人同步）

开通/续期个人会员：

```sql
UPDATE users
SET plan = 'pro',
    plan_expires_at = NOW() + INTERVAL '1 month',
    updated_at = NOW()
WHERE id = :user_id;
```

降级到 free：

```sql
UPDATE users
SET plan = 'free',
    plan_expires_at = NULL,
    updated_at = NOW()
WHERE id = :user_id;
```

## 6. 运维记录要求

每次执行 SQL 后，请在运维台账记录：
- `team_id` 或 `user_id`
- 收款单号/流水号
- 开通时长
- 操作人
- 操作时间（UTC）
- 备注（例如手工补偿、续期、回滚）
