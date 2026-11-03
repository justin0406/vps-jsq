/*
 * 静态资源 + 分享图存储。
 *
 * 路由：
 *   GET  /api/share       健康检查：返回 { ok }，前端据此决定是否显示「复制图片链接」
 *   POST /api/share       上传 WebP/PNG，返回 { url }，图片存进 KV（SHARE_KV），1 年后自动过期
 *   GET  /i/<id>          直接返回图片字节，长缓存，可当 <img src> / og:image 用
 *   其余                   交给静态资源
 *
 * 未绑定 SHARE_KV 时，/api/share 一律返回 ok:false（站点本身不受影响）。
 */

const MAX_BYTES = 1.5 * 1024 * 1024;
const MIN_BYTES = 1024;
// 保留 90 天：分享链接够用，同时把存储上限锁在「全站日上限 × 90 × 单图体积」。
// 免费版 KV 只有 1GB，实测分享图 84~120KB，30 张/天 × 90 天 ≈ 330MB，留足余量。
const TTL_SECONDS = 90 * 24 * 60 * 60;
const ALLOWED_TYPES = new Set(['image/webp', 'image/png', 'image/jpeg']);
// 单 IP 每天 10 张：正常自己用远超不出，脚本刷的话单 IP 伤害有限
const RATE_LIMIT_PER_IP_PER_DAY = 10;
// 全站每天 30 张：兜底闸门，即使被大量不同 IP 刷，也只会产生约 3.6MB/天
const DAILY_UPLOAD_CAP = 30;

function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store'
        }
    });
}

// 10 位 base36 id：约 51 bit 熵，碰撞概率可忽略，URL 也短
function makeId() {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    let n = 0n;
    for (const b of bytes) n = (n << 8n) | BigInt(b);
    return n.toString(36).padStart(10, '0').slice(-10);
}

function clientIp(request) {
    return request.headers.get('cf-connecting-ip')
        || request.headers.get('x-forwarded-for')?.split(',')[0].trim()
        || 'unknown';
}

function sameOrigin(request, url) {
    const origin = request.headers.get('origin');
    // 无 Origin（curl / 服务端）或已是同站，放行；跨站直传拒绝
    return !origin || origin === url.origin;
}

async function handleUpload(request, env, url) {
    if (request.method !== 'POST') return json({ ok: !!env.SHARE_KV }, 200);
    if (!env.SHARE_KV) return json({ ok: false, error: '分享服务未配置' }, 503);
    if (!sameOrigin(request, url)) return json({ ok: false, error: 'forbidden' }, 403);

    const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_TYPES.has(type)) {
        return json({ ok: false, error: '仅支持 webp / png / jpeg' }, 415);
    }

    const declared = Number(request.headers.get('content-length') || 0);
    if (declared > MAX_BYTES) return json({ ok: false, error: '图片过大（上限 1.5MB）' }, 413);

    const buf = await request.arrayBuffer();
    if (buf.byteLength < MIN_BYTES) return json({ ok: false, error: '图片为空' }, 400);
    if (buf.byteLength > MAX_BYTES) return json({ ok: false, error: '图片过大（上限 1.5MB）' }, 413);

    // 两道限额：单 IP 每天 10 张 + 全站每天 30 张，防止被脚本刷爆免费额度
    const day = new Date().toISOString().slice(0, 10);
    const ipKey = `rl:ip:${day}:${clientIp(request)}`;
    const dayKey = `rl:day:${day}`;
    const [ipUsedRaw, dayUsedRaw] = await Promise.all([
        env.SHARE_KV.get(ipKey),
        env.SHARE_KV.get(dayKey)
    ]);
    const ipUsed = Number(ipUsedRaw) || 0;
    const dayUsed = Number(dayUsedRaw) || 0;

    if (ipUsed >= RATE_LIMIT_PER_IP_PER_DAY) {
        return json({ ok: false, error: '今天的分享次数已用完' }, 429);
    }
    if (dayUsed >= DAILY_UPLOAD_CAP) {
        return json({ ok: false, error: '本站今天的分享额度已用完，明天再来' }, 429);
    }

    const id = makeId();
    await env.SHARE_KV.put(`img:${id}`, buf, {
        expirationTtl: TTL_SECONDS,
        metadata: { type, size: buf.byteLength, ts: Date.now() }
    });
    const counterTtl = 2 * 24 * 60 * 60;
    await Promise.all([
        env.SHARE_KV.put(ipKey, String(ipUsed + 1), { expirationTtl: counterTtl }),
        env.SHARE_KV.put(dayKey, String(dayUsed + 1), { expirationTtl: counterTtl })
    ]);

    return json({ ok: true, url: `${url.origin}/i/${id}` });
}

async function handleImage(env, id) {
    if (!env.SHARE_KV) return new Response('Not Found', { status: 404 });
    if (!/^[0-9a-z]{4,16}$/.test(id)) return new Response('Not Found', { status: 404 });

    const { value, metadata } = await env.SHARE_KV.getWithMetadata(`img:${id}`, 'arrayBuffer');
    if (!value) return new Response('Not Found', { status: 404 });

    return new Response(value, {
        headers: {
            'content-type': metadata?.type || 'image/webp',
            'cache-control': 'public, max-age=31536000, immutable',
            'access-control-allow-origin': '*'
        }
    });
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        try {
            if (url.pathname === '/api/share') {
                return await handleUpload(request, env, url);
            }
            if (url.pathname.startsWith('/i/')) {
                if (request.method !== 'GET' && request.method !== 'HEAD') {
                    return new Response('Method Not Allowed', { status: 405 });
                }
                return await handleImage(env, url.pathname.slice(3));
            }
            return await env.ASSETS.fetch(request);
        } catch (e) {
            return json({ ok: false, error: 'server error' }, 500);
        }
    }
};
