import { getMToolsAI } from './mtools-ai';
import { scanMemoryFiles, type MemoryHeader } from './memory-scanner';

export interface RelevantMemory {
  path: string;
  mtimeMs: number;
  score: number;
}

const TYPE_PRIORITY: Record<string, number> = {
  preference: 10,
  fact: 8,
  goal: 6,
  constraint: 7,
  context: 4
};

export async function findRelevantMemories(
  query: string,
  memoryDir: string,
  maxResults = 5,
): Promise<RelevantMemory[]> {
  const headers = await scanMemoryFiles(memoryDir);
  if (headers.length === 0) return [];

  const keywordMatches = findKeywordMatches(query, headers);
  const aiSelected = await selectWithAI(query, headers, maxResults * 2);

  const combined = mergeAndRank([...keywordMatches, ...aiSelected], maxResults);
  return combined;
}

function findKeywordMatches(query: string, headers: MemoryHeader[]): MemoryHeader[] {
  const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  return headers.filter(h => {
    const text = `${h.filename} ${h.description}`.toLowerCase();
    return keywords.some(kw => text.includes(kw));
  });
}

function mergeAndRank(headers: MemoryHeader[], limit: number): RelevantMemory[] {
  const seen = new Map<string, { header: MemoryHeader; score: number }>();

  for (const h of headers) {
    const existing = seen.get(h.filePath);
    const typeScore = TYPE_PRIORITY[h.type || 'context'] || 0;
    const recencyScore = h.mtimeMs / 1e12;
    const score = typeScore + recencyScore;

    if (!existing || score > existing.score) {
      seen.set(h.filePath, { header: h, score });
    }
  }

  return Array.from(seen.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ header, score }) => ({
      path: header.filePath,
      mtimeMs: header.mtimeMs,
      score
    }));
}

async function selectWithAI(
  query: string,
  headers: MemoryHeader[],
  maxResults: number,
): Promise<MemoryHeader[]> {
  if (headers.length === 0) return [];

  const manifest = headers.map(h => `${h.filename}: ${h.description}`).join('\n');
  const prompt = `Query: ${query}\n\nAvailable memories:\n${manifest}\n\nSelect up to ${maxResults} most relevant filenames (JSON array):`;

  try {
    const ai = getMToolsAI();
    const response = await ai.chat({ messages: [{ role: 'user', content: prompt }] });
    const filenames = JSON.parse(response.content);
    return headers.filter(h => filenames.includes(h.filename));
  } catch {
    return headers.slice(0, maxResults);
  }
}
