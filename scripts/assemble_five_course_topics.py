from __future__ import annotations

import csv
import json
import sys
from collections import defaultdict
from pathlib import Path


ROOT = Path("/Users/haichao/Desktop/work/51ToolBox")
NORMALIZED_TOPICS = ROOT / "deliverables" / "ai_training_course_draft" / "normalized_topics.json"
FIRST_TOPIC_FILE = ROOT / "deliverables" / "ai_training_course_draft" / "银行AI产品运营专项-五门课程成稿.md"


def load_topics() -> dict[int, dict]:
    data = json.loads(NORMALIZED_TOPICS.read_text())
    return {int(item["seq"]): item for item in data}


def split_items(text: str) -> list[str]:
    if not text:
        return []
    normalized = text.replace("||", "|")
    parts = [item.strip() for item in normalized.split("|")]
    return [item for item in parts if item]


def course_sort_key(row: dict) -> tuple[int, str]:
    slot = row.get("slot_id", "")
    order = {"C1": 1, "C2": 2, "C3": 3, "C4": 4, "C5": 5}
    return int(row["seq"]), slot if slot not in order else f"{order[slot]:02d}"


def render_course(row: dict) -> list[str]:
    lines = [
        f"#### 课程{row['slot_id'][-1]}：{row['course_name']}",
        "",
        f"- **课程主题**：{row['course_name']}",
        f"- **课程介绍**：{row['course_intro']}",
        "- **课程产出**：",
    ]
    for idx, item in enumerate(split_items(row["course_outputs"]), 1):
        lines.append(f"  {idx}. {item}")
    lines.append("- **课程研讨安排**：")
    for idx, item in enumerate(split_items(row["seminar_arrangement"]), 1):
        lines.append(f"  {idx}. {item}")
    lines.append("- **课程亮点**：")
    for idx, item in enumerate(split_items(row["course_highlights"]), 1):
        lines.append(f"  {idx}. {item}")
    lines.append(f"- **适用性和价值度**：{row['applicability_value']}")
    lines.append("- **覆盖确认**：")
    for idx, item in enumerate(split_items(row["coverage_confirmation"]), 1):
        lines.append(f"  {idx}. {item}")
    lines.append("")
    return lines


def render_topics(rows: list[dict], topics: dict[int, dict], include_first_topic: bool) -> str:
    grouped: dict[int, list[dict]] = defaultdict(list)
    for row in rows:
        grouped[int(row["seq"])].append(row)

    lines = ["# AI培训课程需求五门课程成稿", ""]
    if include_first_topic:
        lines.append("> 说明：本稿整合 28 个课程主题，其中主题13沿用已完成的定稿，其余27个主题由多Agent并行生成后汇总。")
    else:
        lines.append("> 说明：本稿覆盖除已完成主题13外的剩余27个课程主题，每个主题提供5门完整候选课程。")
    lines.append("")

    seqs = sorted(grouped)
    for seq in seqs:
        topic = topics[seq]
        lines.extend(
            [
                f"### 主题{seq}：{topic['topic']}",
                "",
                f"- **项目类别**：{topic['project']}",
                f"- **授课对象**：{topic['audience']}",
                f"- **培训目标**：{topic['objective']}",
                "",
            ]
        )
        for row in sorted(grouped[seq], key=course_sort_key):
            lines.extend(render_course(row))

    return "\n".join(lines).rstrip() + "\n"


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit("Usage: assemble_five_course_topics.py <input_csv> <remaining_md> <all_md>")

    input_csv = Path(sys.argv[1])
    remaining_md = Path(sys.argv[2])
    all_md = Path(sys.argv[3])

    topics = load_topics()
    with input_csv.open() as f:
        rows = list(csv.DictReader(f))

    remaining_md.write_text(render_topics(rows, topics, include_first_topic=False))

    first_topic_text = FIRST_TOPIC_FILE.read_text().strip()
    all_content = render_topics(rows, topics, include_first_topic=True)
    all_md.write_text(all_content + "\n\n---\n\n" + first_topic_text + "\n")

    print(f"rows={len(rows)}")
    print(remaining_md)
    print(all_md)


if __name__ == "__main__":
    main()
