from __future__ import annotations

import argparse
import re
import subprocess
import tempfile
from pathlib import Path


HEADING_RE = re.compile(r"^(#{1,6})\s+(.+)$")
BOLD_BULLET_RE = re.compile(r"^- \*\*(.+?)\*\*(：?)(.*)$")
ORDERED_RE = re.compile(r"^\s+\d+\.\s+(.+)$")
BLOCKQUOTE_RE = re.compile(r"^>\s?(.*)$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="将 Markdown 导出为 Word(docx)")
    parser.add_argument("--input", type=Path, required=True, help="输入 Markdown 文件")
    parser.add_argument("--output", type=Path, required=True, help="输出 docx 文件")
    parser.add_argument("--title", type=str, default="", help="文档标题")
    return parser.parse_args()


def rtf_escape(text: str) -> str:
    chunks: list[str] = []
    for char in text:
        code = ord(char)
        if char == "\\":
            chunks.append(r"\\")
        elif char == "{":
            chunks.append(r"\{")
        elif char == "}":
            chunks.append(r"\}")
        elif char == "\t":
            chunks.append(r"\tab ")
        elif 32 <= code <= 126:
            chunks.append(char)
        else:
            signed = code if code <= 32767 else code - 65536
            chunks.append(rf"\u{signed}?")
    return "".join(chunks)


def strip_markdown_inline(text: str) -> str:
    return re.sub(r"`(.+?)`", r"\1", text)


def bold_segments_to_rtf(text: str) -> str:
    result: list[str] = []
    parts = re.split(r"(\*\*.+?\*\*)", text)
    for part in parts:
        if not part:
            continue
        if part.startswith("**") and part.endswith("**") and len(part) >= 4:
            result.append(r"\b " + rtf_escape(part[2:-2]) + r" \b0 ")
        else:
            result.append(rtf_escape(strip_markdown_inline(part)))
    return "".join(result).strip()


def paragraph(text: str) -> str:
    return r"\pard\sa120\sl300\slmult1 " + text + r"\par"


def heading(text: str, level: int) -> str:
    size_map = {1: 40, 2: 32, 3: 28, 4: 26, 5: 24, 6: 24}
    size = size_map.get(level, 24)
    return rf"\pard\sa180\sl320\slmult1\b\fs{size} {rtf_escape(strip_markdown_inline(text))}\b0\fs24\par"


def markdown_to_rtf(markdown_text: str, title: str) -> str:
    body: list[str] = []
    if title:
        body.append(heading(title, 1))

    for raw_line in markdown_text.splitlines():
        line = raw_line.rstrip()
        if not line.strip():
            body.append(r"\pard\sa80\par")
            continue

        heading_match = HEADING_RE.match(line)
        if heading_match:
            level = min(len(heading_match.group(1)), 6)
            body.append(heading(heading_match.group(2), level))
            continue

        blockquote_match = BLOCKQUOTE_RE.match(line)
        if blockquote_match:
            body.append(r"\pard\li720\i " + bold_segments_to_rtf(blockquote_match.group(1)) + r" \i0\li0\par")
            continue

        bullet_match = BOLD_BULLET_RE.match(line)
        if bullet_match:
            label = rtf_escape(bullet_match.group(1))
            suffix = rtf_escape(bullet_match.group(2) or "")
            rest = bold_segments_to_rtf((bullet_match.group(3) or "").strip())
            if rest:
                body.append(paragraph(rf"\b {label}\b0 {suffix}{rest}"))
            else:
                body.append(paragraph(rf"\b {label}\b0 {suffix}"))
            continue

        ordered_match = ORDERED_RE.match(line)
        if ordered_match:
            content = bold_segments_to_rtf(ordered_match.group(1))
            body.append(r"\pard\li720\tx720 " + content + r"\par")
            continue

        body.append(paragraph(bold_segments_to_rtf(line.strip())))

    return (
        r"{\rtf1\ansi\ansicpg65001\deff0"
        r"{\fonttbl{\f0 PingFang SC;}{\f1 Microsoft YaHei;}{\f2 Menlo;}}"
        r"\viewkind4\uc1\pard\lang2052\f0\fs24 "
        + "".join(body)
        + "}"
    )


def convert_to_docx(source_path: Path, output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "/usr/bin/textutil",
            "-convert",
            "docx",
            str(source_path),
            "-output",
            str(output_path),
        ],
        check=True,
    )


def main() -> None:
    args = parse_args()
    markdown_text = args.input.read_text(encoding="utf-8")
    rtf_text = markdown_to_rtf(markdown_text, args.title or args.input.stem)
    with tempfile.TemporaryDirectory() as tmpdir:
        rtf_path = Path(tmpdir) / f"{args.input.stem}.rtf"
        rtf_path.write_text(rtf_text, encoding="utf-8")
        convert_to_docx(rtf_path, args.output)
    print(args.output)


if __name__ == "__main__":
    main()
