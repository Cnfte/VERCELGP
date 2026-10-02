'use strict';

const express = require('express');
const crypto = require('crypto');
const url = require('url');
const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const VERSION = '3.5.0';

// ─────────────────────────────────────────────────────────────────────────────
// 配置常量
// ─────────────────────────────────────────────────────────────────────────────
const UPSTREAM_HOST = 'generativelanguage.googleapis.com';
const DEFAULT_API_VERSION = 'v1beta';

// 速率限制配置（内存级滑动窗口 + 自动清理，防止内存耗尽 DoS）
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 180;
const MAX_RATE_LIMIT_ENTRIES = 5000;

// 定时清理过期 IP 限流记录（避免每次请求全表扫描造成 CPU 峰值）
const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of rateLimitMap.entries()) {
        if (now - entry.ts > RATE_LIMIT_WINDOW_MS) {
            rateLimitMap.delete(ip);
        }
    }
}, 60000);
if (cleanupTimer.unref) cleanupTimer.unref();

// ─────────────────────────────────────────────────────────────────────────────
// Body 解析
// ─────────────────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// ─────────────────────────────────────────────────────────────────────────────
// 安全中间件
// ─────────────────────────────────────────────────────────────────────────────

// 1. CORS 配置
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, X-Goog-Api-Key, X-Requested-With, Accept, Origin');
    res.setHeader('Access-Control-Expose-Headers', 'X-Proxy-Request-ID, Content-Length, Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
});

// 2. 安全响应头与 CSP 防护
app.use((req, res, next) => {
    res.removeHeader('X-Powered-By');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

    // 对 HTML 页面启用严格 CSP 策略，允许必需的 CDN 与样式/字体资源
    if (req.path === '/' || req.path === '/index.html') {
        res.setHeader(
            'Content-Security-Policy',
            "default-src 'self'; " +
            "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; " +
            "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com; " +
            "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com data:; " +
            "img-src 'self' data: https: blob:; " +
            "connect-src 'self' https://generativelanguage.googleapis.com; " +
            "frame-ancestors 'self';"
        );
    }
    next();
});

// 安全提取客户端真实 IP，防止伪造 IP 造成的限流绕过或内存膨胀
function getClientIp(req) {
    const rawIp = req.headers['x-vercel-forwarded-for'] ||
                  req.headers['x-forwarded-for'] ||
                  req.headers['x-real-ip'] ||
                  req.socket?.remoteAddress ||
                  '127.0.0.1';
    const firstIp = String(rawIp).split(',')[0].trim();
    // 基础正则校验 IPv4 / IPv6 格式
    if (/^[a-fA-F0-9:.]+$/.test(firstIp) && firstIp.length <= 45) {
        return firstIp;
    }
    return '127.0.0.1';
}

// 3. 速率限制中间件
app.use((req, res, next) => {
    if (req.path === '/' || req.path === '/favicon.ico' || req.path === '/health') return next();

    const ip = getClientIp(req);
    const now = Date.now();
    let entry = rateLimitMap.get(ip);

    if (!entry || now - entry.ts > RATE_LIMIT_WINDOW_MS) {
        entry = { ts: now, count: 0 };
    }
    entry.count++;
    rateLimitMap.set(ip, entry);

    // 如果 Map 容量超标，立即快速清理一次超期条目
    if (rateLimitMap.size > MAX_RATE_LIMIT_ENTRIES) {
        for (const [k, v] of rateLimitMap) {
            if (now - v.ts > RATE_LIMIT_WINDOW_MS) rateLimitMap.delete(k);
        }
    }

    if (entry.count > RATE_LIMIT_MAX) {
        return res.status(429).json({
            error: {
                code: 429,
                message: 'Too Many Requests - Rate limit exceeded (max 180 req/min). Please try again later.',
                status: 'RESOURCE_EXHAUSTED'
            }
        });
    }
    next();
});

// ─────────────────────────────────────────────────────────────────────────────
// 辅助与安全校验函数
// ─────────────────────────────────────────────────────────────────────────────

function extractApiKey(req) {
    if (req.headers['x-goog-api-key']) return String(req.headers['x-goog-api-key']).trim();
    const auth = req.headers['authorization'];
    if (auth && typeof auth === 'string') {
        const match = auth.match(/^Bearer\s+(.+)$/i);
        if (match) return match[1].trim();
        if (!auth.includes(' ')) return auth.trim();
    }
    for (const k of ['key', 'api_key', 'apikey', 'token', 'access_token']) {
        if (req.query[k] && typeof req.query[k] === 'string') return req.query[k].trim();
    }
    return null;
}

// 严格 API Key 格式校验（防注入与异常输入）
function isValidApiKey(key) {
    if (!key || typeof key !== 'string') return false;
    const clean = key.trim();
    return clean.length >= 10 && clean.length <= 256 && /^[a-zA-Z0-9_\-]+$/.test(clean);
}

// 严格模型名称安全校验
function sanitizeModelName(name, defaultModel = 'gemini-2.0-flash') {
    if (!name || typeof name !== 'string') return defaultModel;
    const clean = name.replace(/^models\//, '').trim();
    if (!/^[a-zA-Z0-9_\-\.:]+$/.test(clean)) return defaultModel;
    return clean;
}

// 路径遍历与非法控制字符过滤
function sanitizePath(rawPath) {
    if (!rawPath || typeof rawPath !== 'string') return null;
    // 拒绝包含相对路径遍历、CRLF 换行或空字节
    if (rawPath.includes('..') || /(%2e){2}/i.test(rawPath) || /[\r\n\0]/.test(rawPath)) {
        return null;
    }
    // 归一化连续斜杠
    const normalized = rawPath.replace(/\/+/g, '/');
    if (!/^[a-zA-Z0-9_\-\./:%~]+$/.test(normalized)) {
        return null;
    }
    return normalized;
}

// HTTPS 底层请求（带连接销毁保护）
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
        req.setTimeout(35000, () => {
            req.destroy(new Error('Request timeout to upstream'));
        });
        if (body) req.write(body);
        req.end();
    });
}

// 流式代理：将上游响应安全 pipe 到 res，并监听客户端断开事件终止上游请求
function httpsProxy(hostname, path, method, headers, body, res) {
    return new Promise((resolve, reject) => {
        const req = https.request({ hostname, path, method, headers }, (proxyRes) => {
            res.status(proxyRes.statusCode || 200);
            const safeHeaders = [
                'content-type',
                'content-encoding',
                'cache-control',
                'transfer-encoding',
                'x-goog-generation',
                'x-goog-safety-rating'
            ];
            for (const [k, v] of Object.entries(proxyRes.headers || {})) {
                if (safeHeaders.includes(k.toLowerCase())) res.setHeader(k, v);
            }
            proxyRes.pipe(res);
            proxyRes.on('end', resolve);
            proxyRes.on('error', (err) => {
                req.destroy();
                reject(err);
            });
            res.on('close', () => {
                req.destroy();
                resolve();
            });
        });

        req.on('error', (err) => {
            reject(err);
        });

        // 客户端主动取消请求时立即销毁上游请求，防止继续消耗 Google API 配额
        res.on('close', () => {
            if (!req.destroyed) req.destroy();
            resolve();
        });

        req.setTimeout(90000, () => {
            req.destroy(new Error('Proxy upstream timeout'));
        });

        if (body) req.write(body);
        req.end();
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI 兼容协议转换器（适配 Google Gemini 2.5 / 2.0 / Thinking / 联网搜索）
// ─────────────────────────────────────────────────────────────────────────────

function openaiToGeminiContents(messages) {
    const rawList = [];

    for (const msg of messages) {
        if (!msg) continue;
        // system 与 developer 角色由外部提取为 systemInstruction 处理
        if (msg.role === 'system' || msg.role === 'developer') continue;

        const role = (msg.role === 'assistant' || msg.role === 'model') ? 'model' : 'user';
        let parts = [];

        if (typeof msg.content === 'string') {
            if (msg.content.length > 0) parts = [{ text: msg.content }];
        } else if (Array.isArray(msg.content)) {
            for (const c of msg.content) {
                if (!c) continue;
                if (c.type === 'text' && c.text) {
                    parts.push({ text: c.text });
                } else if (c.type === 'image_url') {
                    const u = c.image_url?.url || '';
                    if (u.startsWith('data:')) {
                        const commaIdx = u.indexOf(',');
                        if (commaIdx !== -1) {
                            const header = u.slice(0, commaIdx);
                            const data = u.slice(commaIdx + 1);
                            const mimeType = header.replace(/^data:/i, '').replace(/;base64$/i, '').trim();
                            parts.push({ inlineData: { mimeType, data } });
                        }
                    } else if (u) {
                        parts.push({ text: '[Image URL: ' + u + ']' });
                    }
                }
            }
        }

        if (parts.length > 0) {
            rawList.push({ role, parts });
        }
    }

    if (rawList.length === 0) return [];

    // Google Gemini API 要求多轮对话必须在 user 与 model 之间严格交替
    // 并且第一条消息角色必须为 user。在此合并连续同角色的消息，防止 400 报错。
    const result = [];
    for (const item of rawList) {
        if (result.length === 0) {
            if (item.role === 'model') {
                // 如果首条消息是 model，先补一条空用户引导
                result.push({ role: 'user', parts: [{ text: 'Hello' }] });
            }
            result.push(item);
        } else {
            const prev = result[result.length - 1];
            if (prev.role === item.role) {
                prev.parts.push(...item.parts);
            } else {
                result.push(item);
            }
        }
    }

    return result;
}

// 解析 Gemini 返回的 candidate 内容，支持区分深度思考（reasoning / thought）与正文
function extractGeminiCandidate(geminiData) {
    const candidate = geminiData?.candidates?.[0];
    const parts = candidate?.content?.parts || [];

    let reasoningText = '';
    let mainText = '';

    for (const p of parts) {
        if (p.thought === true) {
            reasoningText += (p.text || '');
        } else if (p.text) {
            mainText += p.text;
        }
    }

    const finishReason = candidate?.finishReason === 'STOP'
        ? 'stop'
        : (candidate?.finishReason && candidate.finishReason !== 'FINISH_REASON_UNSPECIFIED' ? 'length' : null);

    return {
        reasoningText,
        mainText,
        finishReason,
        groundingMetadata: candidate?.groundingMetadata || geminiData?.groundingMetadata || null
    };
}

// 生成 OpenAI SSE 流式 Chunk（支持 reasoning_content 深度思考流）
function geminiToOpenaiStreamChunks(geminiData, model, chunkId, state) {
    const { reasoningText, mainText, finishReason } = extractGeminiCandidate(geminiData);
    const chunks = [];

    // 思考过程输出 (reasoning_content，兼容 DeepSeek / OpenAI o1 格式)
    if (reasoningText) {
        const delta = { reasoning_content: reasoningText };
        if (!state.hasSentRole) {
            delta.role = 'assistant';
            state.hasSentRole = true;
        }
        chunks.push({
            id: chunkId,
            object: 'chat.completion.chunk',
            created: state.created,
            model,
            choices: [{ index: 0, delta, finish_reason: null }]
        });
    }

    // 正文输出 (content)
    if (mainText) {
        const delta = { content: mainText };
        if (!state.hasSentRole) {
            delta.role = 'assistant';
            state.hasSentRole = true;
        }
        chunks.push({
            id: chunkId,
            object: 'chat.completion.chunk',
            created: state.created,
            model,
            choices: [{ index: 0, delta, finish_reason: null }]
        });
    }

    // 结束标识
    if (finishReason) {
        chunks.push({
            id: chunkId,
            object: 'chat.completion.chunk',
            created: state.created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }]
        });
    }

    return chunks;
}

// 非流式完整响应转换
function geminiToOpenaiResponse(geminiData, model) {
    const { reasoningText, mainText, finishReason, groundingMetadata } = extractGeminiCandidate(geminiData);
    const usage = geminiData?.usageMetadata;

    const message = {
        role: 'assistant',
        content: mainText || ''
    };
    if (reasoningText) {
        message.reasoning_content = reasoningText;
    }

    // 如果包含联网搜索引用，以脚注形式丰富内容
    if (groundingMetadata?.groundingChunks?.length) {
        const sources = groundingMetadata.groundingChunks
            .map((chunk, idx) => {
                const web = chunk.web;
                return web ? `[${idx + 1}] [${web.title || web.uri}](${web.uri})` : null;
            })
            .filter(Boolean);
        if (sources.length > 0) {
            message.citations = sources;
        }
    }

    return {
        id: 'chatcmpl-' + crypto.randomUUID(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
            index: 0,
            message,
            finish_reason: finishReason || 'stop'
        }],
        usage: {
            prompt_tokens: usage?.promptTokenCount || 0,
            completion_tokens: usage?.candidatesTokenCount || 0,
            total_tokens: usage?.totalTokenCount || 0
        }
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI 兼容接口路由处理器 (同时支持 /turnopenai/:key/v1/... 与 标准 /v1/...)
// ─────────────────────────────────────────────────────────────────────────────

async function handleOpenAICompatible(req, res, apiKey, subPath) {
    if (!isValidApiKey(apiKey)) {
        return res.status(401).json({
            error: {
                message: 'Invalid or missing Gemini API key. Ensure a valid key is provided.',
                type: 'invalid_request_error',
                code: 'invalid_api_key'
            }
        });
    }

    const cleanSubPath = (subPath || '').replace(/^\/+/, '/');

    // 1. GET /v1/models 模型列表
    if (req.method === 'GET' && (cleanSubPath === '/v1/models' || cleanSubPath === '/models')) {
        try {
            const upPath = '/v1beta/models?key=' + encodeURIComponent(apiKey);
            const result = await httpsRequest(
                UPSTREAM_HOST,
                upPath,
                'GET',
                { 'User-Agent': 'VERCELGP/' + VERSION, 'Accept': 'application/json' },
                null
            );

            let data;
            try { data = JSON.parse(result.body.toString('utf-8')); } catch (_) { data = null; }

            if (result.statusCode !== 200) {
                return res.status(result.statusCode).json({
                    error: {
                        message: data?.error?.message || ('Upstream returned HTTP ' + result.statusCode),
                        type: 'api_error'
                    }
                });
            }

            if (!data || !Array.isArray(data.models)) {
                return res.status(502).json({ error: { message: 'Invalid response from Google API', type: 'api_error' } });
            }

            const openaiModels = data.models
                .filter(m => m.name && (m.name.includes('gemini') || m.name.includes('imagen')))
                .map(m => {
                    const id = m.name.replace(/^models\//, '');
                    return {
                        id,
                        object: 'model',
                        created: Math.floor(Date.now() / 1000),
                        owned_by: 'google',
                        display_name: m.displayName || id,
                        description: m.description || '',
                        input_token_limit: m.inputTokenLimit || 0,
                        output_token_limit: m.outputTokenLimit || 0
                    };
                });

            return res.json({ object: 'list', data: openaiModels });
        } catch (e) {
            return res.status(502).json({ error: { message: 'Failed to fetch models from upstream: ' + e.message, type: 'api_error' } });
        }
    }

    // 2. POST /v1/chat/completions 对话补全
    if (req.method === 'POST' && (cleanSubPath === '/v1/chat/completions' || cleanSubPath === '/chat/completions')) {
        const body = req.body;
        if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
            return res.status(400).json({
                error: { message: 'The "messages" field is required and must be a non-empty array', type: 'invalid_request_error' }
            });
        }

        const modelRaw = body.model || 'gemini-2.0-flash';
        const geminiModel = sanitizeModelName(modelRaw);
        const isStream = body.stream === true;

        // 提取系统提示词 (支持 system 与 developer)
        const systemMsgs = body.messages.filter(m => m.role === 'system' || m.role === 'developer');
        const contents = openaiToGeminiContents(body.messages);

        if (contents.length === 0) {
            return res.status(400).json({
                error: { message: 'No valid user or assistant messages found to process', type: 'invalid_request_error' }
            });
        }

        const geminiBody = { contents };

        if (systemMsgs.length > 0) {
            const systemText = systemMsgs
                .map(m => (typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.map(c => c.text || '').join('\n') : '')))
                .filter(Boolean)
                .join('\n\n');
            if (systemText) {
                geminiBody.systemInstruction = { parts: [{ text: systemText }] };
            }
        }

        // 生成参数构建
        const genConfig = {};
        if (body.max_tokens) genConfig.maxOutputTokens = body.max_tokens;
        if (body.temperature !== undefined) genConfig.temperature = Math.max(0, Math.min(2, Number(body.temperature)));
        if (body.top_p !== undefined) genConfig.topP = Math.max(0, Math.min(1, Number(body.top_p)));
        if (body.top_k !== undefined) genConfig.topK = Number(body.top_k);

        // 适配 Gemini 2.5 / 2.0 思考预算 (thinkingConfig)
        if (body.thinking_budget !== undefined) {
            genConfig.thinkingConfig = { thinkingBudget: Number(body.thinking_budget) };
        } else if (body.reasoning_effort) {
            const effortMap = { low: 1024, medium: 4096, high: 16384 };
            if (effortMap[body.reasoning_effort]) {
                genConfig.thinkingConfig = { thinkingBudget: effortMap[body.reasoning_effort] };
            }
        }

        if (Object.keys(genConfig).length > 0) {
            geminiBody.generationConfig = genConfig;
        }

        // 联网搜索 (Google Search Grounding) 支持
        if (body.web_search || body.google_search || (Array.isArray(body.tools) && body.tools.some(t => t.type === 'web_search' || t.name === 'google_search'))) {
            geminiBody.tools = [{ googleSearch: {} }];
        }

        // 默认放宽安全策略，避免误拦截正常编程或学术分析
        geminiBody.safetySettings = [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' }
        ];

        const bodyStr = JSON.stringify(geminiBody);
        const upHeaders = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(bodyStr),
            'User-Agent': 'VERCELGP/' + VERSION
        };

        // ── 流式响应 ──
        if (isStream) {
            const upPath = `/v1beta/models/${encodeURIComponent(geminiModel)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;

            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            if (res.flushHeaders) res.flushHeaders();

            const chunkId = 'chatcmpl-' + crypto.randomUUID();
            const streamState = {
                created: Math.floor(Date.now() / 1000),
                hasSentRole: false
            };

            return new Promise((resolve) => {
                const proxyReq = https.request({ hostname: UPSTREAM_HOST, path: upPath, method: 'POST', headers: upHeaders }, (proxyRes) => {
                    if (proxyRes.statusCode !== 200) {
                        let errBuf = '';
                        proxyRes.on('data', d => { errBuf += d; });
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
                    proxyRes.on('data', (chunk) => {
                        buf += chunk.toString('utf-8');
                        const lines = buf.split('\n');
                        buf = lines.pop() || '';

                        for (const line of lines) {
                            const trimmed = line.trim();
                            if (!trimmed || trimmed === 'data: [DONE]') continue;
                            if (trimmed.startsWith('data: ')) {
                                try {
                                    const parsed = JSON.parse(trimmed.slice(6));
                                    const chunks = geminiToOpenaiStreamChunks(parsed, geminiModel, chunkId, streamState);
                                    for (const c of chunks) {
                                        res.write('data: ' + JSON.stringify(c) + '\n\n');
                                    }
                                } catch (_) {}
                            }
                        }
                    });

                    proxyRes.on('end', () => {
                        if (buf.trim().startsWith('data: ')) {
                            try {
                                const parsed = JSON.parse(buf.trim().slice(6));
                                const chunks = geminiToOpenaiStreamChunks(parsed, geminiModel, chunkId, streamState);
                                for (const c of chunks) {
                                    res.write('data: ' + JSON.stringify(c) + '\n\n');
                                }
                            } catch (_) {}
                        }
                        res.write('data: [DONE]\n\n');
                        res.end();
                        resolve();
                    });

                    proxyRes.on('error', () => {
                        if (!res.writableEnded) {
                            res.write('data: [DONE]\n\n');
                            res.end();
                        }
                        resolve();
                    });

                    res.on('close', () => {
                        if (!proxyReq.destroyed) proxyReq.destroy();
                        resolve();
                    });
                });

                proxyReq.on('error', (e) => {
                    if (!res.writableEnded) {
                        res.write('data: ' + JSON.stringify({ error: { message: e.message } }) + '\n\n');
                        res.write('data: [DONE]\n\n');
                        res.end();
                    }
                    resolve();
                });

                res.on('close', () => {
                    if (!proxyReq.destroyed) proxyReq.destroy();
                    resolve();
                });

                proxyReq.setTimeout(90000, () => {
                    proxyReq.destroy(new Error('Stream timeout from Google API'));
                });

                proxyReq.write(bodyStr);
                proxyReq.end();
            });
        } else {
            // ── 非流式响应 ──
            const upPath = `/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;
            try {
                const result = await httpsRequest(UPSTREAM_HOST, upPath, 'POST', upHeaders, bodyStr);
                let data;
                try { data = JSON.parse(result.body.toString('utf-8')); } catch (_) { data = null; }

                if (result.statusCode !== 200) {
                    return res.status(result.statusCode).json({
                        error: {
                            message: data?.error?.message || ('Gemini HTTP ' + result.statusCode),
                            type: 'api_error',
                            code: result.statusCode
                        }
                    });
                }

                if (!data) {
                    return res.status(502).json({ error: { message: 'Invalid JSON response from Gemini API', type: 'api_error' } });
                }

                return res.json(geminiToOpenaiResponse(data, geminiModel));
            } catch (e) {
                if (!res.headersSent) {
                    return res.status(502).json({ error: { message: 'Gemini API connection error: ' + e.message, type: 'api_error' } });
                }
            }
        }
        return;
    }

    return res.status(404).json({
        error: { message: 'Endpoint not found or method not allowed: ' + cleanSubPath, type: 'invalid_request_error' }
    });
}

// 兼容路径：/turnopenai/:key/v1/...
app.all(/^\/turnopenai\/([^/]+)\/(.*)/, async (req, res) => {
    const rawKey = req.params[0];
    const subPath = '/' + (req.params[1] || '');
    return handleOpenAICompatible(req, res, rawKey, subPath);
});

// 标准 OpenAI 路径：/v1/chat/completions 与 /v1/models (通过 Authorization: Bearer 提供 Key)
app.all(/^\/v1\/(chat\/completions|models)\/?$/, async (req, res) => {
    const apiKey = extractApiKey(req);
    const subPath = req.path;
    return handleOpenAICompatible(req, res, apiKey, subPath);
});

// ─────────────────────────────────────────────────────────────────────────────
// 基础页面与健康检测
// ─────────────────────────────────────────────────────────────────────────────

let cachedIndexHtml = null;
function loadIndexHtml() {
    if (cachedIndexHtml) return cachedIndexHtml;
    const candidates = [
        path.join(__dirname, 'index.html'),
        path.join(process.cwd(), 'index.html'),
        path.resolve('index.html')
    ];
    for (const p of candidates) {
        try {
            if (fs.existsSync(p)) {
                cachedIndexHtml = fs.readFileSync(p, 'utf-8');
                return cachedIndexHtml;
            }
        } catch (_) {}
    }
    return null;
}

app.get(['/', '/index.html'], (req, res) => {
    const html = loadIndexHtml();
    if (html) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(html);
    }
    res.sendFile(path.join(__dirname, 'index.html'), (err) => {
        if (err && !res.headersSent) {
            res.status(500).send('Index HTML not found');
        }
    });
});

app.get('/favicon.ico', (req, res) => res.status(204).end());

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        version: VERSION,
        uptime: Math.floor(process.uptime()),
        timestamp: Date.now(),
        models_supported: [
            'gemini-2.5-pro',
            'gemini-2.5-flash',
            'gemini-2.0-flash',
            'gemini-2.0-flash-lite',
            'gemini-2.0-flash-thinking-exp-01-21',
            'gemini-2.0-pro-exp-02-05',
            'gemini-1.5-pro',
            'gemini-1.5-flash'
        ],
        features: [
            'reasoning_content (thinking process)',
            'google_search_grounding',
            'openai_compat',
            'multimodal_vision',
            'liquid_glass_ui'
        ]
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 原生 Gemini API 透明代理
// ─────────────────────────────────────────────────────────────────────────────

app.all(/(.*)/, async (req, res) => {
    const apiKey = extractApiKey(req);
    if (!apiKey) {
        return res.status(401).json({
            error: {
                code: 401,
                message: 'API key not found. Please provide via: Authorization: Bearer KEY | x-goog-api-key header | ?key=KEY parameter',
                status: 'UNAUTHENTICATED'
            }
        });
    }

    if (!isValidApiKey(apiKey)) {
        return res.status(400).json({
            error: { code: 400, message: 'Invalid API key format provided', status: 'INVALID_ARGUMENT' }
        });
    }

    const safePath = sanitizePath(req.path);
    if (!safePath) {
        return res.status(400).json({
            error: { code: 400, message: 'Invalid or forbidden characters in request path', status: 'INVALID_ARGUMENT' }
        });
    }

    // 确定目标路径 (默认前缀 /v1beta/)
    let targetPath = safePath;
    if (!safePath.startsWith('/v1/') && !safePath.startsWith('/v1beta/')) {
        targetPath = '/' + DEFAULT_API_VERSION + (safePath.startsWith('/') ? '' : '/') + safePath;
    }

    // 安全构建 Query String
    const qp = new url.URLSearchParams();
    for (const [k, v] of Object.entries(req.query || {})) {
        if (!['key', 'api_key', 'apikey', 'token', 'access_token'].includes(k.toLowerCase())) {
            if (Array.isArray(v)) {
                v.forEach(item => qp.append(k, String(item)));
            } else if (v !== undefined) {
                qp.set(k, String(v));
            }
        }
    }
    qp.set('key', apiKey);

    const upPath = targetPath + '?' + qp.toString();

    let bodyData = null;
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
        if (req.body && (typeof req.body === 'object' || typeof req.body === 'string')) {
            bodyData = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
        }
    }

    const upHeaders = {
        'Content-Type': req.headers['content-type'] || 'application/json',
        'User-Agent': 'VERCELGP/' + VERSION,
        'Accept': req.headers['accept'] || '*/*'
    };
    if (bodyData) {
        upHeaders['Content-Length'] = Buffer.byteLength(bodyData);
    }

    res.setHeader('X-Proxy-Request-ID', crypto.randomUUID());

    try {
        await httpsProxy(UPSTREAM_HOST, upPath, req.method, upHeaders, bodyData, res);
    } catch (error) {
        if (!res.headersSent) {
            res.status(502).json({
                error: {
                    code: 502,
                    message: 'Gemini Upstream Gateway Error: ' + error.message,
                    status: 'BAD_GATEWAY'
                }
            });
        }
    }
});

// 全局异常兜底
app.use((err, req, res, next) => {
    console.error('[VERCELGP Error]', err?.message || err);
    if (!res.headersSent) {
        res.status(500).json({
            error: {
                code: 500,
                message: 'Internal Server Error',
                status: 'INTERNAL'
            }
        });
    }
});

module.exports = app;

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`✨ VERCELGP v${VERSION} running on http://localhost:${PORT}`);
        console.log(`🌐 WebUI:         http://localhost:${PORT}/`);
        console.log(`📡 Native Proxy:  http://localhost:${PORT}/v1beta/models/...`);
        console.log(`🔄 OpenAI Compat: http://localhost:${PORT}/v1/chat/completions`);
        console.log(`🔗 Legacy Compat: http://localhost:${PORT}/turnopenai/{KEY}/v1`);
    });
}
