from __future__ import annotations

import json
import re
import sys
from pathlib import Path


ROOT = Path("/Users/haichao/Desktop/work/51ToolBox")
SCRIPTS_DIR = ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from build_remaining_27_five_courses import build_highlights, build_intro, build_seminars, sanitize  # noqa: E402


TOPICS_PATH = ROOT / "deliverables" / "ai_training_course_draft" / "normalized_topics.json"
TOPIC_DIR = ROOT / "deliverables" / "ai_training_course_draft" / "five_course_batch" / "topics"

COURSE_HEADER_RE = re.compile(r"^##+\s+课程")
STYLE_BY_INDEX = {
    1: "framework",
    2: "deliverable",
    3: "problem",
    4: "deepdive",
    5: "project",
}


def load_topics() -> dict[int, dict]:
    return {int(item["seq"]): item for item in json.loads(TOPICS_PATH.read_text())}


def seq_from_path(path: Path) -> int:
    match = re.search(r"topic_(\d+)_", path.name)
    if not match:
        raise ValueError(f"无法解析主题序号: {path}")
    return int(match.group(1))


def split_blocks(lines: list[str]) -> tuple[list[str], list[list[str]]]:
    header: list[str] = []
    blocks: list[list[str]] = []
    current: list[str] | None = None
    for line in lines:
        if COURSE_HEADER_RE.match(line):
            if current is not None:
                blocks.append(current)
            current = [line]
            continue
        if current is None:
            header.append(line)
        else:
            current.append(line)
    if current is not None:
        blocks.append(current)
    return header, blocks


def parse_items(block: list[str], label: str) -> list[str]:
    items: list[str] = []
    collecting = False
    for line in block:
        if line == label:
            collecting = True
            continue
        if collecting and line.startswith("- **") and line != label:
            break
        if collecting:
            match = re.match(r"^\s+\d+\.\s+(.*)$", line)
            if match:
                items.append(sanitize(match.group(1)))
    return items


def parse_single_value(block: list[str], prefix: str) -> str:
    for line in block:
        if line.startswith(prefix):
            return sanitize(line.split("：", 1)[1])
    raise ValueError(f"未找到字段 {prefix}")


def rebuild_block(topic: dict, block: list[str], idx: int) -> list[str]:
    style = STYLE_BY_INDEX[idx]
    course_header = block[0]
    course_name = parse_single_value(block, "- **课程主题**")
    outputs = parse_items(block, "- **课程产出**：")
    applicability = parse_single_value(block, "- **适用性和价值度**")
    coverage = parse_items(block, "- **覆盖确认**：")
    intro = build_intro(topic, style, idx, course_name)
    seminars = build_seminars(topic, style)
    highlights = build_highlights(topic, style, idx)

    lines = [
        course_header,
        "",
        f"- **课程主题**：{course_name}",
        f"- **课程介绍**：{intro}",
        "- **课程产出**：",
    ]
    for item_idx, item in enumerate(outputs, 1):
        lines.append(f"  {item_idx}. {sanitize(item)}")
    lines.append("- **课程研讨安排**：")
    for item_idx, item in enumerate(seminars, 1):
        lines.append(f"  {item_idx}. {sanitize(item)}")
    lines.append("- **课程亮点**：")
    for item_idx, item in enumerate(highlights, 1):
        lines.append(f"  {item_idx}. {sanitize(item)}")
    lines.append(f"- **适用性和价值度**：{sanitize(applicability)}")
    lines.append("- **覆盖确认**：")
    for item_idx, item in enumerate(coverage, 1):
        lines.append(f"  {item_idx}. {sanitize(item)}")
    lines.append("")
    return lines


def refresh_file(path: Path, topics: dict[int, dict]) -> None:
    seq = seq_from_path(path)
    topic = topics[seq]
    lines = path.read_text().splitlines()
    header, blocks = split_blocks(lines)
    rebuilt = list(header)
    if rebuilt and rebuilt[-1] != "":
        rebuilt.append("")
    for idx, block in enumerate(blocks, 1):
        rebuilt.extend(rebuild_block(topic, block, idx))
    path.write_text("\n".join(rebuilt).rstrip() + "\n")


def main() -> None:
    topics = load_topics()
    files = sorted(TOPIC_DIR.glob("topic_*.md"), key=seq_from_path)
    for file in files:
        refresh_file(file, topics)
        print(file)


if __name__ == "__main__":
    main()
