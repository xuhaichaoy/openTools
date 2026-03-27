from __future__ import annotations

import csv
import json
from pathlib import Path


ROOT = Path("/Users/haichao/Desktop/work/51ToolBox")
NORMALIZED_TOPICS = ROOT / "deliverables" / "ai_training_course_draft" / "normalized_topics.json"
OUTPUT_DIR = ROOT / "deliverables" / "ai_training_course_draft" / "five_course_batch"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

SLOTS = [
    ("C1", "认知地图式", "从整体地图、职责边界或全流程框架切入，强调系统认知与方法框架。"),
    ("C2", "交付物倒推式", "从最终交付物、方案成品、看板、原型、架构或报告倒推课程展开路径。"),
    ("C3", "问题倒逼式", "从典型痛点、异常、失败案例或业务卡点切入，强调诊断、验证与优化。"),
    ("C4", "专题深化式", "从关键难点、专项能力、风险边界或高门槛能力切入，强调深水区突破。"),
    ("C5", "项目推进式", "从项目制、沙盘推演、阶段经营或方案共创切入，强调综合落地。"),
]


def load_topics() -> list[dict]:
    data = json.loads(NORMALIZED_TOPICS.read_text())
    return [topic for topic in data if topic["seq"] != 13]


def write_input_csv(path: Path, rows: list[dict]) -> None:
    fieldnames = [
        "row_id",
        "seq",
        "project",
        "topic",
        "audience",
        "objective",
        "source_outline",
        "slot_id",
        "slot_style",
        "slot_logic",
    ]
    with path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    topics = load_topics()
    rows: list[dict] = []
    for topic in topics:
        for slot_id, slot_style, slot_logic in SLOTS:
            rows.append(
                {
                    "row_id": f"{topic['seq']}_{slot_id}",
                    "seq": topic["seq"],
                    "project": topic["project"],
                    "topic": topic["topic"],
                    "audience": topic["audience"],
                    "objective": topic["objective"],
                    "source_outline": topic["source_outline"],
                    "slot_id": slot_id,
                    "slot_style": slot_style,
                    "slot_logic": slot_logic,
                }
            )

    write_input_csv(OUTPUT_DIR / "remaining_27_topics_5courses_input.csv", rows)
    write_input_csv(OUTPUT_DIR / "pilot_1row_input.csv", rows[:1])
    print(f"topics={len(topics)} rows={len(rows)}")
    print(OUTPUT_DIR / "remaining_27_topics_5courses_input.csv")
    print(OUTPUT_DIR / "pilot_1row_input.csv")


if __name__ == "__main__":
    main()
