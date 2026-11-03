import './style.css';
import { computeRemaining } from './calc.js';

// Firefox 检测：为 html 添加标识类，供 CSS 针对性处理原生控件差异
if (typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent)) {
    document.documentElement.classList.add('is-firefox');
}

const API_URL = 'https://open.er-api.com/v6/latest/CNY';
// 汇率本地缓存时长（小时）。免费 API 一般每天更新一次，12h 足够。
const RATE_CACHE_HOURS = 12;
// 用户手动刷新汇率次数上限（每 RATE_CACHE_HOURS 内）。防止误触刷爆免费 API 配额。
const MANUAL_REFRESH_LIMIT = 2;
const SHARE_IMAGE_MIME_TYPE = 'image/webp';
const SHARE_IMAGE_QUALITY = 0.98;
// 导出图片的最低像素比与目标物理宽度。手机端 CSS 宽度通常仅 ~360px，
// 若固定 pixelRatio=2 输出仅 ~720px 会发糊。这里按卡片实际 CSS 宽度动态
// 计算 pixelRatio，保证输出至少 SHARE_IMAGE_MIN_WIDTH 物理像素宽。
const SHARE_IMAGE_MIN_PIXEL_RATIO = 2;
const SHARE_IMAGE_MAX_PIXEL_RATIO = 4;
// 低内存设备（deviceMemory <= 4GB 或窄屏）限制 pixelRatio，避免导出时内存峰值过高造成卡顿
// 股眼几乎看不出 3x 与 4x 的区别
const SHARE_IMAGE_LOW_END_MAX_PIXEL_RATIO = 3;
const SHARE_IMAGE_MIN_WIDTH = 1440;
let htmlToImageModulePromise = null;
let generatedImageUrl = '';
// 当前生成的图片字节：上传分享时直接复用，不用再从 blob URL 取一遍
let generatedImageBlob = null;
// 已上传得到的分享链接，重复点「复制链接」不重复占存储
let sharedImageUrl = '';
const SHARE_BTN_DEFAULT_TEXT = '复制图片链接';

const currencySymbols = {
    'USD': '$', 'EUR': '\u20AC', 'GBP': '\u00A3', 'JPY': '\u00A5',
    'CNY': '\u00A5', 'HKD': 'HK$', 'AUD': 'A$', 'SGD': 'S$',
    'KRW': '\u20A9', 'TWD': 'NT$', 'CAD': 'C$'
};

const els = {
    price: document.getElementById('price'),
    currency: document.getElementById('currency'),
    cycles: document.getElementsByName('cycle'),
    dueDate: document.getElementById('dueDate'),
    tradeDate: document.getElementById('tradeDate'),
    customRate: document.getElementById('customRate'),
    apiRateDisplay: document.getElementById('apiRateDisplay'),
    refreshBtn: document.getElementById('refreshRateBtn'),
    refreshIcon: document.getElementById('refreshIcon'),
    symbolDisplay: document.querySelector('.symbol-display'),
    finalValue: document.getElementById('finalValue'),
    originalCurrencyValue: document.getElementById('originalCurrencyValue'),
    amountCopyTip: document.getElementById('amountCopyTip'),
    premiumInput: document.getElementById('premiumInput'),
    salePriceInput: document.getElementById('salePriceInput'),
    daysRemaining: document.getElementById('daysRemaining'),
    progressBar: document.getElementById('progressBar'),
    progressText: document.getElementById('progressText'),
    priceCNYPreview: document.getElementById('priceCNYPreview'),
    toast: document.getElementById('toast'),
    rateLimitTip: document.getElementById('rateLimitTip'),
    themeToggle: document.getElementById('themeToggle'),
    themeToggleKnob: document.getElementById('themeToggleKnob'),
    copyLinkBtn: document.getElementById('copyLinkBtn')
};

let rateLimitTimer = null;
let remainingValueCNY = 0;
let quoteLastEdited = 'premium';
// customRate 当前对应的币种。切币种后若拉不到新汇率，靠它判断「手上的汇率已经过期」，
// 避免拿 A 币种的汇率去算 B 币种的金额。
let rateCurrency = '';
// 用户是否手动改过汇率：手动值刷新页面后应保留，不能被缓存汇率覆盖。
let rateIsManual = false;

window.addEventListener('DOMContentLoaded', () => {
    try {
        initTheme();
        loadInputsFromCookie(); 
        initQuoteFields();
        initDates(); 
        syncDateDisplay(els.dueDate);
        syncDateDisplay(els.tradeDate);
        initRates(); 
        setupEventListeners();
        calculate(); 
    } finally {
        hideAppLoader();
    }
});

function hideAppLoader() {
    const loader = document.getElementById('appLoader');
    if (!loader) return;

    let done = false;
    const dismiss = () => {
        if (done) return;
        done = true;
        loader.classList.add('is-hidden');
        window.setTimeout(() => loader.remove(), 180);
    };

    // 正常路径：等下一帧，避免首帧未绘制就隐藏造成闪白。
    // 兜底：标签页在后台打开时 requestAnimationFrame 不触发，靠超时保证不卡在转圈。
    requestAnimationFrame(dismiss);
    window.setTimeout(dismiss, 400);
}

function setupEventListeners() {
    const debouncedSave = debounce(saveInputsToCookie, 500);

    [els.price, els.dueDate, els.tradeDate, els.customRate].forEach(el => el.addEventListener('input', () => {
        if (el.type === 'date') syncDateDisplay(el);
        // 手动输入汇率：标记为手动值，并记下它属于当前币种
        if (el === els.customRate) {
            rateIsManual = els.customRate.value.trim() !== '';
            rateCurrency = els.currency.value;
        }
        calculate();
        debouncedSave();
    }));

    [els.dueDate, els.tradeDate].forEach(el => el.addEventListener('change', () => {
        syncDateDisplay(el);
        calculate();
        saveInputsToCookie();
    }));
    
    els.cycles.forEach(radio => radio.addEventListener('change', () => {
        calculate();
        saveInputsToCookie();
    }));

    els.currency.addEventListener('change', () => {
        updateCurrencySymbol();
        // 换币种后旧汇率不再有效（手动值也一样），重新走一次自动获取
        rateIsManual = false;
        rateCurrency = '';
        initRates(); 
        calculate();
        saveInputsToCookie();
    });

    els.refreshBtn.addEventListener('click', manualRefreshRate); 
    els.themeToggle.addEventListener('click', toggleTheme);
    els.finalValue.addEventListener('click', copyFinalValueAmount);
    els.finalValue.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        copyFinalValueAmount();
    });

    [els.premiumInput, els.salePriceInput].forEach(el => {
        el.addEventListener('input', () => {
            quoteLastEdited = el === els.salePriceInput ? 'sale' : 'premium';
            syncQuoteFields();
            debouncedSave();
        });

        el.addEventListener('blur', () => {
            syncQuoteFields({ formatActive: true });
            saveInputsToCookie();
        });
    });

    // Firefox：date input 改为 visibility:hidden，不接收点击 → 在 wrapper 上绑定点击来触发 showPicker()
    // 非 Firefox：原生透明日历指示器在 webkit 上会自己响应点击，同时下面的 icon handler 作为后备
    if (document.documentElement.classList.contains('is-firefox')) {
        document.querySelectorAll('.date-input-wrapper').forEach((wrapper) => {
            wrapper.addEventListener('click', () => {
                const input = wrapper.querySelector('input[type="date"]');
                if (!input) return;
                try {
                    if (typeof input.showPicker === 'function') {
                        input.showPicker();
                    } else {
                        input.focus();
                    }
                } catch (err) {
                    // ignore
                }
            });
        });
    } else {
        // 非 Firefox：点击右侧自定义日历图标触发 picker
        document.querySelectorAll('.date-input-wrapper .date-input-icon').forEach((icon) => {
            icon.addEventListener('click', (e) => {
                const input = icon.parentElement && icon.parentElement.querySelector('input[type="date"]');
                if (!input) return;
                e.preventDefault();
                try {
                    if (typeof input.showPicker === 'function') {
                        input.showPicker();
                    } else {
                        input.focus();
                    }
                } catch (err) {
                    input.focus();
                }
            });
        });
    }

    // 价格 / 汇率 输入校验：负数或非法时高亮红边
    [els.price, els.customRate].forEach(el => {
        el.addEventListener('input', () => validateNumberInput(el));
        validateNumberInput(el);
    });

    els.salePriceInput.addEventListener('input', () => validateNumberInput(els.salePriceInput));
    validateNumberInput(els.salePriceInput);

    // ESC 关闭模态 / 限流提示
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (!modal.el.classList.contains('hidden')) closeImageModal();
        if (els.rateLimitTip.classList.contains('show')) hideRateLimitTip();
    });
}

function validateNumberInput(el) {
    const raw = el.value.trim();
    if (raw === '') {
        el.classList.remove('input-invalid');
        return true;
    }
    const v = parseFloat(raw);
    const ok = Number.isFinite(v) && v >= 0;
    el.classList.toggle('input-invalid', !ok);
    return ok;
}

function initQuoteFields() {
    updateQuotePlaceholders();
    syncQuoteFields();
}

function parseQuoteValue(value) {
    if (typeof value !== 'string' || value.trim() === '') return NaN;
    return parseFloat(value);
}

function formatMoney(value) {
    return Number.isFinite(value) ? value.toFixed(2) : '';
}

function updatePremiumTone(value) {
    els.premiumInput.classList.remove('premium-positive', 'premium-negative', 'premium-neutral');

    if (!Number.isFinite(value) || value === 0) {
        els.premiumInput.classList.add('premium-neutral');
    } else if (value > 0) {
        els.premiumInput.classList.add('premium-positive');
    } else {
        els.premiumInput.classList.add('premium-negative');
    }
}

function updateSaleTone(isNeutral) {
    els.salePriceInput.classList.toggle('sale-neutral', isNeutral);
}

function updateQuotePlaceholders() {
    els.premiumInput.placeholder = '0.00';
    els.salePriceInput.placeholder = formatMoney(remainingValueCNY) || '0.00';
}

function syncQuoteFields(options = {}) {
    const { formatActive = false } = options;
    const premiumRaw = els.premiumInput.value.trim();
    const saleRaw = els.salePriceInput.value.trim();

    updateQuotePlaceholders();

    if (quoteLastEdited === 'sale') {
        const salePrice = parseQuoteValue(saleRaw);

        if (Number.isFinite(salePrice)) {
            const premium = salePrice - remainingValueCNY;
            els.premiumInput.value = formatMoney(premium);
            if (formatActive) els.salePriceInput.value = formatMoney(salePrice);
            updatePremiumTone(premium);
            updateSaleTone(false);
        } else {
            els.premiumInput.value = '';
            updatePremiumTone(NaN);
            updateSaleTone(true);
        }
        return;
    }

    const premium = premiumRaw === '' ? 0 : parseQuoteValue(els.premiumInput.value);

    if (Number.isFinite(premium)) {
        if (premiumRaw === '') {
            els.salePriceInput.value = '';
            updatePremiumTone(0);
            updateSaleTone(true);
            return;
        }

        const salePrice = remainingValueCNY + premium;
        els.salePriceInput.value = formatMoney(salePrice);
        if (formatActive) els.premiumInput.value = formatMoney(premium);
        updatePremiumTone(premium);
        updateSaleTone(premiumRaw === '' || premium === 0);
    } else {
        els.salePriceInput.value = '';
        updatePremiumTone(NaN);
        updateSaleTone(true);
    }
}

function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

function initTheme() {
    if (localStorage.theme === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        document.documentElement.classList.add('dark');
        updateToggleUI(true);
    } else {
        document.documentElement.classList.remove('dark');
        updateToggleUI(false);
    }
}

function toggleTheme() {
    const isDark = document.documentElement.classList.toggle('dark');
    localStorage.theme = isDark ? 'dark' : 'light';
    updateToggleUI(isDark);
}

function updateToggleUI(isDark) {
    if (isDark) {
        els.themeToggleKnob.classList.add('translate-x-6');
        els.themeToggleKnob.classList.remove('translate-x-1');
    } else {
        els.themeToggleKnob.classList.remove('translate-x-6');
        els.themeToggleKnob.classList.add('translate-x-1');
    }
}

// 注意：函数名沿用历史命名（setCookie / getCookie），实际底层是 localStorage + 过期时间，
// 同时兼容旧版本可能写到 document.cookie 的数据。
function setCookie(name, value, hours) {
    const expiresAt = Date.now() + (hours * 60 * 60 * 1000);
    localStorage.setItem(name, JSON.stringify({ value, expiresAt }));
}

function getCookie(name) {
    const stored = localStorage.getItem(name);
    if (stored) {
        try {
            const parsed = JSON.parse(stored);
            if (!parsed.expiresAt || parsed.expiresAt > Date.now()) {
                return parsed.value || "";
            }
            localStorage.removeItem(name);
        } catch (e) {
            localStorage.removeItem(name);
        }
    }

    const cname = name + "=";
    const decodedCookie = decodeURIComponent(document.cookie);
    const ca = decodedCookie.split(';');
    for(let i = 0; i <ca.length; i++) {
        let c = ca[i];
        while (c.charAt(0) == ' ') {
            c = c.substring(1);
        }
        if (c.indexOf(cname) == 0) {
            return c.substring(cname.length, c.length);
        }
    }
    return "";
}

async function getHtmlToImage() {
    if (!htmlToImageModulePromise) {
        htmlToImageModulePromise = import('html-to-image');
    }

    return htmlToImageModulePromise;
}

function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob) {
                resolve(blob);
            } else {
                reject(new Error(`Canvas export failed: ${type}`));
            }
        }, type, quality);
    });
}

function resetGeneratedImage() {
    if (generatedImageUrl) {
        URL.revokeObjectURL(generatedImageUrl);
    }
    generatedImageUrl = '';
    generatedImageBlob = null;
    sharedImageUrl = '';
}

function formatDateForDisplay(value) {
    return value ? value.replace(/-/g, '/') : '--/--/--';
}

function syncDateDisplay(input) {
    const wrapper = input && input.parentElement;
    const display = wrapper && wrapper.querySelector('.date-display-value');
    if (!display) return;
    display.textContent = formatDateForDisplay(input.value);
}

function prepareDateInputsForExport(node) {
    const restoreTasks = [];
    const inputs = node.querySelectorAll('input[type="date"]');

    inputs.forEach((input) => {
        const wrapper = input.parentElement;
        if (!wrapper) return;
        const display = wrapper.querySelector('.date-display-value') || document.createElement('span');
        const hadDisplay = wrapper.contains(display);
        if (!hadDisplay) {
            display.className = 'date-display-value text-xs md:text-sm font-medium tabular-nums';
            wrapper.insertBefore(display, input.nextSibling);
        }
        display.classList.add('date-display-export');
        display.textContent = formatDateForDisplay(input.value);
        // visibility:hidden 而非 display:none：保留 input 在文档流中的占位高度，
        // 避免 wrapper 塌陷导致 position:absolute 的 display 层变为 0px 高度。
        input.style.visibility = 'hidden';

        restoreTasks.push(() => {
            input.style.visibility = '';
            display.classList.remove('date-display-export');
            if (!hadDisplay) display.remove();
        });
    });

    return () => {
        restoreTasks.reverse().forEach((restore) => restore());
    };
}

/*
 * html-to-image 序列化时无法可靠保留 -webkit-/-moz-appearance 这类伪元素相关样式，
 * Firefox 截图里 number input 会重新出现上下调节按钮。导出前用 div 替换，导出后还原。
 */
function prepareNumberInputsForExport(node) {
    const restoreTasks = [];
    const inputs = node.querySelectorAll('input[type="number"]');

    inputs.forEach((input) => {
        const display = document.createElement('div');
        display.className = input.className;
        const cs = window.getComputedStyle(input);
        // 保留输入框的对齐方式（部分 number 框是居中显示的）
        display.style.display = 'flex';
        display.style.alignItems = 'center';
        display.style.justifyContent = cs.textAlign === 'center'
            ? 'center'
            : (cs.textAlign === 'right' ? 'flex-end' : 'flex-start');
        // 保留动态计算的左内边距，防止多字符货币符号（如 NT$）在截图时与数值重叠
        display.style.paddingLeft = cs.paddingLeft;
        display.textContent = input.value || input.placeholder || '';
        input.style.display = 'none';
        input.parentElement && input.parentElement.insertBefore(display, input);

        restoreTasks.push(() => {
            input.style.display = '';
            display.remove();
        });
    });

    return () => {
        restoreTasks.reverse().forEach((restore) => restore());
    };
}

/*
 * 用 Canvas 预生成一张卡片投影 PNG 贴到卡片后：html-to-image 渲染的是同一张
 * 位图，不受 Safari 丢弃 box-shadow / 离屏下 filter 不渲染的影响，保证跨端一致。
 */
function prepareExportShadow(root, mainCard) {
    const rootRect = root.getBoundingClientRect();
    const cardRect = mainCard.getBoundingClientRect();
    const pad = 24;
    const width = Math.max(1, Math.ceil(cardRect.width) + pad * 2);
    const height = Math.max(1, Math.ceil(cardRect.height) + pad * 2);
    const radius = 22;
    const isDark = document.documentElement.classList.contains('dark');
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.shadowColor = isDark ? 'rgba(0, 0, 0, 0.42)' : 'rgba(15, 23, 42, 0.2)';
    ctx.shadowBlur = 26;
    ctx.shadowOffsetY = 8;
    ctx.fillStyle = isDark ? '#18181e' : '#f7f8fa';
    const x = pad;
    const y = pad;
    const rw = cardRect.width;
    const rh = cardRect.height;
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + rw, y, x + rw, y + rh, radius);
    ctx.arcTo(x + rw, y + rh, x, y + rh, radius);
    ctx.arcTo(x, y + rh, x, y, radius);
    ctx.arcTo(x, y, x + rw, y, radius);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    const url = canvas.toDataURL('image/png');
    const shadow = document.createElement('div');
    shadow.className = 'export-card-shadow';
    shadow.style.left = `${cardRect.left - rootRect.left - pad}px`;
    shadow.style.top = `${cardRect.top - rootRect.top - pad}px`;
    shadow.style.width = `${width}px`;
    shadow.style.height = `${height}px`;
    shadow.style.backgroundImage = `url(${url})`;
    root.insertBefore(shadow, mainCard);
    return () => { shadow.remove(); };
}

function prepareQuoteSectionForExport(mainCard) {
    const premium = parseQuoteValue(els.premiumInput.value);
    const shouldHideQuote = !Number.isFinite(premium) || premium === 0;
    mainCard.classList.toggle('quote-export-empty', shouldHideQuote);

    return () => {
        mainCard.classList.remove('quote-export-empty');
    };
}

function prepareSelectInputsForExport(node) {
    const restoreTasks = [];
    const selects = node.querySelectorAll('select');

    selects.forEach((select) => {
        const selectedValue = select.value;
        const selectedIndex = select.selectedIndex;
        const optionSnapshots = Array.from(select.options).map((option) => ({
            defaultSelected: option.defaultSelected,
            hasSelectedAttr: option.hasAttribute('selected')
        }));

        Array.from(select.options).forEach((option) => {
            const isCurrent = option.value === select.value;
            option.defaultSelected = isCurrent;
            option.toggleAttribute('selected', isCurrent);
        });

        restoreTasks.push(() => {
            Array.from(select.options).forEach((option, index) => {
                const snapshot = optionSnapshots[index];
                option.defaultSelected = snapshot.defaultSelected;
                option.toggleAttribute('selected', snapshot.hasSelectedAttr);
            });
            select.value = selectedValue;
            if (select.value !== selectedValue) select.selectedIndex = selectedIndex;
        });
    });

    return () => {
        restoreTasks.reverse().forEach((restore) => restore());
    };
}

function saveInputsToCookie() {
    const data = {
        price: els.price.value,
        currency: els.currency.value,
        cycle: Array.from(els.cycles).find(r => r.checked)?.value || "365",
        dueDate: els.dueDate.value,
        tradeDate: els.tradeDate.value,
        customRate: els.customRate.value,
        rateIsManual,
        premium: els.premiumInput.value,
        salePrice: els.salePriceInput.value,
        quoteLastEdited
    };
    setCookie("vps_inputs", JSON.stringify(data), 0.5);
}

function loadInputsFromCookie() {
    const saved = getCookie("vps_inputs");
    if (saved) {
        try {
            const data = JSON.parse(saved);
            if(data.price) els.price.value = data.price;
            if(data.currency) els.currency.value = data.currency;
            if(data.dueDate) els.dueDate.value = data.dueDate;
            if(data.tradeDate) els.tradeDate.value = data.tradeDate;
            if(data.customRate) els.customRate.value = data.customRate;
            // 手动改过的汇率要活过刷新，不能被缓存汇率覆盖
            if(data.rateIsManual && data.customRate) {
                rateIsManual = true;
                rateCurrency = data.currency || els.currency.value;
            }
            if(data.quoteLastEdited === 'sale' || data.quoteLastEdited === 'premium') {
                quoteLastEdited = data.quoteLastEdited;
                if (quoteLastEdited === 'sale' && data.salePrice) {
                    els.salePriceInput.value = data.salePrice;
                } else if (quoteLastEdited === 'premium' && data.premium && parseFloat(data.premium) !== 0) {
                    els.premiumInput.value = data.premium;
                }
            }
            if(data.cycle) {
                const radio = document.querySelector(`input[name="cycle"][value="${data.cycle}"]`);
                if(radio) radio.checked = true;
            }
            updateCurrencySymbol();
        } catch(e) { console.error("Cookie parse error", e); }
    }
}

async function initRates() {
    const base = els.currency.value;

    // 用户手动填过汇率：不拿缓存值覆盖，只把归属币种对齐
    if (rateIsManual && els.customRate.value.trim() !== '') {
        rateCurrency = base;
        calculate();
        return;
    }

    if (base === 'CNY') {
        finishRateUpdate(1);
        return;
    }

    const cacheKey = `vps_rate_${base}`;
    const cachedData = getCookie(cacheKey);

    if (cachedData) {
        try {
            const data = JSON.parse(cachedData);
            finishRateUpdate(data.rate);
        } catch (e) {
            manualRefreshRate(false);
        }
    } else {
        manualRefreshRate(false);
    }
}

async function manualRefreshRate(isUserClick = true) {
    const base = els.currency.value;
    if (base === 'CNY') return;

    const limitKey = "vps_refresh_limit";
    const rawLimit = getCookie(limitKey);
    let limitData = { count: 0, resetTime: Date.now() + 12*3600*1000 };

    if (rawLimit) {
        try {
            const parsed = JSON.parse(rawLimit);
            if (parsed.resetTime && Date.now() < parsed.resetTime) {
                limitData = parsed;
            } else {
                limitData = { count: 0, resetTime: Date.now() + RATE_CACHE_HOURS*3600*1000 };
            }
        } catch(e) {}
    }

    if (isUserClick) {
        if (limitData.count >= MANUAL_REFRESH_LIMIT) {
            showRateLimitTip();
            return;
        }
        limitData.count++;
        const hoursLeft = (limitData.resetTime - Date.now()) / (1000*3600);
        setCookie(limitKey, JSON.stringify(limitData), Math.max(0.1, hoursLeft));
    }

    await fetchExchangeRate();
}

async function fetchExchangeRate() {
    const base = els.currency.value;
    els.refreshIcon.classList.add('spin');
    els.apiRateDisplay.textContent = "刷新中";

    try {
        const response = await fetch(API_URL);
        const data = await response.json();
        
        if (data.result === "success") {
            const baseInCNY = data.rates && data.rates[base];
            if (typeof baseInCNY === 'number' && baseInCNY > 0 && Number.isFinite(baseInCNY)) {
                const rate = 1 / baseInCNY;
                finishRateUpdate(rate);
                
                const cacheData = JSON.stringify({ rate: rate, time: Date.now() });
                setCookie(`vps_rate_${base}`, cacheData, RATE_CACHE_HOURS);
                saveInputsToCookie();
            } else {
                throw new Error("Invalid rate value");
            }
        } else {
            throw new Error("API Error");
        }
    } catch (error) {
        console.error(error);
        els.apiRateDisplay.textContent = "汇率刷新";
        els.refreshIcon.classList.remove('spin');
        // 手上的汇率属于上一个币种：留着算出来的结果是错的，清空并提示手动填写
        if (rateCurrency !== els.currency.value) {
            els.customRate.value = '';
            rateCurrency = '';
            calculate();
            showToast("获取汇率失败，请手动填写");
        } else {
            showToast("获取汇率失败");
        }
    }
}

function finishRateUpdate(rate) {
    els.customRate.value = rate.toFixed(4);
    rateCurrency = els.currency.value;
    rateIsManual = false;
    els.apiRateDisplay.textContent = "汇率刷新";
    els.refreshIcon.classList.remove('spin');
    calculate();
}

function showRateLimitTip() {
    els.rateLimitTip.classList.add('show');
    if (rateLimitTimer) clearTimeout(rateLimitTimer);
    rateLimitTimer = setTimeout(() => {
        hideRateLimitTip();
    }, 2000);
}

function hideRateLimitTip() {
    els.rateLimitTip.classList.remove('show');
    if (rateLimitTimer) {
        clearTimeout(rateLimitTimer);
        rateLimitTimer = null;
    }
}

function showToast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    setTimeout(() => {
        els.toast.classList.remove('show');
    }, 2000);
}

function getBlackFriday(year) {
    const novemberFirst = new Date(year, 10, 1);
    const firstThursday = 1 + ((4 - novemberFirst.getDay() + 7) % 7);
    const thanksgivingDay = firstThursday + 21;
    return new Date(year, 10, thanksgivingDay + 1);
}

function getNextBlackFriday(date) {
    const currentYearBlackFriday = getBlackFriday(date.getFullYear());
    return date.getTime() < currentYearBlackFriday.getTime()
        ? currentYearBlackFriday
        : getBlackFriday(date.getFullYear() + 1);
}

function initDates() {
    const now = new Date();
    // 交易日期同样要持久化：只有空值时才默认成今天
    if (!els.tradeDate.value) els.tradeDate.value = formatDate(now);
    syncDateDisplay(els.tradeDate);
    if (els.dueDate.value) {
        syncDateDisplay(els.dueDate);
        return;
    }
    const targetDueDate = getNextBlackFriday(now);
    els.dueDate.value = formatDate(targetDueDate);
    syncDateDisplay(els.dueDate);
}

function formatDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function updateCurrencySymbol() {
    const code = els.currency.value;
    const sym = currencySymbols[code] || code;
    els.symbolDisplay.textContent = sym;
    // Dynamically adjust input left padding to prevent symbol/text overlap
    requestAnimationFrame(() => {
        const symRect = els.symbolDisplay.getBoundingClientRect();
        const inputRect = els.price.getBoundingClientRect();
        const neededPad = symRect.right - inputRect.left + 6;
        els.price.style.paddingLeft = Math.max(neededPad, 32) + 'px';
    });
}

function calculate() {
    const priceRaw = parseFloat(els.price.value);
    const rateRaw = parseFloat(els.customRate.value);
    const price = Number.isFinite(priceRaw) && priceRaw >= 0 ? priceRaw : 0;
    const rate = Number.isFinite(rateRaw) && rateRaw > 0 ? rateRaw : 0;

    let cycleDays = 365;
    for (const radio of els.cycles) {
        if (radio.checked) { cycleDays = parseInt(radio.value, 10); break; }
    }

    const totalCNY = price * rate;
    els.priceCNYPreview.textContent = `≈${totalCNY.toFixed(2)}元`;

    // 计算全部收敛到 calc.js（纯函数，有单测覆盖）
    const result = computeRemaining({
        price,
        rate,
        cycleDays,
        tradeDate: els.tradeDate.value,
        dueDate: els.dueDate.value
    });

    // 空 / 非法日期：清空结果区，给出占位提示
    if (!result) {
        remainingValueCNY = 0;
        setFinalValueDisplay('0.00');
        els.originalCurrencyValue.textContent = '请填写到期日 / 交易日';
        els.daysRemaining.textContent = '--';
        els.progressBar.style.width = '0%';
        els.progressText.textContent = '--';
        syncQuoteFields();
        return;
    }

    els.progressBar.style.width = `${result.barPct}%`;
    remainingValueCNY = result.valueCNY;
    setFinalValueDisplay(result.valueCNY.toFixed(2));

    // 汇率为空（如切币种后拉取失败）：提示补汇率，而不是给出 0 元
    if (rate === 0 && price > 0 && els.currency.value !== 'CNY') {
        els.originalCurrencyValue.textContent = '请填写汇率';
    } else {
        els.originalCurrencyValue.textContent = `≈ ${result.valueOrig.toFixed(2)} ${els.currency.value}`;
    }

    els.daysRemaining.textContent = result.days > 0 ? result.days : '0';
    els.progressText.textContent = `${result.labelPct}%`;
    syncQuoteFields();
}

function setFinalValueDisplay(value) {
    els.finalValue.textContent = value;
    const numericLength = value.replace(/[^0-9]/g, '').length;
    const isLongValue = numericLength >= 7;
    els.finalValue.classList.toggle('final-value-long', isLongValue);
    els.finalValue.closest('.result-amount-row')?.classList.toggle('final-value-row-long', isLongValue);
}

function copyResult() {
    const price = els.price.value || "0";
    const currency = els.currency.value;
    const rate = els.customRate.value || "0";
    const days = els.daysRemaining.textContent;
    const valCNY = els.finalValue.textContent;
    const valOrig = els.originalCurrencyValue.textContent.replace('≈', '').trim().split(' ')[0];
    const premium = els.premiumInput.value || '0.00';
    const salePrice = els.salePriceInput.value || valCNY;
    const tradeDate = els.tradeDate.value;
    const dueDate = els.dueDate.value;
    
    let cycleText = "年付";
    for (const radio of els.cycles) {
        if (radio.checked) { 
            cycleText = radio.parentElement.innerText.trim();
            break; 
        }
    }

    const cnyPrice = (parseFloat(price) * parseFloat(rate)).toFixed(2);
    const md = `## 🐔 VPS 剩余价值
- 📅 交易日期：${tradeDate}
- 💹 外币汇率：1 ${currency} ≈ ${rate} CNY
- 💰 续费价格：${price} ${currency}/${cycleText}（约 ${cnyPrice} 元）
- ⏳ 剩余天数：${days}天（${dueDate} 到期）
- 💎 剩余价值：${valCNY}元（约 ${valOrig} ${currency}）
- 🧾 溢价 / 总价：${premium}元 / ${salePrice}元`;

    copyTextToClipboard(md, flashCopyButton);
}

function copyTextToClipboard(text, done) {
    const fallbackCopy = () => {
        const textArea = document.createElement("textarea");
        textArea.value = text;
        textArea.setAttribute('readonly', '');
        textArea.style.position = 'fixed';
        textArea.style.opacity = '0';
        document.body.appendChild(textArea);
        textArea.select();
        try { document.execCommand("copy"); } catch (_) {}
        document.body.removeChild(textArea);
    };

    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(done).catch(() => { fallbackCopy(); done(); });
    } else {
        fallbackCopy();
        done();
    }
}

function copyFinalValueAmount() {
    const amount = els.finalValue.textContent.trim();
    if (!amount) return;
    copyTextToClipboard(amount, flashAmountCopyTip);
}

function flashAmountCopyTip() {
    if (!els.amountCopyTip) return;
    els.amountCopyTip.classList.add('show');
    clearTimeout(flashAmountCopyTip._t);
    flashAmountCopyTip._t = setTimeout(() => {
        els.amountCopyTip.classList.remove('show');
    }, 1500);
}

function flashCopyButton() {
    const btn = document.getElementById('copyBtn');
    if (!btn) return;
    const label = btn.querySelector('span');
    const originalText = label ? label.textContent : '';
    btn.classList.add('btn-copied');
    if (label) label.textContent = '已复制 ✓';
    clearTimeout(flashCopyButton._t);
    flashCopyButton._t = setTimeout(() => {
        btn.classList.remove('btn-copied');
        if (label) label.textContent = originalText;
    }, 1500);
}

const modal = {
    el: document.getElementById('imageModal'),
    img: document.getElementById('generatedImage'),
    loading: document.getElementById('modalLoading'),
    actions: document.getElementById('modalActions')
};

function closeImageModal() {
    modal.el.classList.remove('opacity-100');
    setTimeout(() => {
        modal.el.classList.add('hidden');
        modal.img.classList.add('hidden');
        modal.actions.classList.add('hidden');
        modal.loading.classList.remove('hidden');
        modal.img.src = '';
        resetGeneratedImage();
    }, 300);
}

// Close modal on background click
modal.el.addEventListener('click', (e) => {
    if (e.target === modal.el) closeImageModal();
});

async function generateImage() {
    
    // Show modal immediately to indicate processing
    modal.el.classList.remove('hidden');
    // Force reflow
    void modal.el.offsetWidth;
    modal.el.classList.add('opacity-100');
    
    // Use setTimeout to allow UI to update before heavy lifting
    setTimeout(async () => {
        const node = document.getElementById('captureRoot');
        const mainCard = document.getElementById('mainCard');
        node.classList.add('exporting');
        mainCard.classList.add('exporting');
        const restoreQuoteSection = prepareQuoteSectionForExport(mainCard);
        const restoreDateInputs = prepareDateInputsForExport(mainCard);
        const restoreNumberInputs = prepareNumberInputsForExport(mainCard);
        const restoreSelectInputs = prepareSelectInputsForExport(mainCard);
        const restoreExportShadow = prepareExportShadow(node, mainCard);

        try {
            const htmlToImage = await getHtmlToImage();
            const rect = node.getBoundingClientRect();
            const cssWidth = Math.max(1, Math.ceil(rect.width));
            const widthBasedRatio = SHARE_IMAGE_MIN_WIDTH / cssWidth;
            const isLowEndDevice = (typeof navigator !== 'undefined'
                && typeof navigator.deviceMemory === 'number'
                && navigator.deviceMemory > 0
                && navigator.deviceMemory <= 4)
                || (typeof window !== 'undefined' && window.innerWidth < 400);
            const maxRatio = isLowEndDevice
                ? SHARE_IMAGE_LOW_END_MAX_PIXEL_RATIO
                : SHARE_IMAGE_MAX_PIXEL_RATIO;
            // WebKit/Safari 对非整数 pixelRatio 的 box-shadow 与网格平铺渲染不准确，
            // 会导致导出样式与 Chromium 不一致；这里向上取整为整数，保证跨浏览器一致。
            const rawRatio = Math.max(SHARE_IMAGE_MIN_PIXEL_RATIO, widthBasedRatio);
            const pixelRatio = Math.min(maxRatio, Math.ceil(rawRatio));
            const canvas = await htmlToImage.toCanvas(node, {
                width: Math.ceil(rect.width),
                height: Math.ceil(rect.height),
                pixelRatio,
                filter: (element) => {
                    if (!element || !element.id) return true;
                    return !['themeToggle', 'btnContainer', 'footerWrap'].includes(element.id);
                },
                style: {
                    transform: 'scale(1)',
                }
            });
            const blob = await canvasToBlob(canvas, SHARE_IMAGE_MIME_TYPE, SHARE_IMAGE_QUALITY);
            resetGeneratedImage();
            generatedImageUrl = URL.createObjectURL(blob);
            generatedImageBlob = blob;

            modal.loading.classList.add('hidden');
            modal.img.src = generatedImageUrl;
            modal.img.classList.remove('hidden');
            modal.actions.classList.remove('hidden');
        } catch (e) {
            console.error('Synchronous error during image generation:', e);
            closeImageModal();
            showToast('生成出错');
        } finally {
            restoreSelectInputs();
            restoreNumberInputs();
            restoreDateInputs();
            restoreQuoteSection();
            restoreExportShadow();
            mainCard.classList.remove('exporting');
            node.classList.remove('exporting');
        }
    }, 100);
}

/*
 * 分享图服务：/api/share 由 Worker 提供（KV 存储，1 年过期）。
 * 未配置 KV 时健康检查返回 ok:false，按钮保持隐藏，页面其它功能不受影响。
 */
async function initShareSupport() {
    const btn = els.copyLinkBtn;
    if (!btn) return;
    try {
        const res = await fetch('/api/share', { headers: { accept: 'application/json' } });
        const data = await res.json();
        if (data && data.ok) btn.classList.remove('hidden');
    } catch (_) {
        // 本地 vite dev 或后端未部署：静默隐藏
    }
}

function flashLinkButton(text) {
    const btn = els.copyLinkBtn;
    if (!btn) return;
    const label = btn.querySelector('span');
    if (!label) return;
    label.textContent = text;
    clearTimeout(flashLinkButton._t);
    flashLinkButton._t = setTimeout(() => {
        label.textContent = SHARE_BTN_DEFAULT_TEXT;
    }, 1800);
}

async function shareGeneratedImage() {
    const btn = els.copyLinkBtn;
    const label = btn && btn.querySelector('span');
    if (!btn || !label) return;

    // 已经传过：直接复用链接，重复点击不再占存储
    if (sharedImageUrl) {
        copyTextToClipboard(sharedImageUrl, () => flashLinkButton('链接已复制 ✓'));
        return;
    }
    if (!generatedImageBlob) return;

    const originalText = label.textContent;
    btn.disabled = true;
    label.textContent = '上传中…';

    try {
        const res = await fetch('/api/share', {
            method: 'POST',
            headers: { 'content-type': generatedImageBlob.type || SHARE_IMAGE_MIME_TYPE },
            body: generatedImageBlob
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data || !data.url) {
            throw new Error((data && data.error) || `HTTP ${res.status}`);
        }
        sharedImageUrl = data.url;
        copyTextToClipboard(sharedImageUrl, () => flashLinkButton('链接已复制 ✓'));
    } catch (e) {
        console.error('share failed', e);
        label.textContent = originalText;
        btn.disabled = false;
        flashLinkButton('上传失败，请长按保存');
    }
}

// 用 addEventListener 绑定（替代 inline onclick），保持 HTML 与逻辑解耦
function bindActionButtons() {
    const map = [
        ['copyBtn', copyResult],
        ['imgBtn', generateImage],
        ['closeImageModalBtn', closeImageModal],
    ];
    for (const [id, fn] of map) {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', fn);
    }

    if (els.copyLinkBtn) {
        els.copyLinkBtn.addEventListener('click', shareGeneratedImage);
        initShareSupport();
    }

    // 鼠标悬停 / 键盘聚焦时预热 html-to-image，点击瞬间减少等待。仅触发一次。
    const imgBtn = document.getElementById('imgBtn');
    if (imgBtn) {
        const prefetch = () => {
            imgBtn.removeEventListener('pointerenter', prefetch);
            imgBtn.removeEventListener('focus', prefetch);
            try { getHtmlToImage(); } catch (_) {}
        };
        imgBtn.addEventListener('pointerenter', prefetch, { once: true });
        imgBtn.addEventListener('focus', prefetch, { once: true });
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindActionButtons);
} else {
    bindActionButtons();
}

