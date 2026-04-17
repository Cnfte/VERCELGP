'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const url = require('url');
const https = require('https');
const http = require('http');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────────────────────────────
// 配置常量
// ─────────────────────────────────────────────────────────────────────────────
const UPSTREAM_HOST = 'generativelanguage.googleapis.com';
const DEFAULT_API_VERSION = 'v1beta';

// 速率限制配置
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 180;

// ─────────────────────────────────────────────────────────────────────────────
// Body 解析
// ─────────────────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─────────────────────────────────────────────────────────────────────────────
// 安全中间件
// ─────────────────────────────────────────────────────────────────────────────

// 1. CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, X-Goog-Api-Key, X-Requested-With, Accept, Origin');
    res.header('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
});

// 2. 安全响应头
app.use((req, res, next) => {
    res.removeHeader('X-Powered-By');
    res.header('X-Content-Type-Options', 'nosniff');
    res.header('X-Frame-Options', 'SAMEORIGIN');
    res.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});

// 3. 速率限制
app.use((req, res, next) => {
    if (req.path === '/' || req.path === '/favicon.ico' || req.path === '/health') return next();
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    let entry = rateLimitMap.get(ip);
    if (!entry || now - entry.ts > RATE_LIMIT_WINDOW_MS) {
        entry = { ts: now, count: 0 };
    }
    entry.count++;
    rateLimitMap.set(ip, entry);
    if (rateLimitMap.size > 10000) {
        for (const [k, v] of rateLimitMap) {
            if (now - v.ts > RATE_LIMIT_WINDOW_MS * 2) rateLimitMap.delete(k);
        }
    }
    if (entry.count > RATE_LIMIT_MAX) {
        return res.status(429).json({ error: { code: 429, message: 'Too Many Requests', status: 'RESOURCE_EXHAUSTED' } });
    }
    next();
});

// ─────────────────────────────────────────────────────────────────────────────
// 辅助函数
// ─────────────────────────────────────────────────────────────────────────────

function extractApiKey(req) {
    if (req.headers['x-goog-api-key']) return req.headers['x-goog-api-key'];
    const auth = req.headers['authorization'];
    if (auth) {
        const match = auth.match(/^Bearer\s+(.+)$/i);
        if (match) return match[1].trim();
        if (!auth.includes(' ')) return auth.trim();
    }
    for (const k of ['key', 'api_key', 'apikey', 'token', 'access_token']) {
        if (req.query[k]) return req.query[k];
    }
    return null;
}

// 低级 HTTPS 请求，返回 Promise<{statusCode, headers, body: Buffer}>
function httpsRequest(hostname, path, method, headers, body) {
    return new Promise((resolve, reject) => {
        const opts = { hostname, path, method, headers };
        const req = https.request(opts, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(30000, () => { req.destroy(new Error('Request timeout')); });
        if (body) req.write(body);
        req.end();
    });
}

// 流式代理：将上游响应直接 pipe 到 res
function httpsProxy(hostname, path, method, headers, body, res) {
    return new Promise((resolve, reject) => {
        const req = https.request({ hostname, path, method, headers }, (proxyRes) => {
            res.status(proxyRes.statusCode || 200);
            const safeHeaders = ['content-type', 'content-encoding', 'cache-control', 'transfer-encoding', 'x-goog-generation'];
            for (const [k, v] of Object.entries(proxyRes.headers || {})) {
                if (safeHeaders.includes(k.toLowerCase())) res.setHeader(k, v);
            }
            proxyRes.pipe(res);
            proxyRes.on('end', resolve);
            proxyRes.on('error', reject);
            res.on('close', resolve);
        });
        req.on('error', reject);
        req.setTimeout(60000, () => { req.destroy(new Error('Proxy timeout')); });
        if (body) req.write(body);
        req.end();
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI 兼容路由: /turnopenai/<KEY>/v1/...
// ─────────────────────────────────────────────────────────────────────────────

function openaiToGeminiContents(messages) {
    const result = [];
    for (const msg of messages) {
        if (msg.role === 'system') continue;
        const role = msg.role === 'assistant' ? 'model' : 'user';
        let parts = [];
        if (typeof msg.content === 'string') {
            parts = [{ text: msg.content }];
        } else if (Array.isArray(msg.content)) {
            for (const c of msg.content) {
                if (c.type === 'text') {
                    parts.push({ text: c.text });
                } else if (c.type === 'image_url') {
                    const u = c.image_url?.url || '';
                    if (u.startsWith('data:')) {
                        const [header, data] = u.split(',');
                        const mimeType = header.replace('data:', '').replace(';base64', '');
                        parts.push({ inline_data: { mime_type: mimeType, data } });
                    } else {
                        parts.push({ text: '[Image URL: ' + u + ']' });
                    }
                }
            }
        }
        if (parts.length > 0) result.push({ role, parts });
    }
    return result;
}

function geminiToOpenaiChunk(geminiData, model, chunkId) {
    const candidate = geminiData?.candidates?.[0];
    const text = (candidate?.content?.parts || []).map(p => p.text || '').join('');
    const finishReason = candidate?.finishReason === 'STOP' ? 'stop' : (candidate?.finishReason && candidate.finishReason !== 'FINISH_REASON_UNSPECIFIED' ? 'length' : null);
    return {
        id: chunkId || ('chatcmpl-' + uuidv4()),
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: finishReason }]
    };
}

function geminiToOpenaiResponse(geminiData, model) {
    const candidate = geminiData?.candidates?.[0];
    const text = (candidate?.content?.parts || []).map(p => p.text || '').join('');
    const finishReason = candidate?.finishReason === 'STOP' ? 'stop' : 'length';
    const usage = geminiData?.usageMetadata;
    return {
        id: 'chatcmpl-' + uuidv4(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: finishReason }],
        usage: {
            prompt_tokens: usage?.promptTokenCount || 0,
            completion_tokens: usage?.candidatesTokenCount || 0,
            total_tokens: usage?.totalTokenCount || 0
        }
    };
}

app.all(/^\/turnopenai\/([^/]+)\/(.*)/, async (req, res) => {
    const geminiKey = req.params[0];
    const subPath = '/' + (req.params[1] || '');

    if (!geminiKey || geminiKey.length < 10) {
        return res.status(401).json({ error: { message: 'Invalid or missing Gemini API key in URL path', type: 'invalid_request_error' } });
    }

    // GET /v1/models
    if (req.method === 'GET' && (subPath === '/v1/models' || subPath === '/v1/models/')) {
        try {
            const result = await httpsRequest(
                UPSTREAM_HOST,
                '/v1beta/models?key=' + encodeURIComponent(geminiKey),
                'GET',
                { 'User-Agent': 'VERCELGP/3.1', 'Accept': 'application/json' },
                null
            );
            let data;
            try { data = JSON.parse(result.body.toString()); } catch (_) { data = null; }
            if (result.statusCode !== 200) {
                return res.status(result.statusCode).json({ error: { message: data?.error?.message || ('Upstream HTTP ' + result.statusCode), type: 'api_error' } });
            }
            if (!data) return res.status(502).json({ error: { message: 'Invalid JSON from upstream', type: 'api_error' } });
            const openaiModels = (data.models || [])
                .filter(m => m.name && m.name.includes('gemini'))
                .map(m => ({
                    id: m.name.replace('models/', ''),
                    object: 'model',
                    created: Math.floor(Date.now() / 1000),
                    owned_by: 'google',
                    display_name: m.displayName || m.name.replace('models/', '')
                }));
            return res.json({ object: 'list', data: openaiModels });
        } catch (e) {
            return res.status(502).json({ error: { message: 'Failed to fetch models: ' + e.message, type: 'api_error' } });
        }
    }

    // POST /v1/chat/completions
    if (req.method === 'POST' && (subPath === '/v1/chat/completions' || subPath === '/v1/chat/completions/')) {
        const body = req.body;
        if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
            return res.status(400).json({ error: { message: 'messages array is required and must not be empty', type: 'invalid_request_error' } });
        }

        const modelRaw = (body.model || 'gemini-2.0-flash').replace(/^models\//, '');
        const geminiModel = modelRaw.startsWith('gemini') ? modelRaw : 'gemini-2.0-flash';
        const isStream = body.stream === true;

        const systemMsgs = body.messages.filter(m => m.role === 'system');
        const contents = openaiToGeminiContents(body.messages);

        if (contents.length === 0) {
            return res.status(400).json({ error: { message: 'No valid user/assistant messages found', type: 'invalid_request_error' } });
        }

        const geminiBody = { contents };
        if (systemMsgs.length > 0) {
            geminiBody.systemInstruction = { parts: [{ text: systemMsgs.map(m => typeof m.content === 'string' ? m.content : '').join('\n') }] };
        }
        const genConfig = {};
        if (body.max_tokens) genConfig.maxOutputTokens = body.max_tokens;
        if (body.temperature !== undefined) genConfig.temperature = body.temperature;
        if (body.top_p !== undefined) genConfig.topP = body.top_p;
        if (Object.keys(genConfig).length) geminiBody.generationConfig = genConfig;

        const bodyStr = JSON.stringify(geminiBody);
        const bodyLen = Buffer.byteLength(bodyStr);
        const upHeaders = {
            'Content-Type': 'application/json',
            'Content-Length': bodyLen,
            'User-Agent': 'VERCELGP/3.1'
        };

        if (isStream) {
            const upPath = '/v1beta/models/' + encodeURIComponent(geminiModel) + ':streamGenerateContent?alt=sse&key=' + encodeURIComponent(geminiKey);
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            res.flushHeaders();

            const chunkId = 'chatcmpl-' + uuidv4();

            await new Promise((resolve) => {
                const proxyReq = https.request({ hostname: UPSTREAM_HOST, path: upPath, method: 'POST', headers: upHeaders }, (proxyRes) => {
                    if (proxyRes.statusCode !== 200) {
                        let errBuf = '';
                        proxyRes.on('data', d => errBuf += d);
                        proxyRes.on('end', () => {
                            try {
                                const errData = JSON.parse(errBuf);
                                res.write('data: ' + JSON.stringify({ error: errData?.error || { message: errBuf } }) + '\n\n');
                            } catch (_) {
                                res.write('data: ' + JSON.stringify({ error: { message: errBuf || ('HTTP ' + proxyRes.statusCode) } }) + '\n\n');
                            }
                            res.write('data: [DONE]\n\n');
                            res.end();
                            resolve();
                        });
                        return;
                    }

                    let buf = '';
                    proxyRes.on('data', chunk => {
                        buf += chunk.toString();
                        const lines = buf.split('\n');
                        buf = lines.pop();
                        for (const line of lines) {
                            const trimmed = line.trim();
                            if (!trimmed || trimmed === 'data: [DONE]') continue;
                            if (trimmed.startsWith('data: ')) {
                                try {
                                    const parsed = JSON.parse(trimmed.slice(6));
                                    res.write('data: ' + JSON.stringify(geminiToOpenaiChunk(parsed, geminiModel, chunkId)) + '\n\n');
                                } catch (_) {}
                            }
                        }
                    });
                    proxyRes.on('end', () => {
                        if (buf.trim().startsWith('data: ')) {
                            try {
                                const parsed = JSON.parse(buf.trim().slice(6));
                                res.write('data: ' + JSON.stringify(geminiToOpenaiChunk(parsed, geminiModel, chunkId)) + '\n\n');
                            } catch (_) {}
                        }
                        res.write('data: [DONE]\n\n');
                        res.end();
                        resolve();
                    });
                    proxyRes.on('error', () => { res.write('data: [DONE]\n\n'); res.end(); resolve(); });
                    res.on('close', resolve);
                });
                proxyReq.on('error', (e) => {
                    if (!res.writableEnded) {
                        res.write('data: ' + JSON.stringify({ error: { message: e.message } }) + '\n\n');
                        res.write('data: [DONE]\n\n');
                        res.end();
                    }
                    resolve();
                });
                proxyReq.setTimeout(60000, () => { proxyReq.destroy(new Error('Stream timeout')); });
                proxyReq.write(bodyStr);
                proxyReq.end();
            });
            return;
        } else {
            const upPath = '/v1beta/models/' + encodeURIComponent(geminiModel) + ':generateContent?key=' + encodeURIComponent(geminiKey);
            try {
                const result = await httpsRequest(UPSTREAM_HOST, upPath, 'POST', upHeaders, bodyStr);
                let data;
                try { data = JSON.parse(result.body.toString()); } catch (_) { data = null; }
                if (result.statusCode !== 200) {
                    return res.status(result.statusCode).json({ error: { message: data?.error?.message || ('Gemini HTTP ' + result.statusCode), type: 'api_error', code: result.statusCode } });
                }
                return res.json(geminiToOpenaiResponse(data, geminiModel));
            } catch (e) {
                if (!res.headersSent) {
                    return res.status(502).json({ error: { message: 'Gemini API error: ' + e.message, type: 'api_error' } });
                }
            }
        }
        return;
    }

    return res.status(404).json({ error: { message: 'Endpoint not found: ' + subPath, type: 'invalid_request_error' } });
});


// ─────────────────────────────────────────────────────────────────────────────
// 主路由
// ─────────────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get('/health', (req, res) => res.json({ status: 'ok', version: '3.1', ts: Date.now() }));

// ...（后面的代理代码保持不变）...
// ─────────────────────────────────────────────────────────────────────────────
// 通用 Gemini API 代理
// ─────────────────────────────────────────────────────────────────────────────
app.all(/(.*)/, async (req, res) => {
    const apiKey = extractApiKey(req);
    if (!apiKey) {
        return res.status(401).json({
            error: { code: 401, message: 'API key not found. Use: Authorization: Bearer KEY | x-goog-api-key header | ?key=KEY query param', status: 'UNAUTHENTICATED' }
        });
    }

    const reqPath = req.path;
    if (reqPath.includes('..') || /(%2e){2}/i.test(reqPath)) {
        return res.status(400).json({ error: { code: 400, message: 'Invalid path', status: 'INVALID_ARGUMENT' } });
    }

    // 确定目标路径
    let targetPath = reqPath;
    if (!reqPath.startsWith('/v1/') && !reqPath.startsWith('/v1beta/')) {
        targetPath = '/' + DEFAULT_API_VERSION + (reqPath.startsWith('/') ? '' : '/') + reqPath;
    }

    // 清理并重建 query string
    const qp = new url.URLSearchParams();
    for (const [k, v] of Object.entries(req.query)) {
        if (!['key', 'api_key', 'apikey', 'token', 'access_token'].includes(k.toLowerCase())) qp.set(k, v);
    }
    qp.set('key', apiKey);

    const upPath = targetPath + '?' + qp.toString();

    let bodyData = null;
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body && Object.keys(req.body).length > 0) {
        bodyData = JSON.stringify(req.body);
    }

    const upHeaders = {
        'Content-Type': 'application/json',
        'User-Agent': 'VERCELGP/3.1',
        'Accept': req.headers['accept'] || '*/*'
    };
    if (bodyData) upHeaders['Content-Length'] = Buffer.byteLength(bodyData);

    res.setHeader('X-Proxy-Request-ID', uuidv4());

    try {
        await httpsProxy(UPSTREAM_HOST, upPath, req.method, upHeaders, bodyData, res);
    } catch (error) {
        if (!res.headersSent) {
            res.status(502).json({ error: { code: 502, message: 'Proxy error: ' + error.message, status: 'BAD_GATEWAY' } });
        }
    }
});

// 全局错误处理
app.use((err, req, res, next) => {
    console.error('[Error]', err.message);
    if (!res.headersSent) res.status(500).json({ error: { code: 500, message: 'Internal Server Error', status: 'INTERNAL' } });
});

module.exports = app;

if (require.main === module) {
    app.listen(PORT, () => {
        console.log('🚀 VERCELGP v3.1  http://localhost:' + PORT);
        console.log('📡 Proxy:          /v1beta/models/<model>:generateContent?key=KEY');
        console.log('🔄 OpenAI compat:  /turnopenai/{KEY}/v1/chat/completions');
        console.log('🌐 WebUI:          http://localhost:' + PORT + '/');
    });
}
