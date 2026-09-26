'use strict';

/**
 * analyzer.js 视觉顺序审计纯函数（computeVisualOrderAudit）单元测试
 * （Node 环境，无 DOM）。
 * 重点：行聚类与 LTR/RTL 视觉排序、Tab 相邻对逆向偏差判定、
 * 零尺寸 / 矩形重叠 / 跨滚动容器 / 行归属不唯一 → 无法判定（不计作无偏差）。
 * 运行：npm test
 */

const assert = require('assert');
const { computeVisualOrderAudit } = require('../public/analyzer.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    console.error('  ✗ ' + name);
    console.error(err);
    process.exitCode = 1;
  }
}

/** 构造矩形条目（top, left, width, height），默认同一滚动容器 0 */
function item(top, left, width, height, container) {
  return { top, left, width, height, container: container === undefined ? 0 : container };
}

console.log('computeVisualOrderAudit · 视觉排序与偏差');

test('LTR：行内左→右、行自上而下；顺序一致时无偏差', () => {
  const items = [
    item(0, 0, 100, 20),   // 0 行1左
    item(0, 120, 100, 20), // 1 行1右
    item(30, 0, 100, 20)   // 2 行2
  ];
  const r = computeVisualOrderAudit(items, 'ltr');
  assert.deepStrictEqual(r.visualOrder, [0, 1, 2]);
  assert.strictEqual(r.deviations.length, 0);
  assert.strictEqual(r.stats.pairs, 2);
  assert.strictEqual(r.stats.comparedPairs, 2);
  assert.strictEqual(r.stats.okPairs, 2);
  assert.strictEqual(r.undetermined.length, 0);
});

test('LTR：Tab 顺序与行内视觉顺序相反 → 偏差', () => {
  const items = [
    item(0, 120, 100, 20), // 0 视觉右
    item(0, 0, 100, 20)    // 1 视觉左
  ];
  const r = computeVisualOrderAudit(items, 'ltr');
  assert.strictEqual(r.deviations.length, 1);
  assert.strictEqual(r.deviations[0].from, 0);
  assert.strictEqual(r.deviations[0].to, 1);
  assert.strictEqual(r.deviations[0].fromRank, 1);
  assert.strictEqual(r.deviations[0].toRank, 0);
  assert.strictEqual(r.stats.okPairs, 0);
});

test('RTL：行内视觉顺序为右→左', () => {
  const items = [
    item(0, 0, 100, 20),
    item(0, 120, 100, 20),
    item(0, 240, 100, 20)
  ];
  const rtl = computeVisualOrderAudit(items, 'rtl');
  assert.deepStrictEqual(rtl.visualOrder, [2, 1, 0]);
  // Tab 顺序 0→1→2 在 RTL 下两对均逆向
  assert.strictEqual(rtl.deviations.length, 2);
  const ltr = computeVisualOrderAudit(items, 'ltr');
  assert.strictEqual(ltr.deviations.length, 0);
});

test('跨行逆向跳转（回到更靠上的行）→ 偏差', () => {
  const items = [
    item(40, 0, 100, 20), // 0 行2
    item(0, 0, 100, 20)   // 1 行1
  ];
  const r = computeVisualOrderAudit(items, 'ltr');
  assert.strictEqual(r.deviations.length, 1);
  assert.deepStrictEqual(r.visualOrder, [1, 0]);
});

test('空输入与单节点：无相邻对', () => {
  const empty = computeVisualOrderAudit([], 'ltr');
  assert.strictEqual(empty.stats.pairs, 0);
  assert.strictEqual(empty.deviations.length, 0);
  const single = computeVisualOrderAudit([item(0, 0, 10, 10)], 'ltr');
  assert.strictEqual(single.stats.pairs, 0);
  assert.deepStrictEqual(single.visualOrder, [0]);
});

console.log('computeVisualOrderAudit · 无法判定');

test('零尺寸节点标为无法判定，相关相邻对不比较也不计作无偏差', () => {
  const items = [
    item(0, 0, 0, 0),     // 0 零尺寸
    item(0, 120, 100, 20) // 1
  ];
  const r = computeVisualOrderAudit(items, 'ltr');
  assert.ok(r.undetermined.some(u => u.reason === 'zero-size' && u.nodes[0] === 0));
  assert.strictEqual(r.stats.comparedPairs, 0);
  assert.strictEqual(r.stats.okPairs, 0);
  assert.strictEqual(r.stats.undeterminedPairs, 1);
  assert.strictEqual(r.stats.undeterminedNodes, 1);
  assert.strictEqual(r.rank[0], -1);
});

test('同容器矩形重叠 → 双方无法判定', () => {
  const items = [
    item(0, 0, 100, 20),
    item(5, 50, 100, 20),  // 与 0 重叠
    item(40, 0, 100, 20)   // 独立节点
  ];
  const r = computeVisualOrderAudit(items, 'ltr');
  const ov = r.undetermined.filter(u => u.reason === 'overlap');
  assert.strictEqual(ov.length, 1);
  assert.deepStrictEqual(ov[0].nodes, [0, 1]);
  assert.strictEqual(r.rank[0], -1);
  assert.strictEqual(r.rank[1], -1);
  assert.strictEqual(r.rank[2], 0); // 唯一可判定节点
  // 涉及 0 / 1 的两对均不比较
  assert.strictEqual(r.stats.comparedPairs, 0);
  assert.strictEqual(r.stats.okPairs, 0);
});

test('紧贴但不重叠的相邻矩形（容差内）不算重叠', () => {
  const items = [
    item(0, 0, 100, 20),
    item(0, 100, 100, 20) // 紧贴（交集为 0）
  ];
  const r = computeVisualOrderAudit(items, 'ltr');
  assert.strictEqual(r.undetermined.length, 0);
  assert.strictEqual(r.deviations.length, 0);
  assert.strictEqual(r.stats.okPairs, 1);
});

test('跨滚动容器的相邻对 → 无法判定（cross-container），且不判重叠', () => {
  const items = [
    item(0, 0, 100, 20, 0),
    item(0, 0, 100, 20, 1) // 不同容器：即使矩形相同也不判重叠
  ];
  const r = computeVisualOrderAudit(items, 'ltr');
  assert.ok(!r.undetermined.some(u => u.reason === 'overlap'));
  const cc = r.undetermined.find(u => u.reason === 'cross-container');
  assert.ok(cc);
  assert.deepStrictEqual(cc.nodes, [0, 1]);
  assert.strictEqual(r.stats.comparedPairs, 0);
  assert.strictEqual(r.stats.undeterminedPairs, 1);
});

test('矩形垂直跨越多个行带 → 行归属不唯一', () => {
  const items = [
    item(0, 0, 100, 10),   // 0 行1
    item(0, 200, 50, 30),  // 1 高矩形，垂直跨越行1与行2
    item(24, 0, 100, 10)   // 2 行2
  ];
  const r = computeVisualOrderAudit(items, 'ltr');
  const ra = r.undetermined.find(u => u.reason === 'row-ambiguous');
  assert.ok(ra);
  assert.deepStrictEqual(ra.nodes, [1]);
  assert.strictEqual(r.rank[1], -1);
  assert.ok(r.rank[0] >= 0 && r.rank[2] >= 0);
  // 涉及高矩形的相邻对均不比较
  assert.strictEqual(r.stats.comparedPairs, 0);
});

test('混合场景统计自洽：pairs = 已比较 + 无法判定对', () => {
  const items = [
    item(0, 0, 100, 20),    // 0
    item(0, 120, 100, 20),  // 1（与 0 同行，顺序一致）
    item(30, 0, 0, 0),      // 2 零尺寸
    item(30, 120, 100, 20), // 3
    item(60, 0, 100, 20, 9) // 4 另一滚动容器
  ];
  const r = computeVisualOrderAudit(items, 'ltr');
  assert.strictEqual(r.stats.pairs, 4);
  assert.strictEqual(r.stats.comparedPairs + r.stats.undeterminedPairs, r.stats.pairs);
  assert.strictEqual(r.stats.okPairs + r.stats.deviations, r.stats.comparedPairs);
  assert.strictEqual(r.stats.undetermined, r.undetermined.length);
});

console.log('\n' + passed + ' 个断言组通过' + (process.exitCode ? '（存在失败）' : ''));
