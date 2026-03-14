#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AIProtocol {
    OpenAI,
    Anthropic,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CapabilitySource {
    OpenClaw,
    Fallback,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ModelCapabilities {
    pub supports_image_input: bool,
    pub source: CapabilitySource,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ModelCapabilityRule {
    pattern: &'static str,
    protocol: Option<AIProtocol>,
    supports_image_input: bool,
    source: CapabilitySource,
}

const OPENCLAW_MODEL_CAPABILITY_RULES: &[ModelCapabilityRule] = &[
    ModelCapabilityRule {
        pattern: "qwen3.5-plus",
        protocol: Some(AIProtocol::OpenAI),
        supports_image_input: true,
        source: CapabilitySource::OpenClaw,
    },
    ModelCapabilityRule {
        pattern: "qwen3-max",
        protocol: Some(AIProtocol::OpenAI),
        supports_image_input: false,
        source: CapabilitySource::OpenClaw,
    },
    ModelCapabilityRule {
        pattern: "qwen3-coder-next",
        protocol: Some(AIProtocol::OpenAI),
        supports_image_input: false,
        source: CapabilitySource::OpenClaw,
    },
    ModelCapabilityRule {
        pattern: "qwen3-coder-plus",
        protocol: Some(AIProtocol::OpenAI),
        supports_image_input: false,
        source: CapabilitySource::OpenClaw,
    },
    ModelCapabilityRule {
        pattern: "minimax-vl-01",
        protocol: Some(AIProtocol::Anthropic),
        supports_image_input: true,
        source: CapabilitySource::OpenClaw,
    },
    ModelCapabilityRule {
        pattern: "minimax-vl",
        protocol: None,
        supports_image_input: true,
        source: CapabilitySource::OpenClaw,
    },
    ModelCapabilityRule {
        pattern: "minimax-m2.5-highspeed",
        protocol: None,
        supports_image_input: false,
        source: CapabilitySource::OpenClaw,
    },
    ModelCapabilityRule {
        pattern: "minimax-m2.5",
        protocol: None,
        supports_image_input: false,
        source: CapabilitySource::OpenClaw,
    },
    ModelCapabilityRule {
        pattern: "minimax-2.5",
        protocol: None,
        supports_image_input: false,
        source: CapabilitySource::OpenClaw,
    },
    ModelCapabilityRule {
        pattern: "glm-5",
        protocol: Some(AIProtocol::OpenAI),
        supports_image_input: false,
        source: CapabilitySource::OpenClaw,
    },
    ModelCapabilityRule {
        pattern: "glm-4.7",
        protocol: Some(AIProtocol::OpenAI),
        supports_image_input: false,
        source: CapabilitySource::OpenClaw,
    },
    ModelCapabilityRule {
        pattern: "kimi-k2.5",
        protocol: Some(AIProtocol::OpenAI),
        supports_image_input: true,
        source: CapabilitySource::OpenClaw,
    },
];

const TEXT_ONLY_HINTS: &[&str] = &[
    "embedding",
    "rerank",
    "re-rank",
    "transcribe",
    "transcription",
    "whisper",
    "tts",
    "speech",
    "asr",
    "coder",
];

const OPENAI_VISION_HINTS: &[&str] = &[
    "gpt-4o",
    "gpt-4.1",
    "claude",
    "gemini",
    "kimi",
    "qwen-vl",
    "qwen2-vl",
    "qwen2.5-vl",
    "qwen3.5-plus",
    "glm-4v",
    "glm-4.1v",
    "minimax-vl",
];

const ANTHROPIC_VISION_HINTS: &[&str] = &["claude", "minimax-vl"];

fn normalize_model_name(model: &str) -> String {
    let mut normalized = String::with_capacity(model.len());
    let mut previous_was_dash = false;

    for ch in model.trim().chars() {
        let ch = ch.to_ascii_lowercase();
        if ch.is_ascii_whitespace() || ch == '_' || ch == '-' {
            if !normalized.is_empty() && !previous_was_dash {
                normalized.push('-');
                previous_was_dash = true;
            }
            continue;
        }

        normalized.push(ch);
        previous_was_dash = false;
    }

    if normalized.ends_with('-') {
        normalized.pop();
    }

    normalized
}

fn matches_rule(rule: &ModelCapabilityRule, model: &str, protocol: AIProtocol) -> bool {
    if let Some(rule_protocol) = rule.protocol {
        if rule_protocol != protocol {
            return false;
        }
    }
    model.contains(rule.pattern)
}

fn matches_any_pattern(model: &str, patterns: &[&str]) -> bool {
    patterns.iter().any(|pattern| model.contains(pattern))
}

fn fallback_supports_image_input(model: &str, protocol: AIProtocol) -> bool {
    if matches_any_pattern(model, TEXT_ONLY_HINTS) {
        return false;
    }

    match protocol {
        AIProtocol::Anthropic => matches_any_pattern(model, ANTHROPIC_VISION_HINTS),
        AIProtocol::OpenAI => matches_any_pattern(model, OPENAI_VISION_HINTS),
    }
}

pub fn resolve_model_capabilities(model: &str, protocol: AIProtocol) -> ModelCapabilities {
    let normalized_model = normalize_model_name(model);

    if let Some(rule) = OPENCLAW_MODEL_CAPABILITY_RULES
        .iter()
        .find(|rule| matches_rule(rule, &normalized_model, protocol))
    {
        return ModelCapabilities {
            supports_image_input: rule.supports_image_input,
            source: rule.source,
        };
    }

    ModelCapabilities {
        supports_image_input: fallback_supports_image_input(&normalized_model, protocol),
        source: CapabilitySource::Fallback,
    }
}

pub fn supports_image_input(model: &str, protocol: AIProtocol) -> bool {
    resolve_model_capabilities(model, protocol).supports_image_input
}

#[cfg(test)]
mod tests {
    use super::{
        resolve_model_capabilities, supports_image_input, AIProtocol, CapabilitySource,
        ModelCapabilities,
    };

    #[test]
    fn matches_openclaw_for_modelstudio_family() {
        assert!(supports_image_input("qwen3.5-plus", AIProtocol::OpenAI));
        assert!(!supports_image_input(
            "qwen3-max-2026-01-23",
            AIProtocol::OpenAI
        ));
        assert!(!supports_image_input("MiniMax-M2.5", AIProtocol::OpenAI));
        assert!(!supports_image_input("MiniMax M2.5", AIProtocol::OpenAI));
        assert!(!supports_image_input("glm-5", AIProtocol::OpenAI));
        assert!(supports_image_input("kimi-k2.5", AIProtocol::OpenAI));
    }

    #[test]
    fn marks_explicit_matches_as_openclaw_sourced() {
        assert_eq!(
            resolve_model_capabilities("qwen3.5-plus", AIProtocol::OpenAI),
            ModelCapabilities {
                supports_image_input: true,
                source: CapabilitySource::OpenClaw,
            }
        );
    }

    #[test]
    fn supports_minimax_vl_with_space_separated_name() {
        assert_eq!(
            resolve_model_capabilities("MiniMax VL 01", AIProtocol::Anthropic),
            ModelCapabilities {
                supports_image_input: true,
                source: CapabilitySource::OpenClaw,
            }
        );
    }

    #[test]
    fn falls_back_for_generic_multimodal_models() {
        assert_eq!(
            resolve_model_capabilities("gpt-4o", AIProtocol::OpenAI),
            ModelCapabilities {
                supports_image_input: true,
                source: CapabilitySource::Fallback,
            }
        );
    }

    #[test]
    fn text_only_hints_override_broad_multimodal_family_matches() {
        assert_eq!(
            resolve_model_capabilities("gpt-4o-mini-transcribe", AIProtocol::OpenAI),
            ModelCapabilities {
                supports_image_input: false,
                source: CapabilitySource::Fallback,
            }
        );
        assert_eq!(
            resolve_model_capabilities("text-embedding-3-large", AIProtocol::OpenAI),
            ModelCapabilities {
                supports_image_input: false,
                source: CapabilitySource::Fallback,
            }
        );
    }

    #[test]
    fn keeps_anthropic_family_fallback_for_claude_models() {
        assert_eq!(
            resolve_model_capabilities("Claude 3.7 Sonnet", AIProtocol::Anthropic),
            ModelCapabilities {
                supports_image_input: true,
                source: CapabilitySource::Fallback,
            }
        );
    }
}
