import { createMark } from "@/core/database/marks";
import { useSnippetStore } from "@/store/snippet-store";
import { useBookmarkStore } from "@/store/bookmark-store";

export async function captureTextMark(text: string) {
  await createMark("text", text);
}

export async function searchSnippets(query: string) {
  await useSnippetStore.getState().loadSnippets();
  return useSnippetStore.getState().searchSnippets(query);
}

export async function matchSnippetByKeyword(keyword: string) {
  await useSnippetStore.getState().loadSnippets();
  return useSnippetStore.getState().matchByKeyword(keyword);
}

export async function searchBookmarks(query: string) {
  await useBookmarkStore.getState().loadBookmarks();
  return useBookmarkStore.getState().searchBookmarks(query);
}
