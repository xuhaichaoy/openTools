/**
 * 插件隔离存储 (Scoped Storage)
 *
 * 为每个插件提供独立的 localStorage 命名空间，防止键名冲突。
 * 键名格式: `plugin:${pluginId}:${key}`
 */

export interface PluginStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
  getAllKeys(): string[];
}

export class ScopedStorage implements PluginStorage {
  private prefix: string;

  constructor(pluginId: string) {
    this.prefix = `plugin:${pluginId}:`;
  }

  private getFullKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  getItem(key: string): string | null {
    return localStorage.getItem(this.getFullKey(key));
  }

  setItem(key: string, value: string): void {
    localStorage.setItem(this.getFullKey(key), value);
  }

  removeItem(key: string): void {
    localStorage.removeItem(this.getFullKey(key));
  }

  clear(): void {
    // 仅清理当前插件前缀的 keys
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(this.prefix)) {
        keysToRemove.push(k);
      }
    }
    keysToRemove.forEach((k) => localStorage.removeItem(k));
  }

  getAllKeys(): string[] {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(this.prefix)) {
        keys.push(k.slice(this.prefix.length));
      }
    }
    return keys;
  }
}
