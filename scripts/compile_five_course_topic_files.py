from __future__ import annotations

import re
from pathlib import Path


ROOT = Path("/Users/haichao/Desktop/work/51ToolBox")
TOPIC_DIR = ROOT / "deliverables" / "ai_training_course_draft" / "five_course_batch" / "topics"
FIRST_TOPIC_FILE = ROOT / "deliverables" / "ai_training_course_draft" / "银行AI产品运营专项-五门课程成稿.md"
OUT_DIR = ROOT / "deliverables" / "ai_training_course_draft" / "five_course_batch"


def seq_from_path(path: Path) -> int:
    match = re.search(r"topic_(\d+)_", path.name)
    if not match:
        raise ValueError(f"无法从文件名提取序号: {path}")
    return int(match.group(1))


def build_remaining() -> str:
    files = [file for file in sorted(TOPIC_DIR.glob("topic_*.md"), key=seq_from_path) if seq_from_path(file) != 13]
    parts = [
        "# AI培训课程需求剩余27主题五门课程成稿",
        "",
        "> 说明：本稿覆盖除已完成主题13外的剩余27个课程主题，每个主题提供5门完整候选课程。",
        "",
    ]
    for file in files:
        parts.append(file.read_text().strip())
        parts.append("")
    return "\n".join(parts).rstrip() + "\n"


def build_all() -> str:
    files = sorted(TOPIC_DIR.glob("topic_*.md"), key=seq_from_path)
    parts = [
        "# AI培训课程需求全28主题五门课程成稿",
        "",
        "> 说明：主题13沿用已完成定稿，其余27个主题采用并行多Agent方式生成并汇总。",
        "",
    ]
    has_topic_13 = any(seq_from_path(file) == 13 for file in files)
    inserted = False
    for file in files:
        seq = seq_from_path(file)
        if not has_topic_13 and not inserted and seq > 13:
            parts.append(FIRST_TOPIC_FILE.read_text().strip())
            parts.append("")
            inserted = True
        parts.append(file.read_text().strip())
        parts.append("")
    if not has_topic_13 and not inserted:
        parts.append(FIRST_TOPIC_FILE.read_text().strip())
        parts.append("")
    return "\n".join(parts).rstrip() + "\n"


def main() -> None:
    remaining_path = OUT_DIR / "AI培训课程需求-剩余27主题-五门课程成稿.md"
    all_path = OUT_DIR / "AI培训课程需求-全28主题-五门课程成稿.md"
    remaining_path.write_text(build_remaining())
    all_path.write_text(build_all())
    print(remaining_path)
    print(all_path)


if __name__ == "__main__":
    main()
