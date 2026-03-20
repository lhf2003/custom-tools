use rusqlite::{Connection, Result};
use std::time::{SystemTime, UNIX_EPOCH};

/// Record app launch event
pub fn record_launch(conn: &Connection, path: &str, name: &str) -> Result<()> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    conn.execute(
        "INSERT INTO app_usage (path, name, launch_count, last_launch, updated_at)
         VALUES (?1, ?2, 1, ?3, CURRENT_TIMESTAMP)
         ON CONFLICT(path) DO UPDATE SET
            launch_count = launch_count + 1,
            last_launch = ?3,
            updated_at = CURRENT_TIMESTAMP",
        rusqlite::params![path, name, now],
    )?;

    Ok(())
}

/// Record search event (increment search_count)
pub fn record_search(conn: &Connection, path: &str, name: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO app_usage (path, name, search_count, updated_at)
         VALUES (?1, ?2, 1, CURRENT_TIMESTAMP)
         ON CONFLICT(path) DO UPDATE SET
            search_count = search_count + 1,
            updated_at = CURRENT_TIMESTAMP",
        rusqlite::params![path, name],
    )?;

    Ok(())
}

/// Get app usage stats for a specific app
pub fn get_usage(conn: &Connection, path: &str) -> Result<Option<AppUsage>> {
    let mut stmt = conn.prepare(
        "SELECT path, name, launch_count, last_launch, search_count
         FROM app_usage WHERE path = ?1"
    )?;

    let result = stmt.query_row([path], |row| {
        Ok(AppUsage {
            path: row.get(0)?,
            name: row.get(1)?,
            launch_count: row.get(2)?,
            last_launch: row.get(3)?,
            search_count: row.get(4)?,
        })
    });

    match result {
        Ok(usage) => Ok(Some(usage)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e),
    }
}

/// Get top N recently used apps (sorted by last_launch desc)
pub fn get_recently_used(conn: &Connection, limit: usize) -> Result<Vec<AppUsage>> {
    let mut stmt = conn.prepare(
        "SELECT path, name, launch_count, last_launch, search_count
         FROM app_usage
         WHERE last_launch IS NOT NULL
         ORDER BY last_launch DESC
         LIMIT ?1"
    )?;

    let usages = stmt.query_map([limit], |row| {
        Ok(AppUsage {
            path: row.get(0)?,
            name: row.get(1)?,
            launch_count: row.get(2)?,
            last_launch: row.get(3)?,
            search_count: row.get(4)?,
        })
    })?;

    usages.collect::<Result<Vec<_>, _>>()
}

/// Get top N most frequently used apps (sorted by launch_count desc)
pub fn get_most_used(conn: &Connection, limit: usize) -> Result<Vec<AppUsage>> {
    let mut stmt = conn.prepare(
        "SELECT path, name, launch_count, last_launch, search_count
         FROM app_usage
         ORDER BY launch_count DESC, last_launch DESC
         LIMIT ?1"
    )?;

    let usages = stmt.query_map([limit], |row| {
        Ok(AppUsage {
            path: row.get(0)?,
            name: row.get(1)?,
            launch_count: row.get(2)?,
            last_launch: row.get(3)?,
            search_count: row.get(4)?,
        })
    })?;

    usages.collect::<Result<Vec<_>, _>>()
}

/// Get all usage stats for frequency-based sorting
pub fn get_all_usage(conn: &Connection) -> Result<Vec<AppUsage>> {
    let mut stmt = conn.prepare(
        "SELECT path, name, launch_count, last_launch, search_count
         FROM app_usage"
    )?;

    let usages = stmt.query_map([], |row| {
        Ok(AppUsage {
            path: row.get(0)?,
            name: row.get(1)?,
            launch_count: row.get(2)?,
            last_launch: row.get(3)?,
            search_count: row.get(4)?,
        })
    })?;

    usages.collect::<Result<Vec<_>, _>>()
}

#[derive(Debug, Clone)]
pub struct AppUsage {
    pub path: String,
    pub name: String,
    pub launch_count: i32,
    pub last_launch: Option<i64>,
    pub search_count: i32,
}

/// Calculate frequency score for sorting
/// Higher score = more frequently/recently used
pub fn calculate_frequency_score(usage: &AppUsage, now: i64) -> f64 {
    let launch_score = (usage.launch_count as f64).ln_1p() * 0.3;

    let recency_score = usage.last_launch.map(|last| {
        let days_since = (now - last) as f64 / 86400.0;
        // Exponential decay: 1.0 for today, 0.5 after 7 days, 0.1 after 30 days
        (-days_since / 14.0).exp()
    }).unwrap_or(0.0) * 0.7;

    launch_score + recency_score
}
