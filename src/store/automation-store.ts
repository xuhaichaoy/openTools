/**
 * 统一自动化 Store — 合并 workflow-store + data-forge-store
 *
 * 为保持向后兼容，此文件作为统一入口 re-export 所有子 Store。
 * 新代码应从此文件导入；旧代码的导入路径仍然有效。
 */

export { useWorkflowStore } from "./workflow-store";

export { useDataForgeStore } from "./data-forge-store";
