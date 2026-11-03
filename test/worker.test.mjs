// Worker 冒烟测试：mock ASSETS / SHARE_KV，覆盖上传 / 取图 / 限流 / 各类拒绝分支
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

const ORIGIN = 'https://jsq.343177.xyz';

const ASSETS = { async fetch() { return new Response('<html>page</html>', { status: 200 }); } };

function makeEnv({ kv = true } = {}) {
    if (!kv) return { ASSETS };
    const store = new Map();
    return {
        ASSETS,
        store,
        SHARE_KV: {
            async get(k) { const v = store.get(k); return v ? v.value : null; },
            async getWithMetadata(k) {
                const v = store.get(k);
                return v ? { value: v.value, metadata: v.metadata } : { value: null, metadata: null };
            },
            async put(k, v, o = {}) { store.set(k, { value: v, metadata: o.metadata }); return null; }
        }
    };
}

function uploadRequest(size = 200 * 1024, { type = 'image/webp', origin = ORIGIN, ip = '1.1.1.1' } = {}) {
    const body = new Uint8Array(size);
    body.set([0x52, 0x49, 0x46, 0x46]); // RIFF
    return new Request(ORIGIN + '/api/share', {
        method: 'POST', body, headers: { 'content-type': type, origin, 'cf-connecting-ip': ip }
    });
}

test('健康检查：有 KV → ok:true，无 KV → ok:false（前端据此隐藏按钮）', async () => {
    const on = await (await worker.fetch(new Request(ORIGIN + '/api/share'), makeEnv())).json();
    assert.equal(on.ok, true);

    const off = await worker.fetch(new Request(ORIGIN + '/api/share'), makeEnv({ kv: false }));
    assert.equal(off.status, 200);
    assert.equal((await off.json()).ok, false);
});

test('上传 → 取图：字节一致，长缓存，CORS 放开', async () => {
    const env = makeEnv();
    const res = await worker.fetch(uploadRequest(), env);
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.match(data.url, /^https:\/\/jsq\.343177\.xyz\/i\/[0-9a-z]{10}$/);

    const got = await worker.fetch(new Request(data.url), env);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'image/webp');
    assert.match(got.headers.get('cache-control'), /immutable/);
    assert.equal(got.headers.get('access-control-allow-origin'), '*');
    assert.equal((await got.arrayBuffer()).byteLength, 200 * 1024);
});

test('取图：不存在的 id / 非法 id 一律 404', async () => {
    const env = makeEnv();
    assert.equal((await worker.fetch(new Request(ORIGIN + '/i/0000000000'), env)).status, 404);
    assert.equal((await worker.fetch(new Request(ORIGIN + '/i/..%2Fetc'), env)).status, 404);
});

test('拒绝分支：类型 / 大小 / 来源', async () => {
    const env = makeEnv();
    assert.equal((await worker.fetch(uploadRequest(4096, { type: 'text/html' }), env)).status, 415);
    assert.equal((await worker.fetch(uploadRequest(2 * 1024 * 1024), env)).status, 413);
    assert.equal((await worker.fetch(uploadRequest(10), env)).status, 400);
    assert.equal((await worker.fetch(uploadRequest(4096, { origin: 'https://evil.example' }), env)).status, 403);
});

test('未绑定 KV 时上传返回 503，不炸站点', async () => {
    const env = makeEnv({ kv: false });
    const res = await worker.fetch(uploadRequest(4096), env);
    assert.equal(res.status, 503);
    assert.ok((await res.json()).error);
});

test('每 IP 每天 30 张上限', async () => {
    const env = makeEnv();
    let last;
    for (let i = 0; i < 31; i++) last = await worker.fetch(uploadRequest(4096), env);
    assert.equal(last.status, 429);
    assert.match((await last.json()).error, /次数/);

    // 换 IP 不受影响
    assert.equal((await worker.fetch(uploadRequest(4096, { ip: '2.2.2.2' }), env)).status, 200);
});

test('其余路径交给静态资源', async () => {
    const res = await worker.fetch(new Request(ORIGIN + '/'), makeEnv());
    assert.match(await res.text(), /<html>/);
});
