export type FilePermission = 'read' | 'write' | 'delete';

export interface FileAccessRule {
  path: string;
  permissions: FilePermission[];
  reason?: string;
}

export class FilePermissionManager {
  private whitelist: FileAccessRule[] = [];
  private blacklist: string[] = [
    '.env',
    '.env.local',
    'credentials.json',
    'secrets.json',
    '*.key',
    '*.pem',
  ];

  addWhitelist(rule: FileAccessRule): void {
    this.whitelist.push(rule);
  }

  canAccess(path: string, permission: FilePermission): boolean {
    // 检查黑名单
    if (this.isBlacklisted(path)) return false;

    // 检查白名单
    const rule = this.whitelist.find(r => this.matchPath(path, r.path));
    return rule ? rule.permissions.includes(permission) : false;
  }

  private isBlacklisted(path: string): boolean {
    return this.blacklist.some(pattern => this.matchPath(path, pattern));
  }

  private matchPath(path: string, pattern: string): boolean {
    const regex = new RegExp(pattern.replace('*', '.*'));
    return regex.test(path);
  }
}
