// ==UserScript==
// @name         雨课堂实时作答监控与 AI 答题助手
// @namespace    https://github.com/F1atSnark/yuketang-lite
// @version      1.0.0
// @description  只读监听雨课堂网页版实时通道：老师发题即时提醒（声音/桌面通知/标题闪烁/ntfy 可选），图片题直传视觉大模型生成参考答案；支持用你的 key 拉取可用模型列表选择模型。不自动提交答案，仅供学习对照。
// @author       F1atSnark contributors
// @homepageURL  https://github.com/F1atSnark/yuketang-lite
// @supportURL   https://github.com/F1atSnark/yuketang-lite/issues
// @updateURL    https://raw.githubusercontent.com/F1atSnark/yuketang-lite/main/yuketang-lite.user.js
// @downloadURL  https://raw.githubusercontent.com/F1atSnark/yuketang-lite/main/yuketang-lite.user.js
// @match        *://yuketang.cn/*
// @match        *://*.yuketang.cn/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        GM_notification
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      *
// @run-at       document-start
// @noframes
// @license      MIT
// ==/UserScript==

(() => {
  'use strict';

  const TAG = '[yuketang-lite]';
  const log = (...a) => console.debug(TAG, ...a);

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const fmtTime = (ts) => {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  const clip = (s, n) => { s = String(s == null ? '' : s).trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

  const hashStr = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36);
  };

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const TYPE_LABELS = {
    single: '单选题', multi: '多选题', multiple: '多选题',
    judge: '判断题', bool: '判断题', truefalse: '判断题',
    blank: '填空题', fill: '填空题', gap: '填空题',
    short: '简答题', subjective: '主观题', open: '主观题', answer: '主观题',
    vote: '投票题', poll: '投票题',
  };
  function typeLabel(t) {
    if (t == null || t === '') return '题目';
    if (typeof t === 'number') {
      const m = { 1: '单选题', 2: '多选题', 3: '填空题' };
      return m[t] || `题目(类型${t})`;
    }
    return TYPE_LABELS[String(t).toLowerCase()] || `题目(${t})`;
  }

  const PROVIDERS = {
    openai:      { label: 'OpenAI',       base: 'https://api.openai.com/v1' },
    deepseek:    { label: 'DeepSeek',     base: 'https://api.deepseek.com' },
    bigmodel:    { label: '智谱 AI',      base: 'https://open.bigmodel.cn/api/paas/v4' },
    custom:      { label: '其他兼容接口', base: '' },
  };

  const DEFAULTS = {
    paused: false,
    dotRight: 18,
    dotBottom: 18,
    sound: true,
    desktop: true,
    titleFlash: true,
    ntfyEnabled: false,
    ntfyServer: 'https://ntfy.sh',
    ntfyTopic: '',
    provider: '',
    baseUrl: '',
    apiKey: '',
    textModel: '',
    autoAsk: true,
    debug: false,
  };

  function loadSettings() {
    let saved = {};
    try { saved = JSON.parse(GM_getValue('yuketangLite.settings', '{}')) || {}; } catch {}
    if (!saved.apiKey
      && saved.provider === 'bigmodel'
      && saved.baseUrl === PROVIDERS.bigmodel.base
      && saved.textModel === 'glm-4.5v') {
      saved.provider = '';
      saved.baseUrl = '';
      saved.textModel = '';
    }
    return Object.assign({}, DEFAULTS, saved);
  }
  const S = loadSettings();
  function saveSettings() { GM_setValue('yuketangLite.settings', JSON.stringify(S)); }

  const session = {
    problems: new Map(),
    order: [],
    unread: 0,
    lessonId: null,
    presentationId: null,
    lastFrameAt: 0,
    wsEverSeen: false,
  };
  const knownIds = new Set();
  const debugBuf = [];
  const DEBUG_MAX = 80;

  function pushDebug(kind, url, text) {
    debugBuf.push({ t: Date.now(), kind, url: clip(url, 120), head: clip(text, 1600) });
    if (debugBuf.length > DEBUG_MAX) debugBuf.shift();
  }

  function lessonIdFromURL() {
    const m = location.pathname.match(/lesson\/(?:fullscreen\/v\d+|\w+)\/(\d+)/);
    return m ? m[1] : null;
  }

  let audioCtx = null;
  function ensureAudio() {
    if (audioCtx) { if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {}); return audioCtx; }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    } catch {}
    return audioCtx;
  }
  window.addEventListener('pointerdown', ensureAudio, { capture: true, once: true });
  window.addEventListener('keydown', ensureAudio, { capture: true, once: true });

  function beepOnce(ctx, at, freq) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.22, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.30);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + 0.32);
  }
  function playAlertSound() {
    const ctx = ensureAudio();
    if (!ctx) return false;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const t = ctx.currentTime + 0.02;
    [880, 988, 1175].forEach((f, i) => beepOnce(ctx, t + i * 0.22, f));
    return true;
  }

  let flashTimer = null;
  const TITLE_MARK = '🔔';
  function startTitleFlash() {
    if (!S.titleFlash || flashTimer) return;
    const orig = document.title;
    let on = false;
    flashTimer = setInterval(() => {
      on = !on;
      document.title = on ? `${TITLE_MARK} 有新题目！` : orig;
    }, 900);
    setTimeout(stopTitleFlash, 120000);
  }
  function stopTitleFlash() {
    if (!flashTimer) return;
    clearInterval(flashTimer);
    flashTimer = null;
    if (document.title.startsWith(TITLE_MARK)) {
      document.title = document.title.replace(`${TITLE_MARK} 有新题目！`, '').trim();
    }
  }

  function notifyDesktop(title, text) {
    try {
      GM_notification({ title, text, timeout: 15000, onclick: () => window.focus() });
      return true;
    } catch (e) {
      try {
        if (typeof Notification !== 'undefined') {
          if (Notification.permission === 'default') Notification.requestPermission();
          if (Notification.permission === 'granted') {
            const n = new Notification(title, { body: text });
            n.onclick = () => { window.focus(); n.close(); };
            return true;
          }
        }
      } catch {}
      return false;
    }
  }

  function ntfyValidTopic() { return /^\S{1,64}$/.test(S.ntfyTopic || ''); }
  function ntfyRawPost(url, headers, body) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'POST', url, timeout: 12000, headers, data: body,
        onload: (r) => resolve(r.status >= 200 && r.status < 300 ? true : `HTTP ${r.status}`),
        onerror: () => resolve('网络错误'),
        ontimeout: () => resolve('超时'),
      });
    });
  }
  // Chromium 不接受含中文或 emoji 的自定义请求头；失败时回退到 topic 路径的纯文本请求。
  async function ntfyPush(title, message, opts = {}) {
    if (!S.ntfyEnabled) return { ok: false, detail: 'ntfy 未开启' };
    if (!ntfyValidTopic()) return { ok: false, detail: `topic 无效（不能含空格）: ${JSON.stringify(S.ntfyTopic)}` };
    const server = (S.ntfyServer || 'https://ntfy.sh').replace(/\/+$/, '');
    const json = { topic: S.ntfyTopic, title, message, tags: ['bell'], priority: 'high' };
    if (opts.clickUrl && /^https?:\/\//.test(opts.clickUrl)) {
      json.click = opts.clickUrl;
      json.actions = [{ action: 'view', label: '打开课堂页', url: opts.clickUrl, clear: true }];
    }
    let r = await ntfyRawPost(`${server}/`, { 'Content-Type': 'application/json' }, JSON.stringify(json));
    if (r !== true) {
      r = await ntfyRawPost(`${server}/${encodeURIComponent(S.ntfyTopic)}`, { 'Content-Type': 'text/plain' }, message);
    }
    if (r !== true) {
      console.warn(TAG, 'ntfy 推送失败：', r, 'server=', server, 'topic=', S.ntfyTopic);
      return { ok: false, detail: `${r}（检查 topic 是否正确、网络是否可达）` };
    }
    return { ok: true, detail: '' };
  }

  function ntfyProblemMessage() {
    return `🔔 新题已布置\n✏️ 请返回课堂做答`;
  }

  // 课件包含历史题目，只用于补全内容，不加入实时事件去重集。
  const Presentations = {
    map: new Map(),

    ingest(data, srcUrl) {
      let pid = null;
      try {
        const u = new URL(srcUrl, location.origin);
        pid = u.searchParams.get('presentation_id') || u.searchParams.get('presentation');
      } catch {}
      if (!pid) pid = this.findPid(data) || 'unknown-' + hashStr(JSON.stringify(data).slice(0, 400));
      session.presentationId = pid;
      this.map.set(pid, { data });
      if (S.debug) log('presentation ingested:', pid);
    },

    findPid(node, depth = 0) {
      if (!node || typeof node !== 'object' || depth > 4) return null;
      if (node.presentation_id != null) return String(node.presentation_id);
      if (node.presentationId != null) return String(node.presentationId);
      for (const k of ['data', 'presentation', 'pres']) {
        if (node[k] && typeof node[k] === 'object') {
          const r = this.findPid(node[k], depth + 1);
          if (r) return r;
        }
      }
      return null;
    },

    // strictKey=true 时仅接受明确的题目 ID 字段，避免把课件节点误判为题目。
    collectProblems(node, strictKey, slideAncestor = null, depth = 0, out = []) {
      if (!node || typeof node !== 'object' || depth > 9) return out;
      if (Array.isArray(node)) {
        for (const n of node) this.collectProblems(n, strictKey, slideAncestor, depth + 1, out);
        return out;
      }
      const keys = strictKey ? ['problemId', 'problem_id', 'prob'] : ['problemId', 'problem_id', 'prob', 'sid'];
      let idKey = null;
      for (const k of keys) {
        if (node[k] != null && (typeof node[k] === 'string' || typeof node[k] === 'number')) { idKey = k; break; }
      }
      const isSlide = node.shapes != null || node.imgs != null || node.img != null || node.background != null;
      if (idKey && !isSlide) {
        const looksProblem = node.problemType != null || node.content != null || node.text != null || node.type != null;
        if (looksProblem) out.push({ id: String(node[idKey]), obj: node, slide: slideAncestor });
      }
      const anc = isSlide ? node : slideAncestor;
      for (const k in node) {
        const v = node[k];
        if (v && typeof v === 'object') this.collectProblems(v, strictKey, anc, depth + 1, out);
      }
      return out;
    },

    slideText(slide) {
      if (!slide || typeof slide !== 'object') return '';
      const parts = [];
      const walk = (n, d) => {
        if (!n || typeof n !== 'object' || d > 5) return;
        if (Array.isArray(n)) { n.forEach(x => walk(x, d + 1)); return; }
        for (const k of ['Text', 'text', 'content', 'plainText', 'plain_text']) {
          const v = n[k];
          if (typeof v === 'string' && v.trim()) parts.push(v.trim());
        }
        for (const k in n) {
          const v = n[k];
          if (v && typeof v === 'object') walk(v, d + 1);
        }
      };
      walk(slide, 0);
      return parts.join('\n').slice(0, 2500);
    },

    slideImages(slide) {
      const urls = [];
      if (!slide || typeof slide !== 'object') return urls;
      const seen = new Set();
      const IMG_EXT = /\.(jpe?g|png|webp|gif|bmp)(\?|$)/i;
      const IMG_KEY = /(img|image|pic|background|thumb)/i;
      const walk = (n, keyName, d) => {
        if (!n || typeof n !== 'object' || d > 6) return;
        if (Array.isArray(n)) { n.forEach(x => walk(x, keyName, d + 1)); return; }
        for (const k in n) {
          const v = n[k];
          if (typeof v === 'string') {
            if (/^https?:\/\//i.test(v) && (IMG_EXT.test(v) || IMG_KEY.test(k))) {
              if (!seen.has(v)) { seen.add(v); urls.push({ url: v, key: k }); }
            }
          } else if (v && typeof v === 'object') {
            walk(v, k, d + 1);
          }
        }
      };
      walk(slide, '', 0);
      urls.sort((a, b) => (a.key === 'url' ? -1 : 0) - (b.key === 'url' ? -1 : 0));
      return urls.map(u => u.url);
    },

    lookup(problemId) {
      for (const [, entry] of this.map) {
        const probs = this.collectProblems(entry.data, true);
        const hit = probs.find(p => p.id === problemId);
        if (hit) {
          return {
            text: this.slideText(hit.slide),
            images: this.slideImages(hit.slide),
          };
        }
      }
      return null;
    },

    listProblems() {
      for (const [, entry] of this.map) {
        const probs = this.collectProblems(entry.data, true);
        if (probs.length) return probs;
      }
      return [];
    },
  };

  async function ensurePresentation() {
    const pid = session.presentationId;
    if (!pid || pid.startsWith('unknown-') || Presentations.map.has(pid)) return;
    try {
      const resp = await fetch(`/api/v3/lesson/presentation/fetch?presentation_id=${encodeURIComponent(pid)}`, {
        credentials: 'include',
      });
      if (!resp.ok) return;
      const data = await resp.json();
      if (data) Presentations.ingest(data, location.origin + `/?presentation_id=${pid}`);
    } catch {}
  }

  function eventNameOf(payload) {
    if (!payload || typeof payload !== 'object') return '';
    for (const k of ['op', 'event', 'type', 'action']) {
      const v = payload[k];
      if (typeof v === 'string' && v) return v.toLowerCase().replace(/[^a-z0-9]/g, '');
    }
    return '';
  }

  const PUSH_EVENT_RE = /(?:send|unlock|publish|push|open|new)problem|problem(?:send|unlock|publish|push|open|new)/;

  function extractProblemsFromPayload(payload) {
    const ev = eventNameOf(payload);
    if (!ev.includes('problem')) return { list: [], baseline: [] };
    const isPush = PUSH_EVENT_RE.test(ev);
    const found = Presentations.collectProblems(payload, !isPush);
    return { list: isPush ? found : [], baseline: isPush ? [] : found };
  }

  function contentOf(problemRec) {
    const obj = problemRec.obj || {};
    const parts = [];
    for (const k of ['content', 'text', 'body', 'title', 'question']) {
      if (typeof obj[k] === 'string' && obj[k].trim()) parts.push(obj[k].trim());
    }
    const direct = parts.join('\n');
    const fromPres = Presentations.lookup(problemRec.id);
    const text = [direct, fromPres && fromPres.text].filter(Boolean).join('\n').slice(0, 4000);
    const images = (fromPres && fromPres.images) || [];
    return { text, images, raw: clip(JSON.stringify(obj), 1500) };
  }

  function onWSFrame(url, data) {
    session.lastFrameAt = Date.now();
    session.wsEverSeen = true;
    if (typeof data !== 'string') return;
    const head = data.trimStart()[0];
    if (head !== '{' && head !== '[') return;
    let payload;
    try { payload = JSON.parse(data); } catch (e) { return; }
    if (S.debug) pushDebug('ws', url, data);

    const pid = Presentations.findPid(payload);
    if (pid) session.presentationId = pid;

    const { list, baseline } = extractProblemsFromPayload(payload);
    baseline.forEach(p => knownIds.add(p.id));

    for (const p of list) {
      if (knownIds.has(p.id)) continue;
      knownIds.add(p.id);
      onNewProblem({
        id: p.id,
        type: p.obj.problemType != null ? p.obj.problemType : p.obj.type,
        obj: p.obj,
        slide: p.slide,
        source: 'ws',
      });
    }
  }

  async function onNewProblem(p) {
    const rec = {
      id: p.id,
      type: p.type,
      typeText: typeLabel(p.type),
      obj: p.obj || null,
      slide: p.slide || null,
      source: p.source || 'ws',
      content: { text: '', images: [], raw: p.raw || '' },
      firstSeen: Date.now(),
      aiState: 'idle',
      aiAnswer: '',
      aiReason: '',
      aiError: '',
    };
    if (p.content) {
      rec.content = p.content;
    } else {
      try { rec.content = contentOf(rec); } catch {}
    }
    // 先入列表再补拉课件，避免网络请求延迟首次提醒。
    if (session.problems.has(rec.id)) {
      session.order = session.order.filter(x => x !== rec.id);
    }
    session.problems.set(rec.id, rec);
    session.order.push(rec.id);
    while (session.order.length > 3) {
      session.problems.delete(session.order.shift());
    }
    if (!p.__silent) session.unread++;
    UI.refreshDot();

    if (!p.content && !rec.content.text && !rec.content.images.length) {
      await ensurePresentation();
      try {
        const c2 = contentOf(rec);
        if (c2.text || c2.images.length) rec.content = c2;
      } catch {}
    }

    if ((S.paused && !p.__test) || p.__silent) {
      return rec;
    }
    alertPipeline(rec, { test: !!p.__test, onAlert: p.onAlert });
    return rec;
  }

  async function alertPipeline(rec, opts = {}) {
    const flags = { sound: false, desktop: false, ntfy: null };

    flags.sound = S.sound ? playAlertSound() : false;
    flags.desktop = S.desktop ? notifyDesktop('🔔 雨课堂新题', '新题已布置，请返回课堂做答') : false;
    if (S.titleFlash) startTitleFlash();
    flags.ntfy = (await ntfyPush('🔔 雨课堂新题', ntfyProblemMessage(), { clickUrl: location.href })).ok;
    if (opts.test && opts.onAlert) opts.onAlert(flags);

    if (S.autoAsk || opts.test) {
      askAI(rec).catch(e => log('askAI failed:', e));
    }
    return flags;
  }

  function startDOMFallback() {
    let lastDomAlert = 0;
    setInterval(() => {
      try {
        if (!document.body) return;
        const btns = [...document.querySelectorAll('button, .btn, a')]
          .filter(el => el.offsetParent !== null && /提交答案|立即提交|^(提交|作答)$/.test((el.textContent || '').trim()));
        const hint = [...document.querySelectorAll('div,span,p')]
          .find(el => el.offsetParent !== null && el.children.length === 0 && /请作答|剩余时间|提交答案后不可修改/.test(el.textContent || ''));
        if (btns.length && hint && Date.now() - lastDomAlert > 60000) {
          lastDomAlert = Date.now();
          onNewProblem({
            id: 'dom-' + hashStr(document.title + Date.now()),
            type: null,
            source: 'dom',
          });
        }
      } catch {}
    }, 3000);
  }

  function apiBase() {
    return (S.baseUrl || '').trim().replace(/\/+$/, '');
  }
  function chatEndpoint() {
    const base = apiBase();
    if (!base) return '';
    return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
  }

  function answerPrompt(rec) {
    const lines = [
      `题型：${rec.typeText}`,
      rec.content.text ? `题目：\n${rec.content.text}` : '题目：见图片（请先读图）',
      rec.content.raw && !rec.content.text ? `（结构化数据供参考：${rec.content.raw}）` : '',
      '',
      '请只依据给出的题目内容作答，按以下格式输出：',
      '答案：<选项字母或内容>',
      '理由：<一句话>',
      '不确定时给出最可能的答案并在理由中注明不确定。',
    ];
    return lines.filter(l => l !== '').join('\n');
  }

  function buildMessages(rec, mode) {
    const text = answerPrompt(rec);
    const useImage = mode === 'vision' && rec.content.images.length > 0;
    if (useImage) {
      const content = [{ type: 'text', text }];
      for (const u of rec.content.images.slice(0, 2)) {
        content.push({ type: 'image_url', image_url: { url: u } });
      }
      return [{ role: 'user', content }];
    }
    return [{ role: 'user', content: text }];
  }

  function imageToDataURL(url) {
    return new Promise(async (resolve) => {
      try {
        const resp = await fetch(url, { credentials: 'include' });
        if (!resp.ok) return resolve(null);
        const blob = await resp.blob();
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => resolve(null);
        fr.readAsDataURL(blob);
      } catch (e) { resolve(null); }
    });
  }

  function chatRequest(body, timeoutMs) {
    const url = chatEndpoint();
    if (!url) return Promise.resolve({ ok: false, error: '请先选择接口服务' });
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url,
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${S.apiKey}`,
        },
        data: JSON.stringify(body),
        onload: (r) => {
          let data = null;
          try { data = JSON.parse(r.responseText); } catch {}
          if (r.status >= 200 && r.status < 300 && data) {
            const msg = data && data.choices && data.choices[0] && data.choices[0].message;
            let content = msg && msg.content;
            if (Array.isArray(content)) content = content.map(c => (c && c.text) || '').join('');
            if (typeof content === 'string' && content.trim()) return resolve({ ok: true, content });
            return resolve({ ok: false, error: '模型返回为空' });
          }
          resolve({ ok: false, status: r.status, error: httpErrorText(r.status) });
        },
        onerror: () => resolve({ ok: false, error: '网络错误（检查接口地址 / 网络代理）' }),
        ontimeout: () => resolve({ ok: false, error: '请求超时' }),
      });
    });
  }

  function httpErrorText(status) {
    if (status === 401 || status === 403) return 'API key 无效或无权限（检查设置里的 key）';
    if (status === 400 || status === 422) return '请求被拒绝：若这是图片题，可能是当前模型不支持看图，换一个支持视觉的型号（如 gpt-4o / glm-4.5v）';
    if (status === 429) return '调用过于频繁（限流），稍后点「重新识别」';
    if (status >= 500) return `服务端错误(${status})，稍后重试`;
    return `请求失败(HTTP ${status})`;
  }

  function parseAIAnswer(content) {
    const c = String(content).trim();
    let answer = '', reason = '';
    const am = c.match(/答案[:：]\s*([\s\S]*?)(?:\n|$)/i);
    const rm = c.match(/理由[:：]\s*([\s\S]*?)(?:\n|$)/i);
    if (am) answer = am[1].trim();
    if (rm) reason = rm[1].trim();
    if (!answer && !reason) { answer = c.slice(0, 300); }
    return { answer, reason };
  }

  async function askAI(rec) {
    if (!apiBase()) {
      rec.aiState = 'error';
      rec.aiError = '请先在设置中选择接口服务';
      UI.refreshQuestionView(rec.id);
      return rec;
    }
    if (!S.apiKey) {
      rec.aiState = 'error';
      rec.aiError = '还没有填 API key，请到设置里配置';
      UI.refreshQuestionView(rec.id);
      return rec;
    }
    if (!S.textModel) {
      rec.aiState = 'error';
      rec.aiError = '请先填写或选择模型';
      UI.refreshQuestionView(rec.id);
      return rec;
    }
    rec.aiState = 'running';
    rec.aiError = '';
    UI.refreshQuestionView(rec.id);

    const wantVision = rec.content.images.length > 0;
    const model = S.textModel;
    const mode = wantVision ? 'vision' : 'text';
    let body = { model, messages: buildMessages(rec, mode), temperature: 0, stream: false };
    let res = await chatRequest(body, wantVision ? 60000 : 30000);

    // 登录态图片无法由模型直取时，回退为内存中的 base64。
    if (!res.ok && wantVision && res.error && /被拒绝|为空|网络/.test(res.error)) {
      const b64s = [];
      for (const u of rec.content.images.slice(0, 1)) {
        const d = await imageToDataURL(u);
        if (d) b64s.push(d);
      }
      if (b64s.length) {
        rec.content.images = b64s;
        body = { model, messages: buildMessages(rec, 'vision'), temperature: 0, stream: false };
        res = await chatRequest(body, 60000);
      }
    }
    if (!res.ok) {
      await sleep(1200);
      res = await chatRequest(body, wantVision ? 60000 : 30000);
    }

    if (res.ok) {
      const { answer, reason } = parseAIAnswer(res.content);
      rec.aiState = 'done';
      rec.aiAnswer = answer;
      rec.aiReason = reason;
    } else {
      rec.aiState = 'error';
      rec.aiError = res.error || '未知错误';
    }
    UI.refreshQuestionView(rec.id);
    return rec;
  }

  async function testConnection() {
    if (!apiBase()) return { ok: false, msg: '请先选择接口服务' };
    if (!S.apiKey) return { ok: false, msg: '请先填写 API key' };
    if (!S.textModel) return { ok: false, msg: '请先填写或选择模型' };
    const res = await chatRequest({
      model: S.textModel,
      messages: [{ role: 'user', content: '请只回复两个字：正常' }],
      max_tokens: 16, temperature: 0, stream: false,
    }, 15000);
    return res.ok ? { ok: true, msg: '连接正常' } : { ok: false, msg: res.error };
  }

  let modelListCache = null;
  function fetchModels() {
    return new Promise((resolve) => {
      if (!S.apiKey) return resolve({ ok: false, msg: '请先填写 API key' });
      const base = apiBase();
      if (!base) return resolve({ ok: false, msg: '请先选择接口服务' });
      const url = /\/models$/.test(base) ? base : `${base}/models`;
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: 15000,
        headers: { 'Authorization': `Bearer ${S.apiKey}` },
        onload: (r) => {
          let d = null;
          try { d = JSON.parse(r.responseText); } catch {}
          const ids = d && d.data && Array.isArray(d.data)
            ? d.data.map(m => (m && (m.id || m.model || m.name))).filter(Boolean)
            : null;
          if (r.status >= 200 && r.status < 300 && ids && ids.length) {
            modelListCache = ids;
            return resolve({ ok: true, msg: `获取到 ${ids.length} 个模型，已切换为下拉选择` });
          }
          if (r.status === 401 || r.status === 403) return resolve({ ok: false, msg: 'key 无效或无权限' });
          resolve({ ok: false, msg: `该接口不提供模型列表(HTTP ${r.status})，请手动输入模型名` });
        },
        onerror: () => resolve({ ok: false, msg: '网络错误' }),
        ontimeout: () => resolve({ ok: false, msg: '请求超时' }),
      });
    });
  }

  async function runSelfTest() {
    const steps = [
      { name: '课堂数据', ok: null, detail: '' },
      { name: '真实题目识别', ok: null, detail: '' },
      { name: '提醒通道', ok: null, detail: '' },
    ];
    UI.showTestResult(steps, null);

    const pid = session.presentationId;
    if (!pid || !Presentations.map.has(pid)) await ensurePresentation();
    const probs = Presentations.listProblems();
    if (Presentations.map.size > 0) {
      steps[0].ok = true;
      steps[0].detail = `课件已就绪，共 ${probs.length} 道题`;
    } else {
      steps[0].ok = 'skip';
      steps[0].detail = '未进课堂，无课堂数据（不影响提醒功能；进课堂页打开 PPT 后可测真实题目）';
    }
    UI.showTestResult(steps, null);

    let rec = null;
    let fromWhere = '';
    if (steps[0].ok === true) {
      for (let i = session.order.length - 1; i >= 0; i--) {
        const r = session.problems.get(session.order[i]);
        if (r && r.source !== 'test' && r.source !== 'courseware' && r.source !== 'demo' && (r.content.text || r.content.images.length)) {
          rec = r;
          break;
        }
      }
      fromWhere = '已捕获题目';
      if (!rec && probs.length) {
        const p = probs[0];
        rec = await onNewProblem({
          id: p.id,
          type: p.obj.problemType != null ? p.obj.problemType : p.obj.type,
          obj: p.obj,
          slide: p.slide,
          source: 'courseware',
          __silent: true,
        });
        fromWhere = '取自课件';
      }
    } else {
      rec = await onNewProblem({
        id: 'test-sample-' + Date.now(),
        type: 'single',
        source: 'test',
        __silent: true,
        content: {
          text: '（示例题）脚本自检：下列关于本脚本的说法哪个是正确的？\nA. 本脚本会代替我自动提交答案\nB. 本脚本只读监听提醒，并生成参考答案供对照\nC. 本脚本会修改我的上行请求\nD. 本脚本会把 API key 上传到服务器',
          images: [],
          raw: '',
        },
      });
      fromWhere = '内置示例题（未进课堂）';
    }
    if (rec) {
      steps[1].detail = `${fromWhere}：${clip(rec.content.text.replace(/\s+/g, ' ') || '图片题', 26)}`;
      UI.showTestResult(steps, rec);
      await askAI(rec);
      steps[1].ok = rec.aiState === 'done';
      steps[1].detail += rec.aiState === 'done'
        ? ` → 参考答案：${clip(rec.aiAnswer, 30)}`
        : ` → ${rec.aiError}`;
    } else {
      steps[1].ok = 'skip';
      steps[1].detail = '当前课件里没有题目，跳过（不影响正常监控）';
    }
    UI.showTestResult(steps, rec);

    const soundOk = S.sound ? playAlertSound() : false;
    const deskOk = S.desktop ? notifyDesktop('🔍 自检通知', '看到这条通知并听到提示音，说明提醒通道正常。') : false;
    steps[2].ok = !!(soundOk || deskOk);
    steps[2].detail = [soundOk ? '声音' : null, deskOk ? '桌面通知' : null].filter(Boolean).join(' + ')
      || '均未触发（检查设置里的提醒开关，并在页面上点击过一次以解锁声音）';
    UI.showTestResult(steps, rec);
    return steps;
  }

  function makeDemoImage() {
    const c = document.createElement('canvas');
    c.width = 320; c.height = 220;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#111111';
    g.font = '28px sans-serif';
    g.fillText('模拟题：图中字母是？', 20, 50);
    g.font = 'bold 110px sans-serif';
    g.fillText('B', 125, 180);
    return c.toDataURL('image/png');
  }

  async function runDemo() {
    await onNewProblem({
      id: 'demo-' + Date.now(),
      type: 'single',
      source: 'demo',
      __test: true,
      content: {
        text: '（模拟）这是一道演示题，用于在无课时验证提醒与 AI 识别全流程。\n图中字母对应的选项是？\nA. A    B. B    C. C    D. D',
        images: [makeDemoImage()],
        raw: '',
      },
    });
    UI.openPanel();
  }

  const UI = (() => {
    let host = null, root = null;
    let view = 'home';
    let viewingId = null;
    let dotEl = null, panelEl = null, panelOpen = false;
    const uiState = {
      textModelCustom: false,
      modelsMsg: '',
    };

    const CSS = `
      :host { all: initial; }
      * { box-sizing: border-box; font-family: system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; }
      .bar {
        position: fixed; right: 18px; bottom: 18px; z-index: 2147483000;
        display: inline-flex; align-items: center; gap: 8px;
        padding: 9px 12px; border-radius: 22px;
        background: #1e293b; color: #fff; border: none; cursor: pointer;
        box-shadow: 0 6px 18px rgba(0,0,0,.32);
        font-size: 13px; font-weight: 600; line-height: 1;
        user-select: none; touch-action: none; padding: 9px 10px 9px 14px;
      }
      .bar .logo { font-size: 15px; }
      .bar .ttl { letter-spacing: .3px; }
      .bar .sdot { width: 10px; height: 10px; border-radius: 50%; background: #22c55e; flex: none; }
      .bar.paused .sdot { background: #f59e0b; }
      .bar.idle .sdot { background: #94a3b8; }
      .bar .tg {
        width: 24px; height: 24px; border-radius: 7px; margin-left: 2px;
        background: rgba(255,255,255,.16); color: #fff;
        font-size: 14px; line-height: 24px; text-align: center; flex: none;
      }
      .bar .badge {
        position: absolute; top: -7px; left: -7px; min-width: 18px; height: 18px;
        background: #ef4444; color: #fff; border-radius: 9px; font-size: 11px;
        line-height: 18px; text-align: center; padding: 0 4px; display: none;
        font-weight: 700;
      }
      .panel {
        position: fixed; right: 18px; bottom: 68px; z-index: 2147483000;
        width: 312px; max-height: min(560px, 70vh);
        display: flex; flex-direction: column; overflow: hidden;
        background: #fff; color: #1e293b; border-radius: 16px;
        box-shadow: 0 12px 44px rgba(0,0,0,.30); font-size: 13px;
      }
      @media (prefers-color-scheme: dark) {
        .panel { background: #1e293b; color: #e2e8f0; box-shadow: 0 12px 44px rgba(0,0,0,.55); }
        .q-item:hover { background: #334155 !important; }
        .muted { color: #94a3b8 !important; }
        .head { border-color: #334155 !important; }
        .sec { color: #7dd3fc !important; border-color: #334155 !important; }
        .qtext, .ai-box { background: #0f172a !important; }
        textarea, input, select { background: #0f172a !important; color: #e2e8f0 !important; border-color: #475569 !important; }
        textarea:focus, input:focus, select:focus { border-color: #38bdf8 !important; outline: none; }
        select option { background: #0f172a; color: #e2e8f0; }
        .chk input[type="checkbox"] { accent-color: #38bdf8; }
        .chk input[type="checkbox"]:not(:checked) { background: #0f172a; border: 1px solid #475569; }
      }
      .head {
        display: flex; align-items: center; gap: 6px; flex: none;
        padding: 9px 12px; border-bottom: 1px solid rgba(128,128,128,.18);
        font-weight: 600; font-size: 13px; background: inherit; border-radius: 16px 16px 0 0;
      }
      .head .grow { flex: 1; }
      .icon-btn {
        border: none; background: transparent; cursor: pointer; font-size: 14px;
        padding: 2px 7px; border-radius: 8px; color: inherit;
      }
      .icon-btn:hover { background: rgba(128,128,128,.15); }
      .body { padding: 9px 12px 12px; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: rgba(128,128,128,.45) transparent; }
      .body::-webkit-scrollbar { width: 8px; }
      .body::-webkit-scrollbar-track { background: transparent; }
      .body::-webkit-scrollbar-thumb { background: rgba(128,128,128,.35); border-radius: 4px; }
      .body::-webkit-scrollbar-thumb:hover { background: rgba(128,128,128,.55); }
      .row { display: flex; gap: 6px; align-items: center; margin: 6px 0; flex-wrap: wrap; }
      .row.grid4 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
      .row.grid4 .act { width: 100%; text-align: center; padding: 5px 8px; }
      button.act {
        border: 1px solid rgba(128,128,128,.35); background: transparent; color: inherit;
        border-radius: 8px; padding: 4px 10px; cursor: pointer; font-size: 12.5px;
      }
      button.act:hover { background: rgba(59,130,246,.12); border-color: #3b82f6; }
      button.act.primary { background: #3b82f6; border-color: #3b82f6; color: #fff; }
      button.act.primary:hover { background: #2563eb; }
      .muted { color: #64748b; font-size: 12px; }
      .status-line { margin: 1px 0 7px; }
      .q-item {
        display: flex; gap: 8px; align-items: center; padding: 5px 7px;
        border-radius: 8px; cursor: pointer;
      }
      .q-item:hover { background: rgba(59,130,246,.08); }
      .q-item .t { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ai-box {
        background: rgba(59,130,246,.07); border-radius: 10px; padding: 8px 10px; margin: 8px 0;
        white-space: pre-wrap; word-break: break-word; line-height: 1.5;
      }
      .ai-box.err { background: rgba(239,68,68,.10); color: #dc2626; }
      .qimg { max-width: 100%; max-height: 180px; border-radius: 8px; display: block; margin: 6px 0; cursor: zoom-in; }
      .qtext {
        white-space: pre-wrap; word-break: break-word; line-height: 1.5;
        max-height: 140px; overflow-y: auto; background: rgba(128,128,128,.08);
        border-radius: 8px; padding: 8px 10px; margin: 6px 0;
      }
      label.fld { display: block; margin: 9px 0 4px; font-weight: 600; font-size: 12px; }
      textarea, input, select {
        width: 100%; padding: 8px 10px; border: 1px solid rgba(128,128,128,.4);
        border-radius: 10px; font-size: 13px; background: transparent; color: inherit;
        outline: none; transition: border-color .15s;
      }
      textarea:focus, input:focus, select:focus { border-color: #3b82f6; }
      select { cursor: pointer; }
      .chk { display: flex; align-items: center; gap: 8px; margin: 6px 0; cursor: pointer; }
      .chk input { width: auto; accent-color: #3b82f6; cursor: pointer; }
      .chk input[type="checkbox"] { width: 16px; height: 16px; }
      .sec { margin: 12px 0 5px; padding-top: 9px; border-top: 1px dashed rgba(128,128,128,.3); font-weight: 700; font-size: 12px; color: #3b82f6; }
      .body > .sec:first-child { margin-top: 1px; padding-top: 0; border-top: none; }
      .step { display: flex; gap: 8px; margin: 5px 0; align-items: center; }
      .step .ic { width: 20px; text-align: center; }
      .back { cursor: pointer; }
    `;

    let dotPos = { right: 18, bottom: 18 };
    const clampNum = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    function setDotPos(r, b) {
      dotPos = { right: r, bottom: b };
      dotEl.style.right = r + 'px';
      dotEl.style.bottom = b + 'px';
    }
    function positionPanel() {
      if (!panelEl) return;
      panelEl.style.right = clampNum(dotPos.right, 8, Math.max(8, window.innerWidth - 346)) + 'px';
      panelEl.style.bottom = clampNum(dotPos.bottom + 50, 8, Math.max(8, window.innerHeight - 160)) + 'px';
    }

    function ensureHost() {
      if (host) return;
      host = document.createElement('div');
      host.id = 'yuketang-lite-host';
      root = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = CSS;
      root.appendChild(style);
      dotEl = document.createElement('button');
      dotEl.className = 'bar';
      dotEl.title = '雨课堂助手 · 点击展开，可拖动';
      dotEl.innerHTML = `
        <span class="logo">💬</span>
        <span class="ttl">雨课堂助手</span>
        <span class="sdot"></span>
        <span class="tg">−</span>
        <span class="badge"></span>`;
      setDotPos(clampNum(Number(S.dotRight) || 18, 4, 9999), clampNum(Number(S.dotBottom) || 18, 4, 9999));
      let drag = null;
      dotEl.addEventListener('pointerdown', (e) => {
        if (e.button != null && e.button !== 0) return;
        drag = { sx: e.clientX, sy: e.clientY, r0: dotPos.right, b0: dotPos.bottom, moved: false };
        try { dotEl.setPointerCapture(e.pointerId); } catch {}
        e.preventDefault();
      });
      dotEl.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
        drag.moved = true;
        setDotPos(
          clampNum(drag.r0 - dx, 4, Math.max(4, window.innerWidth - 220)),
          clampNum(drag.b0 - dy, 4, Math.max(4, window.innerHeight - 52)),
        );
        if (panelOpen) positionPanel();
      });
      dotEl.addEventListener('pointerup', () => {
        if (!drag) return;
        const moved = drag.moved;
        drag = null;
        if (moved) {
          S.dotRight = dotPos.right;
          S.dotBottom = dotPos.bottom;
          saveSettings();
        } else {
          togglePanel();
        }
      });
      dotEl.addEventListener('pointercancel', () => { drag = null; });
      root.appendChild(dotEl);
      panelEl = document.createElement('div');
      panelEl.className = 'panel';
      panelEl.style.display = 'none';
      root.appendChild(panelEl);
      (document.body || document.documentElement).appendChild(host);
    }

    // React 路由切换可能清空 body；保留已创建的 Shadow DOM 并重新挂载宿主。
    function mountGuard() {
      if (!host) return;
      if (!host.isConnected) {
        (document.body || document.documentElement).appendChild(host);
        if (S.debug) log('host re-attached');
      }
    }

    function dotStatus() {
      if (S.paused) return { cls: 'paused', color: '#f59e0b' };
      const age = session.lastFrameAt ? Date.now() - session.lastFrameAt : Infinity;
      if (!session.wsEverSeen) return { cls: 'idle', color: '#94a3b8' };
      if (age < 90000) return { cls: '', color: '#22c55e' };
      return { cls: 'idle', color: '#94a3b8' };
    }

    function refreshDot() {
      if (!root) return;
      const st = dotStatus();
      dotEl.className = 'bar ' + st.cls;
      const sdot = dotEl.querySelector('.sdot');
      if (sdot) sdot.style.background = st.color;
      const badge = dotEl.querySelector('.badge');
      if (badge) {
        if (session.unread > 0 && !panelOpen) {
          badge.style.display = 'block';
          badge.textContent = session.unread > 99 ? '99+' : String(session.unread);
        } else {
          badge.style.display = 'none';
        }
      }
    }

    function togglePanel() {
      panelOpen = !panelOpen;
      if (panelOpen) {
        session.unread = 0;
        stopTitleFlash();
        view = 'home';
        positionPanel();
        render();
      }
      panelEl.style.display = panelOpen ? 'flex' : 'none';
      refreshDot();
    }
    function closePanel() { panelOpen = false; panelEl.style.display = 'none'; refreshDot(); }

    function render() {
      if (!root) return;
      const h = [];
      if (view === 'home') renderHome(h);
      else if (view === 'settings') renderSettings(h);
      else if (view === 'question') renderQuestion(h);
      else if (view === 'test') renderTest(h);
      panelEl.innerHTML = h.join('');
      bindEvents();
      refreshDot();
    }

    function headHTML(title, showSettings) {
      return `<div class="head">
        ${view === 'home' ? '' : '<span class="icon-btn back" data-act="back">←</span>'}
        <span>${esc(title)}</span><span class="grow"></span>
        ${showSettings ? '<button class="icon-btn" data-act="settings" title="设置">⚙</button>' : ''}
        <button class="icon-btn" data-act="close" title="收起">✕</button>
      </div>`;
    }

    function renderHome(h) {
      const lid = session.lessonId || lessonIdFromURL();
      const stText = S.paused ? '已暂停（仍在静默记录）' : (session.wsEverSeen ? '监控中' : '待机（未检测到课堂通道）');
      h.push(headHTML('雨课堂小助手', true));
      h.push(`<div class="body">`);
      h.push(`<div class="muted status-line">状态：${esc(stText)}${lid ? ` · 课堂 ${esc(lid)}` : ''}${S.apiKey ? '' : ' · AI 未配置（提醒不受影响）'}</div>`);
      h.push(`<div class="row grid4">
        <button class="act" data-act="pause">${S.paused ? '▶ 继续' : '⏸ 暂停'}</button>
        <button class="act" data-act="test-notify">🔔 测试通知</button>
        <button class="act" data-act="test">🔍 测试答题</button>
        <button class="act" data-act="demo">🎭 模拟来题</button>
      </div>`);
      const ids = [...session.order].reverse();
      h.push(`<div class="muted" style="margin:8px 0 2px">本次课堂（${session.order.length}）</div>`);
      if (!ids.length) h.push(`<div class="muted" style="padding:4px 8px">还没有收到题目。老师发题后会出现在这里。</div>`);
      for (const id of ids) {
        const r = session.problems.get(id);
        const ic = r.aiState === 'done' ? '✅' : r.aiState === 'running' ? '⏳' : r.aiState === 'error' ? '⚠️' : '🆕';
        h.push(`<div class="q-item" data-q="${esc(id)}">
          <span>${ic}</span>
          <span class="t">${esc(r.typeText)} · ${esc(clip(r.content.text.replace(/\s+/g, ' ') || (r.content.images.length ? '图片题' : '内容待提取'), 22))}</span>
          <span class="muted">${fmtTime(r.firstSeen)}</span>
        </div>`);
      }
      h.push(`</div>`);
    }

    function renderQuestion(h) {
      const r = session.problems.get(viewingId);
      if (!r) { view = 'home'; return render(h); }
      h.push(headHTML(`🔔 ${esc(r.typeText)}`, false));
      h.push(`<div class="body">`);
      h.push(`<div class="muted">来源：${r.source === 'test' ? '自测' : r.source === 'dom' ? '页面检测' : '实时通道'} · ${fmtTime(r.firstSeen)}</div>`);
      if (r.content.images.length) {
        h.push(`<img class="qimg" src="${esc(r.content.images[0])}" alt="题目图片">`);
      }
      if (r.content.text) h.push(`<div class="qtext">${esc(r.content.text)}</div>`);
      if (!r.content.text && !r.content.images.length) {
        h.push(`<div class="qtext muted">未能自动提取题目内容。请直接在课堂页面或手机上查看题目；下方结构化数据仍可提供给 AI 参考。</div>`);
        if (r.content.raw) h.push(`<div class="qtext muted" style="max-height:80px;font-size:11px">${esc(r.content.raw)}</div>`);
      }
      if (r.aiState === 'running') h.push(`<div class="ai-box">AI 识别中…</div>`);
      else if (r.aiState === 'done') {
        h.push(`<div class="ai-box"><b>参考答案：${esc(r.aiAnswer)}</b>${r.aiReason ? `\n理由：${esc(r.aiReason)}` : ''}</div>`);
      } else if (r.aiState === 'error') {
        h.push(`<div class="ai-box err">识别失败：${esc(r.aiError)}</div>`);
      } else {
        h.push(`<div class="ai-box muted">未识别。点下方「重新识别」可调用 AI 生成参考答案。</div>`);
      }
      h.push(`<div class="row">
        <button class="act primary" data-act="retry">🔄 重新识别</button>
        ${r.aiState === 'done' ? '<button class="act" data-act="copy">📋 复制答案</button>' : ''}
      </div>`);
      h.push(`<div class="muted" style="margin-top:8px">参考答案仅供对照学习，请在课堂页面/手机上自行作答提交。</div>`);
      h.push(`</div>`);
    }

    function modelFieldHTML(key, labelText) {
      const isCustom = uiState[key + 'Custom'];
      const val = S[key] || '';
      let control;
      if (modelListCache && !isCustom) {
        const opts = ids => ids.map(id => `<option value="${esc(id)}" ${id === val ? 'selected' : ''}>${esc(id)}</option>`).join('');
        control = `<select data-k="${key}"><option value="__custom__">✏️ 手动输入…</option>${opts([...modelListCache])}</select>`;
      } else {
        control = `<input data-k="${key}" value="${esc(val)}" placeholder="输入模型名，或先获取模型列表">`;
      }
      return `<label class="fld">${labelText}</label>${control}`;
    }

    function renderSettings(h) {
      h.push(headHTML('设置', false));
      h.push(`<div class="body">`);
      h.push(`<div class="sec">提醒</div>`);
      h.push(`<label class="chk"><input type="checkbox" data-k="sound" ${S.sound ? 'checked' : ''}> 提示音</label>`);
      h.push(`<label class="chk"><input type="checkbox" data-k="desktop" ${S.desktop ? 'checked' : ''}> Windows 桌面通知</label>`);
      h.push(`<label class="chk"><input type="checkbox" data-k="titleFlash" ${S.titleFlash ? 'checked' : ''}> 标签页标题闪烁</label>`);
      h.push(`<label class="chk"><input type="checkbox" data-k="ntfyEnabled" ${S.ntfyEnabled ? 'checked' : ''}> ntfy 推送到手机</label>`);
      h.push(`<label class="fld">ntfy 服务器</label><input data-k="ntfyServer" value="${esc(S.ntfyServer)}" placeholder="https://ntfy.sh">`);
      h.push(`<label class="fld">ntfy topic</label><input data-k="ntfyTopic" value="${esc(S.ntfyTopic)}" placeholder="例如 yuketang-a8K3mP7x">`);
      h.push(`<div class="muted">填写手机 ntfy App 中订阅的 topic。请使用随机名称并妥善保管。</div>`);
      h.push(`<div class="row"><button class="act" data-act="ntfy-test">🔔 测试推送</button><span id="ntfy-out" class="muted"></span></div>`);

      h.push(`<div class="sec">AI 识别</div>`);
      h.push(`<label class="fld">接口服务</label>
        <select data-k="provider">
          <option value="" ${S.provider ? '' : 'selected'}>请选择接口服务</option>
          ${Object.entries(PROVIDERS).map(([k, v]) => `<option value="${k}" ${S.provider === k ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}
        </select>`);
      if (S.provider === 'custom') {
        h.push(`<label class="fld">接口地址</label><input data-k="baseUrl" value="${esc(S.baseUrl)}" placeholder="https://example.com/v1">`);
      }
      h.push(`<label class="fld">API key</label>
        <input data-k="apiKey" type="password" value="${esc(S.apiKey)}" placeholder="填写当前接口的 API key">`);
      h.push(`<div class="muted">API key 仅保存在 Tampermonkey 本地存储中。</div>`);
      h.push(modelFieldHTML('textModel', '模型'));
      h.push(`<div class="row">
        <button class="act" data-act="fetch-models">🔄 获取模型列表</button>
        <button class="act" data-act="conn-test">测试连接</button>
      </div>`);
      if (uiState.modelsMsg) h.push(`<div class="muted">${esc(uiState.modelsMsg)}</div>`);
      h.push(`<label class="chk"><input type="checkbox" data-k="autoAsk" ${S.autoAsk ? 'checked' : ''}> 来题自动调用 AI 识别</label>`);

      h.push(`<div class="sec">其他</div>`);
      h.push(`<label class="chk"><input type="checkbox" data-k="debug" ${S.debug ? 'checked' : ''}> 调试日志（记录原始帧）</label>`);
      h.push(`<div class="row"><button class="act" data-act="copy-log">📋 复制调试日志</button></div>`);
      h.push(`<div class="muted" style="margin-top:10px">改动即时保存。遇到漏报/误报时，开调试日志后把日志内容发给维护者即可定位协议差异。</div>`);
      h.push(`</div>`);
    }

    function renderTest(h) {
      h.push(headHTML('🔍 自检', false));
      h.push(`<div class="body">`);
      if (UI._testSteps) {
        for (const s of UI._testSteps) {
          const ic = s.ok === true ? '✅' : s.ok === false ? '❌' : s.ok === 'skip' ? '⏭' : '⏳';
          h.push(`<div class="step"><span class="ic">${ic}</span><span>${esc(s.name)}${s.detail ? ` — <span class="muted">${esc(s.detail)}</span>` : ''}</span></div>`);
        }
      }
      if (UI._testRec) {
        const r = UI._testRec;
        if (r.content.images.length) {
          h.push(`<img class="qimg" src="${esc(r.content.images[0])}" alt="题目图片">`);
        }
        if (r.content.text) h.push(`<div class="qtext">${esc(clip(r.content.text, 300))}</div>`);
        h.push(`<div class="ai-box ${r.aiState === 'error' ? 'err' : ''}">${r.aiState === 'done'
          ? `参考答案：${esc(r.aiAnswer)}${r.aiReason ? `\n理由：${esc(r.aiReason)}` : ''}`
          : r.aiState === 'error' ? esc(r.aiError) : 'AI 识别中…'}</div>`);
      }
      h.push(`<div class="muted">在课堂页测试时，第 2 步会用课件里的真实题目调 AI；在主界面等无课堂数据的页面，会自动改用内置示例题验证 AI 链路（第 1 步显示 ⏭ 属正常）。第 3 步若失败：检查浏览器/系统通知权限，并先在页面上点击任意位置（解锁声音）。</div>`);
      h.push(`<div class="row"><button class="act" data-act="test-again">再测一次</button><button class="act" data-act="back">返回</button></div>`);
      h.push(`</div>`);
    }

    function copyText(text) {
      if (typeof GM_setClipboard === 'function') { GM_setClipboard(text); return; }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
      } else fallbackCopy(text);
    }
    function fallbackCopy(text) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch {}
      ta.remove();
    }

    function bindEvents() {
      panelEl.querySelectorAll('[data-act]').forEach(el => {
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const act = el.dataset.act;
          if (act === 'close') closePanel();
          else if (act === 'back') { view = 'home'; render(); }
          else if (act === 'settings') { view = 'settings'; render(); }
          else if (act === 'pause') {
            S.paused = !S.paused; saveSettings(); refreshDot(); render();
          } else if (act === 'test-notify') {
            const ok1 = S.sound ? playAlertSound() : false;
            const ok2 = S.desktop ? notifyDesktop('🔔 测试通知', '声音与通知正常') : false;
            if (S.titleFlash) startTitleFlash();
            ntfyPush('ntfy 测试', '✅ ntfy 推送配置成功', { clickUrl: location.href })
              .then((res) => {
                if (!ok1 && !ok2 && !res.ok) {
                  alert(`三个提醒通道均未触发：请检查设置里的开关、浏览器通知权限、ntfy 配置（${res.detail}），并先在页面上点击任意位置以解锁声音。`);
                }
              });
          } else if (act === 'demo') { runDemo(); }
          else if (act === 'test' || act === 'test-again') { runSelfTest(); }
          else if (act === 'retry') {
            const r = session.problems.get(viewingId);
            if (r) askAI(r);
          } else if (act === 'copy') {
            const r = session.problems.get(viewingId);
            if (r) copyText(`答案：${r.aiAnswer}${r.aiReason ? `\n理由：${r.aiReason}` : ''}`);
          } else if (act === 'fetch-models') {
            uiState.modelsMsg = '获取中…'; render();
            fetchModels().then(r => {
              uiState.modelsMsg = r.msg;
              if (r.ok) { uiState.textModelCustom = false; }
              render();
            });
          } else if (act === 'ntfy-test') {
            const out = panelEl.querySelector('#ntfy-out');
            const commitTopic = panelEl.querySelector('input[data-k="ntfyTopic"]');
            if (commitTopic) { S.ntfyTopic = commitTopic.value.trim(); saveSettings(); }
            if (out) out.textContent = '推送中…';
            ntfyPush('ntfy 测试', '✅ ntfy 推送配置成功').then((res) => {
              if (out) out.textContent = res.ok ? '✅ 已发出，请看手机' : `❌ ${res.detail}`;
            });
          } else if (act === 'conn-test') {
            uiState.modelsMsg = '测试连接中…'; render();
            testConnection().then(r => { uiState.modelsMsg = r.msg; render(); });
          } else if (act === 'copy-log') {
            copyText(debugLogText());
          }
        });
      });
      panelEl.querySelectorAll('[data-q]').forEach(el => {
        el.addEventListener('click', () => {
          viewingId = el.dataset.q;
          view = 'question';
          render();
        });
      });
      panelEl.querySelectorAll('input[data-k], select[data-k]').forEach(el => {
        const k = el.dataset.k;
        const commit = () => {
          const previous = S[k];
          if (el.type === 'checkbox') { S[k] = el.checked; }
          else {
            let v = el.value.trim();
            if (k === 'textModel' && v === '__custom__') {
              uiState[k + 'Custom'] = true;
              saveSettings();
              render();
              return;
            }
            S[k] = v;
          }
          if (k === 'provider') {
            S.baseUrl = PROVIDERS[S.provider] ? PROVIDERS[S.provider].base : '';
            if (previous !== S.provider) {
              S.textModel = '';
              modelListCache = null;
              uiState.textModelCustom = false;
            }
          }
          saveSettings();
          if (k === 'provider') render();
        };
        el.addEventListener('change', commit);
      });
      panelEl.querySelectorAll('.qimg').forEach(el => {
        el.addEventListener('click', () => { window.open(el.src, '_blank'); });
      });
    }

    function showTestResult(steps, rec) {
      UI._testSteps = steps;
      UI._testRec = rec;
      panelOpen = true;
      view = 'test';
      panelEl.style.display = 'flex';
      render();
    }

    function refreshQuestionView(id) {
      if (panelOpen && view === 'question' && viewingId === id) render();
      else refreshDot();
    }

    function renderIfOpen() { if (panelOpen) render(); }

    function openPanel() { if (!panelOpen) togglePanel(); }

    function debugLogText() {
      const head = `yuketang-lite 调试日志 @ ${new Date().toISOString()} url=${location.href}\n`;
      return head + debugBuf.map(d => `[${new Date(d.t).toLocaleTimeString()}] ${d.kind} ${d.url}\n${d.head}\n---`).join('\n');
    }

    setInterval(() => { if (root) { refreshDot(); mountGuard(); } }, 1000);
    window.addEventListener('resize', () => { if (panelOpen) positionPanel(); });

    return {
      init() { ensureHost(); refreshDot(); },
      refreshDot,
      refreshQuestionView,
      showTestResult,
      renderIfOpen,
      openPanel,
      debugLogText,
    };
  })();

  function installWSHook() {
    try {
      const PageWS = unsafeWindow.WebSocket;
      if (!PageWS) return;
      class HookedWS extends PageWS {
        constructor(url, protocols) {
          super(url, protocols);
          try {
            this.addEventListener('message', (ev) => {
              try { onWSFrame(String(url), ev.data); } catch (e) { if (S.debug) log('ws frame error', e); }
            });
          } catch {}
        }
      }
      unsafeWindow.WebSocket = HookedWS;
      log('WebSocket hook installed');
    } catch (e) {
      log('WebSocket hook failed:', e);
    }
  }

  function installFetchHook() {
    try {
      const orig = unsafeWindow.fetch;
      if (!orig) return;
      const hooked = function (input, init) {
        const p = orig.apply(this, arguments);
        try {
          const url = typeof input === 'string' ? input : (input && input.url) || '';
          if (String(url).includes('presentation/fetch')) {
            p.then((res) => {
              try { res.clone().json().then((j) => Presentations.ingest(j, url)).catch(() => {}); } catch {}
            }).catch(() => {});
          }
        } catch {}
        return p;
      };
      unsafeWindow.fetch = hooked;
      log('fetch hook installed');
    } catch (e) {
      log('fetch hook failed:', e);
    }
  }

  function installXHRHook() {
    try {
      const xp = unsafeWindow.XMLHttpRequest.prototype;
      const origOpen = xp.open, origSend = xp.send;
      xp.open = function (method, url, ...rest) {
        this.__yuketangUrl = String(url || '');
        return origOpen.call(this, method, url, ...rest);
      };
      xp.send = function (...args) {
        if (this.__yuketangUrl && this.__yuketangUrl.includes('presentation/fetch')) {
          this.addEventListener('load', () => {
            try {
              let data = null;
              if (this.responseType === 'json') data = this.response;
              else data = JSON.parse(this.responseText);
              if (data) Presentations.ingest(data, this.__yuketangUrl);
            } catch {}
          });
        }
        return origSend.apply(this, args);
      };
      log('XHR hook installed');
    } catch (e) {
      log('XHR hook failed:', e);
    }
  }

  function boot() {
    UI.init();
    session.lessonId = lessonIdFromURL();
    startDOMFallback();
    setInterval(() => {
      const lid = lessonIdFromURL();
      if (lid) session.lessonId = lid;
    }, 1500);
    try {
      GM_registerMenuCommand('打开助手面板', () => UI.openPanel());
      GM_registerMenuCommand(S.paused ? '▶ 继续监控' : '⏸ 暂停监控', () => {
        S.paused = !S.paused; saveSettings(); UI.refreshDot(); UI.renderIfOpen();
      });
      GM_registerMenuCommand('复制调试日志', () => {
        GM_setClipboard(UI.debugLogText());
      });
    } catch {}
    // 调试句柄不暴露设置对象，避免页面脚本读取 API key。
    try {
      unsafeWindow.__yuketangLite = {
        version: '1.0.0',
        session,
        Presentations,
        onWSFrame,
        parseAIAnswer,
        typeLabel,
      };
    } catch {}
    log('booted on', location.host);
  }

  installWSHook();
  installFetchHook();
  installXHRHook();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
