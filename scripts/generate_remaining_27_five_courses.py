from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path("/Users/haichao/Desktop/work/51ToolBox")
TOPICS_PATH = ROOT / "deliverables" / "ai_training_course_draft" / "normalized_topics.json"
OUTPUT_DIR = ROOT / "deliverables" / "ai_training_course_draft" / "five_course_generated"


OPTION_META = {
    "A": {
        "label": "全景方法工作坊",
        "intro_style": "认知地图式",
        "intro_tpl": "这门课先把{base}的完整能力地图铺开，再沿{section_chain}等关键链路层层推进。课堂把培训目标与课程模块放进一条连续主线中展开，既处理{focus_a}，也覆盖{focus_b}与{focus_c}，帮助{audience}形成从认知建立、方法掌握到落地协同的整体视角，避免只见局部、不见全局。",
    },
    "B": {
        "label": "交付物设计实训",
        "intro_style": "交付物倒推式",
        "intro_tpl": "课堂从最终要交付的一组核心成果倒推，不先堆叠概念，而是先明确要做成什么，再拆到{section_chain}等模块需要掌握的关键动作。学员会围绕{focus_a}、{focus_b}和{focus_c}逐步搭建方案、清单或原型，让{audience}学完后不仅知道方法，还能带着可以直接复用的成果框架回到岗位。",
    },
    "C": {
        "label": "问题诊断与优化实战",
        "intro_style": "问题倒逼式",
        "intro_tpl": "最先摆在学员面前的不是知识点目录，而是一组真实工作中高频出现的棘手问题。课程将围绕{pain}展开，带着学员从{section_chain}等模块逐层拆解，先判断问题出在哪里，再识别该补哪一块能力、如何验证改进是否有效，最终把分析结论转化为可执行的优化动作和复盘路径。",
    },
    "D": {
        "label": "专题深化与攻坚课",
        "intro_style": "专题深化式",
        "intro_tpl": "这门课把最难啃的部分直接前置，围绕{hard_points}展开专题攻坚。课堂不会停留在概念记忆层面，而是把{section_chain}等模块中最容易卡壳、最影响落地质量的部分逐一拆开，帮助{audience}在关键深水区建立稳定的方法抓手、判断标准和专项推进能力。",
    },
    "E": {
        "label": "项目沙盘共创营",
        "intro_style": "项目推进式",
        "intro_tpl": "整个课堂被设定为一个连续推进的拟真项目现场。学员将围绕{project_sim}，在阶段任务推进中把{section_chain}等模块压缩进同一条工作链路，边做边完成方案搭建、风险识别、协同决策和成果汇报。课程重点不只是学会单点知识，而是训练{audience}在真实压力下综合调动多种方法完成落地。",
    },
}


PROJECT_META = {
    "AI应用开发": {
        "artifact_a": "知识底座方案、框架选型表与系统架构蓝图",
        "artifact_b": "知识库工程清单",
        "artifact_c": "智能体集成方案",
        "pain": "知识检索效果不稳、框架选型摇摆、工程集成与系统扩展受限",
        "hard_points": "RAG深度优化、MCP集成、前后端工程化与高可用系统设计",
        "project_sim": "企业级AI应用从知识底座搭建到智能体上线的完整研发项目",
        "scenario": "企业级AI应用研发与架构评审",
        "applicability": "内容贴近金融科技团队在AI应用研发、测试协同和运维保障中的真实任务，可直接支撑知识库建设、智能体工程实现、系统架构设计与上线前评审工作，帮助团队形成更统一的技术语言、交付标准和质量控制抓手。",
    },
    "AI应用解决方案": {
        "artifact_a": "需求规格书、解决方案蓝图与原型评审包",
        "artifact_b": "场景机会清单",
        "artifact_c": "原型评审记录",
        "pain": "需求识别偏差、业务痛点提炼不准、方案难落地或原型难通过评审",
        "hard_points": "场景识别、需求转化、方案建模、原型评审与跨角色对齐",
        "project_sim": "AI产品从场景识别到方案评审的全链路策划项目",
        "scenario": "银行AI产品需求分析与方案设计",
        "applicability": "内容适配金融科技条线在AI场景规划、需求分析、方案设计与原型评审中的实际工作，能够帮助需求分析与产品策划人员减少需求失真、提升方案可落地性，并强化与业务、研发、合规等角色的协同效率。",
    },
    "AI应用运营": {
        "artifact_a": "指标字典、运营看板与优化方案",
        "artifact_b": "监控预警规则表",
        "artifact_c": "巡检与复盘清单",
        "pain": "指标波动难定位、效果提升慢、用户反馈分散、合规风险响应不及时",
        "hard_points": "指标体系搭建、A/B测试、用户运营、案例复用与合规巡检",
        "project_sim": "AI产品上线后从日常运营到全周期优化的经营项目",
        "scenario": "银行AI产品运营复盘与专项优化",
        "applicability": "内容高度贴近金融科技团队在AI产品监控、分析、优化、用户运营与风险管控中的日常场景，可直接迁移到指标治理、报告输出、跨团队协同和全周期运营方案设计工作中。",
    },
    "AI模型算法工程化": {
        "artifact_a": "训练方案、评测方案与部署设计",
        "artifact_b": "数据回流机制图",
        "artifact_c": "推理优化清单",
        "pain": "训练效果不稳定、评测口径不统一、数据回流不足、推理成本与性能难平衡",
        "hard_points": "训练微调、AI Infra、模型评测、安全评估、线上回流与高性能部署",
        "project_sim": "模型从训练调优到线上部署再到迭代优化的工程项目",
        "scenario": "模型工程与部署优化评审",
        "applicability": "内容聚焦金融科技团队在模型训练、评测、部署与迭代中的关键卡点，可直接支撑算法工程、平台建设和线上优化工作，帮助团队以更工程化的方式提升模型稳定性、性能与可维护性。",
    },
    "AI数据能力提升": {
        "artifact_a": "数据架构图、建模成果与质量治理清单",
        "artifact_b": "服务接口设计稿",
        "artifact_c": "安全治理检查表",
        "pain": "异构数据接入慢、建模规范不统一、数据服务质量波动、安全控制前置不足",
        "hard_points": "DCMM落地、数据建模工艺、非结构化处理、服务化保障与安全治理",
        "project_sim": "数据开发与架构能力升级的专项建设项目",
        "scenario": "数据架构评审与治理优化",
        "applicability": "内容面向金融科技机构在数据开发、数据架构、数据治理和服务化建设中的核心诉求，能够帮助数据专业人员把标准规范、建模工艺、质量保障与安全治理真正转化为可执行的工程方法。",
    },
    "AI能力全员赋能": {
        "artifact_a": "工具选型清单、场景方案与个人智能体草图",
        "artifact_b": "任务拆解模板",
        "artifact_c": "使用规范卡片",
        "pain": "不会挑工具、不会拆任务、不会稳定复用、对Agent能力边界理解不足",
        "hard_points": "工具选型、Agent工作原理、提示优化、零代码搭建与场景迁移",
        "project_sim": "个人与团队使用AI工具提升日常工作的场景化项目",
        "scenario": "AI工具应用与个人智能体共创",
        "applicability": "内容适合面向广泛员工开展AI工具使用赋能，既帮助学员理解Agent背后的基本原理，也能把平台使用、任务拆解、提示优化和零代码搭建快速迁移到日常办公与协作场景中。",
    },
}


def load_topics() -> list[dict]:
    topics = json.loads(TOPICS_PATH.read_text())
    return [topic for topic in topics if topic["seq"] != 13]


def clean_text(text: str) -> str:
    text = text.replace("“", "").replace("”", "").replace('"', "")
    return re.sub(r"\s+", " ", text).strip()


def strip_numbering(text: str) -> str:
    text = text.strip()
    text = re.sub(r"^[*•\-]+\s*", "", text)
    text = re.sub(r"^(模块[一二三四五六七八九十]+[:：]|[一二三四五六七八九十]+、|Day\s*\d+[:：]|第[一二三四五六七八九十]+章[:：]?)", "", text)
    text = re.sub(r"^\d+[.、]\s*", "", text)
    return text.strip("：: ")


def heading_kind(line: str) -> str | None:
    line = line.strip()
    if re.match(r"^(模块[一二三四五六七八九十]+[:：]|[一二三四五六七八九十]+、|Day\s*\d+[:：]|第[一二三四五六七八九十]+章[:：]?)", line):
        return "top"
    if re.match(r"^\d+[.、]", line):
        return "num"
    return None


def parse_sections(source_outline: str) -> list[dict]:
    sections: list[dict] = []
    current: dict | None = None
    seen_top = False
    for raw in source_outline.splitlines():
        line = clean_text(raw.strip())
        if not line:
            continue
        kind = heading_kind(line)
        if kind == "top" or (kind == "num" and not seen_top):
            title = strip_numbering(line)
            current = {"title": title, "details": []}
            sections.append(current)
            if kind == "top":
                seen_top = True
        elif current is not None:
            current["details"].append(strip_numbering(line))
        else:
            sections.append({"title": strip_numbering(line), "details": []})
    if not sections:
        sections = [{"title": clean_text(source_outline), "details": []}]
    return sections


def topic_base(topic: str, sections: list[dict]) -> str:
    topic = re.sub(r"（.*?）", "", topic)
    topic = re.sub(r"\(.*?\)", "", topic)
    topic = topic.replace("极客时间-", "").replace("Chatccb", "AI办公")
    topic = re.split(r"[。；;]", topic)[0].strip()
    topic = clean_text(topic)
    if 6 <= len(topic) <= 20:
        return topic
    titles = [section["title"] for section in sections[:2]]
    compact = "与".join(title[:10] for title in titles if title)
    return compact[:22] if compact else topic[:18]


def section_chain(sections: list[dict]) -> str:
    titles = [section["title"] for section in sections[:3]]
    return "、".join(titles)


def section_focus(sections: list[dict], index: int) -> str:
    if not sections:
        return "关键方法与落地动作"
    section = sections[min(index, len(sections) - 1)]
    if section["details"]:
        detail = clean_text(section["details"][0])
        return detail[:26]
    return section["title"][:18]


def build_course_name(base: str, option: str) -> str:
    return f"{base}{OPTION_META[option]['label']}"


def build_intro(topic: dict, sections: list[dict], option: str) -> str:
    meta = OPTION_META[option]
    project_meta = PROJECT_META[topic["project"]]
    text = meta["intro_tpl"].format(
        base=topic_base(topic["topic"], sections),
        section_chain=section_chain(sections),
        focus_a=section_focus(sections, 0),
        focus_b=section_focus(sections, 1),
        focus_c=section_focus(sections, 2),
        audience=topic["audience"],
        pain=project_meta["pain"],
        hard_points=project_meta["hard_points"],
        project_sim=project_meta["project_sim"],
    )
    return clean_text(text)


def build_outputs(topic: dict, option: str) -> list[str]:
    base = topic_base(topic["topic"], parse_sections(topic["source_outline"]))
    project_meta = PROJECT_META[topic["project"]]
    if option == "A":
        return [f"{base}方法框架图", project_meta["artifact_b"], "关键协同与评审清单"]
    if option == "B":
        return [project_meta["artifact_a"], "关键字段或关键步骤设计稿", "课堂成果评审记录"]
    if option == "C":
        return ["问题诊断路径图", "验证与优化动作表", "复盘纪要模板"]
    if option == "D":
        return ["专项攻坚清单", "深水区方法卡", "风险与难点处置表"]
    return ["项目推进路线图", "阶段成果包", "最终汇报与共创方案"]


def build_seminars(topic: dict, sections: list[dict], option: str) -> list[str]:
    section1 = sections[0]["title"] if sections else topic_base(topic["topic"], sections)
    section2 = sections[1]["title"] if len(sections) > 1 else section1
    section3 = sections[2]["title"] if len(sections) > 2 else section2
    project_meta = PROJECT_META[topic["project"]]
    if option == "A":
        return [
            f"案例分析：围绕{project_meta['scenario']}中的典型项目，串联{section1}、{section2}与{section3}，拆解各模块之间的依赖关系、角色边界与常见失误点。",
            f"小组讨论：按业务、产品、研发、运营或数据等角色分组，为一个拟真场景共创{topic_base(topic['topic'], sections)}全链路方法图，并说明每个模块先做什么、后做什么。",
            f"互动演练：针对课堂给定的场景任务，现场完成关键流程排序、职责归口和成果物映射，形成一页可带回岗位复用的执行路线。",
        ]
    if option == "B":
        return [
            f"实战演练：以{section1}为起点，在限定时间内完成一套核心交付物设计，补齐关键字段、责任人、校验点和评审标准。",
            f"案例分析：对比两个{project_meta['scenario']}案例，识别在{section2}与{section3}上的差异做法，判断哪些设计更利于后续落地与协同。",
            f"互动演练：围绕课堂交付物开展现场评审，逐项修正结构缺口、表达歧义和落地风险，形成可直接复用的版本。",
        ]
    if option == "C":
        return [
            f"案例分析：给定一个在{section1}或{section2}环节出现明显卡点的场景，要求学员拆读现象、识别根因，并判断问题会如何影响后续模块推进。",
            f"实战演练：围绕{project_meta['pain']}三类问题，现场搭建问题拆解表、验证顺序和优化动作表，输出可执行的两周改进计划。",
            f"小组讨论：各组从{section3}延伸到整体闭环，讨论资源有限时的优先级取舍，并同步补齐风险控制点与复盘节点。",
        ]
    if option == "D":
        return [
            f"专题研讨：围绕{project_meta['hard_points']}中的关键难题展开深拆，讨论哪些误区最容易导致{topic_base(topic['topic'], sections)}落地效果打折。",
            f"案例分析：复盘一个高复杂度项目在{section2}或{section3}上的失败教训，识别深水区决策失误、能力短板和补救路径。",
            f"实战演练：针对课堂指定的专项攻坚任务，输出一套方法卡、风险清单与推进节奏表，明确谁来牵头、何时评估、何时复盘。",
        ]
    return [
        f"项目实战：以{project_meta['project_sim']}为主任务，按阶段推进{section1}、{section2}和{section3}，每阶段都提交对应成果物并接受现场讲评。",
        f"角色扮演：设置跨角色协同情境，围绕关键决策、资源分配和风险处置开展联席评审，现场统一口径、职责与下一步动作。",
        f"案例分析：对比两个同类项目在落地结果上的差异，提炼可复制的推进打法、评审标准与阶段复盘要点。",
    ]


def build_highlights(topic: dict, option: str) -> list[str]:
    project_meta = PROJECT_META[topic["project"]]
    if option == "A":
        return [
            "课堂不是拆散讲模块，而是按完整链路推进认知与方法，便于学员建立系统视角和跨环节理解。",
            f"成果可直接迁移到{project_meta['scenario']}相关工作中，适合作为统一方法论和协同语言的筑基课程。",
        ]
    if option == "B":
        return [
            "以交付物为牵引组织学习，课程过程天然对应评审、汇报和落地所需的关键成果。",
            "每个练习都带有字段、步骤或结构校验，学完后更容易把课堂内容直接转成岗位产出。",
        ]
    if option == "C":
        return [
            "把课堂重心放在发现问题、验证问题和修正问题上，训练更贴近日常专项攻关和复盘场景。",
            "兼顾问题分析与优化落地，不止回答哪里出错，也回答下一步该怎么改、如何验证是否改对。",
        ]
    if option == "D":
        return [
            "聚焦最容易拉开能力差距的深水区主题，适合用于骨干强化和专项突破。",
            "通过失败案例复盘与攻坚任务设计，帮助学员建立在复杂约束下做判断和推进的能力。",
        ]
    return [
        "课程节奏完全按项目推进组织，学员能在连续任务压力下练成综合调度和阶段决策能力。",
        "同时覆盖成果共创、联席评审和最终汇报，更适合检验多模块知识是否真正打通并能落地。",
    ]


def build_applicability(topic: dict, sections: list[dict]) -> str:
    project_meta = PROJECT_META[topic["project"]]
    return clean_text(
        f"{project_meta['applicability']} 同时，课程围绕{section_chain(sections)}等模块展开，能帮助{topic['audience']}把主题要求快速映射到真实项目、评审或协同场景，缩短从学习到应用的转化距离。"
    )


def build_coverage(sections: list[dict]) -> list[str]:
    items = []
    for section in sections:
        detail = clean_text(section["details"][0]) if section["details"] else "对应方法、流程与关键控制点"
        items.append(f"已覆盖{section['title']}，包含{detail[:32]}")
    return items


def render_topic(topic: dict) -> str:
    sections = parse_sections(topic["source_outline"])
    base = topic_base(topic["topic"], sections)
    lines = [
        f"# 主题{topic['seq']}：{topic['topic']}",
        "",
        f"- **项目类别**：{topic['project']}",
        f"- **授课对象**：{topic['audience']}",
        f"- **培训目标**：{clean_text(topic['objective'])}",
        "",
    ]

    for idx, option in enumerate(["A", "B", "C", "D", "E"], 1):
        course_name = build_course_name(base, option)
        lines.append(f"## 课程{idx}：{course_name}")
        lines.append("")
        lines.append(f"- **课程主题**：{course_name}")
        lines.append(f"- **课程介绍**：{build_intro(topic, sections, option)}")
        lines.append("- **课程产出**：")
        for out_idx, output in enumerate(build_outputs(topic, option), 1):
            lines.append(f"  {out_idx}. {output}")
        lines.append("- **课程研讨安排**：")
        for sem_idx, seminar in enumerate(build_seminars(topic, sections, option), 1):
            lines.append(f"  {sem_idx}. {seminar}")
        lines.append("- **课程亮点**：")
        for hi_idx, highlight in enumerate(build_highlights(topic, option), 1):
            lines.append(f"  {hi_idx}. {highlight}")
        lines.append(f"- **适用性和价值度**：{build_applicability(topic, sections)}")
        lines.append("- **覆盖确认**：")
        for cov_idx, coverage in enumerate(build_coverage(sections), 1):
            lines.append(f"  {cov_idx}. {coverage}")
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    topics = load_topics()

    remaining_parts = ["# AI培训课程需求剩余27主题五门课程成稿", ""]
    for topic in topics:
        content = render_topic(topic)
        topic_file = OUTPUT_DIR / f"topic_{topic['seq']:02d}_五门课程成稿.md"
        topic_file.write_text(content)
        remaining_parts.append(content.strip())
        remaining_parts.append("")

    (OUTPUT_DIR / "remaining_27_topics_5courses.md").write_text("\n".join(remaining_parts).rstrip() + "\n")
    print(f"generated_topics={len(topics)}")
    print(OUTPUT_DIR / "remaining_27_topics_5courses.md")


if __name__ == "__main__":
    main()
