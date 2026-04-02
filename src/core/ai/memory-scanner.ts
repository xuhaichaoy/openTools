import * as fs from 'fs/promises';
import * as path from 'path';

export interface MemoryHeader {
  filename: string;
  filePath: string;
  description: string;
  mtimeMs: number;
}

export async function scanMemoryFiles(memoryDir: string): Promise<MemoryHeader[]> {
  try {
    const files = await fs.readdir(memoryDir);
    const memories: MemoryHeader[] = [];

    for (const file of files) {
      if (!file.endsWith('.md') || file === 'MEMORY.md') continue;

      const filePath = path.join(memoryDir, file);
      const stat = await fs.stat(filePath);
      const content = await fs.readFile(filePath, 'utf-8');

      const description = extractDescription(content);

      memories.push({
        filename: file,
        filePath,
        description,
        mtimeMs: stat.mtimeMs,
      });
    }

    return memories;
  } catch {
    return [];
  }
}

function extractDescription(content: string): string {
  const match = content.match(/^---\n[\s\S]*?description:\s*(.+?)\n/m);
  return match?.[1]?.trim() || '';
}
