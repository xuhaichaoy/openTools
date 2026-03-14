/// Code Knowledge Graph (CKG)
///
/// 基于 tree-sitter 解析项目源代码，将函数/类/方法定义索引到 SQLite，
/// 提供 search_function / search_class / search_class_method 语义查询。
/// 参考: trae-agent CKGDatabase 实现。
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use once_cell::sync::Lazy;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tree_sitter::{Language, Node, Parser};

// ── 数据模型 ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionEntry {
    pub name: String,
    pub file_path: String,
    pub body: String,
    pub start_line: usize,
    pub end_line: usize,
    pub parent_function: Option<String>,
    pub parent_class: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClassEntry {
    pub name: String,
    pub file_path: String,
    pub body: String,
    pub start_line: usize,
    pub end_line: usize,
    pub fields: Option<String>,
    pub methods: Option<String>,
}

// ── 文件扩展名 → tree-sitter 语言 映射 ──

fn extension_to_lang(ext: &str) -> Option<&'static str> {
    match ext {
        "py" => Some("python"),
        "rs" => Some("rust"),
        "ts" | "tsx" => Some("typescript"),
        "js" | "jsx" | "mjs" => Some("javascript"),
        "java" => Some("java"),
        "go" => Some("go"),
        "c" | "h" => Some("c"),
        "cpp" | "cc" | "cxx" | "hpp" | "hh" | "hxx" | "c++" => Some("cpp"),
        _ => None,
    }
}

fn get_tree_sitter_language(lang: &str) -> Option<Language> {
    match lang {
        "python" => Some(tree_sitter_python::LANGUAGE.into()),
        "rust" => Some(tree_sitter_rust::LANGUAGE.into()),
        "typescript" => Some(tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()),
        "javascript" => Some(tree_sitter_javascript::LANGUAGE.into()),
        "java" => Some(tree_sitter_java::LANGUAGE.into()),
        "go" => Some(tree_sitter_go::LANGUAGE.into()),
        "c" => Some(tree_sitter_c::LANGUAGE.into()),
        "cpp" => Some(tree_sitter_cpp::LANGUAGE.into()),
        _ => None,
    }
}

// ── 忽略目录 ──

fn should_skip_dir(name: &str) -> bool {
    matches!(
        name,
        "node_modules"
            | ".git"
            | ".svn"
            | "__pycache__"
            | ".venv"
            | "venv"
            | "target"
            | "build"
            | "dist"
            | ".next"
            | ".nuxt"
            | "vendor"
            | ".idea"
            | ".vscode"
    ) || name.starts_with('.')
}

// ── Git 快照 Hash ──

fn is_git_repository(folder: &Path) -> bool {
    Command::new("git")
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(folder)
        .output()
        .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "true")
        .unwrap_or(false)
}

fn get_git_status_hash(folder: &Path) -> Option<String> {
    let commit = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(folder)
        .output()
        .ok()?;
    if !commit.status.success() {
        return None;
    }
    let base = String::from_utf8_lossy(&commit.stdout).trim().to_string();

    let status = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(folder)
        .output()
        .ok()?;
    let porcelain = String::from_utf8_lossy(&status.stdout).trim().to_string();
    if porcelain.is_empty() {
        Some(format!("git-clean-{}", &base[..12.min(base.len())]))
    } else {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(porcelain.as_bytes());
        let dirty_hash = format!("{:x}", hasher.finalize());
        Some(format!(
            "git-dirty-{}-{}",
            &base[..12.min(base.len())],
            &dirty_hash[..8]
        ))
    }
}

fn get_file_metadata_hash(folder: &Path) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    for entry in walkdir::WalkDir::new(folder)
        .into_iter()
        .filter_entry(|e| {
            if e.file_type().is_dir() {
                return !should_skip_dir(&e.file_name().to_string_lossy());
            }
            true
        })
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        if let Some(ext) = entry.path().extension().and_then(|e| e.to_str()) {
            if extension_to_lang(ext).is_none() {
                continue;
            }
        } else {
            continue;
        }
        hasher.update(entry.path().to_string_lossy().as_bytes());
        if let Ok(meta) = entry.metadata() {
            hasher.update(meta.len().to_le_bytes());
            if let Ok(mtime) = meta.modified() {
                let secs = mtime
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                hasher.update(secs.to_le_bytes());
            }
        }
    }
    format!("meta-{:x}", hasher.finalize())[..20].to_string()
}

fn get_folder_snapshot_hash(folder: &Path) -> String {
    if is_git_repository(folder) {
        if let Some(h) = get_git_status_hash(folder) {
            return h;
        }
    }
    get_file_metadata_hash(folder)
}

// ── CKG 数据库 ──

static CKG_DB_CACHE: Lazy<Mutex<HashMap<String, PathBuf>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn ckg_storage_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.51cto.toolbox")
        .join("ckg")
}

fn open_or_build_db(project_path: &Path) -> Result<Connection, String> {
    let storage = ckg_storage_dir();
    std::fs::create_dir_all(&storage).map_err(|e| format!("创建 CKG 目录失败: {e}"))?;

    let abs_project = project_path
        .canonicalize()
        .unwrap_or_else(|_| project_path.to_path_buf());
    let project_key = abs_project.to_string_lossy().to_string();

    let snapshot = get_folder_snapshot_hash(&abs_project);
    let db_name = format!("{}.db", &snapshot);
    let db_path = storage.join(&db_name);

    // 检查缓存
    {
        let cache = CKG_DB_CACHE.lock().unwrap();
        if let Some(cached_path) = cache.get(&project_key) {
            if cached_path == &db_path && db_path.exists() {
                let conn =
                    Connection::open(&db_path).map_err(|e| format!("打开 CKG 数据库失败: {e}"))?;
                return Ok(conn);
            }
        }
    }

    // 清理旧 DB
    {
        let mut cache = CKG_DB_CACHE.lock().unwrap();
        if let Some(old_path) = cache.get(&project_key) {
            if old_path != &db_path && old_path.exists() {
                let _ = std::fs::remove_file(old_path);
            }
        }
        cache.insert(project_key, db_path.clone());
    }

    if db_path.exists() {
        let conn = Connection::open(&db_path).map_err(|e| format!("打开 CKG 数据库失败: {e}"))?;
        return Ok(conn);
    }

    // 新建并构建索引
    let conn = Connection::open(&db_path).map_err(|e| format!("创建 CKG 数据库失败: {e}"))?;
    create_tables(&conn)?;
    build_index(&conn, &abs_project)?;
    Ok(conn)
}

fn create_tables(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS functions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            file_path TEXT NOT NULL,
            body TEXT NOT NULL,
            start_line INTEGER NOT NULL,
            end_line INTEGER NOT NULL,
            parent_function TEXT,
            parent_class TEXT
        );
        CREATE TABLE IF NOT EXISTS classes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            file_path TEXT NOT NULL,
            body TEXT NOT NULL,
            fields TEXT,
            methods TEXT,
            start_line INTEGER NOT NULL,
            end_line INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_functions_name ON functions(name);
        CREATE INDEX IF NOT EXISTS idx_classes_name ON classes(name);",
    )
    .map_err(|e| format!("建表失败: {e}"))
}

// ── 索引构建 ──

fn build_index(conn: &Connection, project_path: &Path) -> Result<(), String> {
    let mut parsers: HashMap<String, Parser> = HashMap::new();

    for entry in walkdir::WalkDir::new(project_path)
        .into_iter()
        .filter_entry(|e| {
            if e.file_type().is_dir() {
                let name = e.file_name().to_string_lossy();
                return !should_skip_dir(&name);
            }
            true
        })
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let ext = match path.extension().and_then(|e| e.to_str()) {
            Some(e) => e.to_string(),
            None => continue,
        };
        let lang = match extension_to_lang(&ext) {
            Some(l) => l.to_string(),
            None => continue,
        };

        let source = match std::fs::read(path) {
            Ok(b) => b,
            Err(_) => continue,
        };

        // 跳过超大文件 (> 1MB)
        if source.len() > 1_000_000 {
            continue;
        }

        let parser = parsers.entry(lang.clone()).or_insert_with(|| {
            let mut p = Parser::new();
            if let Some(language) = get_tree_sitter_language(&lang) {
                let _ = p.set_language(&language);
            }
            p
        });

        let tree = match parser.parse(&source, None) {
            Some(t) => t,
            None => continue,
        };

        let file_path_str = path.to_string_lossy().to_string();
        let source_str = String::from_utf8_lossy(&source);

        visit_node(
            conn,
            tree.root_node(),
            &file_path_str,
            &source_str,
            &lang,
            None,
            None,
        );
    }

    Ok(())
}

// ── AST 遍历 ──

fn visit_node(
    conn: &Connection,
    node: Node,
    file_path: &str,
    source: &str,
    lang: &str,
    parent_class: Option<&str>,
    parent_function: Option<&str>,
) {
    let kind = node.kind();
    match lang {
        "python" => visit_python(conn, node, file_path, source, parent_class, parent_function),
        "rust" => visit_rust(conn, node, file_path, source, parent_class, parent_function),
        "typescript" | "javascript" => {
            visit_ts_js(conn, node, file_path, source, parent_class, parent_function)
        }
        "java" => visit_java(conn, node, file_path, source, parent_class, parent_function),
        "go" => visit_go(conn, node, file_path, source, parent_class, parent_function),
        "c" => visit_c(conn, node, file_path, source, parent_class, parent_function),
        "cpp" => visit_cpp(conn, node, file_path, source, parent_class, parent_function),
        _ => {
            for i in 0..node.child_count() {
                if let Some(child) = node.child(i) {
                    visit_node(
                        conn,
                        child,
                        file_path,
                        source,
                        lang,
                        parent_class,
                        parent_function,
                    );
                }
            }
        }
    }
    let _ = kind; // suppress unused warning in match arms
}

fn node_text<'a>(node: Node, source: &'a str) -> &'a str {
    let start = node.start_byte();
    let end = node.end_byte();
    if start < source.len() && end <= source.len() && start <= end {
        &source[start..end]
    } else {
        ""
    }
}

fn child_field_text<'a>(node: Node, field: &str, source: &'a str) -> Option<&'a str> {
    node.child_by_field_name(field)
        .map(|n| node_text(n, source))
}

fn insert_function(conn: &Connection, entry: &FunctionEntry) {
    let _ = conn.execute(
        "INSERT INTO functions (name, file_path, body, start_line, end_line, parent_function, parent_class) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![
            entry.name,
            entry.file_path,
            entry.body,
            entry.start_line,
            entry.end_line,
            entry.parent_function,
            entry.parent_class,
        ],
    );
}

fn insert_class(conn: &Connection, entry: &ClassEntry) {
    let _ = conn.execute(
        "INSERT INTO classes (name, file_path, body, fields, methods, start_line, end_line) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![
            entry.name,
            entry.file_path,
            entry.body,
            entry.fields,
            entry.methods,
            entry.start_line,
            entry.end_line,
        ],
    );
}

/// 截断过长的函数体，只保留签名 + 前 N 行
fn truncate_body(body: &str, max_lines: usize) -> String {
    let lines: Vec<&str> = body.lines().collect();
    if lines.len() <= max_lines {
        body.to_string()
    } else {
        let mut out: Vec<&str> = lines[..max_lines].to_vec();
        out.push("    // ... (truncated)");
        out.join("\n")
    }
}

// ── Python ──

fn visit_python(
    conn: &Connection,
    node: Node,
    file_path: &str,
    source: &str,
    parent_class: Option<&str>,
    parent_function: Option<&str>,
) {
    if node.kind() == "function_definition" {
        if let Some(name) = child_field_text(node, "name", source) {
            let entry = FunctionEntry {
                name: name.to_string(),
                file_path: file_path.to_string(),
                body: truncate_body(node_text(node, source), 50),
                start_line: node.start_position().row + 1,
                end_line: node.end_position().row + 1,
                parent_function: parent_function.map(|s| s.to_string()),
                parent_class: parent_class.map(|s| s.to_string()),
            };
            insert_function(conn, &entry);
            for i in 0..node.child_count() {
                if let Some(child) = node.child(i) {
                    visit_python(conn, child, file_path, source, parent_class, Some(name));
                }
            }
            return;
        }
    } else if node.kind() == "class_definition" {
        if let Some(name) = child_field_text(node, "name", source) {
            let mut methods_str = String::new();
            if let Some(body) = node.child_by_field_name("body") {
                for i in 0..body.child_count() {
                    if let Some(child) = body.child(i) {
                        let def_node = if child.kind() == "decorated_definition" {
                            child.child_by_field_name("definition")
                        } else if child.kind() == "function_definition" {
                            Some(child)
                        } else {
                            None
                        };
                        if let Some(fn_node) = def_node {
                            if let Some(method_name) = child_field_text(fn_node, "name", source) {
                                let params_text =
                                    child_field_text(fn_node, "parameters", source).unwrap_or("()");
                                methods_str.push_str(&format!("- {method_name}{params_text}\n"));
                            }
                        }
                    }
                }
            }
            let entry = ClassEntry {
                name: name.to_string(),
                file_path: file_path.to_string(),
                body: truncate_body(node_text(node, source), 30),
                start_line: node.start_position().row + 1,
                end_line: node.end_position().row + 1,
                fields: None,
                methods: if methods_str.is_empty() {
                    None
                } else {
                    Some(methods_str.trim().to_string())
                },
            };
            insert_class(conn, &entry);
            for i in 0..node.child_count() {
                if let Some(child) = node.child(i) {
                    visit_python(conn, child, file_path, source, Some(name), parent_function);
                }
            }
            return;
        }
    }
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            visit_python(
                conn,
                child,
                file_path,
                source,
                parent_class,
                parent_function,
            );
        }
    }
}

// ── Rust ──

fn visit_rust(
    conn: &Connection,
    node: Node,
    file_path: &str,
    source: &str,
    parent_class: Option<&str>,
    parent_function: Option<&str>,
) {
    match node.kind() {
        "function_item" => {
            if let Some(name) = child_field_text(node, "name", source) {
                insert_function(
                    conn,
                    &FunctionEntry {
                        name: name.to_string(),
                        file_path: file_path.to_string(),
                        body: truncate_body(node_text(node, source), 50),
                        start_line: node.start_position().row + 1,
                        end_line: node.end_position().row + 1,
                        parent_function: parent_function.map(|s| s.to_string()),
                        parent_class: parent_class.map(|s| s.to_string()),
                    },
                );
            }
        }
        "struct_item" | "enum_item" | "trait_item" => {
            if let Some(name) = child_field_text(node, "name", source) {
                insert_class(
                    conn,
                    &ClassEntry {
                        name: name.to_string(),
                        file_path: file_path.to_string(),
                        body: truncate_body(node_text(node, source), 30),
                        start_line: node.start_position().row + 1,
                        end_line: node.end_position().row + 1,
                        fields: None,
                        methods: None,
                    },
                );
            }
        }
        "impl_item" => {
            let type_name = child_field_text(node, "type", source).map(|s| s.to_string());
            if let Some(body) = node.child_by_field_name("body") {
                for i in 0..body.child_count() {
                    if let Some(child) = body.child(i) {
                        visit_rust(
                            conn,
                            child,
                            file_path,
                            source,
                            type_name.as_deref().or(parent_class),
                            parent_function,
                        );
                    }
                }
            }
            return;
        }
        _ => {}
    }
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            visit_rust(
                conn,
                child,
                file_path,
                source,
                parent_class,
                parent_function,
            );
        }
    }
}

// ── TypeScript / JavaScript ──

fn visit_ts_js(
    conn: &Connection,
    node: Node,
    file_path: &str,
    source: &str,
    parent_class: Option<&str>,
    parent_function: Option<&str>,
) {
    match node.kind() {
        "function_declaration" | "method_definition" => {
            if let Some(name) = child_field_text(node, "name", source) {
                let is_method = node.kind() == "method_definition";
                insert_function(
                    conn,
                    &FunctionEntry {
                        name: name.to_string(),
                        file_path: file_path.to_string(),
                        body: truncate_body(node_text(node, source), 50),
                        start_line: node.start_position().row + 1,
                        end_line: node.end_position().row + 1,
                        parent_function: if is_method {
                            None
                        } else {
                            parent_function.map(|s| s.to_string())
                        },
                        parent_class: if is_method {
                            parent_class.map(|s| s.to_string())
                        } else {
                            None
                        },
                    },
                );
            }
        }
        "class_declaration" => {
            if let Some(name) = child_field_text(node, "name", source) {
                let mut methods_str = String::new();
                let mut fields_str = String::new();
                if let Some(body) = node.child_by_field_name("body") {
                    for i in 0..body.child_count() {
                        if let Some(child) = body.child(i) {
                            if child.kind() == "method_definition" {
                                let sig: String = (0..child.child_count())
                                    .filter_map(|j| child.child(j))
                                    .take_while(|c| c.kind() != "statement_block")
                                    .map(|c| node_text(c, source))
                                    .collect::<Vec<_>>()
                                    .join(" ");
                                methods_str.push_str(&format!("- {}\n", sig.trim()));
                            } else if child.kind() == "public_field_definition"
                                || child.kind() == "field_definition"
                            {
                                fields_str
                                    .push_str(&format!("- {}\n", node_text(child, source).trim()));
                            }
                        }
                    }
                }
                insert_class(
                    conn,
                    &ClassEntry {
                        name: name.to_string(),
                        file_path: file_path.to_string(),
                        body: truncate_body(node_text(node, source), 30),
                        start_line: node.start_position().row + 1,
                        end_line: node.end_position().row + 1,
                        fields: if fields_str.is_empty() {
                            None
                        } else {
                            Some(fields_str.trim().to_string())
                        },
                        methods: if methods_str.is_empty() {
                            None
                        } else {
                            Some(methods_str.trim().to_string())
                        },
                    },
                );
                for i in 0..node.child_count() {
                    if let Some(child) = node.child(i) {
                        visit_ts_js(conn, child, file_path, source, Some(name), parent_function);
                    }
                }
                return;
            }
        }
        _ => {}
    }
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            visit_ts_js(
                conn,
                child,
                file_path,
                source,
                parent_class,
                parent_function,
            );
        }
    }
}

// ── Java ──

fn visit_java(
    conn: &Connection,
    node: Node,
    file_path: &str,
    source: &str,
    parent_class: Option<&str>,
    parent_function: Option<&str>,
) {
    match node.kind() {
        "class_declaration" | "interface_declaration" => {
            if let Some(name) = child_field_text(node, "name", source) {
                let mut methods_str = String::new();
                let mut fields_str = String::new();
                if let Some(body) = node.child_by_field_name("body") {
                    for i in 0..body.child_count() {
                        if let Some(child) = body.child(i) {
                            if child.kind() == "method_declaration" {
                                let sig: String = (0..child.child_count())
                                    .filter_map(|j| child.child(j))
                                    .take_while(|c| c.kind() != "block")
                                    .map(|c| node_text(c, source))
                                    .collect::<Vec<_>>()
                                    .join(" ");
                                methods_str.push_str(&format!("- {}\n", sig.trim()));
                            } else if child.kind() == "field_declaration" {
                                fields_str
                                    .push_str(&format!("- {}\n", node_text(child, source).trim()));
                            }
                        }
                    }
                }
                insert_class(
                    conn,
                    &ClassEntry {
                        name: name.to_string(),
                        file_path: file_path.to_string(),
                        body: truncate_body(node_text(node, source), 30),
                        start_line: node.start_position().row + 1,
                        end_line: node.end_position().row + 1,
                        fields: if fields_str.is_empty() {
                            None
                        } else {
                            Some(fields_str.trim().to_string())
                        },
                        methods: if methods_str.is_empty() {
                            None
                        } else {
                            Some(methods_str.trim().to_string())
                        },
                    },
                );
                for i in 0..node.child_count() {
                    if let Some(child) = node.child(i) {
                        visit_java(conn, child, file_path, source, Some(name), parent_function);
                    }
                }
                return;
            }
        }
        "method_declaration" => {
            if let Some(name) = child_field_text(node, "name", source) {
                insert_function(
                    conn,
                    &FunctionEntry {
                        name: name.to_string(),
                        file_path: file_path.to_string(),
                        body: truncate_body(node_text(node, source), 50),
                        start_line: node.start_position().row + 1,
                        end_line: node.end_position().row + 1,
                        parent_function: parent_function.map(|s| s.to_string()),
                        parent_class: parent_class.map(|s| s.to_string()),
                    },
                );
            }
        }
        _ => {}
    }
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            visit_java(
                conn,
                child,
                file_path,
                source,
                parent_class,
                parent_function,
            );
        }
    }
}

// ── Go ──

fn visit_go(
    conn: &Connection,
    node: Node,
    file_path: &str,
    source: &str,
    parent_class: Option<&str>,
    _parent_function: Option<&str>,
) {
    match node.kind() {
        "function_declaration" => {
            if let Some(name) = child_field_text(node, "name", source) {
                insert_function(
                    conn,
                    &FunctionEntry {
                        name: name.to_string(),
                        file_path: file_path.to_string(),
                        body: truncate_body(node_text(node, source), 50),
                        start_line: node.start_position().row + 1,
                        end_line: node.end_position().row + 1,
                        parent_function: None,
                        parent_class: None,
                    },
                );
            }
        }
        "method_declaration" => {
            if let Some(name) = child_field_text(node, "name", source) {
                let receiver = child_field_text(node, "receiver", source).map(|s| s.to_string());
                insert_function(
                    conn,
                    &FunctionEntry {
                        name: name.to_string(),
                        file_path: file_path.to_string(),
                        body: truncate_body(node_text(node, source), 50),
                        start_line: node.start_position().row + 1,
                        end_line: node.end_position().row + 1,
                        parent_function: None,
                        parent_class: receiver,
                    },
                );
            }
        }
        "type_declaration" => {
            for i in 0..node.child_count() {
                if let Some(spec) = node.child(i) {
                    if spec.kind() == "type_spec" {
                        if let Some(name) = child_field_text(spec, "name", source) {
                            insert_class(
                                conn,
                                &ClassEntry {
                                    name: name.to_string(),
                                    file_path: file_path.to_string(),
                                    body: truncate_body(node_text(spec, source), 30),
                                    start_line: spec.start_position().row + 1,
                                    end_line: spec.end_position().row + 1,
                                    fields: None,
                                    methods: None,
                                },
                            );
                        }
                    }
                }
            }
        }
        _ => {}
    }
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            visit_go(
                conn,
                child,
                file_path,
                source,
                parent_class,
                _parent_function,
            );
        }
    }
}

// ── C ──

fn visit_c(
    conn: &Connection,
    node: Node,
    file_path: &str,
    source: &str,
    parent_class: Option<&str>,
    parent_function: Option<&str>,
) {
    if node.kind() == "function_definition" {
        if let Some(declarator) = node.child_by_field_name("declarator") {
            if let Some(name_node) = declarator.child_by_field_name("declarator") {
                let name = node_text(name_node, source);
                insert_function(
                    conn,
                    &FunctionEntry {
                        name: name.to_string(),
                        file_path: file_path.to_string(),
                        body: truncate_body(node_text(node, source), 50),
                        start_line: node.start_position().row + 1,
                        end_line: node.end_position().row + 1,
                        parent_function: parent_function.map(|s| s.to_string()),
                        parent_class: parent_class.map(|s| s.to_string()),
                    },
                );
            }
        }
    }
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            visit_c(
                conn,
                child,
                file_path,
                source,
                parent_class,
                parent_function,
            );
        }
    }
}

// ── C++ ──

fn visit_cpp(
    conn: &Connection,
    node: Node,
    file_path: &str,
    source: &str,
    parent_class: Option<&str>,
    parent_function: Option<&str>,
) {
    match node.kind() {
        "class_specifier" | "struct_specifier" => {
            if let Some(name) = child_field_text(node, "name", source) {
                let mut methods_str = String::new();
                let mut fields_str = String::new();
                if let Some(body) = node.child_by_field_name("body") {
                    for i in 0..body.child_count() {
                        if let Some(child) = body.child(i) {
                            if child.kind() == "function_definition" {
                                let sig: String = (0..child.child_count())
                                    .filter_map(|j| child.child(j))
                                    .take_while(|c| c.kind() != "compound_statement")
                                    .map(|c| node_text(c, source))
                                    .collect::<Vec<_>>()
                                    .join(" ");
                                methods_str.push_str(&format!("- {}\n", sig.trim()));
                            } else if child.kind() == "field_declaration" {
                                let has_fn = (0..child.child_count())
                                    .filter_map(|j| child.child(j))
                                    .any(|c| c.kind() == "function_declarator");
                                if has_fn {
                                    methods_str.push_str(&format!(
                                        "- {}\n",
                                        node_text(child, source).trim()
                                    ));
                                } else {
                                    fields_str.push_str(&format!(
                                        "- {}\n",
                                        node_text(child, source).trim()
                                    ));
                                }
                            }
                        }
                    }
                }
                insert_class(
                    conn,
                    &ClassEntry {
                        name: name.to_string(),
                        file_path: file_path.to_string(),
                        body: truncate_body(node_text(node, source), 30),
                        start_line: node.start_position().row + 1,
                        end_line: node.end_position().row + 1,
                        fields: if fields_str.is_empty() {
                            None
                        } else {
                            Some(fields_str.trim().to_string())
                        },
                        methods: if methods_str.is_empty() {
                            None
                        } else {
                            Some(methods_str.trim().to_string())
                        },
                    },
                );
                for i in 0..node.child_count() {
                    if let Some(child) = node.child(i) {
                        visit_cpp(conn, child, file_path, source, Some(name), parent_function);
                    }
                }
                return;
            }
        }
        "function_definition" => {
            if let Some(declarator) = node.child_by_field_name("declarator") {
                if let Some(name_node) = declarator.child_by_field_name("declarator") {
                    let name = node_text(name_node, source);
                    insert_function(
                        conn,
                        &FunctionEntry {
                            name: name.to_string(),
                            file_path: file_path.to_string(),
                            body: truncate_body(node_text(node, source), 50),
                            start_line: node.start_position().row + 1,
                            end_line: node.end_position().row + 1,
                            parent_function: parent_function.map(|s| s.to_string()),
                            parent_class: parent_class.map(|s| s.to_string()),
                        },
                    );
                }
            }
        }
        _ => {}
    }
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            visit_cpp(
                conn,
                child,
                file_path,
                source,
                parent_class,
                parent_function,
            );
        }
    }
}

// ── 查询 ──

fn query_functions(
    conn: &Connection,
    name: &str,
    class_method: bool,
) -> Result<Vec<FunctionEntry>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT name, file_path, body, start_line, end_line, parent_function, parent_class
             FROM functions WHERE name = ?1",
        )
        .map_err(|e| format!("查询准备失败: {e}"))?;

    let rows = stmt
        .query_map(params![name], |row| {
            Ok(FunctionEntry {
                name: row.get(0)?,
                file_path: row.get(1)?,
                body: row.get(2)?,
                start_line: row.get(3)?,
                end_line: row.get(4)?,
                parent_function: row.get(5)?,
                parent_class: row.get(6)?,
            })
        })
        .map_err(|e| format!("查询执行失败: {e}"))?;

    let mut results = Vec::new();
    for row in rows {
        if let Ok(entry) = row {
            if class_method {
                if entry.parent_class.is_some() {
                    results.push(entry);
                }
            } else if entry.parent_class.is_none() {
                results.push(entry);
            }
        }
    }
    Ok(results)
}

fn query_functions_fuzzy(
    conn: &Connection,
    pattern: &str,
    class_method: bool,
    limit: usize,
) -> Result<Vec<FunctionEntry>, String> {
    let like_pattern = format!("%{pattern}%");
    let mut stmt = conn
        .prepare(
            "SELECT name, file_path, body, start_line, end_line, parent_function, parent_class
             FROM functions WHERE name LIKE ?1 LIMIT ?2",
        )
        .map_err(|e| format!("模糊查询准备失败: {e}"))?;

    let rows = stmt
        .query_map(params![like_pattern, limit as i64], |row| {
            Ok(FunctionEntry {
                name: row.get(0)?,
                file_path: row.get(1)?,
                body: row.get(2)?,
                start_line: row.get(3)?,
                end_line: row.get(4)?,
                parent_function: row.get(5)?,
                parent_class: row.get(6)?,
            })
        })
        .map_err(|e| format!("模糊查询执行失败: {e}"))?;

    let mut results = Vec::new();
    for row in rows {
        if let Ok(entry) = row {
            if class_method {
                if entry.parent_class.is_some() {
                    results.push(entry);
                }
            } else if entry.parent_class.is_none() {
                results.push(entry);
            }
        }
    }
    Ok(results)
}

fn query_classes(conn: &Connection, name: &str) -> Result<Vec<ClassEntry>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT name, file_path, body, fields, methods, start_line, end_line
             FROM classes WHERE name = ?1",
        )
        .map_err(|e| format!("查询准备失败: {e}"))?;

    let rows = stmt
        .query_map(params![name], |row| {
            Ok(ClassEntry {
                name: row.get(0)?,
                file_path: row.get(1)?,
                body: row.get(2)?,
                fields: row.get(3)?,
                methods: row.get(4)?,
                start_line: row.get(5)?,
                end_line: row.get(6)?,
            })
        })
        .map_err(|e| format!("查询执行失败: {e}"))?;

    let mut results = Vec::new();
    for row in rows {
        if let Ok(entry) = row {
            results.push(entry);
        }
    }
    Ok(results)
}

fn query_classes_fuzzy(
    conn: &Connection,
    pattern: &str,
    limit: usize,
) -> Result<Vec<ClassEntry>, String> {
    let like_pattern = format!("%{pattern}%");
    let mut stmt = conn
        .prepare(
            "SELECT name, file_path, body, fields, methods, start_line, end_line
             FROM classes WHERE name LIKE ?1 LIMIT ?2",
        )
        .map_err(|e| format!("模糊查询准备失败: {e}"))?;

    let rows = stmt
        .query_map(params![like_pattern, limit as i64], |row| {
            Ok(ClassEntry {
                name: row.get(0)?,
                file_path: row.get(1)?,
                body: row.get(2)?,
                fields: row.get(3)?,
                methods: row.get(4)?,
                start_line: row.get(5)?,
                end_line: row.get(6)?,
            })
        })
        .map_err(|e| format!("模糊查询执行失败: {e}"))?;

    let mut results = Vec::new();
    for row in rows {
        if let Ok(entry) = row {
            results.push(entry);
        }
    }
    Ok(results)
}

fn get_db_stats(conn: &Connection) -> Result<serde_json::Value, String> {
    let fn_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM functions", [], |row| row.get(0))
        .map_err(|e| format!("统计失败: {e}"))?;
    let class_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM classes", [], |row| row.get(0))
        .map_err(|e| format!("统计失败: {e}"))?;
    Ok(serde_json::json!({
        "functions": fn_count,
        "classes": class_count,
    }))
}

// ── Tauri Commands ──

#[tauri::command]
pub async fn ckg_index_project(path: String) -> Result<serde_json::Value, String> {
    let project_path = PathBuf::from(&path);
    if !project_path.is_dir() {
        return Err(format!("路径不存在或不是目录: {path}"));
    }
    tokio::task::spawn_blocking(move || {
        let conn = open_or_build_db(&project_path)?;
        let stats = get_db_stats(&conn)?;
        Ok(serde_json::json!({
            "status": "indexed",
            "path": path,
            "stats": stats,
        }))
    })
    .await
    .map_err(|e| format!("索引任务失败: {e}"))?
}

#[tauri::command]
pub async fn ckg_search_function(
    path: String,
    name: String,
    fuzzy: Option<bool>,
) -> Result<serde_json::Value, String> {
    let project_path = PathBuf::from(&path);
    tokio::task::spawn_blocking(move || {
        let conn = open_or_build_db(&project_path)?;
        let results = if fuzzy.unwrap_or(false) {
            query_functions_fuzzy(&conn, &name, false, 20)?
        } else {
            query_functions(&conn, &name, false)?
        };
        Ok(serde_json::to_value(&results).map_err(|e| format!("序列化失败: {e}"))?)
    })
    .await
    .map_err(|e| format!("查询任务失败: {e}"))?
}

#[tauri::command]
pub async fn ckg_search_class(
    path: String,
    name: String,
    fuzzy: Option<bool>,
) -> Result<serde_json::Value, String> {
    let project_path = PathBuf::from(&path);
    tokio::task::spawn_blocking(move || {
        let conn = open_or_build_db(&project_path)?;
        let results = if fuzzy.unwrap_or(false) {
            query_classes_fuzzy(&conn, &name, 20)?
        } else {
            query_classes(&conn, &name)?
        };
        Ok(serde_json::to_value(&results).map_err(|e| format!("序列化失败: {e}"))?)
    })
    .await
    .map_err(|e| format!("查询任务失败: {e}"))?
}

#[tauri::command]
pub async fn ckg_search_class_method(
    path: String,
    name: String,
    fuzzy: Option<bool>,
) -> Result<serde_json::Value, String> {
    let project_path = PathBuf::from(&path);
    tokio::task::spawn_blocking(move || {
        let conn = open_or_build_db(&project_path)?;
        let results = if fuzzy.unwrap_or(false) {
            query_functions_fuzzy(&conn, &name, true, 20)?
        } else {
            query_functions(&conn, &name, true)?
        };
        Ok(serde_json::to_value(&results).map_err(|e| format!("序列化失败: {e}"))?)
    })
    .await
    .map_err(|e| format!("查询任务失败: {e}"))?
}

#[tauri::command]
pub async fn ckg_get_stats(path: String) -> Result<serde_json::Value, String> {
    let project_path = PathBuf::from(&path);
    tokio::task::spawn_blocking(move || {
        let conn = open_or_build_db(&project_path)?;
        get_db_stats(&conn)
    })
    .await
    .map_err(|e| format!("统计任务失败: {e}"))?
}
