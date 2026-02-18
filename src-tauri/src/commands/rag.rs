use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

// ── 类型定义 ──

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeDoc {
    pub id: String,
    pub name: String,
    pub path: String,
    pub format: String,
    pub size: u64,
    pub status: String,
    pub chunk_count: usize,
    pub token_count: usize,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub error_msg: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default = "default_source_local")]
    pub source_type: String,
    #[serde(default)]
    pub source_id: Option<String>,
}

fn default_source_local() -> String {
    "local".to_string()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DocChunk {
    pub id: String,
    pub doc_id: String,
    pub content: String,
    pub index: usize,
    pub token_count: usize,
    pub metadata: ChunkMetadata,
    #[serde(skip)]
    pub embedding: Vec<f32>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChunkMetadata {
    pub source: String,
    #[serde(default)]
    pub page: Option<usize>,
    #[serde(default)]
    pub heading: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalResult {
    pub chunk: DocChunk,
    pub score: f32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RAGConfig {
    pub chunk_size: usize,
    pub chunk_overlap: usize,
    pub top_k: usize,
    pub score_threshold: f32,
    pub embedding_model: String,
    pub embedding_dimension: usize,
    #[serde(default)]
    pub embedding_base_url: Option<String>,
    #[serde(default)]
    pub embedding_api_key: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RAGStats {
    pub total_docs: usize,
    pub total_chunks: usize,
    pub total_tokens: usize,
    pub index_size: u64,
}

impl Default for RAGConfig {
    fn default() -> Self {
        Self {
            chunk_size: 512,
            chunk_overlap: 50,
            top_k: 5,
            score_threshold: 0.3,
            embedding_model: "text-embedding-3-small".to_string(),
            embedding_dimension: 1536,
            embedding_base_url: None,
            embedding_api_key: None,
        }
    }
}

// ── 工具函数 ──

fn get_rag_dir(app: &AppHandle) -> PathBuf {
    let app_data = app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."));
    let rag_dir = app_data.join("rag");
    let _ = std::fs::create_dir_all(&rag_dir);
    rag_dir
}

fn get_docs_index_path(app: &AppHandle) -> PathBuf {
    get_rag_dir(app).join("docs_index.json")
}

fn get_chunks_dir(app: &AppHandle) -> PathBuf {
    let dir = get_rag_dir(app).join("chunks");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn get_vectors_dir(app: &AppHandle) -> PathBuf {
    let dir = get_rag_dir(app).join("vectors");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn load_docs_index(app: &AppHandle) -> Vec<KnowledgeDoc> {
    let path = get_docs_index_path(app);
    if path.exists() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            return serde_json::from_str(&content).unwrap_or_default();
        }
    }
    Vec::new()
}

fn save_docs_index(app: &AppHandle, docs: &[KnowledgeDoc]) {
    let path = get_docs_index_path(app);
    if let Ok(json) = serde_json::to_string_pretty(docs) {
        let _ = std::fs::write(&path, json);
    }
}

/// 简单的 token 估算（按字符数 / 4）
fn estimate_tokens(text: &str) -> usize {
    // 中文字符约 1-2 token，英文约 4 字符 1 token
    let cjk_count = text.chars().filter(|c| {
        let code = *c as u32;
        (0x4E00..=0x9FFF).contains(&code) || (0x3400..=0x4DBF).contains(&code)
    }).count();
    let other_count = text.chars().count() - cjk_count;
    cjk_count * 2 + other_count / 4
}

/// 文本分块
fn chunk_text(text: &str, chunk_size: usize, overlap: usize) -> Vec<String> {
    let sentences: Vec<&str> = text.split(|c: char| c == '\n' || c == '。' || c == '.' || c == '！' || c == '!' || c == '？' || c == '?')
        .filter(|s| !s.trim().is_empty())
        .collect();

    let mut chunks = Vec::new();
    let mut current_chunk = String::new();
    let mut current_tokens = 0;

    for sentence in &sentences {
        let sentence = sentence.trim();
        if sentence.is_empty() { continue; }

        let sent_tokens = estimate_tokens(sentence);

        if current_tokens + sent_tokens > chunk_size && !current_chunk.is_empty() {
            chunks.push(current_chunk.clone());

            // 保留 overlap
            if overlap > 0 {
                let words: Vec<&str> = current_chunk.split_whitespace().collect();
                let overlap_start = words.len().saturating_sub(overlap / 4);
                current_chunk = words[overlap_start..].join(" ");
                current_tokens = estimate_tokens(&current_chunk);
            } else {
                current_chunk.clear();
                current_tokens = 0;
            }
        }

        if !current_chunk.is_empty() {
            current_chunk.push(' ');
        }
        current_chunk.push_str(sentence);
        current_tokens += sent_tokens;
    }

    if !current_chunk.is_empty() {
        chunks.push(current_chunk);
    }

    if chunks.is_empty() && !text.trim().is_empty() {
        chunks.push(text.trim().to_string());
    }

    chunks
}

/// 调用 Embedding API 获取向量
async fn get_embeddings(app: &AppHandle, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
    let rag_config = load_rag_config(app);

    // 优先使用 RAG 独立配置的 Embedding API，回退到通用 AI 配置
    use tauri_plugin_store::StoreExt;
    let store = app.store("config.json").map_err(|e| e.to_string())?;
    let ai_config = store.get("ai_config");

    let base_url = rag_config.embedding_base_url
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            ai_config.as_ref()
                .and_then(|v| v.get("base_url"))
                .and_then(|v| v.as_str())
                .unwrap_or("https://api.openai.com/v1")
        })
        .to_string();

    let raw_api_key = rag_config.embedding_api_key
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            ai_config.as_ref()
                .and_then(|v| v.get("api_key"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
        })
        .to_string();
    let api_key = crate::crypto::maybe_decrypt(&raw_api_key);

    if api_key.is_empty() {
        return Err("请先配置 Embedding API Key（在知识库设置或 AI 设置中）".to_string());
    }

    let url = format!("{}/embeddings", base_url.trim_end_matches('/'));

    let body = serde_json::json!({
        "model": rag_config.embedding_model,
        "input": texts,
    });

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Embedding API 请求失败: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Embedding API 返回错误 {}: {}", status, text));
    }

    let result: serde_json::Value = resp.json().await.map_err(|e| format!("解析响应失败: {}", e))?;

    let embeddings: Vec<Vec<f32>> = result["data"]
        .as_array()
        .ok_or("响应中缺少 data 字段")?
        .iter()
        .filter_map(|item| {
            item["embedding"]
                .as_array()
                .map(|arr| arr.iter().filter_map(|v| v.as_f64().map(|f| f as f32)).collect())
        })
        .collect();

    if embeddings.len() != texts.len() {
        return Err("返回的 embedding 数量与输入不匹配".to_string());
    }

    Ok(embeddings)
}

/// 余弦相似度
fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    dot / (norm_a * norm_b)
}

fn load_rag_config(app: &AppHandle) -> RAGConfig {
    let path = get_rag_dir(app).join("config.json");
    if path.exists() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            return serde_json::from_str(&content).unwrap_or_default();
        }
    }
    RAGConfig::default()
}

fn save_rag_config(app: &AppHandle, config: &RAGConfig) {
    let path = get_rag_dir(app).join("config.json");
    if let Ok(json) = serde_json::to_string_pretty(config) {
        let _ = std::fs::write(&path, json);
    }
}

fn load_chunks_for_doc(app: &AppHandle, doc_id: &str) -> Vec<DocChunk> {
    let path = get_chunks_dir(app).join(format!("{}.json", doc_id));
    if path.exists() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            return serde_json::from_str(&content).unwrap_or_default();
        }
    }
    Vec::new()
}

fn save_chunks_for_doc(app: &AppHandle, doc_id: &str, chunks: &[DocChunk]) {
    let path = get_chunks_dir(app).join(format!("{}.json", doc_id));
    if let Ok(json) = serde_json::to_string(chunks) {
        let _ = std::fs::write(&path, json);
    }
}

fn load_vectors_for_doc(app: &AppHandle, doc_id: &str) -> Vec<Vec<f32>> {
    let path = get_vectors_dir(app).join(format!("{}.bin", doc_id));
    if path.exists() {
        if let Ok(bytes) = std::fs::read(&path) {
            // 每个 f32 占 4 字节
            let config = load_rag_config(app);
            let dim = config.embedding_dimension;
            let float_count = bytes.len() / 4;
            let vec_count = float_count / dim;
            let mut vectors = Vec::with_capacity(vec_count);
            for i in 0..vec_count {
                let mut vec = Vec::with_capacity(dim);
                for j in 0..dim {
                    let offset = (i * dim + j) * 4;
                    if offset + 4 <= bytes.len() {
                        let val = f32::from_le_bytes([
                            bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3],
                        ]);
                        vec.push(val);
                    }
                }
                vectors.push(vec);
            }
            return vectors;
        }
    }
    Vec::new()
}

fn save_vectors_for_doc(app: &AppHandle, doc_id: &str, vectors: &[Vec<f32>]) {
    let path = get_vectors_dir(app).join(format!("{}.bin", doc_id));
    let mut bytes = Vec::new();
    for vec in vectors {
        for &val in vec {
            bytes.extend_from_slice(&val.to_le_bytes());
        }
    }
    let _ = std::fs::write(&path, bytes);
}

fn detect_format(path: &str) -> String {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "md" | "markdown" => "md".to_string(),
        "pdf" => "pdf".to_string(),
        "json" => "json".to_string(),
        "csv" => "csv".to_string(),
        "html" | "htm" => "html".to_string(),
        _ => "txt".to_string(),
    }
}

// ── Tauri Commands ──

/// 列出所有知识库文档
#[tauri::command]
pub async fn rag_list_docs(app: AppHandle) -> Result<Vec<KnowledgeDoc>, String> {
    Ok(load_docs_index(&app))
}

/// 导入文档到知识库
#[tauri::command]
pub async fn rag_import_doc(
    app: AppHandle,
    file_path: String,
    tags: Vec<String>,
) -> Result<KnowledgeDoc, String> {
    // 读取文件
    let path = PathBuf::from(&file_path);
    if !path.exists() {
        return Err(format!("文件不存在: {}", file_path));
    }

    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("读取文件失败: {}", e))?;

    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
    let format = detect_format(&file_path);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let doc_id = format!("doc_{}", now);
    let config = load_rag_config(&app);

    let mut doc = KnowledgeDoc {
        id: doc_id.clone(),
        name,
        path: file_path,
        format,
        size,
        status: "processing".to_string(),
        chunk_count: 0,
        token_count: 0,
        created_at: now,
        updated_at: now,
        error_msg: None,
        tags,
        source_type: "local".to_string(),
        source_id: None,
    };

    // 保存初始状态
    let mut docs = load_docs_index(&app);
    docs.push(doc.clone());
    save_docs_index(&app, &docs);

    // 发送进度事件
    use tauri::Emitter;
    let _ = app.emit("rag-index-progress", serde_json::json!({
        "docId": &doc_id,
        "status": "processing",
    }));

    // 分块
    let text_chunks = chunk_text(&content, config.chunk_size, config.chunk_overlap);

    let mut chunks: Vec<DocChunk> = text_chunks
        .iter()
        .enumerate()
        .map(|(i, text)| DocChunk {
            id: format!("{}_{}", doc_id, i),
            doc_id: doc_id.clone(),
            content: text.clone(),
            index: i,
            token_count: estimate_tokens(text),
            metadata: ChunkMetadata {
                source: doc.name.clone(),
                page: None,
                heading: None,
            },
            embedding: Vec::new(),
        })
        .collect();

    // 获取 embedding（分批处理，每批最多 20 个）
    let batch_size = 20;
    let mut all_embeddings: Vec<Vec<f32>> = Vec::new();

    for batch_start in (0..text_chunks.len()).step_by(batch_size) {
        let batch_end = (batch_start + batch_size).min(text_chunks.len());
        let batch: Vec<String> = text_chunks[batch_start..batch_end].to_vec();

        match get_embeddings(&app, &batch).await {
            Ok(embeddings) => {
                all_embeddings.extend(embeddings);
            }
            Err(e) => {
                doc.status = "error".to_string();
                doc.error_msg = Some(e.clone());
                doc.updated_at = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;

                // 更新索引
                let mut docs = load_docs_index(&app);
                if let Some(d) = docs.iter_mut().find(|d| d.id == doc_id) {
                    *d = doc.clone();
                }
                save_docs_index(&app, &docs);

                let _ = app.emit("rag-index-progress", serde_json::json!({
                    "docId": &doc_id,
                    "status": "error",
                    "error": &e,
                }));

                return Err(e);
            }
        }
    }

    // 保存 chunks 和 vectors
    for (i, emb) in all_embeddings.iter().enumerate() {
        if i < chunks.len() {
            chunks[i].embedding = emb.clone();
        }
    }

    let total_tokens: usize = chunks.iter().map(|c| c.token_count).sum();

    save_chunks_for_doc(&app, &doc_id, &chunks);
    save_vectors_for_doc(&app, &doc_id, &all_embeddings);

    // 更新文档状态
    doc.status = "indexed".to_string();
    doc.chunk_count = chunks.len();
    doc.token_count = total_tokens;
    doc.updated_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let mut docs = load_docs_index(&app);
    if let Some(d) = docs.iter_mut().find(|d| d.id == doc_id) {
        *d = doc.clone();
    }
    save_docs_index(&app, &docs);

    let _ = app.emit("rag-index-progress", serde_json::json!({
        "docId": &doc_id,
        "status": "indexed",
    }));

    Ok(doc)
}

/// 从内容字符串直接导入到知识库（用于云端文档下载后导入）
#[tauri::command]
pub async fn rag_import_from_content(
    app: AppHandle,
    name: String,
    content: String,
    format: String,
    tags: Vec<String>,
    source_type: Option<String>,
    source_id: Option<String>,
) -> Result<KnowledgeDoc, String> {
    let size = content.len() as u64;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let doc_id = format!("doc_{}", now);
    let config = load_rag_config(&app);

    let src_type = source_type.unwrap_or_else(|| "local".to_string());

    let mut doc = KnowledgeDoc {
        id: doc_id.clone(),
        name: name.clone(),
        path: format!("cloud://{}", name),
        format,
        size,
        status: "processing".to_string(),
        chunk_count: 0,
        token_count: 0,
        created_at: now,
        updated_at: now,
        error_msg: None,
        tags,
        source_type: src_type,
        source_id,
    };

    let mut docs = load_docs_index(&app);
    docs.push(doc.clone());
    save_docs_index(&app, &docs);

    use tauri::Emitter;
    let _ = app.emit("rag-index-progress", serde_json::json!({
        "docId": &doc_id,
        "status": "processing",
    }));

    let text_chunks = chunk_text(&content, config.chunk_size, config.chunk_overlap);

    let mut chunks: Vec<DocChunk> = text_chunks
        .iter()
        .enumerate()
        .map(|(i, text)| DocChunk {
            id: format!("{}_{}", doc_id, i),
            doc_id: doc_id.clone(),
            content: text.clone(),
            index: i,
            token_count: estimate_tokens(text),
            metadata: ChunkMetadata {
                source: name.clone(),
                page: None,
                heading: None,
            },
            embedding: Vec::new(),
        })
        .collect();

    let batch_size = 20;
    let mut all_embeddings: Vec<Vec<f32>> = Vec::new();

    for batch_start in (0..text_chunks.len()).step_by(batch_size) {
        let batch_end = (batch_start + batch_size).min(text_chunks.len());
        let batch: Vec<String> = text_chunks[batch_start..batch_end].to_vec();

        match get_embeddings(&app, &batch).await {
            Ok(embeddings) => {
                all_embeddings.extend(embeddings);
            }
            Err(e) => {
                doc.status = "error".to_string();
                doc.error_msg = Some(e.clone());
                doc.updated_at = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;

                let mut docs = load_docs_index(&app);
                if let Some(d) = docs.iter_mut().find(|d| d.id == doc_id) {
                    *d = doc.clone();
                }
                save_docs_index(&app, &docs);

                let _ = app.emit("rag-index-progress", serde_json::json!({
                    "docId": &doc_id,
                    "status": "error",
                    "error": &e,
                }));

                return Err(e);
            }
        }
    }

    for (i, emb) in all_embeddings.iter().enumerate() {
        if i < chunks.len() {
            chunks[i].embedding = emb.clone();
        }
    }

    let total_tokens: usize = chunks.iter().map(|c| c.token_count).sum();

    save_chunks_for_doc(&app, &doc_id, &chunks);
    save_vectors_for_doc(&app, &doc_id, &all_embeddings);

    doc.status = "indexed".to_string();
    doc.chunk_count = chunks.len();
    doc.token_count = total_tokens;
    doc.updated_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let mut docs = load_docs_index(&app);
    if let Some(d) = docs.iter_mut().find(|d| d.id == doc_id) {
        *d = doc.clone();
    }
    save_docs_index(&app, &docs);

    let _ = app.emit("rag-index-progress", serde_json::json!({
        "docId": &doc_id,
        "status": "indexed",
    }));

    Ok(doc)
}

/// 删除知识库文档
#[tauri::command]
pub async fn rag_remove_doc(app: AppHandle, doc_id: String) -> Result<(), String> {
    let mut docs = load_docs_index(&app);
    docs.retain(|d| d.id != doc_id);
    save_docs_index(&app, &docs);

    // 删除 chunks 和 vectors 文件
    let chunks_path = get_chunks_dir(&app).join(format!("{}.json", doc_id));
    let vectors_path = get_vectors_dir(&app).join(format!("{}.bin", doc_id));
    let _ = std::fs::remove_file(chunks_path);
    let _ = std::fs::remove_file(vectors_path);

    Ok(())
}

/// 重建文档索引
#[tauri::command]
pub async fn rag_reindex_doc(app: AppHandle, doc_id: String) -> Result<(), String> {
    let docs = load_docs_index(&app);
    let doc = docs.iter().find(|d| d.id == doc_id).ok_or("文档不存在")?;
    let file_path = doc.path.clone();
    let tags = doc.tags.clone();

    // 先删除旧数据
    rag_remove_doc(app.clone(), doc_id).await?;

    // 重新导入
    rag_import_doc(app, file_path, tags).await?;
    Ok(())
}

/// 检索知识库
#[tauri::command]
pub async fn rag_search(
    app: AppHandle,
    query: String,
    top_k: Option<usize>,
    threshold: Option<f32>,
) -> Result<Vec<RetrievalResult>, String> {
    let config = load_rag_config(&app);
    let top_k = top_k.unwrap_or(config.top_k);
    let threshold = threshold.unwrap_or(config.score_threshold);

    // 获取 query 的 embedding
    let query_embeddings = get_embeddings(&app, &[query]).await?;
    let query_vec = query_embeddings.into_iter().next().ok_or("获取查询向量失败")?;

    // 遍历所有文档的 chunks 和 vectors，使用最小堆维护 top_k 高分结果
    // 避免全量排序（O(n log n)），改为 O(n log k) 其中 k = top_k
    let docs = load_docs_index(&app);
    use std::collections::BinaryHeap;
    use std::cmp::Reverse;

    // 包装 f32 以支持 Ord（NaN 视为最小值）
    #[derive(PartialEq, Clone, Copy)]
    struct OrdF32(f32);
    impl Eq for OrdF32 {}
    impl PartialOrd for OrdF32 {
        fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> { Some(self.cmp(other)) }
    }
    impl Ord for OrdF32 {
        fn cmp(&self, other: &Self) -> std::cmp::Ordering {
            self.0.partial_cmp(&other.0).unwrap_or(std::cmp::Ordering::Equal)
        }
    }

    let mut heap: BinaryHeap<Reverse<(OrdF32, usize)>> = BinaryHeap::new();
    let mut all_candidates: Vec<RetrievalResult> = Vec::new();

    for doc in &docs {
        if doc.status != "indexed" {
            continue;
        }

        let chunks = load_chunks_for_doc(&app, &doc.id);
        let vectors = load_vectors_for_doc(&app, &doc.id);

        for (i, chunk) in chunks.iter().enumerate() {
            if i < vectors.len() {
                let score = cosine_similarity(&query_vec, &vectors[i]);
                if score >= threshold {
                    let idx = all_candidates.len();
                    all_candidates.push(RetrievalResult {
                        chunk: chunk.clone(),
                        score,
                    });
                    if heap.len() < top_k {
                        heap.push(Reverse((OrdF32(score), idx)));
                    } else if let Some(&Reverse((min_score, _))) = heap.peek() {
                        if OrdF32(score) > min_score {
                            heap.pop();
                            heap.push(Reverse((OrdF32(score), idx)));
                        }
                    }
                }
            }
        }
    }

    // 从堆中提取结果并按分数降序排列
    let mut results: Vec<RetrievalResult> = heap
        .into_iter()
        .map(|Reverse((_, idx))| all_candidates[idx].clone())
        .collect();
    results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));

    Ok(results)
}

/// 获取知识库统计
#[tauri::command]
pub async fn rag_get_stats(app: AppHandle) -> Result<RAGStats, String> {
    let docs = load_docs_index(&app);
    let total_docs = docs.len();
    let total_chunks: usize = docs.iter().map(|d| d.chunk_count).sum();
    let total_tokens: usize = docs.iter().map(|d| d.token_count).sum();

    // 计算索引大小
    let vectors_dir = get_vectors_dir(&app);
    let mut index_size: u64 = 0;
    if vectors_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&vectors_dir) {
            for entry in entries.flatten() {
                index_size += entry.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }

    Ok(RAGStats {
        total_docs,
        total_chunks,
        total_tokens,
        index_size,
    })
}

/// 设置 RAG 配置
#[tauri::command]
pub async fn rag_set_config(app: AppHandle, config: RAGConfig) -> Result<(), String> {
    save_rag_config(&app, &config);
    Ok(())
}
