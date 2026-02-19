use crate::{Error, Result};
use chrono::{DateTime, NaiveDate, TimeZone, Utc};

/// Validate and normalize `YYYY-MM`.
pub fn validate_month_key(raw: &str) -> Result<String> {
    let value = raw.trim();
    if value.len() != 7 || !value.is_ascii() || &value[4..5] != "-" {
        return Err(Error::BadRequest(
            "Invalid month format, expected YYYY-MM".into(),
        ));
    }

    let year: i32 = value[0..4]
        .parse()
        .map_err(|_| Error::BadRequest("Invalid month format, expected YYYY-MM".into()))?;
    let month: u32 = value[5..7]
        .parse()
        .map_err(|_| Error::BadRequest("Invalid month format, expected YYYY-MM".into()))?;

    if year < 1970 || !(1..=12).contains(&month) {
        return Err(Error::BadRequest(
            "Invalid month format, expected YYYY-MM".into(),
        ));
    }

    Ok(format!("{:04}-{:02}", year, month))
}

/// Resolve month key. If not provided, use DB UTC time.
pub async fn resolve_month_key(db: &sqlx::PgPool, input: Option<&str>) -> Result<String> {
    if let Some(month) = input.map(str::trim).filter(|m| !m.is_empty()) {
        return validate_month_key(month);
    }

    let month_key: String =
        sqlx::query_scalar("SELECT TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM')")
            .fetch_one(db)
            .await?;

    validate_month_key(&month_key)
}

/// Convert `YYYY-MM` into UTC month range [start, end).
pub fn month_range_utc(month_key: &str) -> Result<(DateTime<Utc>, DateTime<Utc>)> {
    let normalized = validate_month_key(month_key)?;

    let year: i32 = normalized[0..4]
        .parse()
        .map_err(|_| Error::BadRequest("Invalid month format, expected YYYY-MM".into()))?;
    let month: u32 = normalized[5..7]
        .parse()
        .map_err(|_| Error::BadRequest("Invalid month format, expected YYYY-MM".into()))?;

    let start_date = NaiveDate::from_ymd_opt(year, month, 1)
        .ok_or_else(|| Error::BadRequest("Invalid month format, expected YYYY-MM".into()))?;

    let (next_year, next_month) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    let end_date = NaiveDate::from_ymd_opt(next_year, next_month, 1)
        .ok_or_else(|| Error::BadRequest("Invalid month format, expected YYYY-MM".into()))?;

    let start = Utc.from_utc_datetime(
        &start_date
            .and_hms_opt(0, 0, 0)
            .ok_or_else(|| Error::BadRequest("Invalid month boundary".into()))?,
    );
    let end = Utc.from_utc_datetime(
        &end_date
            .and_hms_opt(0, 0, 0)
            .ok_or_else(|| Error::BadRequest("Invalid month boundary".into()))?,
    );

    Ok((start, end))
}

#[cfg(test)]
mod tests {
    use super::{month_range_utc, validate_month_key};

    #[test]
    fn validate_month_key_ok() {
        assert_eq!(validate_month_key("2026-02").unwrap(), "2026-02");
        assert_eq!(validate_month_key(" 2026-12 ").unwrap(), "2026-12");
    }

    #[test]
    fn validate_month_key_invalid() {
        assert!(validate_month_key("2026/02").is_err());
        assert!(validate_month_key("2026-13").is_err());
        assert!(validate_month_key("202").is_err());
    }

    #[test]
    fn month_range_handles_year_boundary() {
        let (start, end) = month_range_utc("2026-12").unwrap();
        assert_eq!(start.to_rfc3339(), "2026-12-01T00:00:00+00:00");
        assert_eq!(end.to_rfc3339(), "2027-01-01T00:00:00+00:00");
    }
}
