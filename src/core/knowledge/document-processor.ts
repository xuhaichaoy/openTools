/**
 * DocumentProcessor — 统一文档处理流水线
 *
 * 灵感来源：Yuxi-Know 的 DocumentProcessorFactory + 多解析器架构
 *
 * 支持多格式文档解析：
 * - PDF → 文本提取（通过 Rust 端 pdf-extract 或 OCR）
 * - Word (.docx) → 结构化文本
 * - Markdown → 直接解析
 * - 图片 → OCR 识别（通过 Rust 端 OCR 或 LLM Vision）
 * - Excel → 表格数据提取（通过 Rust 端 calamine）
 * - 纯文本 → 直接读取
 *
 * 采用工厂 + 策略模式，可灵活注册新的解析器。
 */

import { invoke } from "@tauri-apps/api/core";

export interface ParsedDocument {
  /** 原始文件路径 */
  filePath: string;
  /** 文档标题（从内容中推断或使用文件名） */
  title: string;
  /** 提取的纯文本内容 */
  content: string;
  /** 文档格式 */
  format: DocumentFormat;
  /** 元数据 */
  metadata: Record<string, unknown>;
  /** 页数（PDF/Word） */
  pageCount?: number;
  /** 解析耗时 (ms) */
  parseTimeMs: number;
}

export type DocumentFormat = "pdf" | "docx" | "markdown" | "image" | "excel" | "text" | "html" | "csv";

export interface DocumentParser {
  name: string;
  supportedFormats: DocumentFormat[];
  parse(input: DocumentInput): Promise<ParsedDocument>;
}

export interface DocumentInput {
  filePath: string;
  /** Pre-loaded content (for text-based formats) */
  content?: string;
  /** Binary content (for binary formats) */
  binary?: Uint8Array;
  format: DocumentFormat;
}

const FORMAT_EXTENSIONS: Record<string, DocumentFormat> = {
  ".pdf": "pdf",
  ".docx": "docx",
  ".doc": "docx",
  ".md": "markdown",
  ".mdx": "markdown",
  ".markdown": "markdown",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".gif": "image",
  ".webp": "image",
  ".bmp": "image",
  ".xlsx": "excel",
  ".xls": "excel",
  ".csv": "csv",
  ".html": "html",
  ".htm": "html",
  ".txt": "text",
  ".log": "text",
  ".json": "text",
  ".xml": "text",
  ".yaml": "text",
  ".yml": "text",
  ".toml": "text",
};

export function detectDocumentFormat(filePath: string): DocumentFormat | undefined {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return FORMAT_EXTENSIONS[ext];
}

// ── Built-in Parsers ──

class MarkdownParser implements DocumentParser {
  name = "markdown";
  supportedFormats: DocumentFormat[] = ["markdown", "text"];

  async parse(input: DocumentInput): Promise<ParsedDocument> {
    const start = Date.now();
    let content = input.content ?? "";

    if (!content && input.filePath) {
      try {
        content = await invoke<string>("read_text_file", { path: input.filePath });
      } catch {
        throw new Error(`Failed to read file: ${input.filePath}`);
      }
    }

    const titleMatch = content.match(/^#\s+(.+)$/m);
    const title = titleMatch?.[1] ?? input.filePath.split("/").pop() ?? "Untitled";

    return {
      filePath: input.filePath,
      title,
      content,
      format: input.format,
      metadata: { wordCount: content.split(/\s+/).length },
      parseTimeMs: Date.now() - start,
    };
  }
}

class PdfParser implements DocumentParser {
  name = "pdf";
  supportedFormats: DocumentFormat[] = ["pdf"];

  async parse(input: DocumentInput): Promise<ParsedDocument> {
    const start = Date.now();

    try {
      const result = await invoke<{ text: string; pages: number; metadata: Record<string, unknown> }>(
        "parse_pdf",
        { path: input.filePath },
      );
      return {
        filePath: input.filePath,
        title: (result.metadata.title as string) ?? input.filePath.split("/").pop() ?? "PDF Document",
        content: result.text,
        format: "pdf",
        metadata: result.metadata,
        pageCount: result.pages,
        parseTimeMs: Date.now() - start,
      };
    } catch {
      throw new Error(`PDF parsing failed for ${input.filePath}. Ensure Rust pdf-extract backend is available.`);
    }
  }
}

class ExcelParser implements DocumentParser {
  name = "excel";
  supportedFormats: DocumentFormat[] = ["excel", "csv"];

  async parse(input: DocumentInput): Promise<ParsedDocument> {
    const start = Date.now();

    try {
      const result = await invoke<{ sheets: Array<{ name: string; rows: string[][] }> }>(
        "parse_excel",
        { path: input.filePath },
      );

      const content = result.sheets.map((sheet) => {
        const header = `## ${sheet.name}\n`;
        const table = sheet.rows.map((row) => row.join("\t")).join("\n");
        return header + table;
      }).join("\n\n");

      return {
        filePath: input.filePath,
        title: input.filePath.split("/").pop() ?? "Spreadsheet",
        content,
        format: input.format,
        metadata: { sheetCount: result.sheets.length },
        parseTimeMs: Date.now() - start,
      };
    } catch {
      // Fallback: try reading as CSV text
      if (input.format === "csv" || input.filePath.endsWith(".csv")) {
        const text = input.content ?? await invoke<string>("read_text_file", { path: input.filePath }).catch(() => "");
        return {
          filePath: input.filePath,
          title: input.filePath.split("/").pop() ?? "CSV",
          content: text,
          format: "csv",
          metadata: {},
          parseTimeMs: Date.now() - start,
        };
      }
      throw new Error(`Excel parsing failed for ${input.filePath}. Ensure Rust calamine backend is available.`);
    }
  }
}

class ImageParser implements DocumentParser {
  name = "image-ocr";
  supportedFormats: DocumentFormat[] = ["image"];

  async parse(input: DocumentInput): Promise<ParsedDocument> {
    const start = Date.now();

    try {
      const result = await invoke<{ text: string; confidence: number }>(
        "ocr_image",
        { path: input.filePath },
      );
      return {
        filePath: input.filePath,
        title: input.filePath.split("/").pop() ?? "Image",
        content: result.text,
        format: "image",
        metadata: { ocrConfidence: result.confidence },
        parseTimeMs: Date.now() - start,
      };
    } catch {
      // Fallback: try LLM Vision
      try {
        const { getMToolsAI } = await import("@/core/ai/mtools-ai");
        const ai = getMToolsAI();
        const text = await ai.chat([
          { role: "system", content: "Extract all text content from this image. Return only the extracted text." },
          { role: "user", content: `[Image: ${input.filePath}]` },
        ]);
        return {
          filePath: input.filePath,
          title: input.filePath.split("/").pop() ?? "Image",
          content: String(text),
          format: "image",
          metadata: { method: "llm-vision" },
          parseTimeMs: Date.now() - start,
        };
      } catch {
        throw new Error(`Image OCR failed for ${input.filePath}. No OCR backend available.`);
      }
    }
  }
}

class HtmlParser implements DocumentParser {
  name = "html";
  supportedFormats: DocumentFormat[] = ["html"];

  async parse(input: DocumentInput): Promise<ParsedDocument> {
    const start = Date.now();
    let content = input.content ?? "";

    if (!content && input.filePath) {
      try {
        content = await invoke<string>("read_text_file", { path: input.filePath });
      } catch {
        throw new Error(`Failed to read file: ${input.filePath}`);
      }
    }

    // Strip HTML tags for plain text
    const plainText = content
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z]+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();

    const titleMatch = content.match(/<title>([^<]+)<\/title>/i);
    const title = titleMatch?.[1] ?? input.filePath.split("/").pop() ?? "HTML Document";

    return {
      filePath: input.filePath,
      title,
      content: plainText,
      format: "html",
      metadata: {},
      parseTimeMs: Date.now() - start,
    };
  }
}

// ── Document Processor Factory (inspired by Yuxi-Know's KnowledgeBaseFactory) ──

class DocumentProcessorFactory {
  private parsers = new Map<DocumentFormat, DocumentParser>();

  constructor() {
    this.register(new MarkdownParser());
    this.register(new PdfParser());
    this.register(new ExcelParser());
    this.register(new ImageParser());
    this.register(new HtmlParser());
  }

  register(parser: DocumentParser): void {
    for (const format of parser.supportedFormats) {
      this.parsers.set(format, parser);
    }
  }

  getParser(format: DocumentFormat): DocumentParser | undefined {
    return this.parsers.get(format);
  }

  getSupportedFormats(): DocumentFormat[] {
    return [...this.parsers.keys()];
  }

  async parse(filePath: string, content?: string): Promise<ParsedDocument> {
    const format = detectDocumentFormat(filePath);
    if (!format) {
      throw new Error(`Unsupported file format: ${filePath}`);
    }

    const parser = this.parsers.get(format);
    if (!parser) {
      throw new Error(`No parser registered for format: ${format}`);
    }

    return parser.parse({ filePath, content, format });
  }

  async parseBatch(files: Array<{ path: string; content?: string }>): Promise<ParsedDocument[]> {
    const results = await Promise.allSettled(
      files.map((f) => this.parse(f.path, f.content)),
    );
    return results
      .filter((r): r is PromiseFulfilledResult<ParsedDocument> => r.status === "fulfilled")
      .map((r) => r.value);
  }
}

export const documentProcessor = new DocumentProcessorFactory();
