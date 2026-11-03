/*
 * 纯计算模块：不含任何 DOM 依赖，便于单测。
 * 口径与旧版 calculate() 完全一致：
 *   剩余价值 = 续费价 / 周期天数 × 剩余天数 × 汇率
 *   剩余天数 = ceil((到期日 - 交易日) / 86400000)，两者都按 UTC 解析，天然规避 DST。
 */

export const MS_PER_DAY = 86400000;

export function toDate(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

// 返回天数字符串对应的时间差天数；日期非法返回 null。
export function diffDays(tradeDate, dueDate) {
    const trade = toDate(tradeDate);
    const due = toDate(dueDate);
    if (!trade || !due) return null;
    return Math.ceil((due.getTime() - trade.getTime()) / MS_PER_DAY);
}

/*
 * 进度条语义：本期周期内还剩多少（%）。
 * 剩余天数超过一个周期时（例如月付却填了 3 个月后到期），
 * 进度条与文案都封顶 100%，避免出现「450%」这种自相矛盾的展示；
 * 金额本身仍按实际天数计算，可以超过续费价。
 */
export function computeProgress(days, cycleDays) {
    if (!(cycleDays > 0) || !(days > 0)) return { bar: 0, label: 0 };
    const ratio = (days / cycleDays) * 100;
    const label = Math.min(100, Math.max(1, Math.round(ratio)));
    return { bar: label, label };
}

export function computeRemaining({ price, rate, cycleDays, tradeDate, dueDate }) {
    const days = diffDays(tradeDate, dueDate);
    if (days === null) return null;

    const safePrice = Number.isFinite(price) && price > 0 ? price : 0;
    const safeRate = Number.isFinite(rate) && rate > 0 ? rate : 0;
    const cycle = Number.isFinite(cycleDays) && cycleDays > 0 ? cycleDays : 0;

    const remainingDays = Math.max(days, 0);
    const dailyPrice = cycle > 0 ? safePrice / cycle : 0;
    const valueOrig = dailyPrice * remainingDays;
    const valueCNY = valueOrig * safeRate;
    const progress = computeProgress(remainingDays, cycle);

    return {
        rawDays: days,
        days: remainingDays,
        dailyPrice,
        valueOrig,
        valueCNY,
        barPct: progress.bar,
        labelPct: progress.label,
    };
}
