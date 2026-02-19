use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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

// ── BM25 关键词搜索引擎 ──

/// 倒排索引：term → [(doc_id, chunk_index, term_frequency)]
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
struct InvertedIndex {
    postings: HashMap<String, Vec<Posting>>,
    doc_count: usize,
    avg_doc_len: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct Posting {
    doc_id: String,
    chunk_idx: usize,
    tf: usize,
}

/// CJK + 英文混合分词器（bigram for CJK, whitespace for latin）
fn tokenize(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    let mut tokens = Vec::new();
    let mut latin_buf = String::new();

    let chars: Vec<char> = lower.chars().collect();
    for (i, &ch) in chars.iter().enumerate() {
        if is_cjk(ch) {
            // flush latin buffer
            if !latin_buf.is_empty() {
                for word in latin_buf.split_whitespace() {
                    let w = word.trim_matches(|c: char| !c.is_alphanumeric());
                    if w.len() >= 2 {
                        tokens.push(w.to_string());
                    }
                }
                latin_buf.clear();
            }
            // unigram
            tokens.push(ch.to_string());
            // bigram
            if i + 1 < chars.len() && is_cjk(chars[i + 1]) {
                tokens.push(format!("{}{}", ch, chars[i + 1]));
            }
        } else {
            latin_buf.push(ch);
        }
    }
    if !latin_buf.is_empty() {
        for word in latin_buf.split_whitespace() {
            let w = word.trim_matches(|c: char| !c.is_alphanumeric());
            if w.len() >= 2 {
                tokens.push(w.to_string());
            }
        }
    }
    tokens
}

fn is_cjk(c: char) -> bool {
    let code = c as u32;
    (0x4E00..=0x9FFF).contains(&code)
        || (0x3400..=0x4DBF).contains(&code)
        || (0x3000..=0x303F).contains(&code)
        || (0xFF00..=0xFFEF).contains(&code)
}

fn get_keyword_index_path(app: &AppHandle) -> PathBuf {
    get_rag_dir(app).join("keyword_index.json")
}

fn load_keyword_index(app: &AppHandle) -> InvertedIndex {
    let path = get_keyword_index_path(app);
    if path.exists() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            return serde_json::from_str(&content).unwrap_or_default();
        }
    }
    InvertedIndex::default()
}

fn save_keyword_index(app: &AppHandle, index: &InvertedIndex) {
    let path = get_keyword_index_path(app);
    if let Ok(json) = serde_json::to_string(index) {
        let _ = std::fs::write(&path, json);
    }
}

/// 为一个文档的 chunks 构建倒排索引条目
fn build_index_for_doc(index: &mut InvertedIndex, doc_id: &str, chunks: &[DocChunk]) {
    // 先移除该 doc 的旧条目
    for postings in index.postings.values_mut() {
        postings.retain(|p| p.doc_id != doc_id);
    }

    for chunk in chunks {
        let tokens = tokenize(&chunk.content);
        let mut tf_map: HashMap<String, usize> = HashMap::new();
        for token in &tokens {
            *tf_map.entry(token.clone()).or_insert(0) += 1;
        }
        for (term, tf) in tf_map {
            index.postings.entry(term).or_default().push(Posting {
                doc_id: doc_id.to_string(),
                chunk_idx: chunk.index,
                tf,
            });
        }
    }
    // 清理空条目
    index.postings.retain(|_, v| !v.is_empty());
}

fn remove_doc_from_index(index: &mut InvertedIndex, doc_id: &str) {
    for postings in index.postings.values_mut() {
        postings.retain(|p| p.doc_id != doc_id);
    }
    index.postings.retain(|_, v| !v.is_empty());
}

/// 更新全局文档数量和平均文档长度（用于 BM25）
/// 基于索引中实际存在的文档数计算，不依赖 status 字段
fn update_index_stats(index: &mut InvertedIndex, _docs: &[KnowledgeDoc]) {
    // 从索引的 postings 中统计实际有多少个不同的 doc_id
    let doc_ids: std::collections::HashSet<&str> = index.postings.values()
        .flat_map(|postings| postings.iter().map(|p| p.doc_id.as_str()))
        .collect();
    index.doc_count = doc_ids.len().max(1);

    // 估算平均文档长度：总 postings 数 / 文档数
    let total_postings: usize = index.postings.values().map(|v| v.len()).sum();
    if doc_ids.is_empty() {
        index.avg_doc_len = 0.0;
    } else {
        index.avg_doc_len = total_postings as f64 / doc_ids.len() as f64;
    }
}

/// BM25 打分搜索
fn bm25_search(
    app: &AppHandle,
    index: &InvertedIndex,
    query: &str,
    top_k: usize,
) -> Vec<RetrievalResult> {
    let query_tokens = tokenize(query);
    if query_tokens.is_empty() {
        return Vec::new();
    }

    // BM25 在这里以 chunk 为检索单位：
    // - n: 总 chunk 数
    // - df: 命中该 term 的 chunk 数
    // - doc_len: 当前 chunk 的 token 长度
    //
    // 之前用“文档数”计算 n，会在单文档多 chunk 场景下导致 df > n，
    // 高频关键词被错误跳过，从而出现“明明有内容却搜不到”。
    let mut chunk_token_lens: HashMap<(String, usize), usize> = HashMap::new();
    for postings in index.postings.values() {
        for posting in postings {
            let key = (posting.doc_id.clone(), posting.chunk_idx);
            *chunk_token_lens.entry(key).or_insert(0) += posting.tf;
        }
    }

    if chunk_token_lens.is_empty() {
        return Vec::new();
    }

    let k1: f64 = 1.2;
    let b: f64 = 0.75;
    let n = chunk_token_lens.len() as f64;
    let avg_doc_len = chunk_token_lens.values().sum::<usize>() as f64 / n.max(1.0);

    // chunk_key → score
    let mut scores: HashMap<(String, usize), f64> = HashMap::new();

    for token in &query_tokens {
        if let Some(postings) = index.postings.get(token) {
            let df = postings
                .iter()
                .map(|p| (p.doc_id.as_str(), p.chunk_idx))
                .collect::<std::collections::HashSet<_>>()
                .len() as f64;
            let idf = ((n - df + 0.5) / (df + 0.5) + 1.0).ln();
            if idf <= 0.0 { continue; }

            for posting in postings {
                let key = (posting.doc_id.clone(), posting.chunk_idx);
                let tf = posting.tf as f64;
                let doc_len = *chunk_token_lens.get(&key).unwrap_or(&1) as f64;
                let tf_norm = (tf * (k1 + 1.0))
                    / (tf + k1 * (1.0 - b + b * doc_len / avg_doc_len.max(1.0)));
                *scores.entry(key).or_insert(0.0) += idf * tf_norm;
            }
        }
    }

    if scores.is_empty() {
        return Vec::new();
    }

    // 归一化分数到 0-1 范围
    let max_score = scores.values().cloned().fold(f64::NEG_INFINITY, f64::max);
    let min_score = scores.values().cloned().fold(f64::INFINITY, f64::min);
    let score_range = if max_score > min_score { max_score - min_score } else { 1.0 };

    let mut sorted: Vec<((String, usize), f64)> = scores.into_iter().collect();
    sorted.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    sorted.truncate(top_k);

    let mut results = Vec::new();
    for ((doc_id, chunk_idx), score) in sorted {
        let chunks = load_chunks_for_doc(app, &doc_id);
        if let Some(chunk) = chunks.into_iter().find(|c| c.index == chunk_idx) {
            let normalized = if score_range > 0.0 { (score - min_score) / score_range } else { 1.0 };
            results.push(RetrievalResult {
                chunk,
                score: (normalized * 0.7 + 0.3) as f32, // scale to 0.3-1.0
            });
        }
    }
    results
}

// ── Tauri Commands ──

/// 列出所有知识库文档
#[tauri::command]
pub async fn rag_list_docs(app: AppHandle) -> Result<Vec<KnowledgeDoc>, String> {
    Ok(load_docs_index(&app))
}

/// 内部通用导入逻辑：分块 → 关键词索引（必做）→ Embedding（可选）
async fn import_doc_internal(
    app: &AppHandle,
    doc: &mut KnowledgeDoc,
    content: &str,
) -> Result<(), String> {
    let config = load_rag_config(app);
    let doc_id = doc.id.clone();

    use tauri::Emitter;
    let _ = app.emit("rag-index-progress", serde_json::json!({
        "docId": &doc_id,
        "status": "processing",
    }));

    // 1) 分块
    let text_chunks = chunk_text(content, config.chunk_size, config.chunk_overlap);
    let chunks: Vec<DocChunk> = text_chunks
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
        })
        .collect();

    let total_tokens: usize = chunks.iter().map(|c| c.token_count).sum();
    save_chunks_for_doc(app, &doc_id, &chunks);

    // 2) 关键词索引（始终成功，无外部依赖）
    let mut kw_index = load_keyword_index(app);
    build_index_for_doc(&mut kw_index, &doc_id, &chunks);
    let all_docs = load_docs_index(app);
    update_index_stats(&mut kw_index, &all_docs);
    save_keyword_index(app, &kw_index);

    doc.chunk_count = chunks.len();
    doc.token_count = total_tokens;
    doc.status = "indexed".to_string();
    doc.updated_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    // 更新 docs_index
    let mut docs = load_docs_index(app);
    if let Some(d) = docs.iter_mut().find(|d| d.id == doc_id) {
        *d = doc.clone();
    }
    save_docs_index(app, &docs);

    let _ = app.emit("rag-index-progress", serde_json::json!({
        "docId": &doc_id,
        "status": "indexed",
    }));

    // 3) 向量索引（可选增强，失败不阻断）
    let batch_size = 20;
    let mut all_embeddings: Vec<Vec<f32>> = Vec::new();
    let mut embed_ok = true;

    for batch_start in (0..text_chunks.len()).step_by(batch_size) {
        let batch_end = (batch_start + batch_size).min(text_chunks.len());
        let batch: Vec<String> = text_chunks[batch_start..batch_end].to_vec();

        match get_embeddings(app, &batch).await {
            Ok(embeddings) => {
                all_embeddings.extend(embeddings);
            }
            Err(e) => {
                log::info!("Embedding 可选增强跳过: {}", e);
                embed_ok = false;
                break;
            }
        }
    }

    if embed_ok && all_embeddings.len() == chunks.len() {
        save_vectors_for_doc(app, &doc_id, &all_embeddings);
        doc.status = "indexed_full".to_string();
        doc.updated_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        let mut docs = load_docs_index(app);
        if let Some(d) = docs.iter_mut().find(|d| d.id == doc_id) {
            *d = doc.clone();
        }
        save_docs_index(app, &docs);
    }

    Ok(())
}

/// 导入文档到知识库
#[tauri::command]
pub async fn rag_import_doc(
    app: AppHandle,
    file_path: String,
    tags: Vec<String>,
) -> Result<KnowledgeDoc, String> {
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

    let mut docs = load_docs_index(&app);
    docs.push(doc.clone());
    save_docs_index(&app, &docs);

    import_doc_internal(&app, &mut doc, &content).await?;
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

    import_doc_internal(&app, &mut doc, &content).await?;
    Ok(doc)
}

/// 删除知识库文档
#[tauri::command]
pub async fn rag_remove_doc(app: AppHandle, doc_id: String) -> Result<(), String> {
    let mut docs = load_docs_index(&app);
    docs.retain(|d| d.id != doc_id);
    save_docs_index(&app, &docs);

    // 从关键词索引中移除
    let mut kw_index = load_keyword_index(&app);
    remove_doc_from_index(&mut kw_index, &doc_id);
    update_index_stats(&mut kw_index, &docs);
    save_keyword_index(&app, &kw_index);

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

/// 确保关键词索引与磁盘上的 chunks 文件同步
/// 不依赖文档 status，直接扫描 chunks 目录，有 chunks 文件但不在索引中的就补建
fn ensure_keyword_index(app: &AppHandle, index: &mut InvertedIndex) {
    let chunks_dir = get_chunks_dir(app);
    let Ok(entries) = std::fs::read_dir(&chunks_dir) else { return };

    // 收集磁盘上所有有 chunks 文件的 doc_id
    let disk_doc_ids: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if name.ends_with(".json") {
                Some(name.trim_end_matches(".json").to_string())
            } else {
                None
            }
        })
        .collect();

    if disk_doc_ids.is_empty() {
        return;
    }

    // 找出不在关键词索引中的 doc_id
    let index_doc_ids: std::collections::HashSet<&str> = index.postings.values()
        .flat_map(|postings| postings.iter().map(|p| p.doc_id.as_str()))
        .collect();
    let missing: Vec<&String> = disk_doc_ids.iter()
        .filter(|id| !index_doc_ids.contains(id.as_str()))
        .collect();

    if missing.is_empty() {
        return;
    }

    log::info!("关键词索引缺少 {} 个文档（共 {} 个），补充建立...", missing.len(), disk_doc_ids.len());
    for doc_id in &missing {
        let chunks = load_chunks_for_doc(app, doc_id);
        if !chunks.is_empty() {
            build_index_for_doc(index, doc_id, &chunks);
            log::info!("  已索引文档 {} ({} 个分块)", doc_id, chunks.len());
        }
    }
    let docs = load_docs_index(app);
    update_index_stats(index, &docs);
    save_keyword_index(app, index);
    log::info!("关键词索引更新完成，共 {} 个词条", index.postings.len());
}

/// 关键词搜索（BM25，无需任何 API）
#[tauri::command]
pub async fn rag_keyword_search(
    app: AppHandle,
    query: String,
    top_k: Option<usize>,
) -> Result<Vec<RetrievalResult>, String> {
    let config = load_rag_config(&app);
    let top_k = top_k.unwrap_or(config.top_k);
    let mut index = load_keyword_index(&app);
    ensure_keyword_index(&app, &mut index);
    Ok(bm25_search(&app, &index, &query, top_k))
}

/// 检索知识库（自动选择最优策略：有向量用混合，没有则用关键词）
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

    // 始终执行关键词搜索（含自动重建）
    let mut kw_index = load_keyword_index(&app);
    ensure_keyword_index(&app, &mut kw_index);
    let keyword_results = bm25_search(&app, &kw_index, &query, top_k * 2);

    // 尝试向量搜索（如果有 Embedding API 配置）
    let vector_results = match get_embeddings(&app, &[query.clone()]).await {
        Ok(query_embeddings) => {
            let query_vec = query_embeddings.into_iter().next().unwrap_or_default();
            if query_vec.is_empty() {
                Vec::new()
            } else {
                let docs = load_docs_index(&app);
                let mut results = Vec::new();
                for doc in &docs {
                    if doc.status != "indexed_full" && doc.status != "indexed" {
                        continue;
                    }
                    let chunks = load_chunks_for_doc(&app, &doc.id);
                    let vectors = load_vectors_for_doc(&app, &doc.id);
                    for (i, chunk) in chunks.iter().enumerate() {
                        if i < vectors.len() {
                            let score = cosine_similarity(&query_vec, &vectors[i]);
                            if score >= threshold {
                                results.push(RetrievalResult { chunk: chunk.clone(), score });
                            }
                        }
                    }
                }
                results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
                results.truncate(top_k * 2);
                results
            }
        }
        Err(_) => Vec::new(),
    };

    // RRF（Reciprocal Rank Fusion）合并两路结果
    if vector_results.is_empty() {
        let mut r = keyword_results;
        r.truncate(top_k);
        return Ok(r);
    }

    let k_rrf: f64 = 60.0;
    let mut fused_scores: HashMap<String, (f64, DocChunk)> = HashMap::new();

    for (rank, r) in keyword_results.iter().enumerate() {
        let key = r.chunk.id.clone();
        let rrf_score = 1.0 / (k_rrf + rank as f64 + 1.0);
        let entry = fused_scores.entry(key).or_insert((0.0, r.chunk.clone()));
        entry.0 += rrf_score;
    }
    for (rank, r) in vector_results.iter().enumerate() {
        let key = r.chunk.id.clone();
        let rrf_score = 1.0 / (k_rrf + rank as f64 + 1.0);
        let entry = fused_scores.entry(key).or_insert((0.0, r.chunk.clone()));
        entry.0 += rrf_score;
    }

    let mut fused: Vec<RetrievalResult> = fused_scores
        .into_values()
        .map(|(score, chunk)| RetrievalResult { chunk, score: score as f32 })
        .collect();
    fused.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    fused.truncate(top_k);

    Ok(fused)
}

/// 列出知识库文档元数据（供 AI 工具使用）
#[tauri::command]
pub async fn rag_list_doc_summaries(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let docs = load_docs_index(&app);
    let summaries: Vec<serde_json::Value> = docs
        .iter()
        .filter(|d| d.status == "indexed" || d.status == "indexed_full" || d.status == "indexed_keyword")
        .map(|d| {
            serde_json::json!({
                "id": d.id,
                "name": d.name,
                "format": d.format,
                "size": d.size,
                "chunkCount": d.chunk_count,
                "tokenCount": d.token_count,
                "tags": d.tags,
                "sourceType": d.source_type,
                "status": d.status,
            })
        })
        .collect();
    Ok(summaries)
}

/// 读取指定文档的 chunk 内容（带上下文）
#[tauri::command]
pub async fn rag_read_doc_chunks(
    app: AppHandle,
    doc_id: String,
    chunk_indices: Vec<usize>,
    context_window: Option<usize>,
) -> Result<Vec<serde_json::Value>, String> {
    let chunks = load_chunks_for_doc(&app, &doc_id);
    if chunks.is_empty() {
        return Err("文档不存在或没有分块数据".to_string());
    }

    let window = context_window.unwrap_or(1);
    let max_idx = chunks.len();
    let mut result = Vec::new();

    for target_idx in chunk_indices {
        let start = target_idx.saturating_sub(window);
        let end = (target_idx + window + 1).min(max_idx);

        for chunk in chunks.iter().filter(|c| c.index >= start && c.index < end) {
            result.push(serde_json::json!({
                "chunkId": chunk.id,
                "docId": chunk.doc_id,
                "index": chunk.index,
                "content": chunk.content,
                "tokenCount": chunk.token_count,
                "source": chunk.metadata.source,
                "isTarget": chunk.index == target_idx,
            }));
        }
    }

    // 去重（多个 target 的上下文可能重叠）
    let mut seen = std::collections::HashSet::new();
    result.retain(|v| {
        let id = v["chunkId"].as_str().unwrap_or("").to_string();
        seen.insert(id)
    });

    Ok(result)
}

/// 获取知识库统计
#[tauri::command]
pub async fn rag_get_stats(app: AppHandle) -> Result<RAGStats, String> {
    let docs = load_docs_index(&app);
    let total_docs = docs.len();
    let total_chunks: usize = docs.iter().map(|d| d.chunk_count).sum();
    let total_tokens: usize = docs.iter().map(|d| d.token_count).sum();

    let vectors_dir = get_vectors_dir(&app);
    let mut index_size: u64 = 0;
    if vectors_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&vectors_dir) {
            for entry in entries.flatten() {
                index_size += entry.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    // include keyword index size
    let kw_path = get_keyword_index_path(&app);
    if kw_path.exists() {
        index_size += std::fs::metadata(&kw_path).map(|m| m.len()).unwrap_or(0);
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
