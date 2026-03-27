from __future__ import annotations

import json
import re
import sys
from pathlib import Path


ROOT = Path("/Users/haichao/Desktop/work/51ToolBox")
SCRIPTS_DIR = ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from build_remaining_27_five_courses import (  # noqa: E402
    PROJECT_SCENE,
    compact_focus,
    parse_sections,
    sanitize,
    topic_short,
)


TOPICS_PATH = ROOT / "deliverables" / "ai_training_course_draft" / "normalized_topics.json"
OUT_DIR = ROOT / "deliverables" / "ai_training_course_draft" / "expanded_course_pool"
OUT_DIR.mkdir(parents=True, exist_ok=True)
POOL_PATH = OUT_DIR / "AI培训课程需求-全28主题-扩展课程池.md"


STYLE_ORDER = [
    "framework",
    "method",
    "scenario",
    "design",
    "deliverable",
    "evaluation",
    "optimization",
    "governance",
    "diagnostic",
    "case",
    "deepdive",
    "project",
    "strategy",
    "lab",
]

PROJECT_FOCUS_FALLBACKS = {
    "AI应用开发": ["架构设计", "工程落地", "场景应用", "质量保障", "安全合规", "性能优化", "协同治理", "项目实战"],
    "AI应用解决方案": ["需求分析", "方案设计", "场景转化", "原型表达", "交付评审", "业务协同", "优化迭代", "项目推进"],
    "AI应用运营": ["运营框架", "指标体系", "效果评估", "优化策略", "合规治理", "风险处置", "协同机制", "项目复盘"],
    "AI模型算法工程化": ["模型原理", "训练方法", "评测验证", "部署优化", "回流迭代", "风险控制", "工程效率", "项目实战"],
    "AI数据能力提升": ["数据开发", "架构治理", "数据分析", "语义建模", "质量保障", "服务化应用", "规范治理", "价值转化"],
    "AI能力全员赋能": ["工具认知", "方法应用", "典型场景", "协同提效", "问题处理", "实践复盘", "进阶使用", "综合演练"],
}

TOPIC_FOCUS_FALLBACKS = {
    1: ["知识库构建", "智能体工程化", "架构设计", "检索优化", "高并发设计", "研发调试"],
    2: ["威胁建模", "数据安全", "模型安全", "风险评估", "安全开发", "安全治理"],
    3: ["数据安全", "内容合规", "算法伦理", "风险认知", "监管要求", "应对预案"],
    4: ["数据架构", "访问控制", "数据加密", "数据脱敏", "安全审计", "纵深防御"],
    5: ["运维架构", "部署管理", "性能分析", "监控告警", "智能运维", "闭环优化"],
    6: ["测试框架", "功能测试", "自动化测试", "AI测试指标", "智能造数", "图像识别测试"],
    7: ["能力地图", "业务赋能", "场景识别", "产品思维", "技术边界", "技能迁移"],
    8: ["全生命周期", "商业画布", "MVP设计", "PMF验证", "合规伦理", "产品规划"],
    9: ["场景认知", "需求挖掘", "需求文档", "方案设计", "原型设计", "体验优化"],
    10: ["战略规划", "市场分析", "需求洞察", "设计提效", "数据决策", "体验优化"],
    11: ["产品思维", "战略规划", "用户需求", "场景定义", "数据驱动", "团队协同"],
    12: ["数据思维", "量化分析", "对比分析", "归因诊断", "SSA模型", "OSM指标体系"],
    13: ["运营框架", "生命周期运营", "指标体系", "效果评估", "优化策略", "合规巡检"],
    14: ["运营工具", "数据分析", "A/B测试", "用户运营", "标杆案例", "全周期方案"],
    15: ["模型选型", "架构解析", "成本评估", "场景适配", "安全评估", "技术演进"],
    16: ["数据处理", "数据飞轮", "业务回流", "自动化评测", "数据合成", "质量闭环"],
    17: ["场景适配", "领域知识注入", "工具调用", "微调策略", "复杂推理", "架构优化"],
    18: ["自动化评测", "评测集构建", "业务指标", "性能评估", "模型安全", "隐私保护"],
    19: ["回流架构", "隐式反馈", "显式反馈", "难例挖掘", "增量训练", "收益量化"],
    20: ["并行训练", "轻量微调", "强化学习", "框架部署", "SFT实战", "效果验证"],
    21: ["并行策略", "框架选型", "显存优化", "训练调优", "集群管理", "监控告警"],
    22: ["推理框架", "PrefixCache", "多Token预测", "PD分离部署", "量化优化", "容量规划"],
    23: ["数据标准", "数据建模", "采集整合", "非结构化处理", "数据服务", "安全合规"],
    24: ["DCMM应用", "自主用数", "指标看板", "智能分析", "知识萃取", "安全红线"],
    25: ["本体建模", "W3C标准", "知识萃取", "语义映射", "图数据库", "知识推理"],
    26: ["平台生态", "Agent原理", "知识库应用", "工具集成", "任务规划", "实战搭建"],
    27: ["大模型认知", "应用广场", "智能体广场", "日常提效", "安全合规", "场景应用"],
    28: ["Agent原理", "需求转化", "角色设定", "工作流编排", "知识库注入", "调试发布"],
}

STYLE_METHODS = {
    "framework": "框架讲授、模块拆解与认知建模",
    "method": "专题讲授、关键动作拆分与对照练习",
    "scenario": "场景拆解、案例映射与应用推演",
    "design": "方案推导、结构设计与课堂讲评",
    "deliverable": "样板示范、模板填制与成果修订",
    "evaluation": "指标设计、效果验证与结果解读",
    "optimization": "问题复盘、改进设计与策略迭代",
    "governance": "规则解读、边界分析与治理研讨",
    "diagnostic": "异常排查、根因定位与优化推演",
    "case": "案例对标、经验提炼与迁移讨论",
    "deepdive": "进阶讲授、专题比较与路径比选",
    "project": "项目沙盘、角色协同与阶段答辩",
    "strategy": "策略研讨、路线拆解与实施排布",
    "lab": "工具演练、模板套用与结果打磨",
}

STYLE_SUFFIXES = {
    "framework": ["全景认知与方法框架", "核心逻辑与能力地图", "体系化认知与工作框架"],
    "method": ["核心方法与实践路径", "方法拆解与实施要点", "关键机制与应用方法"],
    "scenario": ["典型场景与应用设计", "业务场景与落地思路", "场景应用与方案转化"],
    "design": ["方案设计与结构化表达", "设计逻辑与表达训练", "方案构思与设计方法"],
    "deliverable": ["成果输出与交付实训", "成果设计与模板应用", "交付成果与落地实训"],
    "evaluation": ["效果评估与验证方法", "指标设计与结果解读", "评估体系与验证实践"],
    "optimization": ["优化路径与迭代策略", "优化设计与提升方法", "改进策略与迭代实战"],
    "governance": ["治理要求与实施边界", "规范约束与管理机制", "治理逻辑与落地规则"],
    "diagnostic": ["问题诊断与优化提升", "偏差识别与改进路径", "问题复盘与修正方法"],
    "case": ["案例复盘与经验迁移", "典型案例拆解", "案例对标与方法迁移"],
    "deepdive": ["进阶专题与高阶应用", "高阶方法与专题突破", "复杂专题与深化训练"],
    "project": ["项目沙盘与综合演练", "项目推进与成果答辩", "综合实战与协同训练"],
    "strategy": ["策略规划与实施路线", "顶层设计与推进路径", "能力布局与实施框架"],
    "lab": ["工具应用与实务演练", "工具链实训与模板演练", "实操工坊与成果打磨"],
}

STYLE_FOCUS_INDEX = {
    "framework": [0, 1, 2],
    "method": [1, 2, 3],
    "scenario": [0, 3, 4],
    "design": [1, 3, 4],
    "deliverable": [2, 3, 4],
    "evaluation": [0, 2, 5],
    "optimization": [1, 4, 6],
    "governance": [0, 2, 4],
    "diagnostic": [1, 4, 5],
    "case": [0, 4, 5],
    "deepdive": [2, 4, 5],
    "project": [1, 3, 5],
    "strategy": [0, 2, 6],
    "lab": [2, 4, 6],
}

STYLE_PRIORITY = {
    "framework": "整体框架、模块衔接与职责边界",
    "method": "方法口径、执行步骤与应用条件",
    "scenario": "场景判断、方案组合与落地取舍",
    "design": "结构搭建、表达顺序与呈现标准",
    "deliverable": "成果结构、模板字段与评审依据",
    "evaluation": "指标口径、验证步骤与结果解读",
    "optimization": "问题闭环、改进顺序与迭代安排",
    "governance": "规则边界、协同机制与控制要求",
    "diagnostic": "异常识别、证据判断与修正路径",
    "case": "经验提炼、路径比较与迁移条件",
    "deepdive": "复杂约束、进阶取舍与专题突破",
    "project": "推进节奏、分工协同与阶段交付",
    "strategy": "目标拆解、路线编排与实施优先级",
    "lab": "工具用法、模板修订与成果定稿",
}

STYLE_RESULT = {
    "framework": "系统化认知框架与统一工作口径",
    "method": "可复用的方法步骤与执行清单",
    "scenario": "场景适配能力与方案转化思路",
    "design": "结构化方案与规范化表达能力",
    "deliverable": "可直接套用的成果模板与交付结构",
    "evaluation": "稳定的评估框架与验证分析能力",
    "optimization": "持续优化机制与动作优先级判断能力",
    "governance": "规范落地意识与治理协同能力",
    "diagnostic": "问题排查框架与修正闭环意识",
    "case": "案例迁移能力与方法借鉴标准",
    "deepdive": "复杂议题的专题分析与进阶判断能力",
    "project": "完整项目方案与协同推进能力",
    "strategy": "可执行的实施路线与阶段推进框架",
    "lab": "可落地的工具模板和实操产出能力",
}

INTRO_PATTERNS = [
    "本课程以{focus_a}为主线，采用{method}组织教学，将{focus_b}、{focus_c}与{objective_a}串联为完整任务链，重点处理{priority}，帮助{audience}形成{result}。",
    "课程从{scene}中的{focus_b}切入，通过{method}展开分层训练，依次拆解{focus_a}、{focus_c}与{objective_a}之间的衔接关系，重点强化{priority}，使{audience}能够沉淀{result}。",
    "围绕{course_name}对应的核心任务，教学安排采用{method}，先校准{focus_a}的判断标准，再落到{focus_b}与{focus_c}的实施动作，重点提升{priority}，适合{audience}建立{result}。",
    "本课程面向{scene}中的实际推进场景，采用{method}组织内容，不以概念堆叠为主，而是围绕{focus_a}、{objective_a}与{focus_c}逐步搭建处理路径，重点落实{priority}，支撑{audience}形成{result}。",
    "课程以{focus_c}为牵引重组主题知识，通过{method}打通{focus_a}与{focus_b}，重点分析{scene}场景下的关键取舍、控制节点与验证方式，帮助{audience}获得{result}。",
    "针对{audience}在{scene}中经常面对的{objective_a}要求，本课程采用{method}开展训练，把{focus_a}、{focus_b}与{focus_c}转成可执行环节，重点校准{priority}，最终沉淀{result}。",
    "本课程围绕{focus_a}与{objective_b}的协同关系展开，采用{method}组织推进，课堂将{focus_b}和{focus_c}纳入统一分析口径，重点解决{priority}，帮助{audience}提升{result}。",
    "课程将{course_name}界定为一项可落地的工作任务，通过{method}完成认知导入、动作拆解与结果校准，重点聚焦{focus_a}、{focus_b}和{objective_a}，使{audience}能够形成{result}。",
    "以{focus_a}、{focus_b}和{focus_c}为知识骨架，课程采用{method}搭建教学流程，重点围绕{priority}组织分析与练习，面向{audience}沉淀{result}。",
    "课程不从概念罗列切入，而是直接对应{scene}中的{focus_a}任务，借助{method}展开拆解，重点校准{focus_b}、{focus_c}与{objective_a}的联动关系，帮助{audience}构建{result}。",
    "作为{scene}主题下的专项课程，本课程通过{method}组织学习，以{focus_b}为入口、以{focus_a}为主轴、以{focus_c}为落点，重点落实{priority}，适合{audience}形成{result}。",
    "教学过程围绕{course_name}所对应的真实任务展开，采用{method}分阶段推进，先完成{focus_a}与{focus_b}的口径统一，再延伸到{focus_c}的应用校验，重点强化{priority}，支撑{audience}获得{result}。",
    "本课程针对{scene}中常见的{focus_a}议题设置学习路径，借助{method}把{focus_b}、{objective_a}与{focus_c}整合为一套处理框架，重点提升{priority}，帮助{audience}沉淀{result}。",
    "课程围绕{focus_c}这一关键切口组织教学，采用{method}串联{focus_a}、{focus_b}与{objective_b}，重点回应{scene}场景中的{priority}要求，使{audience}能够形成{result}。",
]

GENERIC_FOCUS = {
    "案例分析",
    "案例研讨",
    "实践任务",
    "实战演练",
    "实操练习",
    "应用案例",
    "平台概览",
    "核心架构拆解",
    "工作原理",
    "项目交付",
    "学员作品展示",
    "专业点评",
    "综合沙盘演练",
}

LEADING_VERB_PATTERN = re.compile(
    r"^(?:介绍|讲解|详细讲解|解析|剖析|理解|掌握|建立|帮助|能够|具备|学会|聚焦|面向|围绕|针对|通过|利用|设计|完成|展示|分享|深度理解|深入理解|深入对比|重点讲解|详解)\s*"
)

DIRTY_PREFIXES = ("介绍", "讲解", "详细讲解", "帮助", "能够", "具备", "掌握", "理解", "建立", "围绕", "面向", "聚焦", "针对")

ALL_SUFFIXES = sorted({item for values in STYLE_SUFFIXES.values() for item in values}, key=len, reverse=True)


def load_topics() -> list[dict]:
    topics = json.loads(TOPICS_PATH.read_text(encoding="utf-8"))
    topics.sort(key=lambda item: int(item["seq"]))
    return topics


def load_existing_courses() -> dict[int, list[dict[str, str]]]:
    if not POOL_PATH.exists():
        return {}
    text = POOL_PATH.read_text(encoding="utf-8")
    topic_pattern = re.compile(r"^# 主题(\d+)：", re.M)
    name_pattern = re.compile(r"- \*\*课程名称\*\*：(.+)")
    current_topic = 0
    current_name = ""
    grouped: dict[int, list[dict[str, str]]] = {}
    for line in text.splitlines():
        topic_match = topic_pattern.match(line)
        if topic_match:
            current_topic = int(topic_match.group(1))
            grouped.setdefault(current_topic, [])
            continue
        name_match = name_pattern.match(line)
        if name_match:
            current_name = sanitize(name_match.group(1))
            continue
        if line.startswith("- **课程介绍**：") and current_topic:
            intro = sanitize(line.split("：", 1)[1])
            grouped.setdefault(current_topic, []).append({"name": current_name, "intro": intro})
    return grouped


def pool_topic_label(topic: dict) -> str:
    raw = sanitize(topic["topic"])
    special_map = {
        "面向AI应用研发介绍AI": "企业级AI应用研发",
        "AI安全风险与防护体系": "AI安全风险与防护体系",
        "AI应用的安全与合规红线": "AI应用安全与合规红线",
        "数据安全与合规治理": "数据安全与合规治理",
        "面向AI支撑下的智能化应用": "AI应用系统运维",
        "极客时间-AI测试开发训练营": "AI测试开发",
        "AI产品能力进阶课": "AI产品能力进阶",
        "AI产品从0到1的商业实践": "AI产品商业化实践",
        "银行AI产品需求转化与解决方案设计核心能力筑基": "银行AI产品需求转化与方案设计",
        "AI产品经理战略规划与创新设计实践": "AI产品经理战略规划与创新设计",
        "金融产品经理的AI创新战略与设计体系": "金融产品经理AI创新战略与设计",
        "AI时代金融科技从业者必备的数据思维与分析框架": "金融科技数据思维与分析框架",
        "银行AI产品运营核心能力与合规运营体系筑基": "银行AI产品运营与合规运营",
        "银行AI产品运营实战与全周期运营方案设计": "银行AI产品全周期运营设计",
        "大模型能力边界、技术原理和适用场景简介": "大模型能力边界与适用场景",
        "AI数据工程案例讲解": "AI数据工程",
        "模型场景建模工程": "模型场景建模",
        "模型测试与安全评估": "模型测试与安全评估",
        "线上数据回流与迭代优化机制设计": "线上数据回流与迭代优化",
        "大模型训练与微调理论基础与技术实战": "大模型训练与微调",
        "大模型训练：AI Infra 与训练效率": "AI Infra与训练效率",
        "推理优化与高性能部署": "推理优化与高性能部署",
        "数智基石：数据开发与架构进阶班": "数据开发与架构进阶",
        "数智洞察：数据应用与分析进阶班": "数据应用与分析进阶",
        "数义合一：基于本体论的数据语义建模专项班": "数据语义建模",
        "AI Agent基础工具与使用方法": "AI Agent基础工具",
        "Chatccb赋能日常工作": "AI赋能日常工作",
        "零代码构建你的专属AI智能体": "零代码AI智能体构建",
    }
    for key, value in special_map.items():
        if key in raw:
            return value
    return compact_focus(topic_short(raw), 18)


def outline_lines(source_outline: str) -> list[str]:
    return [sanitize(line.strip(" *")) for line in source_outline.splitlines() if sanitize(line.strip(" *"))]


def is_generic_focus(text: str) -> bool:
    text = sanitize(text)
    if not text:
        return True
    if text in GENERIC_FOCUS:
        return True
    if text in {"工作坊", "项目实战", "综合实战", "课程介绍", "课堂练习"}:
        return True
    if text.endswith("案例") and len(text) <= 6:
        return True
    return False


def normalize_focus_seed(text: str, max_len: int = 14) -> str:
    text = sanitize(text)
    if not text:
        return ""
    text = re.sub(r"^[-*▶]+", "", text)
    text = re.sub(r"^[0-9]+[、.：:)]\s*", "", text)
    text = re.sub(r"^[a-zA-Z][、.：:)]\s*", "", text)
    text = re.sub(r"^[一二三四五六七八九十]+[、.：:]\s*", "", text)
    text = re.sub(r"^第[一二三四五六七八九十]+章[：:]?", "", text)
    text = re.sub(r"^Day ?\d+[：:]?", "", text, flags=re.I)
    text = re.sub(r"^【[^】]{1,8}】", "", text)
    if "——" in text:
        left, right = text.split("——", 1)
        if len(left) <= 8 and right:
            text = right
    if re.search(r"[：:]", text):
        left, right = re.split(r"[：:]", text, maxsplit=1)
        left = sanitize(left)
        right = sanitize(right)
        if left in GENERIC_FOCUS or left in {"平台概览", "应用案例", "工作原理", "核心架构拆解", "案例分析", "实操练习", "交互优化"}:
            text = right
    text = text.replace("LLM-as-a-Judge", "LLM裁判")
    text = text.replace("Chatccb", "大模型应用")
    text = LEADING_VERB_PATTERN.sub("", text)
    patterns = [
        r"在.+?中的应用.*$",
        r"的目标和原则.*$",
        r"的作用和方法.*$",
        r"的应用方法.*$",
        r"的设计方法.*$",
        r"的原理、分类和应用场景.*$",
        r"的原理与应用场景.*$",
        r"的原理.*$",
        r"的方法论.*$",
        r"的核心要求.*$",
        r"的核心要点.*$",
        r"的背景与收益.*$",
        r"的适用场景.*$",
        r"的实际应用场景及提效果成果.*$",
    ]
    for pattern in patterns:
        text = re.sub(pattern, "", text)
    text = re.sub(r"如.+$", "", text)
    text = re.sub(r"包括.+$", "", text)
    text = re.sub(r"如何.+$", "", text)
    text = re.split(r"[，；。]", text)[0].strip()
    text = re.sub(r"（.*?）", "", text)
    text = re.sub(r"\(.*?\)", "", text)
    text = re.sub(r"\s+", "", text)
    text = compact_focus(text, max_len)
    text = re.sub(r"^[的与和及]", "", text).rstrip("与和及")
    if len(text) > max_len:
        text = text[:max_len].rstrip("与和及")
    return text


def is_clean_focus(text: str) -> bool:
    cleaned = normalize_focus_seed(text, 14)
    if not cleaned:
        return False
    if len(cleaned) < 4 or len(cleaned) > 12:
        return False
    if is_generic_focus(cleaned):
        return False
    if re.search(r"[【】]|(?:^|\s)\d+[.、:：)]|(?:^|\s)[a-zA-Z][.、:：)]|——", cleaned):
        return False
    if cleaned.startswith(DIRTY_PREFIXES):
        return False
    if cleaned.startswith("某"):
        return False
    if cleaned.endswith("的"):
        return False
    if cleaned.count("的") >= 2:
        return False
    if any(
        word in cleaned
        for word in [
            "介绍",
            "讲解",
            "帮助",
            "能够",
            "具备",
            "掌握",
            "理解",
            "学习",
            "提升",
            "全流程构建方法",
            "核心技术原理",
            "具体银行业务场景",
            "虚拟的AI合规风险案例",
        ]
    ):
        return False
    if re.search(r"[A-Za-z]{4,}$", cleaned) and cleaned not in {"Coze", "Dify", "LoRA", "Swift"}:
        return False
    return True


def is_dirty_course_name(text: str) -> bool:
    text = sanitize(text)
    if not text:
        return True
    if len(text) < 8 or len(text) > 28:
        return True
    if text.startswith(DIRTY_PREFIXES):
        return True
    if re.search(r"[【】]|(?:^|\s)\d+[.、:：)]|(?:^|\s)[a-zA-Z][.、:：)]|——", text):
        return True
    if any(word in text for word in ["详细讲解", "案例研讨", "帮助员工", "能够对", "介绍", "讲解"]):
        return True
    if re.search(r"[A-Za-z]{4,}$", text) and text.split()[-1] not in {"Infra", "Cache", "Token", "Agent", "Prompt", "Coze", "Dify"}:
        return True
    return False


def safe_focus(text: str, topic_label: str, max_len: int = 12) -> str:
    cleaned = normalize_focus_seed(text, max_len)
    if is_clean_focus(cleaned):
        return cleaned
    return compact_focus(topic_label, max_len)


def parse_sections_for_pool(source_outline: str) -> list[dict[str, list[str] | str]]:
    cleaned_sections: list[dict[str, list[str] | str]] = []
    seen: set[str] = set()
    for section in parse_sections(source_outline):
        raw_title = str(section.get("title", ""))
        title = normalize_focus_seed(raw_title, 14)
        details: list[str] = []
        for detail in list(section.get("details", []))[:3]:  # type: ignore[arg-type]
            piece = normalize_focus_seed(detail, 14)
            if piece and piece not in details and not is_generic_focus(piece):
                details.append(piece)
        if title and not is_generic_focus(title) and title not in seen:
            cleaned_sections.append({"title": title, "details": details})
            seen.add(title)
        elif details:
            primary = details[0]
            if primary not in seen:
                cleaned_sections.append({"title": primary, "details": details[1:]})
                seen.add(primary)
    for line in outline_lines(source_outline):
        if not re.match(r"^(?:[a-zA-Z][.、:：)]|\d+[.、:：)]|\d+[:：]|【)", line):
            continue
        piece = normalize_focus_seed(line, 14)
        if piece and piece not in seen and not is_generic_focus(piece):
            cleaned_sections.append({"title": piece, "details": []})
            seen.add(piece)
    return cleaned_sections[:8]


def parse_objectives(objective: str) -> list[str]:
    text = sanitize(objective).replace("；；", "；")
    parts = re.split(r"(?:\n+|(?=\d+[、.])|[；;]|(?=·)|(?=•))", text)
    cleaned: list[str] = []
    for part in parts:
        part = sanitize(re.sub(r"^[·•]\s*", "", part))
        piece = normalize_focus_seed(part, 14)
        if piece and is_clean_focus(piece) and piece not in cleaned:
            cleaned.append(piece)
    return cleaned[:6]


def add_unique(items: list[str], value: str) -> None:
    value = sanitize(value)
    if value and value not in items:
        items.append(value)


def build_focus_pool(topic: dict) -> list[str]:
    topic_label = pool_topic_label(topic)
    seq = int(topic["seq"])
    pool: list[str] = [topic_label]
    for item in TOPIC_FOCUS_FALLBACKS.get(seq, []):
        if is_clean_focus(item):
            add_unique(pool, item)
    for section in parse_sections_for_pool(topic["source_outline"]):
        title = sanitize(str(section["title"]))
        if is_clean_focus(title):
            add_unique(pool, title)
        for detail in list(section.get("details", []))[:2]:  # type: ignore[arg-type]
            if is_clean_focus(detail):
                add_unique(pool, detail)
    for item in parse_objectives(topic["objective"]):
        add_unique(pool, item)
    for fallback in PROJECT_FOCUS_FALLBACKS.get(sanitize(topic["project"]), []):
        add_unique(pool, fallback)
    while len(pool) < 10:
        add_unique(pool, "核心应用")
    return pool[:12]


def pick_focus_triplet(pool: list[str], style: str) -> tuple[str, str, str]:
    indexes = STYLE_FOCUS_INDEX[style]
    picked: list[str] = []
    for index in indexes:
        picked.append(pool[index % len(pool)])
    while len(picked) < 3:
        picked.append(pool[len(picked) % len(pool)])
    return picked[0], picked[1], picked[2]


def pick_variant(items: list[str], seed: int, offset: int = 0) -> str:
    return items[(seed + offset) % len(items)]


def strip_style_suffix(name: str) -> str:
    for suffix in ALL_SUFFIXES:
        if name.endswith(suffix):
            return name[: -len(suffix)]
    return name


def base_limit(base: str, topic_label: str) -> int:
    return 3 if base == topic_label else 2


def exceeds_base_limit(candidate: str, existing_names: set[str], topic_label: str) -> bool:
    base = strip_style_suffix(candidate)
    count = sum(1 for name in existing_names if strip_style_suffix(name) == base)
    return count >= base_limit(base, topic_label)


def infer_style_from_name(name: str) -> str:
    for style, suffixes in STYLE_SUFFIXES.items():
        if any(name.endswith(suffix) for suffix in suffixes):
            return style
    return "framework"


def build_course_name(topic: dict, style: str, seed: int, existing_names: set[str]) -> str:
    topic_label = pool_topic_label(topic)
    focus_pool = build_focus_pool(topic)
    focus_a, focus_b, focus_c = pick_focus_triplet(focus_pool, style)
    anchor_a = safe_focus(focus_a, topic_label, 12)
    anchor_b = safe_focus(focus_b, topic_label, 12)
    anchor_c = safe_focus(focus_c, topic_label, 12)
    if style in {"framework", "design", "evaluation", "governance", "case", "project"}:
        bases = [topic_label, anchor_a, anchor_b, anchor_c]
    elif style in {"method", "optimization", "strategy"}:
        bases = [anchor_a, anchor_b, topic_label, anchor_c]
    elif style in {"scenario", "diagnostic"}:
        bases = [anchor_b, anchor_a, topic_label, anchor_c]
    else:
        bases = [anchor_c, anchor_b, anchor_a, topic_label]

    for base_index, base in enumerate(bases):
        if not base:
            continue
        for suffix in STYLE_SUFFIXES[style]:
            candidate = sanitize(f"{base}{suffix}")
            if is_dirty_course_name(candidate):
                continue
            if candidate in existing_names:
                continue
            if exceeds_base_limit(candidate, existing_names, topic_label):
                continue
            return candidate

    default_candidate = sanitize(f"{topic_label}{pick_variant(STYLE_SUFFIXES[style], seed, 1)}")
    if (
        not is_dirty_course_name(default_candidate)
        and default_candidate not in existing_names
        and not exceeds_base_limit(default_candidate, existing_names, topic_label)
    ):
        return default_candidate
    for suffix in STYLE_SUFFIXES[style]:
        fallback = sanitize(f"{topic_label}{suffix}")
        if (
            fallback not in existing_names
            and not is_dirty_course_name(fallback)
            and not exceeds_base_limit(fallback, existing_names, topic_label)
        ):
            return fallback
    return sanitize(f"{topic_label}{STYLE_SUFFIXES[style][0]}{len(existing_names) + 1}")


def build_intro(topic: dict, style: str, course_name: str, seed: int) -> str:
    focus_pool = build_focus_pool(topic)
    focus_a, focus_b, focus_c = pick_focus_triplet(focus_pool, style)
    goal_pool = focus_pool[1:] or [focus_a, focus_b]
    objective_a = goal_pool[(seed + 2) % len(goal_pool)]
    objective_b = goal_pool[(seed + 4) % len(goal_pool)]
    pattern = INTRO_PATTERNS[(seed * 5 + len(course_name) * 7 + len(focus_b) * 3) % len(INTRO_PATTERNS)]
    intro = pattern.format(
        course_name=course_name,
        scene=PROJECT_SCENE.get(topic["project"], "金融科技业务"),
        method=STYLE_METHODS[style],
        focus_a=focus_a,
        focus_b=focus_b,
        focus_c=focus_c,
        objective_a=objective_a,
        objective_b=objective_b,
        priority=STYLE_PRIORITY[style],
        result=STYLE_RESULT[style],
        audience=sanitize(topic["audience"]),
    )
    intro = sanitize(intro)
    if intro and intro[-1] not in "。！？":
        intro += "。"
    return intro


def topic_course_count(topic: dict) -> int:
    project = sanitize(topic["project"])
    seq = int(topic["seq"])
    if project == "AI应用开发":
        return 14
    if project == "AI模型算法工程化":
        return 14
    if project == "AI应用运营" and seq in {13, 14}:
        return 14
    if project == "AI应用解决方案":
        return 12
    if project == "AI数据能力提升":
        return 12
    if project == "AI应用运营":
        return 12
    if project == "AI能力全员赋能":
        return 10
    return 12


def select_seed_courses(topic: dict, final_count: int, existing_pool: dict[int, list[dict[str, str]]]) -> list[dict[str, str]]:
    topic_label = pool_topic_label(topic)
    allowed_bases = set(TOPIC_FOCUS_FALLBACKS.get(int(topic["seq"]), []))
    allowed_bases.update(PROJECT_FOCUS_FALLBACKS.get(sanitize(topic["project"]), []))
    allowed_bases.add(topic_label)
    selected: list[dict[str, str]] = []
    selected_names: set[str] = set()
    for record in existing_pool.get(int(topic["seq"]), []):
        name = sanitize(record["name"])
        if is_dirty_course_name(name):
            continue
        base = strip_style_suffix(name)
        if base not in allowed_bases and not (is_clean_focus(base) and len(base) <= 10):
            continue
        if name in selected_names:
            continue
        if exceeds_base_limit(name, selected_names, topic_label):
            continue
        selected.append({"name": name, "style": infer_style_from_name(name)})
        selected_names.add(name)
        if len(selected) >= final_count:
            break
    return selected


def build_topic_block(
    topic: dict,
    existing_pool: dict[int, list[dict[str, str]]],
    global_names: set[str],
    count_per_topic: int | None = None,
) -> str:
    final_count = count_per_topic or topic_course_count(topic)
    lines = [f"# 主题{topic['seq']}：{sanitize(topic['topic'])}", ""]
    courses: list[tuple[str, str]] = []
    existing_names: set[str] = set()

    for index, record in enumerate(select_seed_courses(topic, final_count, existing_pool), start=1):
        name = record["name"]
        style = record["style"]
        if name in global_names:
            name = build_course_name(topic, style, int(topic["seq"]) * 29 + index * 17, existing_names | global_names)
        if name in global_names or name in existing_names:
            continue
        existing_names.add(name)
        global_names.add(name)
        intro = build_intro(topic, style, name, int(topic["seq"]) * 31 + index * 9)
        courses.append((name, intro))

    round_index = 0
    while len(courses) < final_count and round_index < 5:
        for style in STYLE_ORDER:
            if len(courses) >= final_count:
                break
            seed = int(topic["seq"]) * 37 + round_index * 101 + len(courses) * 13
            name = build_course_name(topic, style, seed, existing_names | global_names)
            if name in existing_names or name in global_names:
                continue
            existing_names.add(name)
            global_names.add(name)
            intro = build_intro(topic, style, name, seed)
            courses.append((name, intro))
        round_index += 1

    for idx, (course_name, intro) in enumerate(courses[:final_count], start=1):
        lines.extend(
            [
                f"## 课程{idx}：{course_name}",
                "",
                f"- **课程名称**：{course_name}",
                f"- **课程介绍**：{intro}",
                "",
            ]
        )
    return "\n".join(lines).rstrip() + "\n"


def build_all_topics() -> str:
    topics = load_topics()
    existing_pool = load_existing_courses()
    global_names: set[str] = set()
    total_courses = sum(topic_course_count(topic) for topic in topics)
    parts = [
        "# AI培训课程需求全28主题扩展课程池",
        "",
        f"> 说明：本稿在现有课程池基础上保留质量达标课程，并对异常命名、句子化标题和高重复表达进行清洗重构；现按14门、12门、10门分层扩展，共计{total_courses}门课程，仅保留课程名称与课程介绍两个字段。",
        "",
    ]
    for topic in topics:
        parts.append(build_topic_block(topic, existing_pool, global_names).strip())
        parts.append("")
    return "\n".join(parts).rstrip() + "\n"


def main() -> None:
    POOL_PATH.write_text(build_all_topics(), encoding="utf-8")
    print(POOL_PATH)


if __name__ == "__main__":
    main()
