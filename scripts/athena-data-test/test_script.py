#!/usr/bin/env python3
"""
数据工坊测试脚本 — 验证 athena-data 接入流程
支持 --key=value 形式的命令行参数
"""
import argparse
import json
import os
import sys
from datetime import datetime


def main():
    parser = argparse.ArgumentParser(description="数据工坊测试脚本")
    parser.add_argument("--query", type=str, default="test", help="查询关键词")
    parser.add_argument("--limit", type=int, default=10, help="返回条数")
    parser.add_argument("--format", type=str, default="json", choices=["json", "text"], help="输出格式")
    args = parser.parse_args()

    print(f"[数据工坊测试] 开始执行...")
    print(f"  查询: {args.query}")
    print(f"  限制: {args.limit}")
    print(f"  格式: {args.format}")
    print(f"  时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print()

    # 检查环境变量中的凭证（模拟真实脚本行为）
    saas_token = os.environ.get("SAAS_TOKEN", "")
    archery_cookie = os.environ.get("ARCHERY_COOKIE", "")
    print(f"  SAAS_TOKEN: {'已配置 ✅' if saas_token else '未配置 ⚠️'}")
    print(f"  ARCHERY_COOKIE: {'已配置 ✅' if archery_cookie else '未配置 ⚠️'}")
    print()

    # 模拟数据查询结果
    mock_results = []
    for i in range(min(args.limit, 5)):
        mock_results.append({
            "id": i + 1,
            "name": f"测试数据_{args.query}_{i+1}",
            "score": 80 + i * 3,
            "status": "完成"
        })

    if args.format == "json":
        print(json.dumps({"total": len(mock_results), "data": mock_results}, ensure_ascii=False, indent=2))
    else:
        print(f"共 {len(mock_results)} 条结果:")
        for r in mock_results:
            print(f"  [{r['id']}] {r['name']} - 得分: {r['score']} - {r['status']}")

    print()
    print("[数据工坊测试] 执行完成 ✅")


if __name__ == "__main__":
    main()
