use crate::{Error, Result};
use chrono::{DateTime, Utc};
use http::StatusCode;
use serde::Serialize;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
pub struct PersonalEntitlement {
    pub personal_plan: String,
    pub personal_plan_expires_at: Option<DateTime<Utc>>,
    pub can_personal_sync: bool,
    pub personal_sync_status: String,
    pub days_to_expire: Option<i64>,
    pub personal_sync_stop_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TeamEntitlement {
    pub team_plan: String,
    pub is_team_active: bool,
    pub expires_at: Option<DateTime<Utc>>,
    pub status: String,
    pub is_member: bool,
    pub role: Option<String>,
    pub team_sync_status: String,
    pub days_to_expire: Option<i64>,
    pub team_sync_stop_at: Option<DateTime<Utc>>,
    pub can_team_sync: bool,
}

const EXPIRING_SOON_DAYS: i64 = 3;

fn normalize_user_plan(raw: &str) -> String {
    match raw {
        "pro" | "team" => "pro".to_string(),
        _ => "free".to_string(),
    }
}

fn normalize_team_plan(raw: &str) -> String {
    match raw {
        "pro" => "pro".to_string(),
        _ => "trial".to_string(),
    }
}

fn is_pro_active(expires_at: Option<DateTime<Utc>>, now: DateTime<Utc>) -> bool {
    expires_at.map(|exp| exp > now).unwrap_or(true)
}

fn is_team_active(plan: &str, expires_at: Option<DateTime<Utc>>, now: DateTime<Utc>) -> bool {
    match plan {
        "pro" => is_pro_active(expires_at, now),
        "trial" => expires_at.map(|exp| exp > now).unwrap_or(false),
        _ => false,
    }
}

fn team_status(plan: &str, active: bool) -> String {
    if active {
        if plan == "trial" {
            "trial_active".to_string()
        } else {
            "pro_active".to_string()
        }
    } else {
        "expired".to_string()
    }
}

fn sync_status(active: bool, expires_at: Option<DateTime<Utc>>, now: DateTime<Utc>) -> String {
    if !active {
        return "expired".to_string();
    }

    if let Some(exp) = expires_at {
        let seconds_left = (exp - now).num_seconds();
        if seconds_left > 0 && seconds_left <= EXPIRING_SOON_DAYS * 24 * 60 * 60 {
            return "expiring_soon".to_string();
        }
    }

    "active".to_string()
}

fn days_to_expire(expires_at: Option<DateTime<Utc>>, now: DateTime<Utc>) -> Option<i64> {
    let exp = expires_at?;
    if exp <= now {
        return Some(0);
    }

    let seconds_left = (exp - now).num_seconds();
    Some((seconds_left + 86_399) / 86_400)
}

pub async fn resolve_personal_entitlement(
    db: &sqlx::PgPool,
    user_id: Uuid,
) -> Result<PersonalEntitlement> {
    let row: Option<(String, Option<DateTime<Utc>>)> =
        sqlx::query_as("SELECT plan, plan_expires_at FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_optional(db)
            .await?;

    let (raw_plan, plan_expires_at) =
        row.ok_or_else(|| Error::NotFound("User not found".into()))?;
    let personal_plan = normalize_user_plan(&raw_plan);
    let now = Utc::now();
    let can_personal_sync = personal_plan == "pro" && is_pro_active(plan_expires_at, now);
    let personal_sync_status = sync_status(can_personal_sync, plan_expires_at, now);
    let days_to_expire = days_to_expire(plan_expires_at, now);

    Ok(PersonalEntitlement {
        personal_plan,
        personal_plan_expires_at: plan_expires_at,
        can_personal_sync,
        personal_sync_status,
        days_to_expire,
        personal_sync_stop_at: plan_expires_at,
    })
}

pub async fn require_personal_sync(
    db: &sqlx::PgPool,
    user_id: Uuid,
) -> Result<PersonalEntitlement> {
    let entitlement = resolve_personal_entitlement(db, user_id).await?;
    if entitlement.can_personal_sync {
        return Ok(entitlement);
    }

    Err(Error::api(
        StatusCode::FORBIDDEN,
        "PLAN_REQUIRED",
        "个人云同步需要会员",
        Some(serde_json::json!({
            "personal_plan": entitlement.personal_plan,
            "personal_plan_expires_at": entitlement.personal_plan_expires_at,
        })),
    ))
}

pub async fn resolve_team_entitlement(
    db: &sqlx::PgPool,
    team_id: Uuid,
    user_id: Uuid,
) -> Result<TeamEntitlement> {
    let row: Option<(String, Option<DateTime<Utc>>, Option<String>)> = sqlx::query_as(
        "SELECT
            t.subscription_plan,
            t.subscription_expires_at,
            tm.role
         FROM teams t
         LEFT JOIN team_members tm
           ON tm.team_id = t.id AND tm.user_id = $2
         WHERE t.id = $1",
    )
    .bind(team_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?;

    let (raw_plan, expires_at, role) =
        row.ok_or_else(|| Error::NotFound("Team not found".into()))?;

    let team_plan = normalize_team_plan(&raw_plan);
    let now = Utc::now();
    let active = is_team_active(&team_plan, expires_at, now);
    let status = team_status(&team_plan, active);
    let is_member = role.is_some();
    let team_sync_status = sync_status(active, expires_at, now);
    let days_to_expire = days_to_expire(expires_at, now);
    let can_team_sync = is_member && active;

    Ok(TeamEntitlement {
        team_plan,
        is_team_active: active,
        expires_at,
        status,
        is_member,
        role,
        team_sync_status,
        days_to_expire,
        team_sync_stop_at: expires_at,
        can_team_sync,
    })
}

pub async fn require_team_active(
    db: &sqlx::PgPool,
    team_id: Uuid,
    user_id: Uuid,
) -> Result<TeamEntitlement> {
    let entitlement = resolve_team_entitlement(db, team_id, user_id).await?;

    if !entitlement.is_member {
        return Err(Error::api(
            StatusCode::FORBIDDEN,
            "TEAM_ACCESS_DENIED",
            "Not a team member",
            Some(serde_json::json!({ "team_id": team_id })),
        ));
    }

    if entitlement.is_team_active {
        return Ok(entitlement);
    }

    let (code, message) = if entitlement.team_plan == "trial" {
        ("TEAM_TRIAL_EXPIRED", "团队试用已到期")
    } else {
        ("TEAM_SUBSCRIPTION_REQUIRED", "团队会员未开通或已到期")
    };

    Err(Error::api(
        StatusCode::FORBIDDEN,
        code,
        message,
        Some(serde_json::json!({
            "team_id": team_id,
            "team_plan": entitlement.team_plan,
            "expires_at": entitlement.expires_at,
            "status": entitlement.status,
        })),
    ))
}

#[cfg(test)]
mod tests {
    use super::{days_to_expire, is_team_active, sync_status, team_status};
    use chrono::{Duration, Utc};

    #[test]
    fn pro_without_expiry_is_active() {
        let now = Utc::now();
        assert!(is_team_active("pro", None, now));
        assert_eq!(team_status("pro", true), "pro_active");
    }

    #[test]
    fn trial_expired_is_inactive() {
        let now = Utc::now();
        let expires = now - Duration::seconds(1);
        assert!(!is_team_active("trial", Some(expires), now));
        assert_eq!(team_status("trial", false), "expired");
    }

    #[test]
    fn sync_status_marks_expiring_soon_within_three_days() {
        let now = Utc::now();
        let expires = now + Duration::days(2);
        assert_eq!(sync_status(true, Some(expires), now), "expiring_soon");
    }

    #[test]
    fn days_to_expire_uses_ceil_for_partial_days() {
        let now = Utc::now();
        let expires = now + Duration::hours(25);
        assert_eq!(days_to_expire(Some(expires), now), Some(2));
    }
}
