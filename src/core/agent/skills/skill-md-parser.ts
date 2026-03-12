/**
 * SKILL.md Parser — parses deer-flow compatible SKILL.md files
 * into AgentSkill objects.
 *
 * Format:
 *   ---
 *   name: my-skill
 *   description: What the skill does
 *   allowed-tools: [tool_a, tool_b]
 *   trigger-patterns: ["\\bpattern\\b"]
 *   category: coding
 *   tags: [typescript, react]
 *   ---
 *   # Markdown body becomes systemPrompt
 */

import type { AgentSkill, SkillMdFrontmatter } from "./types";

/**
 * Parse a SKILL.md string into an AgentSkill.
 * Returns null if the file is malformed.
 */
export function parseSkillMd(
  content: string,
  opts?: { id?: string; filePath?: string },
): AgentSkill | null {
  const parsed = splitFrontmatterAndBody(content);
  if (!parsed) return null;

  const { frontmatter, body } = parsed;
  const fm = parseYamlFrontmatter(frontmatter);
  if (!fm || !fm.name) return null;

  const now = Date.now();
  const id = opts?.id ?? `skillmd-${slugify(fm.name)}`;

  const skill: AgentSkill = {
    id,
    name: fm.name,
    description: fm.description || "",
    version: fm.version || "1.0.0",
    author: fm.author,
    enabled: true,
    autoActivate: fm["auto-activate"] !== false,
    triggerPatterns: fm["trigger-patterns"],
    systemPrompt: body.trim() || undefined,
    category: fm.category,
    tags: fm.tags,
    icon: fm.icon,
    allowedTools: fm["allowed-tools"],
    toolFilter: fm["allowed-tools"]?.length
      ? { include: fm["allowed-tools"] }
      : undefined,
    dependency: fm.dependency,
    createdAt: now,
    updatedAt: now,
    source: "skillmd",
  };

  return skill;
}

function splitFrontmatterAndBody(
  content: string,
): { frontmatter: string; body: string } | null {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) return null;

  const endIdx = trimmed.indexOf("\n---", 3);
  if (endIdx < 0) return null;

  const frontmatter = trimmed.slice(3, endIdx).trim();
  const body = trimmed.slice(endIdx + 4).trim();

  return { frontmatter, body };
}

/**
 * Minimal YAML parser for SKILL.md frontmatter.
 * Handles flat key-value pairs, arrays (both inline `[a, b]` and multi-line `- item`),
 * and nested objects (one level deep for `dependency`).
 * No external dependency required.
 */
function parseYamlFrontmatter(yaml: string): SkillMdFrontmatter | null {
  try {
    const result: Record<string, unknown> = {};
    const lines = yaml.split("\n");
    let currentKey = "";
    let currentArray: string[] | null = null;
    let currentObj: Record<string, string> | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();

      if (!trimmedLine || trimmedLine.startsWith("#")) continue;

      // Array continuation: `- item`
      if (trimmedLine.startsWith("- ") && currentArray !== null) {
        currentArray.push(trimmedLine.slice(2).trim().replace(/^["']|["']$/g, ""));
        continue;
      }

      // Nested object continuation: `  key: value`
      if (/^\s{2,}\S/.test(line) && currentObj !== null) {
        const match = trimmedLine.match(/^([^:]+):\s*(.+)$/);
        if (match) {
          currentObj[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, "");
        }
        continue;
      }

      // Flush previous collection
      if (currentArray !== null) {
        result[currentKey] = currentArray;
        currentArray = null;
      }
      if (currentObj !== null) {
        result[currentKey] = currentObj;
        currentObj = null;
      }

      // Key-value pair: `key: value`
      const kvMatch = trimmedLine.match(/^([a-zA-Z_-]+):\s*(.*)$/);
      if (!kvMatch) continue;

      const key = kvMatch[1].trim();
      const value = kvMatch[2].trim();
      currentKey = key;

      if (!value) {
        // Might be start of array or object — peek next line
        const nextLine = i + 1 < lines.length ? lines[i + 1] : "";
        const nextTrimmed = nextLine.trim();
        if (nextTrimmed.startsWith("- ")) {
          currentArray = [];
        } else if (/^\s{2,}\S/.test(nextLine)) {
          currentObj = {};
        } else {
          result[key] = "";
        }
        continue;
      }

      // Inline array: `[a, b, c]`
      if (value.startsWith("[") && value.endsWith("]")) {
        const items = value
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
        result[key] = items;
        continue;
      }

      // Boolean
      if (value === "true") { result[key] = true; continue; }
      if (value === "false") { result[key] = false; continue; }

      // Number
      if (/^\d+(\.\d+)?$/.test(value)) {
        result[key] = Number(value);
        continue;
      }

      // String (strip quotes)
      result[key] = value.replace(/^["']|["']$/g, "");
    }

    // Flush last collection
    if (currentArray !== null) result[currentKey] = currentArray;
    if (currentObj !== null) result[currentKey] = currentObj;

    return result as unknown as SkillMdFrontmatter;
  } catch {
    return null;
  }
}

/**
 * Serialize an AgentSkill back to SKILL.md format.
 */
export function serializeSkillMd(skill: AgentSkill): string {
  const lines: string[] = ["---"];

  lines.push(`name: ${skill.name}`);
  if (skill.description) lines.push(`description: ${skill.description}`);
  if (skill.version && skill.version !== "1.0.0") lines.push(`version: ${skill.version}`);
  if (skill.author) lines.push(`author: ${skill.author}`);
  if (skill.category) lines.push(`category: ${skill.category}`);
  if (skill.tags?.length) lines.push(`tags: [${skill.tags.join(", ")}]`);
  if (skill.icon) lines.push(`icon: ${skill.icon}`);
  if (skill.allowedTools?.length) {
    lines.push(`allowed-tools: [${skill.allowedTools.join(", ")}]`);
  }
  if (skill.triggerPatterns?.length) {
    lines.push(`trigger-patterns: [${skill.triggerPatterns.map((p) => `"${p}"`).join(", ")}]`);
  }
  if (skill.autoActivate === false) lines.push("auto-activate: false");
  if (skill.dependency) {
    lines.push("dependency:");
    for (const [k, v] of Object.entries(skill.dependency)) {
      lines.push(`  ${k}: "${v}"`);
    }
  }

  lines.push("---");
  lines.push("");

  if (skill.systemPrompt) {
    lines.push(skill.systemPrompt);
  }

  return lines.join("\n");
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}
