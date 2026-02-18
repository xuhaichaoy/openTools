/**
 * 云端知识库 Store
 *
 * 管理个人云端文档和团队云端文档。
 * 与 rag-store（本地 RAG 引擎）配合使用。
 */

import { create } from "zustand";
import { api } from "@/core/api/client";
import { handleError } from "@/core/errors";
import { useTeamStore } from "@/store/team-store";

export interface KbCloudDoc {
  id: string;
  owner_type: "personal" | "team";
  owner_id: string;
  uploader_id: string;
  name: string;
  format: string;
  size: number;
  tags: string[];
  description: string | null;
  created_at: string;
  updated_at: string;
  uploader_name?: string | null;
  content?: string | null;
}

export type KbScope =
  | { type: "indexed" }
  | { type: "search" }
  | { type: "personal" }
  | { type: "team"; teamId: string; teamName: string };

interface KbState {
  personalDocs: KbCloudDoc[];
  teamDocs: Record<string, KbCloudDoc[]>;
  activeScope: KbScope;
  loading: boolean;

  setScope: (scope: KbScope) => void;

  loadPersonalDocs: () => Promise<void>;
  loadTeamDocs: (teamId: string) => Promise<void>;

  createPersonalDoc: (name: string, content: string, format?: string, tags?: string[], description?: string) => Promise<KbCloudDoc>;
  createTeamDoc: (teamId: string, name: string, content: string, format?: string, tags?: string[], description?: string) => Promise<KbCloudDoc>;

  uploadPersonalDoc: (file: File) => Promise<KbCloudDoc>;
  uploadTeamDoc: (teamId: string, file: File) => Promise<KbCloudDoc>;

  updateDoc: (docId: string, payload: { name?: string; content?: string; tags?: string[]; description?: string }) => Promise<KbCloudDoc>;
  updateTeamDoc: (teamId: string, docId: string, payload: { name?: string; content?: string; tags?: string[]; description?: string }) => Promise<KbCloudDoc>;

  deletePersonalDoc: (docId: string) => Promise<void>;
  deleteTeamDoc: (teamId: string, docId: string) => Promise<void>;

  getDocContent: (docId: string) => Promise<KbCloudDoc>;
  getTeamDocContent: (teamId: string, docId: string) => Promise<KbCloudDoc>;

  downloadDocUrl: (docId: string) => string;
  downloadTeamDocUrl: (teamId: string, docId: string) => string;
}

export const useKbStore = create<KbState>((set, get) => ({
  personalDocs: [],
  teamDocs: {},
  activeScope: { type: "indexed" },
  loading: false,

  setScope: (scope) => set({ activeScope: scope }),

  loadPersonalDocs: async () => {
    set({ loading: true });
    try {
      const docs = await api.get<KbCloudDoc[]>("/kb/personal");
      set({ personalDocs: docs });
    } catch (e) {
      console.warn("[KB] loadPersonalDocs failed:", e);
      set({ personalDocs: [] });
    } finally {
      set({ loading: false });
    }
  },

  loadTeamDocs: async (teamId) => {
    set({ loading: true });
    try {
      const docs = await api.get<KbCloudDoc[]>(`/teams/${teamId}/kb`);
      set({ teamDocs: { ...get().teamDocs, [teamId]: docs } });
    } catch (e) {
      console.warn("[KB] loadTeamDocs failed:", e);
      set({ teamDocs: { ...get().teamDocs, [teamId]: [] } });
    } finally {
      set({ loading: false });
    }
  },

  createPersonalDoc: async (name, content, format = "md", tags = [], description) => {
    const doc = await api.post<KbCloudDoc>("/kb/personal", {
      name,
      content,
      format,
      tags,
      description,
    });
    set({ personalDocs: [doc, ...get().personalDocs] });
    return doc;
  },

  createTeamDoc: async (teamId, name, content, format = "md", tags = [], description) => {
    const doc = await api.post<KbCloudDoc>(`/teams/${teamId}/kb`, {
      name,
      content,
      format,
      tags,
      description,
    });
    const prev = get().teamDocs[teamId] || [];
    set({ teamDocs: { ...get().teamDocs, [teamId]: [doc, ...prev] } });
    return doc;
  },

  uploadPersonalDoc: async (file) => {
    const formData = new FormData();
    formData.append("file", file);
    const doc = await api.upload<KbCloudDoc>("/kb/personal/upload", formData);
    set({ personalDocs: [doc, ...get().personalDocs] });
    return doc;
  },

  uploadTeamDoc: async (teamId, file) => {
    const formData = new FormData();
    formData.append("file", file);
    const doc = await api.upload<KbCloudDoc>(`/teams/${teamId}/kb/upload`, formData);
    const prev = get().teamDocs[teamId] || [];
    set({ teamDocs: { ...get().teamDocs, [teamId]: [doc, ...prev] } });
    return doc;
  },

  updateDoc: async (docId, payload) => {
    const doc = await api.patch<KbCloudDoc>(`/kb/personal/${docId}`, payload);
    set({
      personalDocs: get().personalDocs.map((d) => (d.id === docId ? doc : d)),
    });
    return doc;
  },

  updateTeamDoc: async (teamId, docId, payload) => {
    const doc = await api.patch<KbCloudDoc>(`/teams/${teamId}/kb/${docId}`, payload);
    const prev = get().teamDocs[teamId] || [];
    set({
      teamDocs: {
        ...get().teamDocs,
        [teamId]: prev.map((d) => (d.id === docId ? doc : d)),
      },
    });
    return doc;
  },

  deletePersonalDoc: async (docId) => {
    await api.delete(`/kb/personal/${docId}`);
    set({
      personalDocs: get().personalDocs.filter((d) => d.id !== docId),
    });
  },

  deleteTeamDoc: async (teamId, docId) => {
    await api.delete(`/teams/${teamId}/kb/${docId}`);
    const prev = get().teamDocs[teamId] || [];
    set({
      teamDocs: {
        ...get().teamDocs,
        [teamId]: prev.filter((d) => d.id !== docId),
      },
    });
  },

  getDocContent: async (docId) => {
    return api.get<KbCloudDoc>(`/kb/personal/${docId}`);
  },

  getTeamDocContent: async (teamId, docId) => {
    return api.get<KbCloudDoc>(`/teams/${teamId}/kb/${docId}`);
  },

  downloadDocUrl: (docId) => `/kb/personal/${docId}/download`,
  downloadTeamDocUrl: (teamId, docId) => `/teams/${teamId}/kb/${docId}/download`,
}));
