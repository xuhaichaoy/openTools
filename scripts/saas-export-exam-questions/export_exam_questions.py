#!/usr/bin/env python3
"""
从 SaaS 考试中提取试题导出到 xlsx
原始脚本: athena-data/从saas的考试中提取试题到xlsx.py
适配数据工坊 CLI 参数调用
"""
import argparse
import csv
import json
import os
import re
import sys
from datetime import datetime

import requests

regex = re.compile(r'<[^>]+>')


def remove_html(string):
    return regex.sub('', string)


def get_exam_questions(exam_id: str, token: str):
    url = f"https://saas-api.51cto.com/admpc/exam/exams/{exam_id}"
    headers = {
        'authorization': f"bearer {token}"
    }
    response = requests.get(url, headers=headers)
    if response.status_code != 200:
        print(f"❌ 请求失败: HTTP {response.status_code}", file=sys.stderr)
        print(f"   响应: {response.text[:200]}", file=sys.stderr)
        sys.exit(1)

    text = remove_html(response.text)
    text = text.replace("&nbsp;", " ")
    js = json.loads(text)

    if js.get("code") != 200 and js.get("code") != 0:
        print(f"❌ API 返回错误: {js.get('msg', json.dumps(js, ensure_ascii=False)[:200])}", file=sys.stderr)
        sys.exit(1)

    return js["data"]["title"], js["data"]["paper"]["questions"]


def main():
    parser = argparse.ArgumentParser(description="从 SaaS 考试中提取试题导出到 CSV")
    parser.add_argument("--exam_id", type=str, required=True, help="考试ID")
    parser.add_argument("--output_dir", type=str, default="", help="输出目录，默认为桌面")
    args = parser.parse_args()

    # token 优先从环境变量读取
    token = os.environ.get("SAAS_TOKEN", "")
    if token.startswith("bearer "):
        token = token[7:]
    if not token:
        print("❌ 未配置 SAAS_TOKEN，请在数据工坊「凭证设置」中配置", file=sys.stderr)
        sys.exit(1)

    print(f"[导出试题] 开始执行...")
    print(f"  考试ID: {args.exam_id}")

    title, questions = get_exam_questions(args.exam_id, token)

    print(f"  考试名称: {title}")
    print(f"  试题数量: {len(questions)}")

    # 确定输出路径
    output_dir = args.output_dir or os.path.expanduser("~/Desktop")
    os.makedirs(output_dir, exist_ok=True)
    date_str = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_file = os.path.join(output_dir, f"考试试题_{title}_{date_str}.csv")

    with open(output_file, 'w', newline='', encoding="utf-8-sig") as csvfile:
        writer = csv.writer(csvfile)
        writer.writerow(
            ['*题型', '*题目', '*试题分类', '*难度', '答案解析', '*正确答案',
             '*选项A', '*选项B', '选项C', '选项D', '选项E', '选项F', '选项G']
        )

        difficulty_map = {"EASY": "简单", "MIDDLE": "普通", "DIFFICULT": "困难"}
        answer_labels = ['A', 'B', 'C', 'D', 'E', 'F', 'G']

        for q in questions:
            row = []
            # 题型
            type_map = {"MULTIPLE": "多选题", "SINGLE": "单选题", "JUDGE": "判断题"}
            row.append(type_map.get(q["type"], q["type"]))
            # 题目
            row.append(q["title"])
            # 分类
            row.append(q.get("categoryFullName") or title)
            # 难度
            row.append(difficulty_map.get(q.get("difficulty", "MIDDLE"), "普通"))
            # 解析
            row.append(q.get("analysis", ""))

            # 正确答案 & 选项
            answer = []
            ops = []
            for k, op in enumerate(q.get("options", [])):
                ops.append(op["option"])
                if op.get("correct"):
                    answer.append(answer_labels[k])

            row.append(''.join(answer))
            row += ops

            writer.writerow(row)

    print(f"  输出文件: {output_file}")
    print(f"[导出试题] 执行完成 ✅ 共导出 {len(questions)} 道试题")


if __name__ == "__main__":
    main()
