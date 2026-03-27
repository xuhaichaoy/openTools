from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path("/Users/haichao/Desktop/work/51ToolBox")
DELIVERABLE_DIR = ROOT / "deliverables" / "ai_training_course_draft" / "five_course_batch" / "generated_v2"
DELIVERABLE_DIR.mkdir(parents=True, exist_ok=True)

TOPICS_PATH = ROOT / "deliverables" / "ai_training_course_draft" / "normalized_topics.json"
CANDIDATES_PATH = ROOT / "deliverables" / "ai_training_course_draft" / "candidate_courses.json"
FIRST_TOPIC_PATH = ROOT / "deliverables" / "ai_training_course_draft" / "银行AI产品运营专项-五门课程成稿.md"

PROJECT_SCENE = {
    "AI应用开发": "企业级AI应用研发与交付",
    "AI应用解决方案": "银行业务需求转化与方案设计",
    "AI应用运营": "银行AI产品运营与价值验证",
    "AI模型算法工程化": "模型训练、评测、部署与迭代",
    "AI数据能力提升": "数据开发、架构治理与服务化建设",
    "AI能力全员赋能": "日常办公提效与跨团队协作",
}

STYLE_MAP = {
    "A": "framework",
    "B": "deliverable",
    "C": "deepdive",
    "D": "project",
    "E": "problem",
}


def sanitize(text: str) -> str:
    text = text or ""
    replacements = {
        "课程介绍：": "",
        "招标方": "项目方",
        "招标": "项目",
        "建信金科": "机构",
        "“": "",
        "”": "",
        "\"": "",
        "\t": " ",
    }
    for old, new in replacements.items():
        text = text.replace(old, new)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def topic_short(topic: str) -> str:
    cleaned = re.sub(r"（.*?）", "", topic)
    cleaned = re.split(r"[：:；。，、]", cleaned)[0].strip()
    cleaned = re.sub(r"\s+", "", cleaned)
    if len(cleaned) < 6:
        cleaned = re.sub(r"\s+", "", re.sub(r"[（）()]", "", topic))[:18]
    return cleaned[:20].rstrip("与和及")


def parse_sections(source_outline: str) -> list[dict[str, list[str] | str]]:
    sections: list[dict[str, list[str] | str]] = []
    current: dict[str, list[str] | str] | None = None
    lines = [sanitize(line.strip(" *")) for line in source_outline.splitlines() if sanitize(line.strip(" *"))]
    module_pattern = re.compile(r"^(模块[一二三四五六七八九十]+)[:：](.+)$")
    chinese_pattern = re.compile(r"^([一二三四五六七八九十]+、)(.+)$")
    chapter_pattern = re.compile(r"^(第[一二三四五六七八九十]+章)[:：](.+)$")
    day_pattern = re.compile(r"^(Day ?\d+)[:：](.+)$", re.I)
    segment_pattern = re.compile(r"^(.{2,24}(?:篇|部分|单元|专题|模块|流程|环节))[:：](.*)$")
    number_pattern = re.compile(r"^(\d+[.、])\s*(.+)$")

    if any(module_pattern.match(line) for line in lines):
        heading_patterns = [module_pattern]
    elif any(chinese_pattern.match(line) for line in lines):
        heading_patterns = [chinese_pattern]
    elif any(chapter_pattern.match(line) for line in lines):
        heading_patterns = [chapter_pattern]
    elif any(day_pattern.match(line) for line in lines):
        heading_patterns = [day_pattern]
    elif any(segment_pattern.match(line) for line in lines):
        heading_patterns = [segment_pattern]
    else:
        heading_patterns = [number_pattern]

    for line in lines:
        matched = None
        for pattern in heading_patterns:
            m = pattern.match(line)
            if m:
                if pattern is segment_pattern:
                    matched = sanitize(m.group(2)) or sanitize(re.sub(r"(篇|部分|单元|专题|模块|流程|环节)$", "", m.group(1)))
                else:
                    matched = sanitize(m.group(2))
                break
        if matched:
            current = {"title": matched, "details": []}
            sections.append(current)
            continue
        if current is not None:
            detail = sanitize(re.sub(r"^[0-9]+[.、]\s*", "", line))
            if detail:
                current["details"].append(detail)
    return sections[:6]


def detail_summary(section: dict[str, list[str] | str]) -> str:
    details: list[str] = section.get("details", [])  # type: ignore[assignment]
    if not details:
        return sanitize(section["title"])[:24]
    cleaned = []
    for item in details[:2]:
        piece = re.split(r"[；;。]", item)[0].strip()
        cleaned.append(piece)
    text = "、".join(cleaned)
    return text[:36]


def compact_focus(text: str, max_len: int = 18) -> str:
    text = sanitize(text)
    text = re.sub(r"^[0-9]+[.、]\s*", "", text)
    text = re.sub(r"^\(?[0-9]+\)?\s*", "", text)
    text = re.sub(r"^深度剖析[:：]", "", text)
    text = re.sub(r"^学习", "", text)
    text = re.sub(r"^应用AI", "AI驱动", text)
    text = re.sub(r"^AI\s*时代，", "AI时代", text)
    text = re.sub(r"（.*?）", "", text)
    text = re.sub(r"\(.*?\)", "", text)
    if "：" in text:
        left, right = text.split("：", 1)
        if 4 <= len(left) <= 18:
            text = left
        else:
            text = right
    if "，" in text and len(text) > 18:
        head, tail = text.split("，", 1)
        if 4 <= len(head) <= 18:
            text = head
        elif 4 <= len(tail) <= 18:
            text = tail
    text = re.split(r"[；。]", text)[0].strip()
    return text[:max_len].rstrip("与和及")


def course_intro_label(course_name: str) -> str:
    text = sanitize(course_name)
    text = re.sub(
        r"(工作坊|实训|实战|实战营|演练营|专项班|专项课|专题课|训练营|沙盘训练营|沙盘共创营|训练营|全景课|方法论|入门|课程)$",
        "",
        text,
    )
    text = text.rstrip("：: -")
    return compact_focus(text, 24) or compact_focus(course_name, 24)


def build_focus_items(topic: dict, sections: list[dict[str, list[str] | str]], short: str) -> list[str]:
    title_candidates: list[str] = []
    detail_candidates: list[str] = []
    for section in sections:
        title = compact_focus(str(section.get("title", "")))
        if title:
            title_candidates.append(title)
        details = list(section.get("details", []))  # type: ignore[arg-type]
        for detail in details[:2]:
            piece = compact_focus(re.split(r"[；;。]", detail)[0])
            if piece:
                detail_candidates.append(piece)

    unique: list[str] = []
    for item in title_candidates + detail_candidates:
        normalized = compact_focus(item)
        if normalized and normalized not in unique:
            unique.append(normalized)

    for fallback in [short, f"{short}关键方法", f"{short}落地应用"]:
        if fallback not in unique:
            unique.append(fallback)
    return unique[:6]


def pick_focus_triplet(focus_pool: list[str], style: str) -> tuple[str, str, str]:
    style_index_map = {
        "framework": [0, 1, 2],
        "deliverable": [1, 2, 3],
        "problem": [0, 2, 3],
        "deepdive": [2, 3, 4],
        "project": [1, 3, 4],
    }
    indexes = style_index_map[style]
    picked = []
    for idx in indexes:
        picked.append(focus_pool[idx % len(focus_pool)])
    while len(picked) < 3:
        picked.append(focus_pool[len(picked) % len(focus_pool)])
    return picked[0], picked[1], picked[2]


def trim_to_range(text: str, min_len: int = 150, max_len: int = 220) -> str:
    text = sanitize(text)
    if len(text) <= max_len:
        if text and text[-1] not in "。！？":
            text += "。"
        return text
    text = text[:max_len]
    last_punct = max(text.rfind("。"), text.rfind("；"), text.rfind("，"))
    if last_punct >= min_len - 1:
        text = text[: last_punct + 1]
    if text and text[-1] not in "。！？":
        text = text.rstrip("，； ") + "。"
    return text


def pick_variant(templates: list[str], seed: int, offset: int = 0) -> str:
    return templates[(seed + offset) % len(templates)]


CASE_LIBRARY = {
    "development": [
        ("某国有大行员工知识助手建设案例", "知识接入、向量检索、智能体编排与高可用架构之间的接口衔接"),
        ("某股份制银行投研问答平台研发案例", "多源知识入库、检索增强与复杂任务编排的实现顺序"),
        ("某城商行信贷审查助手研发案例", "业务规则嵌入、模型调用链治理与异常兜底机制"),
        ("某消费金融机构营销文案生成平台案例", "提示词治理、内容校验与服务弹性扩缩设计"),
        ("某理财子公司研究辅助应用研发案例", "知识库更新频率、工具调用权限与上线验收标准"),
    ],
    "security": [
        ("某股份制银行智能客服提示词注入防护案例", "输入过滤、系统指令隔离、工具调用白名单与输出审计"),
        ("某国有大行知识助手敏感信息泄露防控案例", "数据脱敏、权限分层、日志审计与异常追溯"),
        ("某城商行大模型外呼脚本合规巡检案例", "生成内容合规校验、违规话术识别与人工复核触发条件"),
        ("某证券机构投顾问答系统数据投毒应对案例", "知识源可信校验、版本回滚与污染样本隔离"),
        ("某金融机构模型后门排查案例", "红队测试、风险分级、修复闭环与复测门槛"),
    ],
    "ops": [
        ("某国有大行生产级知识助手运维案例", "日志追踪、故障降级、弹性扩缩与告警联动机制"),
        ("某股份制银行智能客服高峰期稳定性保障案例", "容量预估、链路监控、熔断策略与服务恢复顺序"),
        ("某城商行AIOps辅助运维案例", "事件归因、工单联动、自动化处置与人工接管边界"),
        ("某消费金融机构多模型服务运维案例", "版本切换、灰度发布、回滚预案与资源利用率优化"),
        ("某保险机构会话式应用运行监控案例", "响应时延、异常会话识别与运营问题联动排查"),
    ],
    "testing": [
        ("某消费金融机构智能审批助手测试案例", "测试集构造、回归基线、越权输出识别与风险分级"),
        ("某国有大行知识问答系统红队评测案例", "攻击样本设计、鲁棒性验证与缺陷闭环整改"),
        ("某股份制银行营销生成应用验收案例", "业务准确率、合规约束、人工复核命中率与上线阈值"),
        ("某证券机构研究助手评测案例", "事实性核验、多轮会话稳定性与知识引用准确度"),
        ("某理财子公司智能投顾助手测试案例", "用户意图覆盖、异常路径验证与体验缺陷定位"),
    ],
    "product": [
        ("某股份制银行财富管理陪伴产品设计案例", "客户分层、需求拆解、方案结构与原型优先级取舍"),
        ("某国有大行手机银行智能助手规划案例", "业务目标映射、场景边界、价值假设与路线图安排"),
        ("某城商行对公营销助手产品化案例", "行业洞察、用户旅程、需求转化与解决方案组合"),
        ("某消费金融机构贷后服务智能化案例", "客户触点重构、体验优化与合规约束前置设计"),
        ("某理财子公司投顾辅助平台创新设计案例", "场景验证、功能颗粒度与产品增长指标口径"),
    ],
    "operation": [
        ("某国有大行手机银行智能客服运营案例", "知识召回、转人工阈值、满意度波动与投诉风险联动"),
        ("某股份制银行智能营销运营案例", "触达转化、活动节奏、客群标签更新与A/B测试验证"),
        ("某城商行信贷审核助手运营案例", "规则命中率、人工复核效率与异常单据处置机制"),
        ("某消费金融机构员工助手运营案例", "活跃度提升、知识更新频率与运营台账沉淀方式"),
        ("某理财子公司投顾问答运营案例", "用户体验、内容巡检、舆情风险与持续优化闭环"),
    ],
    "analytics": [
        ("某股份制银行零售活动复盘分析案例", "指标口径统一、漏斗拆解、客群分层与经营结论输出"),
        ("某国有大行智能客服数据分析案例", "服务量、满意度、转人工率与热点问题归因"),
        ("某城商行营销活动数据诊断案例", "用户路径、转化流失点与运营策略优化依据"),
        ("某消费金融机构贷中风控分析案例", "特征波动、策略命中、业务结果关联与异常定位"),
        ("某理财子公司客户陪伴效果分析案例", "用户留存、交互频次、价值转化与运营动作评估"),
    ],
    "model": [
        ("某金融机构反欺诈模型迭代案例", "样本回流、特征漂移、评测指标与上线门槛控制"),
        ("某国有大行授信评分模型优化案例", "场景建模、误差定位、阈值调优与业务影响评估"),
        ("某股份制银行大模型微调案例", "训练数据构造、参数选择、效果验证与风险约束"),
        ("某证券机构研究生成模型部署案例", "推理延迟、算力利用、量化压缩与服务稳定性"),
        ("某消费金融机构线上反馈回流案例", "用户行为回流、误差样本标注与迭代节奏设计"),
    ],
    "data": [
        ("某银行客户数据中台治理案例", "数据分层、口径统一、服务目录与复用机制建设"),
        ("某国有大行本体建模落地案例", "语义关系设计、指标映射与知识组织结构优化"),
        ("某股份制银行标签平台建设案例", "标签定义、数据质量校验与对外服务规范"),
        ("某城商行经营分析数据架构案例", "数据集成、指标服务化与多场景复用能力"),
        ("某理财子公司数据资产盘点案例", "元数据治理、权限控制与数据价值评估机制"),
    ],
    "enablement": [
        ("某总行办公室公文助手落地案例", "提示模板、知识引用、审批留痕与使用规范"),
        ("某分行综合管理部会议纪要助手案例", "信息提炼、格式规范、敏感内容校验与协同分发"),
        ("某金融机构培训问答助手案例", "知识组织、问答质量与零代码配置边界"),
        ("某城商行员工服务智能体案例", "表单自动化、工具调用权限与使用效果评估"),
        ("某理财子公司日常办公协同助手案例", "多场景提示词模板、知识复用与使用行为沉淀"),
    ],
}


def detect_case_family(topic: dict) -> str:
    text = sanitize(topic["topic"])
    project = sanitize(topic["project"])
    if project == "AI应用开发":
        if any(keyword in text for keyword in ["安全", "合规", "隐私"]):
            return "security"
        if any(keyword in text for keyword in ["运维", "监控", "稳定", "部署"]):
            return "ops"
        if any(keyword in text for keyword in ["测试", "评估"]):
            return "testing"
        return "development"
    if project == "AI应用解决方案":
        return "product"
    if project == "AI应用运营":
        if any(keyword in text for keyword in ["数据思维", "分析", "分析框架"]):
            return "analytics"
        return "operation"
    if project == "AI模型算法工程化":
        return "model"
    if project == "AI数据能力提升":
        return "data"
    if project == "AI能力全员赋能":
        return "enablement"
    return "development"


def pick_case(topic: dict, offset: int = 0) -> tuple[str, str]:
    family = detect_case_family(topic)
    cases = CASE_LIBRARY[family]
    seq = int(topic["seq"])
    return cases[(seq + offset) % len(cases)]


STYLE_METHOD_BANK = {
    "framework": [
        "框架讲授、模块拆解与协同研讨",
        "体系化讲授、流程推演与岗位对照",
        "专题讲授、案例拆解与共创练习",
        "方法论讲授、场景拆分与分组研讨",
        "全景导入、流程拆解与结构化复盘",
    ],
    "deliverable": [
        "成果模板示范、结构化拆解与现场填制",
        "交付件逆向拆解、讲师示范与分组共创",
        "文档样例讲评、模块拆分与实操演练",
        "成果物对标、重点字段拆解与课堂讲评",
        "样板解析、结构复刻与现场修订",
    ],
    "problem": [
        "问题诊断、案例复盘与优化推演",
        "故障拆解、诊断讨论与修正演练",
        "典型问题复盘、根因分析与改进设计",
        "异常场景推演、案例讨论与优化复核",
        "问题工单解析、证据验证与改造方案讲评",
    ],
    "deepdive": [
        "专题精讲、案例比较与参数推演",
        "关键专题拆解、路径比选与深度研讨",
        "进阶讲授、案例复盘与决策推演",
        "高阶方法讲解、场景对比与优化设计",
        "难点穿透讲授、专题案例解析与方案重构",
    ],
    "project": [
        "项目沙盘、阶段答辩与角色协作",
        "拟真项目推进、里程碑评审与分工演练",
        "场景化项目实战、角色答辩与阶段复盘",
        "连续任务驱动、跨角色协同与成果评审",
        "项目化训练、节点汇报与复盘修正",
    ],
}


STYLE_FLOW_BANK = {
    "framework": [
        "全景认知搭建—关键模块拆解—角色职责校准",
        "核心框架梳理—流程链路展开—协同边界明确",
        "能力地图建立—控制节点识别—实施顺序校正",
        "模块关系识别—岗位接口梳理—治理机制归位",
        "业务主线拆分—关键任务归类—方法体系固化",
    ],
    "deliverable": [
        "成果样板识别—结构字段拆解—交付内容填制",
        "目标成果对标—模板版块拆分—评审口径统一",
        "输出结构还原—关键字段补齐—验证依据固化",
        "样板讲评对照—内容逻辑重构—成果版本修订",
        "成果框架确认—要点逐项填制—课堂评审优化",
    ],
    "problem": [
        "异常现象识别—根因路径定位—修正动作验证",
        "问题线索收集—证据链条拼接—优化顺序确定",
        "偏差表现还原—成因逐层拆解—整改闭环复核",
        "风险信号判断—关键症结锁定—验证方案设计",
        "问题工单研判—排查步骤展开—改进结果复盘",
    ],
    "deepdive": [
        "高难专题锁定—方案路径比选—边界条件判断",
        "关键参数比较—约束场景推演—优化标准明确",
        "复杂问题穿透—不同路径对照—实施代价评估",
        "专题机理拆解—组合方式分析—风险后果校验",
        "深水区难点聚焦—方案重构验证—判断依据固化",
    ],
    "project": [
        "项目启动—阶段推进—里程碑评审—复盘迭代",
        "任务分解—角色协同—过程验证—成果答辩",
        "场景导入—阶段交付—节点质询—二轮优化",
        "项目排期建立—关键决策推进—阶段复盘修正",
        "拟真任务发布—过程协同演练—终局汇报复核",
    ],
}


STYLE_INTRO_BANK = {
    "framework": [
        "课程以{flow}为授课逻辑，采用{method}的教学组织方式。围绕{joined}构建整体认知，重点讲解{focus_a}、{focus_b}与{focus_c}之间的职责边界、前后依赖和控制节点，帮助{audience}在{scene}场景下建立系统化方法框架。",
        "教学设计遵循{flow}的推进顺序，综合运用{method}。课程围绕{joined}展开，重点说明{focus_a}如何衔接{focus_b}与{focus_c}，以及各环节对{scene}实施质量、评审效率和协同节奏的影响，帮助{audience}形成全局判断。",
        "本课程按{flow}组织内容，采用{method}的授课形式。课程以{joined}为主线，重点解析{focus_a}、{focus_b}和{focus_c}在业务推进中的定位分工与治理要求，帮助{audience}形成结构清晰、标准统一的工作认知。",
        "授课安排以{flow}为主轴，结合{method}展开。课程围绕{joined}逐层搭建知识框架，重点校准{focus_a}、{focus_b}与{focus_c}的衔接关系、关键节点与常见失效点，帮助{audience}提升框架化理解与协同效率。",
        "课程采用{method}，并按照{flow}逐步推进。围绕{joined}，课程重点梳理{focus_a}、{focus_b}和{focus_c}对{scene}交付质量与治理效果的作用机制，帮助{audience}建立可迁移的认知主线。",
    ],
    "deliverable": [
        "课程以{flow}为教学逻辑，采用{method}。围绕{joined}拆解成果物结构，重点讲解{focus_a}、{focus_b}与{focus_c}如何沉淀为模板字段、表达顺序和评审依据，帮助{audience}形成可直接应用的交付输出能力。",
        "教学组织按照{flow}展开，综合运用{method}。课程围绕{joined}组织学习，重点说明{focus_a}、{focus_b}和{focus_c}在方案成型、内容呈现和落地验证中的对应关系，帮助{audience}提高成果物质量与评审通过率。",
        "本课程采用{method}的授课方式，并以{flow}作为推进主线。围绕{joined}，课程重点拆分{focus_a}、{focus_b}与{focus_c}对应的结构版块、关键字段和风险提示，帮助{audience}把方法快速转化为正式材料。",
        "课程按照{flow}设计教学环节，采用{method}开展训练。围绕{joined}，重点解析{focus_a}、{focus_b}和{focus_c}如何落实到方案、原型或操作稿的内容框架与验证口径之中，强化{audience}的结构化表达能力。",
        "授课内容围绕{flow}展开，结合{method}实施。课程聚焦{joined}，重点梳理{focus_a}、{focus_b}与{focus_c}在成果组织、呈现逻辑和课堂评审中的应用方法，帮助{audience}建立可复用的输出规范。",
    ],
    "problem": [
        "课程以{flow}为主线，采用{method}。围绕{joined}设置诊断场景，重点讲解{focus_a}、{focus_b}与{focus_c}相关异常的识别方式、排查路径和修正顺序，帮助{audience}建立可验证、可复盘的问题处置方法。",
        "教学安排遵循{flow}，综合运用{method}。课程围绕{joined}组织问题推演，重点说明{focus_a}、{focus_b}和{focus_c}在结果偏差出现时的症结定位、证据判断和优化动作设计，提升{audience}的诊断效率。",
        "本课程采用{method}的教学方式，并按照{flow}逐层推进。围绕{joined}，课程重点还原{focus_a}、{focus_b}与{focus_c}导致结果失真或推进受阻的典型原因，帮助{audience}形成系统化排查思路。",
        "课程围绕{flow}组织讲授与演练，采用{method}展开。聚焦{joined}，重点分析{focus_a}、{focus_b}和{focus_c}在偏差场景中的影响链条、验证方法和整改闭环，帮助{audience}提升问题识别与修正能力。",
        "授课设计以{flow}为推进路径，结合{method}实施。课程围绕{joined}展开复盘训练，重点讲清{focus_a}、{focus_b}与{focus_c}对应的风险信号、排查步骤和改进优先级，帮助{audience}沉淀稳定的问题处理机制。",
    ],
    "deepdive": [
        "课程以{flow}为授课逻辑，采用{method}。围绕{joined}中的高难专题展开深化训练，重点剖析{focus_a}、{focus_b}与{focus_c}在复杂约束下的适用边界、取舍逻辑和验证标准，适合{audience}开展专项突破。",
        "教学内容按照{flow}逐层递进，综合运用{method}。课程围绕{joined}组织专题攻坚，重点比较{focus_a}、{focus_b}和{focus_c}在不同业务条件下的实施代价、风险后果和优化空间，提升{audience}的专业判断深度。",
        "本课程采用{method}，并以{flow}作为推进主线。围绕{joined}，课程重点讲清{focus_a}、{focus_b}与{focus_c}在复杂场景中的组合方式、约束关系和治理要求，帮助{audience}从经验判断走向方法判断。",
        "课程以{flow}为专题推进顺序，结合{method}展开。围绕{joined}，重点分析{focus_a}、{focus_b}和{focus_c}在高难应用中的关键参数、边界条件与成败因素，帮助{audience}增强专项攻关能力。",
        "授课设计围绕{flow}组织，采用{method}实施。课程聚焦{joined}，重点拆解{focus_a}、{focus_b}与{focus_c}对应的机理差异、方案路径和验证口径，帮助{audience}形成更稳健的进阶方法体系。",
    ],
    "project": [
        "课程以{flow}为授课主线，采用{method}。围绕{joined}设置连续任务与阶段评审，重点引导{audience}在推进{focus_a}、{focus_b}和{focus_c}的过程中同步完成分工协作、过程验证与成果汇报，形成完整实施闭环。",
        "教学组织按照{flow}展开，综合运用{method}。课程围绕{joined}构建拟真项目场景，重点检验{focus_a}、{focus_b}与{focus_c}在真实推进节奏中的执行顺序、协同机制与风险应对，提升{audience}的综合落地能力。",
        "本课程采用{method}的方式开展，并以{flow}串联全程。围绕{joined}，课程重点让{audience}在处理{focus_a}、{focus_b}和{focus_c}时兼顾资源分配、节点答辩和阶段复盘，强化项目推进能力。",
        "课程围绕{flow}组织项目化训练，采用{method}展开。以{joined}为任务链条，重点呈现{focus_a}、{focus_b}与{focus_c}如何在同一项目周期内形成联动，帮助{audience}把方法理解沉淀为可执行方案。",
        "授课设计以{flow}为推进节奏，结合{method}实施。课程围绕{joined}设置阶段交付与答辩环节，重点训练{audience}在推进{focus_a}、{focus_b}和{focus_c}时的取舍判断、协同表达和复盘修正能力。",
    ],
}


STYLE_TOPIC_OPENERS = {
    "framework": [
        "{short}聚焦{scene}中的组织与实施要求，课程通过{method}搭建整体认知。",
        "{short}对应{audience}在{scene}中的协同与治理任务，课程采用{method}组织教学。",
        "{short}面向真实业务链路中的职责划分与实施安排，课程以{method}展开系统讲解。",
        "{short}围绕关键职责、控制节点与治理要求，课程通过{method}建立整体框架。",
        "{short}结合{scene}的实际推进场景，课程采用{method}开展训练。",
    ],
    "deliverable": [
        "{short}围绕成果物输出与评审应用，课程采用{method}组织训练。",
        "{short}对应{scene}中的正式交付要求，课程通过{method}展开成果导向教学。",
        "{short}聚焦从方法理解到正式交付的转换过程，课程采用{method}推进课堂训练。",
        "{short}面向{audience}在{scene}中的成果表达与评审需求，课程以{method}搭建教学过程。",
        "{short}对应方案、原型或操作稿输出任务，课程通过{method}组织内容。",
    ],
    "problem": [
        "{short}针对推进中的常见偏差与异常场景，课程采用{method}展开诊断训练。",
        "{short}围绕{scene}中的高频问题与返工情形，课程通过{method}组织复盘。",
        "{short}聚焦实施过程中易出现的断点、偏差与失效风险，课程采用{method}推进教学。",
        "{short}面向{audience}在{scene}中处理异常时的真实需求，课程以{method}开展训练。",
        "{short}围绕问题识别、根因定位与修正动作，课程通过{method}建立分析路径。",
    ],
    "deepdive": [
        "{short}聚焦主题中的高难专题，课程采用{method}开展进阶训练。",
        "{short}针对{scene}中的复杂约束与专业难点，课程通过{method}组织深化学习。",
        "{short}围绕复杂场景下的关键取舍与技术边界，课程采用{method}展开讲解。",
        "{short}面向{audience}在{scene}中承担的专项攻关任务，课程以{method}推进高阶训练。",
        "{short}围绕复杂机理、关键参数与治理要求，课程通过{method}开展专题深化。",
    ],
    "project": [
        "{short}围绕真实推进场景，课程采用{method}组织项目化训练。",
        "{short}结合{scene}中的典型项目任务，课程通过{method}还原整体推进过程。",
        "{short}面向阶段交付与跨角色协同要求，课程采用{method}开展全流程演练。",
        "{short}对应{audience}在{scene}中的项目推进任务，课程以{method}搭建拟真场景。",
        "{short}针对从启动到复盘的完整链路，课程通过{method}组织连续任务训练。",
    ],
}


STYLE_TOPIC_BODIES = {
    "framework": [
        "课程以{focus_a}为切入口，延展到{focus_b}与{focus_c}，重点讲解模块衔接、职责边界和关键控制节点。",
        "内容围绕{focus_a}、{focus_b}和{focus_c}展开，重点说明三者在业务链路中的前后依赖、评审节点与治理关系。",
        "课堂将{focus_a}、{focus_b}与{focus_c}置于同一框架中解析，重点校准角色分工、协同接口和实施顺序。",
        "课程围绕{focus_a}、{focus_b}和{focus_c}逐层展开，重点梳理各模块对实施质量、治理效果和协同效率的作用机制。",
    ],
    "deliverable": [
        "课程围绕{focus_a}、{focus_b}与{focus_c}拆解成果结构，重点讲清模板字段、表达顺序和评审依据的设置方法。",
        "内容以{focus_a}、{focus_b}和{focus_c}为主线，重点说明各项内容如何转化为方案版块、关键字段和验证口径。",
        "课堂将{focus_a}、{focus_b}与{focus_c}落实到成果物设计中，重点解析版块组织、风险提示和讲评标准。",
        "课程围绕{focus_a}、{focus_b}和{focus_c}展开，重点强化内容组织、成果呈现和落地验证之间的对应关系。",
    ],
    "problem": [
        "课程围绕{focus_a}、{focus_b}与{focus_c}设置排查链路，重点讲解异常识别、证据判断和修正动作的展开顺序。",
        "内容以{focus_a}、{focus_b}和{focus_c}为诊断主线，重点说明结果偏差、过程断点和整改闭环之间的关系。",
        "课堂将{focus_a}、{focus_b}与{focus_c}纳入同一张问题图谱，重点解析根因定位、验证方法和优先级判断。",
        "课程围绕{focus_a}、{focus_b}和{focus_c}组织复盘，重点梳理风险信号、排查步骤和改进路径的设计方法。",
    ],
    "deepdive": [
        "课程围绕{focus_a}、{focus_b}与{focus_c}展开专题比较，重点剖析适用边界、取舍逻辑和验证标准。",
        "内容聚焦{focus_a}、{focus_b}和{focus_c}，重点说明不同路径在复杂约束下的代价、风险与优化空间。",
        "课堂将{focus_a}、{focus_b}与{focus_c}置于复杂场景中反复比对，重点讲清组合方式、边界条件和治理要求。",
        "课程围绕{focus_a}、{focus_b}和{focus_c}深入展开，重点强化关键参数、机理差异和方案重构方法。",
    ],
    "project": [
        "课程将{focus_a}、{focus_b}与{focus_c}嵌入阶段任务，重点训练分工协作、过程验证和节点答辩的推进能力。",
        "内容围绕{focus_a}、{focus_b}和{focus_c}设置连续任务，重点检验执行顺序、协同机制和风险应对安排。",
        "课堂以{focus_a}、{focus_b}与{focus_c}为任务链条，重点训练阶段交付、角色协同和成果汇报能力。",
        "课程围绕{focus_a}、{focus_b}和{focus_c}开展项目演练，重点强化资源取舍、过程复盘和终局优化能力。",
    ],
}


STYLE_TOPIC_ENDINGS = {
    "framework": [
        "训练完成后，{audience}可形成更清晰的认知主线和统一工作口径。",
        "有助于{audience}在{scene}中建立系统化理解并提升跨团队协同效率。",
        "帮助{audience}把零散经验转化为可迁移的方法框架。",
    ],
    "deliverable": [
        "有助于{audience}提升成果物质量、评审效率和正式交付能力。",
        "帮助{audience}建立更稳定的结构化表达和评审应对能力。",
        "训练完成后，{audience}可沉淀更清晰的成果模板与输出规范。",
    ],
    "problem": [
        "有助于{audience}提升问题识别效率、修正命中率和复盘沉淀能力。",
        "帮助{audience}建立更稳定的诊断思路与优化闭环。",
        "训练完成后，{audience}可形成可复用的问题排查与整改机制。",
    ],
    "deepdive": [
        "有助于{audience}提升复杂场景下的专业判断与专题攻关能力。",
        "帮助{audience}形成更稳健的进阶方法体系和取舍标准。",
        "训练完成后，{audience}可对高难议题形成更清楚的边界判断。",
    ],
    "project": [
        "有助于{audience}提升真实推进节奏下的综合落地能力。",
        "帮助{audience}把方法理解沉淀为可执行、可答辩、可复盘的项目方案。",
        "训练完成后，{audience}可形成更完整的项目推进与协同表达能力。",
    ],
}


def build_intro(topic: dict, style: str, course_idx: int | None = None, course_name: str | None = None) -> str:
    topic_label = topic_short(topic["topic"])
    short = course_intro_label(course_name) if course_name else topic_label
    scene = PROJECT_SCENE.get(topic["project"], "金融科技业务")
    sections = parse_sections(topic["source_outline"])
    focus_pool = build_focus_items(topic, sections, topic_label)
    focus_a, focus_b, focus_c = pick_focus_triplet(focus_pool, style)
    audience = sanitize(topic["audience"])
    seed = int(topic["seq"]) + (course_idx or 0) * 3
    method = pick_variant(STYLE_METHOD_BANK[style], seed)
    opener = pick_variant(STYLE_TOPIC_OPENERS[style], seed, 1)
    body = pick_variant(STYLE_TOPIC_BODIES[style], seed, 2)
    ending = pick_variant(STYLE_TOPIC_ENDINGS[style], seed, 3)
    return trim_to_range(
        " ".join(
            [
                opener.format(
                    short=short,
                    audience=audience,
                    scene=scene,
                    method=method,
                ),
                body.format(
                    focus_a=focus_a,
                    focus_b=focus_b,
                    focus_c=focus_c,
                ),
                ending.format(
                    audience=audience,
                    scene=scene,
                ),
            ]
        ).strip()
    )


def split_pipe(text: str) -> list[str]:
    return [sanitize(part) for part in text.split("|") if sanitize(part)]


def build_outputs(project: str, style: str, existing: list[str], short: str) -> list[str]:
    if existing:
        return existing[:3]
    generated = {
        "AI应用开发": [f"{short}实施路线图", f"{short}架构与集成草图", "风险与质量检查清单"],
        "AI应用解决方案": [f"{short}需求转化表", f"{short}解决方案草图", "原型与评审纪要"],
        "AI应用运营": [f"{short}运营方案包", "监控与优化动作清单", "复盘与风险处置记录"],
        "AI模型算法工程化": [f"{short}工程方案", "评测与优化记录", "上线迭代路线图"],
        "AI数据能力提升": [f"{short}数据架构方案", "数据质量与安全清单", "服务化落地路径图"],
        "AI能力全员赋能": [f"{short}个人应用场景卡", "团队协作提示模板", "提效实践清单"],
    }
    return generated.get(project, [f"{short}成果清单", "实施步骤说明", "复盘纪要"])[:3]


def build_new_course_name(topic: dict) -> str:
    short = topic_short(topic["topic"])
    suffix = {
        "AI应用开发": "落地难点诊断与优化实战营",
        "AI应用解决方案": "需求误区诊断与方案优化工作坊",
        "AI应用运营": "关键问题诊断与优化闭环实战营",
        "AI模型算法工程化": "关键瓶颈诊断与工程优化实战营",
        "AI数据能力提升": "关键卡点诊断与治理优化实战营",
        "AI能力全员赋能": "应用误区排障与提效实践营",
    }
    return f"{short}{suffix.get(topic['project'], '关键问题诊断与优化实战营')}"


def build_seminars(topic: dict, style: str) -> list[str]:
    short = topic_short(topic["topic"])
    sections = parse_sections(topic["source_outline"])
    focus_pool = build_focus_items(topic, sections, short)
    first, second, third = pick_focus_triplet(focus_pool, style)
    case_a_name, case_a_focus = pick_case(topic, 0)
    case_b_name, case_b_focus = pick_case(topic, 1)
    if style == "framework":
        return [
            f"案例分析：以{case_a_name}为样本，重点分析{case_a_focus}，并对应梳理{first}、{second}与{third}在实施链路中的衔接关系和控制节点。",
            f"小组讨论：围绕课堂主题在真实业务中的落地路径，分组梳理{first}与{second}之间的职责接口、前后依赖和常见失效点，形成方法地图。",
            f"互动演练：以课堂给定场景为对象，现场完成框架图、岗位分工表和优先级排序，并接受讲师讲评。",
        ]
    if style == "deliverable":
        return [
            f"案例分析：以{case_a_name}为对象，重点分析{case_a_focus}，提炼{first}、{second}对应的方案结构、关键字段和评审口径。",
            f"实战演练：围绕课堂主题核心任务，现场输出与{first}相关的方案草图、模板样例或操作清单，并明确验证依据。",
            f"互动演练：组织课堂评审，逐项补齐交付物中的风险点、遗漏项和优化动作，形成可复用成果版本。",
        ]
    if style == "deepdive":
        return [
            f"案例分析：围绕{case_a_name}开展专题拆解，重点分析{case_a_focus}，并识别{first}与{second}在复杂场景中的取舍逻辑和瓶颈位置。",
            f"小组讨论：结合{case_b_name}，讨论{third}在不同技术路径或方法路径下的适用边界、成本收益和实施前提。",
            f"实战演练：输出一份专题优化方案，明确改造动作、验证指标、潜在风险和复盘节点。",
        ]
    if style == "project":
        return [
            f"案例导入：以{case_a_name}为项目背景，重点分析{case_a_focus}，明确{first}、{second}和{third}在项目推进中的阶段目标与验收要求。",
            f"项目实战：把{short}拆成阶段任务推进，分轮完成需求澄清、方案设计、过程验证和成果答辩，沉淀阶段记录。",
            f"角色扮演：模拟业务、产品、研发、运营或管理角色开展联席评审，现场确认分工、节奏和风险应对安排。",
        ]
    return [
        f"案例分析：复盘{case_a_name}，重点分析{case_a_focus}，并从{first}、{second}入手定位导致结果偏差的关键原因。",
        f"实战演练：围绕课堂给定问题搭建排查路径，完成原因拆解、验证顺序编排和优化动作设计，形成问题清单与修正方案。",
        f"小组讨论：结合{case_b_name}中的处置经验，讨论{third}高频卡点如何兼顾实施效率、风险控制和复盘留痕，输出改进优先级。",
    ]


def build_highlights(topic: dict, style: str, course_idx: int | None = None) -> list[str]:
    short = topic_short(topic["topic"])
    audience = sanitize(topic["audience"])
    scene = PROJECT_SCENE.get(topic["project"], "金融科技业务")
    seed = int(topic["seq"]) + (course_idx or 0) * 5
    mapping = {
        "framework": [
            [
                f"体系认知清晰：通过框架讲授与案例拆解，将相关模块关系、岗位接口和控制节点置于同一视图，便于{audience}快速建立整体认知。",
                f"岗位转化直接：课程形成的方法地图和分工要点可直接应用于{scene}中的方案讨论、项目启动和跨团队协同。",
            ],
            [
                f"结构主线明确：课程以系统框架为骨架组织内容，重点呈现关键模块之间的前后依赖与决策逻辑，降低学习碎片化风险。",
                f"协同价值突出：围绕{scene}设置角色接口和评审节点，能够帮助{audience}统一口径、减少沟通偏差并提升协作效率。",
            ],
        ],
        "deliverable": [
            [
                f"成果导向鲜明：课程围绕模板、字段和评审标准组织讲授与演练，帮助{audience}把方法快速沉淀为可提交、可评审的正式材料。",
                f"复用价值较高：课堂形成的方案草图、模板样例和讲评记录可直接服务于{scene}中的立项、汇报和交接场景。",
            ],
            [
                f"交付逻辑可视：课程对成果结构、内容顺序和验证依据逐项拆解，有助于{audience}减少返工和评审遗漏。",
                f"表达标准统一：通过样板讲评和现场修订，课程能够提升{scene}场景下的方案表达清晰度与评审通过率。",
            ],
        ],
        "deepdive": [
            [
                f"专题深度突出：课程聚焦主题中的高难环节，系统比较关键参数、取舍逻辑与边界条件，更适合{audience}开展专项强化。",
                f"判断依据扎实：通过案例比较和专题推演，课程帮助学员在{scene}中形成可说明、可验证的专业判断标准。",
            ],
            [
                f"难点拆解到位：课程围绕复杂场景中的关键问题展开深度拆分，能够帮助{audience}识别真正影响结果的核心变量。",
                f"方法升级明显：通过比选、复盘与方案重构，课程可提升{scene}场景下专项攻关与复杂决策的把控能力。",
            ],
        ],
        "project": [
            [
                f"项目链路完整：课程通过阶段任务、里程碑评审和角色协作还原真实推进节奏，能够系统检验{audience}的综合落地能力。",
                f"成果沉淀明确：课堂形成的阶段成果包、答辩材料和推进记录可直接服务于{scene}中的项目启动与阶段复盘。",
            ],
            [
                f"实战氛围充分：课程将课堂主题放入动态业务场景，通过连续任务和事件触发强化学员的判断、修正与表达能力。",
                f"预演价值明显：对于{scene}团队而言，该课程既是学习过程，也是一次低风险的项目演练，可提前暴露协同断点与执行风险。",
            ],
        ],
        "problem": [
            [
                f"问题链路完整：课程从异常信号、证据验证到整改复盘构建完整诊断流程，能够帮助{audience}提升问题定位效率与优化命中率。",
                f"改进方向明确：围绕{scene}中的高频偏差场景设计训练，有助于团队沉淀更可复用的排查模板与修正机制。",
            ],
            [
                f"风险识别前置：课程突出{short}中的异常征兆、证据链条与优先级判断，帮助{audience}更早发现关键问题。",
                f"优化闭环清楚：通过连续推演症结、验证和修正动作，课程能够减少{scene}中的试错成本并强化复盘机制。",
            ],
        ],
    }
    variants = mapping[style]
    return variants[seed % len(variants)]


def build_applicability(topic: dict, style: str, existing: str) -> str:
    if existing:
        text = sanitize(existing).replace("机构级", "组织级").replace("机构内部", "团队内部")
        return text
    short = topic_short(topic["topic"])
    audience = sanitize(topic["audience"])
    scene = PROJECT_SCENE.get(topic["project"], "金融科技业务")
    tail = {
        "framework": "有助于建立统一方法框架和沟通口径。",
        "deliverable": "有助于提升文档质量、交付效率和评审通过率。",
        "deepdive": "有助于支撑专项攻关、体系升级和关键能力突破。",
        "project": "有助于检验综合能力，并沉淀可复用的项目模板。",
        "problem": "有助于缩短问题定位周期，提升持续优化效率。",
    }[style]
    return f"内容贴合{scene}场景下的真实工作要求，适合{audience}围绕课堂主题建立可迁移的方法、协同节奏与成果沉淀方式，{tail}"


def build_coverage(topic: dict) -> list[str]:
    sections = parse_sections(topic["source_outline"])
    if not sections:
        return [f"已覆盖{topic_short(topic['topic'])}对应的培训目标与课程模块，并形成从认知、方法到实操的完整闭环。"]
    items = []
    for section in sections:
        title = sanitize(section["title"])
        items.append(f"已覆盖{title}相关方法、实操要求与落地要点。")
    return items


def render_course(topic: dict, course_name: str, intro: str, outputs: list[str], seminars: list[str], highlights: list[str], applicability: str, coverage: list[str], idx: int) -> list[str]:
    lines = [
        f"#### 课程{idx}：{course_name}",
        "",
        f"- **课程主题**：{course_name}",
        f"- **课程介绍**：{intro}",
        "- **课程产出**：",
    ]
    for i, item in enumerate(outputs, 1):
        lines.append(f"  {i}. {sanitize(item)}")
    lines.append("- **课程研讨安排**：")
    for i, item in enumerate(seminars, 1):
        lines.append(f"  {i}. {sanitize(item)}")
    lines.append("- **课程亮点**：")
    for i, item in enumerate(highlights, 1):
        lines.append(f"  {i}. {sanitize(item)}")
    lines.append(f"- **适用性和价值度**：{sanitize(applicability)}")
    lines.append("- **覆盖确认**：")
    for i, item in enumerate(coverage, 1):
        lines.append(f"  {i}. {sanitize(item)}")
    lines.append("")
    return lines


def load_data():
    topics = [item for item in json.loads(TOPICS_PATH.read_text()) if item["seq"] != 13]
    topics.sort(key=lambda x: x["seq"])
    candidates = json.loads(CANDIDATES_PATH.read_text())
    grouped: dict[int, dict[str, dict]] = {}
    for item in candidates:
        grouped.setdefault(int(item["seq"]), {})[item["option_type"]] = item
    return topics, grouped


def build_topic_file(topic: dict, candidate_group: dict[str, dict]) -> str:
    lines = [
        f"# 主题{topic['seq']}：{topic['topic']}",
        "",
        f"- **项目类别**：{sanitize(topic['project'])}",
        f"- **授课对象**：{sanitize(topic['audience'])}",
        f"- **培训目标**：{sanitize(topic['objective'])}",
        "",
    ]

    option_order = ["A", "B", "C", "D", "E"]
    for idx, option_type in enumerate(option_order, 1):
        if option_type == "E":
            course_name = build_new_course_name(topic)
            style = STYLE_MAP[option_type]
            existing_outputs: list[str] = []
            existing_applicability = ""
        else:
            option = candidate_group[option_type]
            course_name = sanitize(option["course_name"])
            style = STYLE_MAP[option_type]
            existing_outputs = split_pipe(option.get("course_outputs", ""))
            existing_applicability = option.get("applicability_value", "")
        lines.extend(
            render_course(
                topic=topic,
                course_name=course_name,
                intro=build_intro(topic, style, idx, course_name),
                outputs=build_outputs(topic["project"], style, existing_outputs, topic_short(topic["topic"])),
                seminars=build_seminars(topic, style),
                highlights=build_highlights(topic, style, idx),
                applicability=build_applicability(topic, style, existing_applicability),
                coverage=build_coverage(topic),
                idx=idx,
            )
        )
    return "\n".join(lines).rstrip() + "\n"


def main() -> None:
    topics, grouped = load_data()
    master_lines = [
        "# AI培训课程需求剩余27主题五门课程成稿",
        "",
        "> 说明：本稿覆盖除已完成主题13外的剩余27个课程主题。每个主题均提供5门完整候选课程，并保持课程主题、课程介绍、课程产出、课程研讨安排、课程亮点、适用性和价值度、覆盖确认 7 项结构。",
        "",
    ]

    for topic in topics:
        content = build_topic_file(topic, grouped[int(topic["seq"])])
        slug = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]+", "-", topic_short(topic["topic"])).strip("-")
        (DELIVERABLE_DIR / f"topic_{topic['seq']:02d}_{slug}_五门课程成稿.md").write_text(content)
        master_lines.append(content.rstrip())
        master_lines.append("")

    remaining_path = DELIVERABLE_DIR / "AI培训课程需求-剩余27主题-五门课程成稿.md"
    remaining_path.write_text("\n".join(master_lines).rstrip() + "\n")

    full_path = DELIVERABLE_DIR / "AI培训课程需求-全28主题-五门课程成稿.md"
    full_path.write_text(
        "\n".join(master_lines).rstrip()
        + "\n\n---\n\n"
        + FIRST_TOPIC_PATH.read_text().strip()
        + "\n"
    )

    print(remaining_path)
    print(full_path)


if __name__ == "__main__":
    main()
