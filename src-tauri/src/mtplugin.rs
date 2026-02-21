use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, CONTROLS};

const MTPLUGIN_PATH_ENCODE_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'`')
    .add(b'{')
    .add(b'}');

fn normalize_base_dir_path(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let trimmed = normalized.trim_end_matches('/');
    if trimmed.is_empty() {
        "/".to_string()
    } else if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{}", trimmed)
    }
}

fn looks_like_windows_drive_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn decode_mtplugin_request_path_for_platform(raw_path: &str, is_windows: bool) -> String {
    let decoded = percent_decode_str(raw_path).decode_utf8_lossy().to_string();
    let normalized = decoded.replace('\\', "/");
    if is_windows {
        if let Some(stripped) = normalized.strip_prefix('/') {
            if looks_like_windows_drive_path(stripped) {
                return stripped.to_string();
            }
        }
    }
    normalized
}

pub fn build_mtplugin_base_url(dir_path: &str) -> String {
    let normalized = normalize_base_dir_path(dir_path);
    let encoded = utf8_percent_encode(&normalized, MTPLUGIN_PATH_ENCODE_SET).to_string();
    format!("mtplugin://localhost{}/", encoded)
}

pub fn decode_mtplugin_request_path(raw_path: &str) -> String {
    decode_mtplugin_request_path_for_platform(raw_path, cfg!(target_os = "windows"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unix_path_round_trip_decoding() {
        let raw = "/Users/alice/My%20Plugin/%E6%B5%8B%E8%AF%95/index.html";
        let decoded = decode_mtplugin_request_path_for_platform(raw, false);
        assert_eq!(decoded, "/Users/alice/My Plugin/测试/index.html");
    }

    #[test]
    fn windows_drive_path_round_trip_decoding() {
        let raw = "/C:/Users/Alice/My%20Plugin/%E6%B5%8B%E8%AF%95/index.html";
        let decoded = decode_mtplugin_request_path_for_platform(raw, true);
        assert_eq!(decoded, "C:/Users/Alice/My Plugin/测试/index.html");
    }

    #[test]
    fn build_base_url_keeps_localhost_host_on_windows_style_path() {
        let base_url = build_mtplugin_base_url(r"C:\Users\Alice\My Plugin\测试");
        let parsed = url::Url::parse(&base_url).expect("base url should be valid");
        assert_eq!(parsed.host_str(), Some("localhost"));
        assert!(parsed.path().starts_with("/C:/Users/Alice/My%20Plugin/"));
    }

    #[test]
    fn decode_percent_sign_and_space() {
        let raw = "/tmp/100%25%20ok/file.txt";
        let decoded = decode_mtplugin_request_path_for_platform(raw, false);
        assert_eq!(decoded, "/tmp/100% ok/file.txt");
    }
}
