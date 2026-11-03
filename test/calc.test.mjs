import test from 'node:test';
import assert from 'node:assert/strict';
import { computeRemaining, computeProgress, diffDays } from '../src/calc.js';

const demo = {
    price: 99,
    rate: 6.743,
    cycleDays: 365,
    tradeDate: '2026-08-23',
    dueDate: '2026-11-27'
};

test('天数：常规区间按日历日计算（含闰年/跨月）', () => {
    assert.equal(diffDays('2026-08-23', '2026-11-27'), 96);
    assert.equal(diffDays('2024-02-28', '2024-03-01'), 2); // 2024 是闰年
    assert.equal(diffDays('2026-02-28', '2026-03-01'), 1); // 平年
    assert.equal(diffDays('2026-03-07', '2026-03-09'), 2); // 跨夏令时（美国）
});

test('天数：日期非法返回 null', () => {
    assert.equal(diffDays('', '2026-11-27'), null);
    assert.equal(diffDays('2026-08-23', 'not-a-date'), null);
});

test('核心口径：剩余价值 = 续费价 / 周期 × 剩余天数 × 汇率', () => {
    const r = computeRemaining(demo);
    assert.equal(r.days, 96);
    assert.equal(r.valueOrig.toFixed(2), '26.04');
    assert.equal(r.valueCNY.toFixed(2), '175.58');
    assert.equal(r.barPct, 26);
    assert.equal(r.labelPct, 26);
});

test('到期日早于交易日：金额归零，不出现负数', () => {
    const r = computeRemaining({ ...demo, tradeDate: '2026-11-27', dueDate: '2026-08-23' });
    assert.equal(r.days, 0);
    assert.equal(r.valueCNY, 0);
    assert.equal(r.barPct, 0);
    assert.equal(r.labelPct, 0);
});

test('同一天交易与到期：0 天 0 元', () => {
    const r = computeRemaining({ ...demo, tradeDate: '2026-11-27', dueDate: '2026-11-27' });
    assert.equal(r.days, 0);
    assert.equal(r.valueCNY, 0);
});

test('非法输入按 0 处理，不产生 NaN', () => {
    const r = computeRemaining({ ...demo, price: NaN, rate: undefined, cycleDays: NaN });
    assert.equal(r.valueCNY, 0);
    assert.equal(Number.isNaN(r.valueOrig), false);
});

test('汇率缺失（切币种后拉取失败）：金额为 0 但天数/进度仍正常', () => {
    const r = computeRemaining({ ...demo, rate: 0 });
    assert.equal(r.valueCNY, 0);
    assert.equal(r.days, 96);
    assert.equal(r.barPct, 26);
});

test('剩余天数超过一个周期：进度封顶 100%，金额仍按实际天数计', () => {
    // 月付（30 天）却填了 90 天剩余
    const r = computeRemaining({ ...demo, cycleDays: 30, tradeDate: '2026-09-01', dueDate: '2026-11-30' });
    assert.equal(r.days, 90);
    assert.equal(r.barPct, 100);
    assert.equal(r.labelPct, 100);
    assert.equal(r.valueCNY.toFixed(2), (99 / 30 * 90 * 6.743).toFixed(2));
});

test('进度：不足 1% 时至少显示 1%，避免看起来像 0', () => {
    assert.deepEqual(computeProgress(1, 365), { bar: 1, label: 1 });
    assert.deepEqual(computeProgress(0, 365), { bar: 0, label: 0 });
    assert.deepEqual(computeProgress(182.5, 365), { bar: 50, label: 50 });
});

test('CNY 币种：汇率恒为 1，金额等于原币金额', () => {
    const r = computeRemaining({ ...demo, price: 700, rate: 1, cycleDays: 365 });
    assert.equal(r.valueOrig.toFixed(2), r.valueCNY.toFixed(2));
    assert.equal(r.valueCNY.toFixed(2), '184.11');
});
