import { useState, useEffect, useCallback } from "react";
import {
  marksDb,
  tagsDb,
  createMark,
  searchMarks,
  getActiveMarks,
  getMarksByTag,
  createTag,
  getAllTags,
  type Mark,
  type MarkType,
  type Tag,
} from "@/core/database/marks";
import { handleError } from "@/core/errors";

export function useMarks() {
  const [marks, setMarks] = useState<Mark[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [searchKeyword, setSearchKeyword] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      let items: Mark[];
      if (searchKeyword) {
        items = await searchMarks(searchKeyword);
      } else if (activeTag) {
        items = await getMarksByTag(activeTag);
      } else {
        items = await getActiveMarks();
      }
      setMarks(items);
      const allTags = await getAllTags();
      setTags(allTags);
    } catch (e) {
      handleError(e, { context: "加载快速录入记录" });
    } finally {
      setLoading(false);
    }
  }, [searchKeyword, activeTag]);

  useEffect(() => {
    reload();
  }, [reload]);

  const addMark = useCallback(
    async (
      type: MarkType,
      content: string,
      options?: { tags?: string[]; title?: string; metadata?: Record<string, unknown> },
    ) => {
      await createMark(type, content, options);
      await reload();
    },
    [reload],
  );

  const removeMark = useCallback(
    async (id: string) => {
      await marksDb.delete(id);
      await reload();
    },
    [reload],
  );

  const updateMark = useCallback(
    async (id: string, partial: Partial<Mark>) => {
      await marksDb.update(id, { ...partial, updatedAt: Date.now() });
      await reload();
    },
    [reload],
  );

  const addTag = useCallback(
    async (name: string, color?: string) => {
      await createTag(name, color);
      await reload();
    },
    [reload],
  );

  const removeTag = useCallback(
    async (id: string) => {
      await tagsDb.delete(id);
      await reload();
    },
    [reload],
  );

  return {
    marks,
    tags,
    loading,
    activeTag,
    setActiveTag,
    searchKeyword,
    setSearchKeyword,
    addMark,
    removeMark,
    updateMark,
    addTag,
    removeTag,
    reload,
  };
}
