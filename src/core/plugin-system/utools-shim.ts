/**
 * utools API Shim — 注入到插件 WebviewWindow 的兼容层
 *
 * 实现 uTools 插件最常用的 API，使现有 uTools 插件可以在 mTools 中运行。
 * 通过 Tauri WebviewWindow.eval() 注入到插件的执行环境中。
 *
 * 参考: https://www.u.tools/docs/developer/api.html
 */

export function generateUtoolsShimScript(pluginId: string): string {
  return `
(function() {
  'use strict';

  // ── 内部状态 ──
  const __pluginId = '${pluginId}';
  const __callbacks = {};
  let __callId = 0;

  // ── 与宿主通信 ──
  function __invoke(method, args) {
    return new Promise((resolve, reject) => {
      const id = ++__callId;
      __callbacks[id] = { resolve, reject };

      window.__TAURI__.core.invoke('plugin_api_call', {
        pluginId: __pluginId,
        method: method,
        args: JSON.stringify(args || {}),
        callId: id,
      }).then(result => {
        resolve(JSON.parse(result || 'null'));
        delete __callbacks[id];
      }).catch(err => {
        reject(err);
        delete __callbacks[id];
      });
    });
  }

  // ── utools API 实现 ──
  const utools = {
    // ─ 窗口操作 ─
    hideMainWindow() {
      __invoke('hideMainWindow');
    },

    showMainWindow() {
      __invoke('showMainWindow');
    },

    setExpendHeight(height) {
      __invoke('setExpendHeight', { height });
    },

    setSubInput(onChange, placeholder, isFocus) {
      // 子输入框（简化实现）
      window.__utoolsSubInputCallback = onChange;
      __invoke('setSubInput', { placeholder, isFocus });
    },

    removeSubInput() {
      window.__utoolsSubInputCallback = null;
      __invoke('removeSubInput');
    },

    // ─ 剪贴板 ─
    copyText(text) {
      return __invoke('copyText', { text });
    },

    copyImage(base64) {
      return __invoke('copyImage', { base64 });
    },

    getCopyedFiles() {
      // uTools 获取粘贴板文件（简化实现）
      return [];
    },

    // ─ 数据存储 (使用 Tauri Store) ─
    dbStorage: {
      setItem(key, value) {
        return __invoke('dbStorage.setItem', { key, value });
      },
      getItem(key) {
        return __invoke('dbStorage.getItem', { key });
      },
      removeItem(key) {
        return __invoke('dbStorage.removeItem', { key });
      },
    },

    // ─ 系统 ─
    getPath(name) {
      return __invoke('getPath', { name });
    },

    showNotification(body, clickFeatureCode) {
      __invoke('showNotification', { body, clickFeatureCode });
    },

    shellOpenExternal(url) {
      __invoke('shellOpenExternal', { url });
    },

    shellOpenPath(path) {
      __invoke('shellOpenPath', { path });
    },

    shellShowItemInFolder(path) {
      __invoke('shellShowItemInFolder', { path });
    },

    // ─ 屏幕取色 / 截图（暂不支持）─
    screenCapture(callback) {
      console.warn('[mTools] screenCapture 暂未实现');
      callback && callback(null);
    },

    screenColorPick(callback) {
      console.warn('[mTools] screenColorPick 暂未实现');
      callback && callback(null);
    },

    // ─ 用户信息 ─
    getUser() {
      return { avatar: '', nickname: '本地用户', type: 'member' };
    },

    // ─ 插件信息 ─
    getAppVersion() {
      return '0.1.0';
    },

    isDarkColors() {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    },

    isMacOS() {
      return navigator.platform.toLowerCase().includes('mac');
    },

    isWindows() {
      return navigator.platform.toLowerCase().includes('win');
    },

    isLinux() {
      return navigator.platform.toLowerCase().includes('linux');
    },

    // ─ 事件 ─
    onPluginReady(callback) {
      if (callback) setTimeout(callback, 0);
    },

    onPluginEnter(callback) {
      window.__utoolsOnEnterCallback = callback;
    },

    onPluginOut(callback) {
      window.__utoolsOnOutCallback = callback;
    },

    // ── mTools 扩展 AI API ──
    ai: {
      chat(message, options) {
        return __invoke('ai.chat', { message, ...options });
      },
      stream(message, onChunk, options) {
        // 简化的流式 AI 调用
        return __invoke('ai.stream', { message, ...options });
      },
    },

    // ─ 重定向 ─
    redirect(label, payload) {
      __invoke('redirect', { label, payload });
    },

    outPlugin() {
      __invoke('outPlugin');
    },
  };

  // ── 暴露到全局 ──
  window.utools = utools;

  // ── 兼容 Rubick 的 rubick API ──
  window.rubick = utools;

  console.log('[mTools] utools API shim 已注入, pluginId:', __pluginId);
})();
`
}

/**
 * 生成插件进入事件的触发脚本
 */
export function generatePluginEnterScript(code: string, type: string, payload?: string): string {
  return `
(function() {
  if (window.__utoolsOnEnterCallback) {
    window.__utoolsOnEnterCallback({
      code: '${code}',
      type: '${type}',
      payload: ${payload ? `'${payload.replace(/'/g, "\\'")}'` : 'undefined'},
    });
  }
})();
`
}
