use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{Context, Result, anyhow};
use auth_mini_axum::{AuthMiniLayer, AuthMiniPrincipal, JwksCachePolicy};
use axum::{
    Json, Router,
    extract::{Extension, Path as AxumPath, Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::Utc;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use tower::{Layer, ServiceExt, service_fn};
use tower_http::{compression::CompressionLayer, services::ServeDir, trace::TraceLayer};
use uuid::Uuid;

pub const AUTH_MINI_ISSUER: &str = "https://auth.ntnl.io";
pub const AUTH_MINI_AUDIENCE: &str = "remi.ntnl.io";

#[derive(Clone)]
pub struct AppState {
    pub data_dir: PathBuf,
    pub auth: AuthMiniLayer,
    pub llm: Option<LlmConfig>,
    db_lock: Arc<Mutex<()>>,
}

#[derive(Clone)]
pub struct LlmConfig {
    pub api_base: String,
    pub api_key: String,
    pub model: String,
}

#[derive(Debug, Serialize)]
pub struct ApiError {
    pub error: &'static str,
    pub message: String,
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (StatusCode::BAD_REQUEST, Json(self)).into_response()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Anchor {
    pub id: String,
    pub question: String,
    pub answer: Option<String>,
    pub source: String,
    pub created_at: i64,
    pub updated_at: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Candidate {
    pub id: String,
    pub kind: String,
    pub question: String,
    pub answer: Option<String>,
    pub source: String,
    pub created_at: i64,
}

#[derive(Deserialize)]
pub struct CreateAnchor {
    pub question: String,
    pub answer: Option<String>,
    pub source: Option<String>,
}
#[derive(Deserialize)]
pub struct CreateCandidate {
    pub kind: String,
    pub question: String,
    pub answer: Option<String>,
    pub source: Option<String>,
}
#[derive(Deserialize)]
pub struct InferenceRequest {
    pub question: String,
    #[serde(default)]
    pub context: Vec<String>,
}
#[derive(Serialize)]
pub struct InferenceResponse {
    pub answer: String,
    pub recalled_anchor_ids: Vec<String>,
    pub boundary: String,
}
#[derive(Serialize)]
pub struct MeResponse {
    pub subject: String,
}

pub async fn build_state(data_dir: PathBuf) -> Result<AppState> {
    std::fs::create_dir_all(&data_dir)?;
    let auth = AuthMiniLayer::from_issuer(
        AUTH_MINI_ISSUER,
        AUTH_MINI_AUDIENCE,
        JwksCachePolicy::default(),
    )
    .await?;
    let llm = match (
        std::env::var("REMI_LLM_API_BASE").ok(),
        std::env::var("REMI_LLM_API_KEY").ok(),
        std::env::var("REMI_LLM_MODEL").ok(),
    ) {
        (Some(api_base), Some(api_key), Some(model)) => Some(LlmConfig {
            api_base,
            api_key,
            model,
        }),
        _ => None,
    };
    Ok(AppState {
        data_dir,
        auth,
        llm,
        db_lock: Arc::new(Mutex::new(())),
    })
}

pub fn app(state: AppState, web_dir: Option<PathBuf>) -> Router {
    let protected = Router::new()
        .route("/api/me", get(me))
        .route("/api/anchors", get(list_anchors).post(create_anchor))
        .route(
            "/api/candidates",
            get(list_candidates).post(create_candidate),
        )
        .route("/api/candidates/{id}/approve", post(approve_candidate))
        .route("/api/inference", post(infer))
        .route_layer(middleware::from_fn_with_state(state.clone(), authenticate));
    let mut router = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .merge(protected);
    if let Some(dir) = web_dir {
        router = router.fallback_service(ServeDir::new(dir).append_index_html_on_directories(true));
    }
    router
        .layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn authenticate(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let service = state.auth.layer(service_fn(move |request: Request| {
        let next = next.clone();
        async move { Ok::<_, std::convert::Infallible>(next.run(request).await) }
    }));
    match service.oneshot(request).await {
        Ok(response) => response,
        Err(never) => match never {},
    }
}
fn now() -> i64 {
    Utc::now().timestamp_millis()
}
fn user_db_path_for(data_dir: &Path, subject: &str) -> PathBuf {
    let mut h = Sha256::new();
    h.update(subject.as_bytes());
    data_dir
        .join("users")
        .join(format!("{:x}.sqlite", h.finalize()))
}

fn connection(state: &AppState, subject: &str) -> Result<Connection> {
    connection_for(&state.data_dir, subject)
}

fn connection_for(data_dir: &Path, subject: &str) -> Result<Connection> {
    let path = user_db_path_for(data_dir, subject);
    std::fs::create_dir_all(path.parent().context("user db parent")?)?;
    let db = Connection::open(path)?;
    db.pragma_update(None, "journal_mode", "WAL")?;
    db.pragma_update(None, "foreign_keys", "ON")?;
    db.busy_timeout(std::time::Duration::from_secs(5))?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS soul_anchors(id TEXT PRIMARY KEY,question TEXT NOT NULL,answer TEXT,source TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS candidates(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('anchor','probe')),question TEXT NOT NULL,answer TEXT,source TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),created_at INTEGER NOT NULL,decided_at INTEGER); CREATE TABLE IF NOT EXISTS approval_requests(id TEXT PRIMARY KEY,candidate_id TEXT NOT NULL,action TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(candidate_id,action)); CREATE TABLE IF NOT EXISTS inference_messages(id TEXT PRIMARY KEY,role TEXT NOT NULL CHECK(role IN ('user','assistant')),content TEXT NOT NULL,recalled_anchor_ids TEXT NOT NULL,created_at INTEGER NOT NULL);")?;
    db.execute(
        "INSERT OR IGNORE INTO app_meta(key,value) VALUES ('owner_subject',?1)",
        [subject],
    )?;
    Ok(db)
}
fn bad(message: impl Into<String>) -> ApiError {
    ApiError {
        error: "validation_error",
        message: message.into(),
    }
}
fn internal(error: anyhow::Error) -> Response {
    tracing::error!(error = ?error, "ReMi API request failed");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ApiError {
            error: "internal_error",
            message: "The request could not be completed.".to_string(),
        }),
    )
        .into_response()
}

async fn me(Extension(p): Extension<AuthMiniPrincipal>) -> Json<MeResponse> {
    Json(MeResponse { subject: p.subject })
}
async fn list_anchors(
    State(state): State<AppState>,
    Extension(p): Extension<AuthMiniPrincipal>,
) -> Response {
    let _guard = state.db_lock.lock().await;
    match connection(&state, &p.subject).and_then(|db| read_anchors(&db)) {
        Ok(data) => (StatusCode::OK, Json(data)).into_response(),
        Err(e) => internal(e),
    }
}
fn read_anchors(db: &Connection) -> Result<Vec<Anchor>> {
    let mut s=db.prepare("SELECT id,question,answer,source,created_at,updated_at FROM soul_anchors ORDER BY updated_at DESC")?;
    Ok(s.query_map([], |r| {
        Ok(Anchor {
            id: r.get(0)?,
            question: r.get(1)?,
            answer: r.get(2)?,
            source: r.get(3)?,
            created_at: r.get(4)?,
            updated_at: r.get(5)?,
        })
    })?
    .collect::<std::result::Result<_, _>>()?)
}
async fn create_anchor(
    State(state): State<AppState>,
    Extension(p): Extension<AuthMiniPrincipal>,
    Json(input): Json<CreateAnchor>,
) -> Response {
    if input.question.trim().is_empty() {
        return bad("question is required").into_response();
    }
    let _guard = state.db_lock.lock().await;
    let result = (|| -> Result<Anchor> {
        let db = connection(&state, &p.subject)?;
        let item = Anchor {
            id: Uuid::new_v4().to_string(),
            question: input.question.trim().to_string(),
            answer: input.answer.filter(|v| !v.trim().is_empty()),
            source: input.source.unwrap_or_else(|| "manual".into()),
            created_at: now(),
            updated_at: now(),
        };
        db.execute("INSERT INTO soul_anchors(id,question,answer,source,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6)",params![item.id,item.question,item.answer,item.source,item.created_at,item.updated_at])?;
        Ok(item)
    })();
    match result {
        Ok(item) => (StatusCode::CREATED, Json(item)).into_response(),
        Err(e) => internal(e),
    }
}
async fn list_candidates(
    State(state): State<AppState>,
    Extension(p): Extension<AuthMiniPrincipal>,
) -> Response {
    let _guard = state.db_lock.lock().await;
    let result = (|| -> Result<Vec<Candidate>> {
        let db = connection(&state, &p.subject)?;
        let mut s=db.prepare("SELECT id,kind,question,answer,source,created_at FROM candidates WHERE status='pending' ORDER BY created_at DESC")?;
        Ok(s.query_map([], |r| {
            Ok(Candidate {
                id: r.get(0)?,
                kind: r.get(1)?,
                question: r.get(2)?,
                answer: r.get(3)?,
                source: r.get(4)?,
                created_at: r.get(5)?,
            })
        })?
        .collect::<std::result::Result<_, _>>()?)
    })();
    match result {
        Ok(x) => Json(x).into_response(),
        Err(e) => internal(e),
    }
}
async fn create_candidate(
    State(state): State<AppState>,
    Extension(p): Extension<AuthMiniPrincipal>,
    Json(input): Json<CreateCandidate>,
) -> Response {
    if !matches!(input.kind.as_str(), "anchor" | "probe") || input.question.trim().is_empty() {
        return bad("kind must be anchor or probe and question is required").into_response();
    }
    let _guard = state.db_lock.lock().await;
    let result = (|| -> Result<Candidate> {
        let db = connection(&state, &p.subject)?;
        let x = Candidate {
            id: Uuid::new_v4().to_string(),
            kind: input.kind,
            question: input.question.trim().into(),
            answer: input.answer.filter(|v| !v.trim().is_empty()),
            source: input.source.unwrap_or_else(|| "manual".into()),
            created_at: now(),
        };
        db.execute("INSERT INTO candidates(id,kind,question,answer,source,status,created_at) VALUES(?1,?2,?3,?4,?5,'pending',?6)",params![x.id,x.kind,x.question,x.answer,x.source,x.created_at])?;
        Ok(x)
    })();
    match result {
        Ok(x) => (StatusCode::CREATED, Json(x)).into_response(),
        Err(e) => internal(e),
    }
}
async fn approve_candidate(
    State(state): State<AppState>,
    Extension(p): Extension<AuthMiniPrincipal>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    let _guard = state.db_lock.lock().await;
    let result = (|| -> Result<Anchor> {
        let mut db = connection(&state, &p.subject)?;
        let tx = db.transaction()?;
        let candidate:Candidate=tx.query_row("SELECT id,kind,question,answer,source,created_at FROM candidates WHERE id=?1 AND status='pending'",[&id],|r|Ok(Candidate{id:r.get(0)?,kind:r.get(1)?,question:r.get(2)?,answer:r.get(3)?,source:r.get(4)?,created_at:r.get(5)?})).optional()?.ok_or_else(||anyhow!("pending candidate not found"))?;
        let item = Anchor {
            id: Uuid::new_v4().to_string(),
            question: candidate.question,
            answer: if candidate.kind == "probe" {
                None
            } else {
                candidate.answer
            },
            source: candidate.source,
            created_at: now(),
            updated_at: now(),
        };
        tx.execute("INSERT INTO soul_anchors(id,question,answer,source,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6)",params![item.id,item.question,item.answer,item.source,item.created_at,item.updated_at])?;
        tx.execute(
            "UPDATE candidates SET status='approved',decided_at=?2 WHERE id=?1",
            params![id, now()],
        )?;
        tx.execute("INSERT INTO approval_requests(id,candidate_id,action,created_at) VALUES(?1,?2,'approve',?3)",params![Uuid::new_v4().to_string(),id,now()])?;
        tx.commit()?;
        Ok(item)
    })();
    match result {
        Ok(x) => Json(x).into_response(),
        Err(e) => internal(e),
    }
}

async fn infer(
    State(state): State<AppState>,
    Extension(p): Extension<AuthMiniPrincipal>,
    Json(input): Json<InferenceRequest>,
) -> Response {
    if input.question.trim().is_empty() {
        return bad("question is required").into_response();
    }
    let _guard = state.db_lock.lock().await;
    let result = infer_inner(&state, &p.subject, input).await;
    match result {
        Ok(x) => Json(x).into_response(),
        Err(e) => internal(e),
    }
}
async fn infer_inner(
    state: &AppState,
    subject: &str,
    input: InferenceRequest,
) -> Result<InferenceResponse> {
    let db = connection(state, subject)?;
    let anchors = read_anchors(&db)?;
    let normalized_question = input.question.to_lowercase();
    let recalled: Vec<_> = anchors
        .into_iter()
        .filter(|anchor| anchor.answer.is_some())
        .filter(|anchor| {
            anchor
                .question
                .to_lowercase()
                .split_whitespace()
                .any(|word| word.len() > 2 && normalized_question.contains(word))
        })
        .take(12)
        .collect();
    let evidence = recalled
        .iter()
        .map(|a| {
            format!(
                "Q: {}\nA: {}",
                a.question,
                a.answer.as_deref().expect("recalled anchors are answered")
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let boundary = if recalled.is_empty() {
        "No approved anchor directly supports a confident answer.".to_string()
    } else {
        "Answer only from recalled anchors; state any missing evidence.".to_string()
    };
    let answer = match &state.llm {
        Some(config) => {
            call_llm(
                config,
                &input.question,
                &input.context,
                &evidence,
                &boundary,
            )
            .await?
        }
        None => format!("Inference provider is not configured. {}", boundary),
    };
    let ids = recalled.iter().map(|a| a.id.clone()).collect::<Vec<_>>();
    db.execute("INSERT INTO inference_messages(id,role,content,recalled_anchor_ids,created_at) VALUES(?1,'user',?2,'[]',?3)",params![Uuid::new_v4().to_string(),input.question,now()])?;
    db.execute("INSERT INTO inference_messages(id,role,content,recalled_anchor_ids,created_at) VALUES(?1,'assistant',?2,?3,?4)",params![Uuid::new_v4().to_string(),answer,serde_json::to_string(&ids)?,now()])?;
    Ok(InferenceResponse {
        answer,
        recalled_anchor_ids: ids,
        boundary,
    })
}
async fn call_llm(
    config: &LlmConfig,
    question: &str,
    context: &[String],
    evidence: &str,
    boundary: &str,
) -> Result<String> {
    let response=reqwest::Client::new().post(format!("{}/chat/completions",config.api_base.trim_end_matches('/'))).header(AUTHORIZATION,format!("Bearer {}",config.api_key)).header(CONTENT_TYPE,"application/json").json(&serde_json::json!({"model":config.model,"temperature":0.2,"messages":[{"role":"system","content":format!("You are ReMi's inference runtime. Do not treat raw context as memory. Use only approved Soul Anchors as evidence. {}\n\nApproved anchor evidence:\n{}",boundary,evidence)},{"role":"user","content":format!("Question: {}\nContext: {}",question,context.join("\n"))}]})).send().await?.error_for_status()?;
    let value: serde_json::Value = response.json().await?;
    value
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| anyhow!("LLM response contained no message content"))
}

pub fn legacy_db_backup_path(target_dir: &Path, legacy_path: &Path) -> PathBuf {
    let mut h = DefaultHasher::new();
    legacy_path.hash(&mut h);
    target_dir
        .join("legacy-backups")
        .join(format!("{:x}.sqlite", h.finish()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn per_subject_sqlite_wal_databases_are_isolated() {
        let root = std::env::temp_dir().join(format!("remi-test-{}", Uuid::new_v4()));
        let first_path = user_db_path_for(&root, "auth-mini-subject-a");
        let second_path = user_db_path_for(&root, "auth-mini-subject-b");
        assert_ne!(first_path, second_path);
        assert!(!first_path.to_string_lossy().contains("auth-mini-subject-a"));

        let first = connection_for(&root, "auth-mini-subject-a").expect("first user db");
        first
            .execute(
                "INSERT INTO soul_anchors(id,question,answer,source,created_at,updated_at) VALUES('a','What matters?','Evidence matters','test',1,1)",
                [],
            )
            .expect("insert first anchor");
        let journal_mode: String = first
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .expect("journal mode");
        assert_eq!(journal_mode.to_lowercase(), "wal");
        drop(first);

        let second = connection_for(&root, "auth-mini-subject-b").expect("second user db");
        assert!(read_anchors(&second).expect("second anchors").is_empty());
        drop(second);
        std::fs::remove_dir_all(root).expect("remove test database directory");
    }

    #[test]
    fn only_answered_anchors_become_inference_evidence() {
        let root = std::env::temp_dir().join(format!("remi-test-{}", Uuid::new_v4()));
        let db = connection_for(&root, "subject").expect("user db");
        db.execute(
            "INSERT INTO soul_anchors(id,question,answer,source,created_at,updated_at) VALUES('answered','How do I decide?','I start from evidence.','test',1,1)",
            [],
        )
        .expect("answered anchor");
        db.execute(
            "INSERT INTO soul_anchors(id,question,answer,source,created_at,updated_at) VALUES('probe','How do I decide later?',NULL,'test',1,1)",
            [],
        )
        .expect("probe anchor");
        let anchors = read_anchors(&db).expect("anchors");
        let question = "How do I decide?".to_lowercase();
        let recalled: Vec<_> = anchors
            .into_iter()
            .filter(|anchor| anchor.answer.is_some())
            .filter(|anchor| {
                anchor
                    .question
                    .to_lowercase()
                    .split_whitespace()
                    .any(|word| word.len() > 2 && question.contains(word))
            })
            .collect();
        assert_eq!(
            recalled
                .iter()
                .map(|anchor| anchor.id.as_str())
                .collect::<Vec<_>>(),
            vec!["answered"]
        );
        drop(db);
        std::fs::remove_dir_all(root).expect("remove test database directory");
    }
}
