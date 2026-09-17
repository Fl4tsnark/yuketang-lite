// yuketang-lite 核心逻辑模拟测试（无需浏览器）
// 运行：node test/test-core.mjs
// 伪造课件数据与 WebSocket 帧，验证：课件索引 → 发题捕获 → 基线去重 → AI 调用与答案解析。

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert';

// ---------- 沙箱桩 ----------

class FakeElement {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.style = {}; this.dataset = {};
    this.className = ''; this.textContent = ''; this.innerHTML = ''; this.title = '';
    this.src = ''; this.value = ''; this.type = ''; this.id = '';
  }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener() {}
  attachShadow() { return new FakeElement('#shadow'); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

const fixtureSettings = {
  paused: false,
  sound: true, desktop: true, titleFlash: false,   // 关闭标题闪烁，避免测试进程被定时器拖住
  ntfyEnabled: false, ntfyServer: 'https://ntfy.sh', ntfyTopic: '',
  provider: 'bigmodel',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: 'test-key',
  textModel: 'glm-4.5v',
  autoAsk: true, debug: false,
};

const calls = { notifications: [], chat: [] };
const sandbox = {};
sandbox.window = sandbox;
sandbox.unsafeWindow = sandbox;
sandbox.self = sandbox;
sandbox.console = console;
sandbox.setTimeout = setTimeout;
sandbox.clearTimeout = clearTimeout;
sandbox.setInterval = setInterval;
sandbox.clearInterval = clearInterval;
sandbox.URL = URL;
sandbox.location = {
  pathname: '/lesson/fullscreen/v3/12345',
  origin: 'https://test.yuketang.cn',
  host: 'test.yuketang.cn',
  href: 'https://test.yuketang.cn/lesson/fullscreen/v3/12345',
};
sandbox.navigator = {};
sandbox.document = Object.assign(new FakeElement('#document'), {
  readyState: 'complete',
  body: new FakeElement('body'),
  documentElement: new FakeElement('html'),
  title: '',
  createElement: (tag) => new FakeElement(tag),
});
sandbox.XMLHttpRequest = class FakeXHR {};
sandbox.addEventListener = () => {};
sandbox.fetch = async () => { throw new Error('test 环境不应发起网络请求'); };
sandbox.WebSocket = class FakeWS {};
sandbox.GM_getValue = (k, d) => (k === 'yuketangLite.settings' ? JSON.stringify(fixtureSettings) : d);
sandbox.GM_setValue = () => {};
sandbox.GM_setClipboard = () => {};
sandbox.GM_notification = (d) => { calls.notifications.push(d); };
sandbox.GM_registerMenuCommand = () => {};
sandbox.GM_xmlhttpRequest = (opts) => {
  const url = String(opts.url || '');
  setTimeout(() => {
    if (url.includes('/chat/completions')) {
      calls.chat.push(JSON.parse(opts.data));
      opts.onload({ status: 200, responseText: JSON.stringify({
        choices: [{ message: { content: '答案：B\n理由：自测通过' } }],
      }) });
    } else if (/\/models$/.test(url)) {
      opts.onload({ status: 200, responseText: JSON.stringify({
        data: [{ id: 'glm-5.3-flash' }, { id: 'glm-4.5v' }, { id: 'glm-4-flash' }],
      }) });
    } else {
      opts.onload({ status: 404, responseText: '{}' });
    }
  }, 5);
};

vm.createContext(sandbox);
const src = readFileSync(new URL('../yuketang-lite.user.js', import.meta.url), 'utf8');
assert.ok(!src.includes('AI（OpenAI 兼容接口）'), '设置标题不应使用括号式开发说明');
assert.ok(!src.includes('API key（仅保存在本地）'), 'API key 标签应保持简洁');
assert.ok(!src.includes('ntfy topic（不能含空格；相当于密码，请保密）'), 'ntfy 标签应保持简洁');
assert.match(src, /provider:\s*'',/, '新安装不应预选 AI 服务商');
assert.match(src, /textModel:\s*'',/, '新安装不应预填模型');
assert.match(src, /@updateURL\s+https:\/\/raw\.githubusercontent\.com\/F1atSnark\/yuketang-lite\/main\/yuketang-lite\.user\.js/, '应提供 GitHub 更新地址');
assert.match(src, /@downloadURL\s+https:\/\/raw\.githubusercontent\.com\/F1atSnark\/yuketang-lite\/main\/yuketang-lite\.user\.js/, '应提供 GitHub 下载地址');
vm.runInContext(src, sandbox, { filename: 'yuketang-lite.user.js' });

const yuketang = sandbox.unsafeWindow.__yuketangLite;
assert.ok(yuketang, '__yuketangLite 调试句柄应已挂载');
assert.strictEqual(yuketang.version, '1.0.1', '脚本版本应与发布版本一致');

// ---------- 测试数据 ----------

const PRES_URL = 'https://test.yuketang.cn/api/v3/lesson/presentation/fetch?presentation_id=888';
const PRES_DATA = {
  data: {
    slides: [
      { id: 's1', imgs: [{ url: 'https://img.yuketang.cn/slide1.jpg' }], shapes: [{ text: '1+1=?' }], problem: [{ problemId: 'p1', problemType: 1 }] },
      { id: 's2', shapes: [{ text: '第二页，无图' }] },
    ],
  },
};

const results = [];
function check(name, fn) {
  try { fn(); results.push(`✅ ${name}`); }
  catch (e) { results.push(`❌ ${name}: ${e.message}`); process.exitCode = 1; }
}

// 1. 课件摄取与索引
yuketang.Presentations.ingest(PRES_DATA, PRES_URL);
check('课件 id 识别', () => assert.strictEqual(yuketang.session.presentationId, '888'));
check('课件题目内容查找', () => {
  const hit = yuketang.Presentations.lookup('p1');
  assert.ok(hit, '应能找到 p1');
  assert.ok(hit.text.includes('1+1=?'), '应提取到幻灯片文本');
  assert.strictEqual(hit.images.length, 1, '应提取到 1 张图片');
  assert.ok(hit.images[0].includes('slide1.jpg'));
});
check('课件里的历史题不触发提醒', () => {
  assert.strictEqual(yuketang.session.order.length, 0, '摄取课件不应产生提醒');
});

// 2. 实时推题 → 捕获 + 提醒 + AI
yuketang.onWSFrame('wss://test/ws', JSON.stringify({ op: 'sendproblem', problem: { problemId: 'p1', problemType: 1 } }));
check('实时推题已捕获', () => {
  assert.ok(yuketang.session.order.includes('p1'), '应记录 p1');
  const r = yuketang.session.problems.get('p1');
  assert.strictEqual(r.typeText, '单选题');
  assert.ok(r.content.text.includes('1+1=?'), '题目文本应来自课件');
  assert.strictEqual(r.content.images.length, 1, '题图应来自课件');
});
check('桌面通知已发送', () => {
  assert.ok(calls.notifications.length >= 1, '应调用 GM_notification');
  assert.ok(calls.notifications[0].title.includes('雨课堂新题'));
});

// 等 AI 返回
async function waitAI(id, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = yuketang.session.problems.get(id);
    if (r && (r.aiState === 'done' || r.aiState === 'error')) return r;
    await new Promise(res => setTimeout(res, 30));
  }
  return yuketang.session.problems.get(id);
}
const rec1 = await waitAI('p1');
check('AI 调用单模型并解析答案', () => {
  assert.strictEqual(rec1.aiState, 'done', `aiState=${rec1.aiState} err=${rec1.aiError}`);
  assert.strictEqual(rec1.aiAnswer, 'B');
  assert.strictEqual(rec1.aiReason, '自测通过');
  const last = calls.chat[calls.chat.length - 1];
  assert.strictEqual(last.model, 'glm-4.5v', '应使用设置的单一模型');
  assert.ok(last.messages[0].content.some(c => c.type === 'image_url'), '消息应包含图片');
});

// 3. 去重与基线
yuketang.onWSFrame('wss://test/ws', JSON.stringify({ op: 'sendproblem', problem: { problemId: 'p1', problemType: 1 } }));
check('同一题不重复提醒', () => {
  assert.strictEqual(yuketang.session.order.filter(x => x === 'p1').length, 1);
});
yuketang.onWSFrame('wss://test/ws', JSON.stringify({ type: 'syncproblem', data: { unlockedproblem: [{ problemId: 'p9', problemType: 2 }, { problemId: 'p10', problemType: 3 }] } }));
yuketang.onWSFrame('wss://test/ws', JSON.stringify({ op: 'sendproblem', problem: { problemId: 'p9', problemType: 2 } }));
check('初始同步的题目按基线处理', () => {
  assert.ok(!yuketang.session.order.includes('p9'), '同步题不应提醒');
  assert.ok(!yuketang.session.order.includes('p10'), '同步题不应提醒');
});
yuketang.onWSFrame('wss://test/ws', JSON.stringify({ op: 'publishproblem', problem: { problemId: 'p11', problemType: 2 } }));
check('新推题正常提醒', () => {
  assert.ok(yuketang.session.order.includes('p11'));
  assert.strictEqual(yuketang.session.problems.get('p11').typeText, '多选题');
});

// 4. 答案解析纯函数
check('parseAIAnswer 标准格式', () => {
  const r = yuketang.parseAIAnswer('答案：A C\n理由：因为是');
  assert.strictEqual(r.answer, 'A C'); assert.strictEqual(r.reason, '因为是');
});
check('parseAIAnswer 无格式兜底', () => {
  const r = yuketang.parseAIAnswer('这道题选 B');
  assert.ok(r.answer.includes('B'));
});
check('typeLabel 映射', () => {
  assert.strictEqual(yuketang.typeLabel(1), '单选题');
  assert.strictEqual(yuketang.typeLabel('judge'), '判断题');
});

console.log('\n===== yuketang-lite 核心逻辑测试结果 =====');
for (const r of results) console.log(r);
console.log(`共 ${results.length} 项，失败 ${results.filter(r => r.startsWith('❌')).length} 项`);
process.exit(process.exitCode || 0);
