use anyhow::{Context, Result, anyhow};
use remi::legacy_db_backup_path;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use std::{env, fs, path::PathBuf};
use uuid::Uuid;

#[derive(Serialize)]
struct MigrationReport {
    owner_subject: String,
    legacy_path: String,
    backup_path: String,
    anchors: usize,
    messages: usize,
    candidates: usize,
    unmapped_tables: Vec<&'static str>,
}
fn required(flag: &str) -> Result<String> {
    let mut it = env::args().skip(1);
    while let Some(k) = it.next() {
        if k == flag {
            return it.next().ok_or_else(|| anyhow!("{flag} requires a value"));
        }
    }
    Err(anyhow!("missing {flag}"))
}
fn main() -> Result<()> {
    let legacy = PathBuf::from(required("--legacy-db")?);
    let target = PathBuf::from(required("--target-db")?);
    let owner = required("--owner-subject")?;
    if owner.trim().is_empty() {
        return Err(anyhow!("owner subject cannot be empty"));
    };
    if !legacy.is_file() {
        return Err(anyhow!("legacy db does not exist"));
    };
    let backup = legacy_db_backup_path(target.parent().context("target parent")?, &legacy);
    fs::create_dir_all(backup.parent().unwrap())?;
    if !backup.exists() {
        fs::copy(&legacy, &backup)?;
    }
    let old = Connection::open_with_flags(&legacy, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let new = Connection::open(&target)?;
    new.pragma_update(None, "journal_mode", "WAL")?;
    new.execute_batch("CREATE TABLE IF NOT EXISTS app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS soul_anchors(id TEXT PRIMARY KEY,question TEXT NOT NULL,answer TEXT,source TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,legacy_id TEXT UNIQUE); CREATE TABLE IF NOT EXISTS candidates(id TEXT PRIMARY KEY,kind TEXT NOT NULL,question TEXT NOT NULL,answer TEXT,source TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,decided_at INTEGER,legacy_id TEXT UNIQUE); CREATE TABLE IF NOT EXISTS inference_messages(id TEXT PRIMARY KEY,role TEXT NOT NULL,content TEXT NOT NULL,recalled_anchor_ids TEXT NOT NULL,created_at INTEGER NOT NULL,legacy_id INTEGER UNIQUE);")?;
    new.execute(
        "INSERT OR IGNORE INTO app_meta(key,value) VALUES('owner_subject',?1)",
        [&owner],
    )?;
    let tx = new.unchecked_transaction()?;
    let mut anchors = 0;
    let mut messages = 0;
    let mut candidates = 0;
    if table_exists(&old, "soul_anchors")? {
        let mut stmt = old
            .prepare("SELECT id,question,answer,source,created_at,updated_at FROM soul_anchors")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, i64>(5)?,
            ))
        })?;
        for row in rows {
            let (legacy_id, q, a, s, c, u) = row?;
            let id = Uuid::new_v5(
                &Uuid::NAMESPACE_OID,
                format!("{owner}:anchor:{legacy_id}").as_bytes(),
            )
            .to_string();
            anchors+=tx.execute("INSERT OR IGNORE INTO soul_anchors(id,question,answer,source,created_at,updated_at,legacy_id) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![id,q,a,s,c,u,legacy_id])?
        }
    }
    if table_exists(&old, "messages")? {
        let mut stmt = old.prepare("SELECT id,role,content,created_at FROM messages")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })?;
        for row in rows {
            let (legacy_id, role, content, created) = row?;
            let role = if role == "assistant" {
                "assistant"
            } else {
                "user"
            };
            let id = Uuid::new_v5(
                &Uuid::NAMESPACE_OID,
                format!("{owner}:message:{legacy_id}").as_bytes(),
            )
            .to_string();
            messages+=tx.execute("INSERT OR IGNORE INTO inference_messages(id,role,content,recalled_anchor_ids,created_at,legacy_id) VALUES(?1,?2,?3,'[]',?4,?5)",params![id,role,content,created,legacy_id])?
        }
    }
    if table_exists(&old, "soul_candidate_queue")? {
        let mut stmt =
            old.prepare("SELECT id,question,answer,source,created_at FROM soul_candidate_queue")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
            ))
        })?;
        for row in rows {
            let (legacy_id, q, a, s, c) = row?;
            let id = Uuid::new_v5(
                &Uuid::NAMESPACE_OID,
                format!("{owner}:candidate:{legacy_id}").as_bytes(),
            )
            .to_string();
            let kind = if a.is_some() { "anchor" } else { "probe" };
            candidates+=tx.execute("INSERT OR IGNORE INTO candidates(id,kind,question,answer,source,status,created_at,legacy_id) VALUES(?1,?2,?3,?4,?5,'pending',?6,?7)",params![id,kind,q,a,s,c,legacy_id])?
        }
    }
    tx.commit()?;
    let report = MigrationReport {
        owner_subject: owner,
        legacy_path: legacy.display().to_string(),
        backup_path: backup.display().to_string(),
        anchors,
        messages,
        candidates,
        unmapped_tables: vec![
            "direct_messages",
            "public_profile",
            "public_profile_avatar",
            "api_tokens",
            "goal_nodes",
        ],
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
fn table_exists(db: &Connection, name: &str) -> Result<bool> {
    Ok(db
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
            [name],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}
