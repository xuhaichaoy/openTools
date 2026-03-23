import { create } from "zustand";
import { handleError } from "@/core/errors";
import {
  listLocalExportDatasets,
  removeLocalExportDataset,
  upsertLocalExportDataset,
} from "@/core/data-export/dataset-registry";
import type { PersonalExportDatasetDefinition } from "@/core/data-export/types";

interface DataExportDatasetState {
  datasets: PersonalExportDatasetDefinition[];
  isLoading: boolean;
  loadDatasets: () => Promise<void>;
  saveDataset: (dataset: PersonalExportDatasetDefinition) => Promise<void>;
  deleteDataset: (datasetId: string) => Promise<void>;
}

export const useDataExportDatasetStore = create<DataExportDatasetState>((set) => ({
  datasets: [],
  isLoading: false,

  loadDatasets: async () => {
    set({ isLoading: true });
    try {
      const datasets = await listLocalExportDatasets();
      set({ datasets });
    } catch (error) {
      handleError(error, { context: "加载本地数据集" });
    } finally {
      set({ isLoading: false });
    }
  },

  saveDataset: async (dataset) => {
    try {
      const datasets = await upsertLocalExportDataset(dataset);
      set({ datasets });
    } catch (error) {
      handleError(error, { context: "保存本地数据集" });
    }
  },

  deleteDataset: async (datasetId) => {
    try {
      const datasets = await removeLocalExportDataset(datasetId);
      set({ datasets });
    } catch (error) {
      handleError(error, { context: "删除本地数据集" });
    }
  },
}));
