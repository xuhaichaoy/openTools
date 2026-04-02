export type IMChannel = 'dingtalk' | 'feishu' | 'local';

export interface IMPermission {
  channel: IMChannel;
  canReadMessages: boolean;
  canSendMessages: boolean;
  canAccessFiles: boolean;
}

export class IMPermissionManager {
  private permissions = new Map<IMChannel, IMPermission>();

  constructor() {
    // 默认权限
    this.permissions.set('local', {
      channel: 'local',
      canReadMessages: true,
      canSendMessages: true,
      canAccessFiles: true,
    });

    this.permissions.set('dingtalk', {
      channel: 'dingtalk',
      canReadMessages: true,
      canSendMessages: true,
      canAccessFiles: false, // 默认不允许
    });

    this.permissions.set('feishu', {
      channel: 'feishu',
      canReadMessages: true,
      canSendMessages: true,
      canAccessFiles: false,
    });
  }

  canAccess(channel: IMChannel, action: keyof Omit<IMPermission, 'channel'>): boolean {
    const perm = this.permissions.get(channel);
    return perm ? perm[action] : false;
  }

  updatePermission(channel: IMChannel, updates: Partial<IMPermission>): void {
    const current = this.permissions.get(channel);
    if (current) {
      this.permissions.set(channel, { ...current, ...updates });
    }
  }
}
