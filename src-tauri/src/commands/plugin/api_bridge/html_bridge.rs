pub(super) fn inject_base_tag(html: &str, base_url: &str) -> String {
    let base_tag = format!("<base href=\"{}\">", base_url);
    let lower = html.to_lowercase();
    if let Some(pos) = lower.find("<head>") {
        let insert_pos = pos + 6;
        format!("{}{}{}", &html[..insert_pos], base_tag, &html[insert_pos..])
    } else if let Some(pos) = lower.find("<html>") {
        let insert_pos = pos + 6;
        format!(
            "{}<head>{}</head>{}",
            &html[..insert_pos],
            base_tag,
            &html[insert_pos..]
        )
    } else {
        format!("<head>{}</head>{}", base_tag, html)
    }
}

pub(super) fn inject_embed_bridge(html: &str, bridge_script: &str) -> String {
    let script_tag = format!("<script>{}</script>", bridge_script);
    let lower = html.to_lowercase();
    if let Some(pos) = lower.find("<head>") {
        let insert_pos = pos + 6;
        format!(
            "{}{}{}",
            &html[..insert_pos],
            script_tag,
            &html[insert_pos..]
        )
    } else if let Some(pos) = lower.find("<html>") {
        let insert_pos = pos + 6;
        format!(
            "{}<head>{}</head>{}",
            &html[..insert_pos],
            script_tag,
            &html[insert_pos..]
        )
    } else {
        format!("<head>{}</head>{}", script_tag, html)
    }
}

fn escape_js_string(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('\'', "\\'")
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
}

pub(super) fn generate_utools_shim(plugin_id: &str) -> String {
    format!(
        r#"
(function() {{
  'use strict';
  const coreInvoke = window.__TAURI__?.core?.invoke;
  if (coreInvoke) {{
      delete window.__TAURI__;
  }} else {{
      console.error('[mTools] Panic: Tauri API not found during shim initialization');
  }}
  const __pluginId = '{plugin_id}';
  let __callId = 0;

  function __invoke(method, args) {{
    return new Promise((resolve, reject) => {{
      if (!coreInvoke) {{
        console.warn('[mTools] Tauri IPC unavailable or stripped', method);
        reject(new Error('Tauri IPC not available'));
        return;
      }}
      const id = ++__callId;
      coreInvoke('plugin_api_call', {{
        pluginId: __pluginId,
        method: method,
        args: JSON.stringify(args || {{}}),
        callId: id,
      }}).then(result => {{
        resolve(JSON.parse(result || 'null'));
      }}).catch(err => {{
        reject(err);
      }});
    }});
  }}

  function __resolveActionHandler(actionName) {{
    if (window.mtools && window.mtools.actions && typeof window.mtools.actions[actionName] === 'function') {{
      return window.mtools.actions[actionName];
    }}
    if (window.__mtoolsActions && typeof window.__mtoolsActions[actionName] === 'function') {{
      return window.__mtoolsActions[actionName];
    }}
    if (window.mtoolsActions && typeof window.mtoolsActions[actionName] === 'function') {{
      return window.mtoolsActions[actionName];
    }}
    if (window.exports && typeof window.exports[actionName] === 'function') {{
      return window.exports[actionName];
    }}
    if (typeof window[actionName] === 'function') {{
      return window[actionName];
    }}
    return null;
  }}

  window.__mtoolsActionCallback = function(requestId, result, error) {{
    if (!coreInvoke) return;
    var normalizedResult = result;
    if (normalizedResult !== undefined && typeof normalizedResult !== 'string') {{
      normalizedResult = JSON.stringify(normalizedResult);
    }}
    return coreInvoke('plugin_action_callback', {{
      pluginId: __pluginId,
      requestId: requestId,
      result: normalizedResult,
      error: error || null,
    }});
  }};

  window.__mtoolsHostInvokeAction = function(requestId, actionName, paramsJson) {{
    var params = {{}};
    try {{
      params = paramsJson ? JSON.parse(paramsJson) : {{}};
    }} catch (_err) {{
      params = {{}};
    }}
    Promise.resolve()
      .then(function() {{
        var handler = __resolveActionHandler(actionName);
        if (!handler) {{
          throw new Error('找不到 action 处理器: ' + actionName);
        }}
        return handler(params);
      }})
      .then(function(result) {{
        var normalized =
          typeof result === 'string' ? result : JSON.stringify(result ?? null);
        return window.__mtoolsActionCallback(requestId, normalized, null);
      }})
      .catch(function(err) {{
        var message = err && err.message ? err.message : String(err);
        return window.__mtoolsActionCallback(requestId, null, message);
      }});
  }};

  const utools = {{
    hideMainWindow() {{ __invoke('hideMainWindow'); }},
    showMainWindow() {{ __invoke('showMainWindow'); }},
    setExpendHeight(height) {{ __invoke('setExpendHeight', {{ height }}); }},
    setSubInput(onChange, placeholder, isFocus) {{
      window.__utoolsSubInputCallback = onChange;
      __invoke('setSubInput', {{ placeholder, isFocus }});
    }},
    removeSubInput() {{
      window.__utoolsSubInputCallback = null;
      __invoke('removeSubInput');
    }},
    copyText(text) {{ return __invoke('copyText', {{ text }}); }},
    copyImage(base64) {{ return __invoke('copyImage', {{ base64 }}); }},
    getCopyedFiles() {{ return []; }},
    dbStorage: {{
      setItem(key, value) {{ return __invoke('dbStorage.setItem', {{ key, value }}); }},
      getItem(key) {{ return __invoke('dbStorage.getItem', {{ key }}); }},
      removeItem(key) {{ return __invoke('dbStorage.removeItem', {{ key }}); }},
    }},
    getPath(name) {{ return __invoke('getPath', {{ name }}); }},
    showNotification(body, clickFeatureCode) {{ __invoke('showNotification', {{ body, clickFeatureCode }}); }},
    shellOpenExternal(url) {{ __invoke('shellOpenExternal', {{ url }}); }},
    shellOpenPath(path) {{ __invoke('shellOpenPath', {{ path }}); }},
    shellShowItemInFolder(path) {{ __invoke('shellShowItemInFolder', {{ path }}); }},
    screenCapture(callback) {{
      window.__utoolsScreenCaptureCallback = callback;
      __invoke('screenCapture');
    }},
    getFeatures() {{ return __invoke('getFeatures'); }},
    screenColorPick(callback) {{
      __invoke('plugin_start_color_picker').then(function(hex) {{
        callback && callback(hex || null);
      }}).catch(function(err) {{
        console.error('[mTools] 取色失败:', err);
        callback && callback(null);
      }});
    }},
    getUser() {{ return {{ avatar: '', nickname: '本地用户', type: 'member' }}; }},
    getAppVersion() {{ return '0.1.0'; }},
    isDarkColors() {{ return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches; }},
    isMacOS() {{ return navigator.platform.toLowerCase().includes('mac'); }},
    isWindows() {{ return navigator.platform.toLowerCase().includes('win'); }},
    isLinux() {{ return navigator.platform.toLowerCase().includes('linux'); }},
    onPluginReady(callback) {{ if (callback) setTimeout(callback, 0); }},
    onPluginEnter(callback) {{ window.__utoolsOnEnterCallback = callback; }},
    onPluginOut(callback) {{ window.__utoolsOnOutCallback = callback; }},
    redirect(label, payload) {{ __invoke('redirect', {{ label, payload }}); }},
    outPlugin() {{ __invoke('outPlugin'); }},
  }};

  window.utools = utools;
  window.rubick = utools;
  console.log('[mTools] utools API shim 已注入, pluginId:', __pluginId);
}})();
"#,
        plugin_id = plugin_id
    )
}

pub(super) fn generate_embed_bridge(plugin_id: &str, bridge_token: &str) -> String {
    let plugin_id_esc = escape_js_string(plugin_id);
    let bridge_token_esc = escape_js_string(bridge_token);
    format!(
        r#"
(function(){{
  var __pluginId = '{plugin_id_esc}';
  var __bridgeToken = '{bridge_token_esc}';
  var __invokeId = 0;
  function __invoke(cmd, args) {{
    return new Promise(function(resolve, reject) {{
      var id = 'inv-' + (++__invokeId);
      var done = false;
      function onResp(e) {{
        if (e.data && e.data.type === 'mtools-embed-result' && e.data.id === id && e.data.token === __bridgeToken) {{
          done = true;
          window.removeEventListener('message', onResp);
          if (e.data.error) reject(new Error(e.data.error)); else resolve(e.data.result);
        }}
      }}
      window.addEventListener('message', onResp);
      try {{
        window.parent.postMessage({{ type: 'mtools-embed-invoke', id: id, cmd: cmd, args: args || {{}}, pluginId: __pluginId, token: __bridgeToken }}, '*');
      }} catch (err) {{
        if (!done) {{ window.removeEventListener('message', onResp); reject(err); }}
      }}
      setTimeout(function() {{
        if (!done) {{ done = true; window.removeEventListener('message', onResp); reject(new Error('embed invoke timeout')); }}
      }}, 30000);
    }});
  }}
  window.__mtoolsActionCallback = function(requestId, result, error) {{
    var normalizedResult = result;
    if (normalizedResult !== undefined && typeof normalizedResult !== 'string') {{
      normalizedResult = JSON.stringify(normalizedResult);
    }}
    return __invoke('plugin_action_callback', {{
      pluginId: __pluginId,
      requestId: requestId,
      result: normalizedResult,
      error: error || null
    }});
  }};
  function __resolveActionHandler(actionName) {{
    if (window.mtools && window.mtools.actions && typeof window.mtools.actions[actionName] === 'function') {{
      return window.mtools.actions[actionName];
    }}
    if (window.__mtoolsActions && typeof window.__mtoolsActions[actionName] === 'function') {{
      return window.__mtoolsActions[actionName];
    }}
    if (window.mtoolsActions && typeof window.mtoolsActions[actionName] === 'function') {{
      return window.mtoolsActions[actionName];
    }}
    if (window.exports && typeof window.exports[actionName] === 'function') {{
      return window.exports[actionName];
    }}
    if (typeof window[actionName] === 'function') {{
      return window[actionName];
    }}
    return null;
  }}
  window.__mtoolsHostInvokeAction = function(requestId, actionName, paramsJson) {{
    var params = {{}};
    try {{
      params = paramsJson ? JSON.parse(paramsJson) : {{}};
    }} catch (_err) {{
      params = {{}};
    }}
    return Promise.resolve()
      .then(function() {{
        var handler = __resolveActionHandler(actionName);
        if (!handler) {{
          throw new Error('找不到 action 处理器: ' + actionName);
        }}
        return handler(params);
      }})
      .then(function(result) {{
        var normalized =
          typeof result === 'string' ? result : JSON.stringify(result ?? null);
        return window.__mtoolsActionCallback(requestId, normalized, null);
      }})
      .catch(function(err) {{
        var message = err && err.message ? err.message : String(err);
        return window.__mtoolsActionCallback(requestId, null, message);
      }});
  }};
  window.__TAURI__ = {{
    core: {{ invoke: __invoke }},
    event: {{ listen: function(name, cb) {{ return __invoke('event-listen', {{ name: name }}).then(function() {{ return function() {{}}; }}); }} }}
  }};
  var __callId = 0;
  function __apiInvoke(method, args) {{
    return __invoke('plugin_api_call', {{ pluginId: __pluginId, method: method, args: JSON.stringify(args || {{}}), callId: ++__callId }}).then(function(r) {{ return JSON.parse(r || 'null'); }});
  }}
  window.utools = window.rubick = {{
    hideMainWindow: function() {{ return __apiInvoke('hideMainWindow'); }},
    showMainWindow: function() {{ return __apiInvoke('showMainWindow'); }},
    setExpendHeight: function(o) {{ return __apiInvoke('setExpendHeight', o); }},
    setSubInput: function(onChange, p, f) {{ window.__utoolsSubInputCallback = onChange; return __apiInvoke('setSubInput', {{ placeholder: p, isFocus: f }}); }},
    removeSubInput: function() {{ window.__utoolsSubInputCallback = null; return __apiInvoke('removeSubInput'); }},
    copyText: function(t) {{ return __apiInvoke('copyText', {{ text: t }}); }},
    copyImage: function(b) {{ return __apiInvoke('copyImage', {{ base64: b }}); }},
    getCopyedFiles: function() {{ return []; }},
    dbStorage: {{ setItem: function(k,v) {{ return __apiInvoke('dbStorage.setItem', {{ key: k, value: v }}); }}, getItem: function(k) {{ return __apiInvoke('dbStorage.getItem', {{ key: k }}); }}, removeItem: function(k) {{ return __apiInvoke('dbStorage.removeItem', {{ key: k }}); }} }},
    getPath: function(n) {{ return __apiInvoke('getPath', {{ name: n }}); }},
    showNotification: function(b,c) {{ return __apiInvoke('showNotification', {{ body: b, clickFeatureCode: c }}); }},
    shellOpenExternal: function(u) {{ return __apiInvoke('shellOpenExternal', {{ url: u }}); }},
    shellOpenPath: function(p) {{ return __apiInvoke('shellOpenPath', {{ path: p }}); }},
    shellShowItemInFolder: function(p) {{ return __apiInvoke('shellShowItemInFolder', {{ path: p }}); }},
    screenCapture: function(cb) {{ if (cb) cb(null); }},
    screenColorPick: function(cb) {{ __invoke('plugin_start_color_picker').then(function(hex) {{ if (cb) cb(hex || null); }}).catch(function() {{ if (cb) cb(null); }}); }},
    getUser: function() {{ return {{ avatar: '', nickname: '本地用户', type: 'member' }}; }},
    getAppVersion: function() {{ return '0.1.0'; }},
    isDarkColors: function() {{ return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches; }},
    isMacOS: function() {{ return /mac/i.test(navigator.platform); }},
    isWindows: function() {{ return /win/i.test(navigator.platform); }},
    isLinux: function() {{ return /linux/i.test(navigator.platform); }},
    onPluginReady: function(cb) {{ if (cb) setTimeout(cb, 0); }},
    onPluginEnter: function(cb) {{ window.__utoolsOnEnterCallback = cb; }},
    onPluginOut: function(cb) {{ window.__utoolsOnOutCallback = cb; }},
    redirect: function(l, p) {{ return __apiInvoke('redirect', {{ label: l, payload: p }}); }},
    outPlugin: function() {{ return __apiInvoke('outPlugin'); }}
  }};

  var __aiReqId = 0;
  window.mtools = {{
    ai: {{
      chat: function(opts) {{
        return new Promise(function(resolve, reject) {{
          var id = 'ai-' + (++__aiReqId);
          function onResp(e) {{
            if (e.data && e.data.type === 'mtools-ai-result' && e.data.id === id && e.data.token === __bridgeToken) {{
              window.removeEventListener('message', onResp);
              if (e.data.error) reject(new Error(e.data.error));
              else resolve({{ content: e.data.content }});
            }}
          }}
          window.addEventListener('message', onResp);
          window.parent.postMessage({{ type: 'mtools-ai-chat', id: id, messages: opts.messages, model: opts.model, temperature: opts.temperature, pluginId: __pluginId, token: __bridgeToken }}, '*');
        }});
      }},
      stream: function(opts) {{
        return new Promise(function(resolve, reject) {{
          var id = 'ai-' + (++__aiReqId);
          function onMsg(e) {{
            if (!e.data || e.data.id !== id || e.data.token !== __bridgeToken) return;
            if (e.data.type === 'mtools-ai-chunk' && opts.onChunk) opts.onChunk(e.data.chunk);
            if (e.data.type === 'mtools-ai-done') {{
              window.removeEventListener('message', onMsg);
              if (opts.onDone) opts.onDone(e.data.content);
              resolve();
            }}
            if (e.data.type === 'mtools-ai-error') {{
              window.removeEventListener('message', onMsg);
              reject(new Error(e.data.error));
            }}
          }}
          window.addEventListener('message', onMsg);
          window.parent.postMessage({{ type: 'mtools-ai-stream', id: id, messages: opts.messages, pluginId: __pluginId, token: __bridgeToken }}, '*');
        }});
      }},
      getModels: function() {{
        return __invoke('ai_list_models', {{}}).then(function(r) {{ return r || []; }}).catch(function() {{ return []; }});
      }}
    }}
  }};

  window.addEventListener('message', function(e) {{
    var d = e.data || {{}};
    if (d.type !== 'mtools-dev-simulate') return;
    if (d.pluginId !== __pluginId) return;
    var p = d.payload;
    switch (d.eventType) {{
      case 'onPluginEnter':
        if (window.__utoolsOnEnterCallback) window.__utoolsOnEnterCallback(p || {{ code: '', type: 'text', payload: null }});
        break;
      case 'onPluginOut':
        if (window.__utoolsOnOutCallback) window.__utoolsOnOutCallback();
        break;
      case 'setSubInput':
        var text = typeof p === 'string' ? p : (p && (p.text || p.value || '')) || '';
        if (window.__utoolsSubInputCallback) window.__utoolsSubInputCallback(text);
        break;
      case 'screenCapture':
        if (window.__utoolsScreenCaptureCallback) window.__utoolsScreenCaptureCallback(p || null);
        break;
      case 'redirect':
        // redirect 无内建回调，这里仅保留兼容入口
        break;
    }}
  }});
}})();
"#,
        plugin_id_esc = plugin_id_esc,
        bridge_token_esc = bridge_token_esc
    )
}

pub(super) fn generate_plugin_enter_script(
    code: &str,
    cmd_type: &str,
    payload: Option<&str>,
) -> String {
    let payload_js = match payload {
        Some(p) => format!("'{}'", p.replace('\'', "\\'")),
        None => "undefined".to_string(),
    };
    format!(
        r#"
(function() {{
  setTimeout(function() {{
    if (window.__utoolsOnEnterCallback) {{
      window.__utoolsOnEnterCallback({{
        code: '{code}',
        type: '{cmd_type}',
        payload: {payload_js},
      }});
    }}
  }}, 100);
}})();
"#,
        code = code,
        cmd_type = cmd_type,
        payload_js = payload_js
    )
}
