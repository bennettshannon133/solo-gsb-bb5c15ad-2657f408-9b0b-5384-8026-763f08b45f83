'use strict';

/**
 * 非 npm 套件的集成验证（依赖可选的 jsdom，仅本地/CI 可用时运行）：
 * 在真实 DOM 下验证 analyzer.js 的视觉顺序审计 DOM 侧链路——
 * 矩形采集（getBoundingClientRect 打桩）、最近滚动容器分组、
 * route 消息中的 visualAudit 负载结构，以及偏差 / 无法判定项的
 * 高亮联动消息往返。
 * 运行：npm install --no-save jsdom && node test/visual-integration.js
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = `<!DOCTYPE html><html><body>
  <button id="b1">行1左</button>
  <button id="b2">行1右</button>
  <div id="scroller" style="overflow-y: auto">
    <button id="s1">滚动容器内1</button>
    <button id="s2">滚动容器内2</button>
  </div>
  <button id="b3">行2右（Tab 先于行2左 → 偏差）</button>
  <button id="b4">行2左</button>
  <span id="z" tabindex="0">零尺寸可聚焦</span>
</body></html>`;

// 视口坐标矩形（打桩 getBoundingClientRect；jsdom 无布局，默认全零）
const RECTS = {
  b1: { top: 10, left: 10, width: 80, height: 20 },   // 文档·行1·左
  b2: { top: 10, left: 100, width: 80, height: 20 },  // 文档·行1·右
  b3: { top: 40, left: 100, width: 80, height: 20 },  // 文档·行2·右（视觉在 b4 之后）
  b4: { top: 40, left: 10, width: 80, height: 20 },   // 文档·行2·左
  s1: { top: 300, left: 10, width: 80, height: 20 },  // 滚动容器·行1
  s2: { top: 330, left: 10, width: 80, height: 20 },  // 滚动容器·行2
  z:  { top: 0, left: 0, width: 0, height: 0 }        // 零尺寸
};

const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
const { document } = window;

window.Element.prototype.getBoundingClientRect = function () {
  const r = RECTS[this.id] || { top: 0, left: 0, width: 0, height: 0 };
  return {
    top: r.top, left: r.left, width: r.width, height: r.height,
    right: r.left + r.width, bottom: r.top + r.height,
    x: r.left, y: r.top, toJSON() { return {}; }
  };
};

// 分析器内 parent.postMessage（sandbox iframe 形态）：让 parent 指向自身窗口
try { Object.defineProperty(window, 'parent', { value: window, configurable: true }); } catch (e) {}

let routePayload = null;
window.addEventListener('message', (ev) => {
  if (ev.data && ev.data.type === 'route') routePayload = ev.data.payload;
  if (ev.data && ev.data.type === 'error') console.error('analyzer error:', ev.data.message);
});

const analyzerSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'analyzer.js'), 'utf8');
window.eval(analyzerSrc);

setTimeout(() => {
  let failures = 0;
  function check(name, cond, extra) {
    if (cond) { console.log('  ✓ ' + name); }
    else { failures++; console.error('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
  }

  if (!routePayload) {
    console.error('未收到 route 消息');
    process.exit(1);
  }
  const va = routePayload.visualAudit;

  console.log('visualAudit 负载结构');
  check('route 负载包含 visualAudit', !!va);
  check('文档方向为 ltr', va.direction === 'ltr', va.direction);
  check('识别出 2 个滚动容器分组（文档/视口 + div#scroller）',
    va.containers.length === 2 &&
    va.containers[0].kind === 'document' &&
    va.containers[1].kind === 'element' && va.containers[1].label === 'div#scroller',
    JSON.stringify(va.containers));
  check('滚动容器带可往返分段选择器',
    va.containers[1].selector === 'L:#scroller', va.containers[1].selector);

  console.log('统计自洽');
  const st = va.stats;
  check('7 个可 Tab 节点 / 6 个相邻对', st.nodes === 7 && st.pairs === 6,
    JSON.stringify(st));
  check('已比较 3 对（文档内 2 + 滚动容器内 1）', st.comparedPairs === 3, String(st.comparedPairs));
  check('一致 2 对、偏差 1 对', st.okPairs === 2 && st.deviations === 1);
  check('无法判定 3 对（2 跨容器 + 1 涉及零尺寸）', st.undeterminedPairs === 3,
    String(st.undeterminedPairs));
  check('pairs = 已比较 + 无法判定对', st.comparedPairs + st.undeterminedPairs === st.pairs);

  console.log('视觉逆向偏差');
  check('恰好 1 条偏差', va.deviations.length === 1, JSON.stringify(va.deviations));
  const dv = va.deviations[0];
  check('偏差为 第5位(b3) → 第6位(b4)',
    dv.from.step === 5 && dv.to.step === 6 &&
    /#b3/.test(dv.from.selector) && /#b4/.test(dv.to.selector),
    JSON.stringify(dv));
  check('偏差带容器内视觉名次（4 → 3，逆向）',
    dv.fromVisualRank === 4 && dv.toVisualRank === 3);
  check('偏差两端矩形已采集（b3 位于行2右侧）',
    dv.from.rect.top === 40 && dv.from.rect.left === 100);

  console.log('无法判定（不计作无偏差）');
  check('无法判定共 3 条', va.undetermined.length === 3, JSON.stringify(va.undetermined));
  const zero = va.undetermined.find(u => u.reason === 'zero-size');
  check('零尺寸：第7位 z，附原因说明',
    zero && zero.nodes.length === 1 && zero.nodes[0].step === 7 &&
    /#z/.test(zero.nodes[0].selector) && /宽或高为 0/.test(zero.message));
  const cc = va.undetermined.filter(u => u.reason === 'cross-container');
  check('跨滚动容器 2 对（b2→s1、s2→b3）', cc.length === 2 &&
    cc[0].nodes[0].step === 2 && cc[0].nodes[1].step === 3 &&
    cc[1].nodes[0].step === 4 && cc[1].nodes[1].step === 5,
    JSON.stringify(cc));
  check('跨容器对分属不同容器分组',
    cc[0].nodes[0].container !== cc[0].nodes[1].container);
  check('无矩形重叠 / 行归属误报',
    !va.undetermined.some(u => u.reason === 'overlap' || u.reason === 'row-ambiguous'));

  console.log('高亮联动（偏差点击 → highlight；无法判定点击 → highlight-node）');
  function awaitMessage(pred, timeoutMs) {
    return new Promise((res) => {
      const timer = setTimeout(() => { window.removeEventListener('message', onMsg); res(null); }, timeoutMs || 800);
      function onMsg(ev) {
        if (pred(ev.data)) {
          clearTimeout(timer);
          window.removeEventListener('message', onMsg);
          res(ev.data);
        }
      }
      window.addEventListener('message', onMsg);
    });
  }
  (async () => {
    // 偏差项点击 = 父页面发送 highlight（step 为 0 基：第 5 位 → step 4）
    const p1 = awaitMessage(d => d && d.type === 'highlighted' && d.step === 4);
    window.postMessage({ target: 'focus-lab', type: 'highlight', step: 4 }, '*');
    const h1 = await p1;
    check('highlight 回执定位偏差起点 b3', h1 && /#b3/.test(h1.selector), h1 && h1.selector);

    // 无法判定项点击 = 父页面发送 highlight-node（零尺寸节点 z）
    const zSel = zero.nodes[0].selector;
    const p2 = awaitMessage(d => d && (d.type === 'highlighted' || d.type === 'highlight-miss'));
    window.postMessage({ target: 'focus-lab', type: 'highlight-node', selector: zSel, badge: '无法判定 · 零尺寸' }, '*');
    const h2 = await p2;
    check('highlight-node 回执定位零尺寸节点 z',
      h2 && h2.type === 'highlighted' && h2.selector === zSel, h2 && h2.type);

    if (failures) { console.error('\n集成验证存在 ' + failures + ' 个失败'); process.exit(1); }
    console.log('\n集成验证全部通过');
  })();
}, 400);
