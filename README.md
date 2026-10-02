# VERCELGP v3.5 (Liquid Glass Edition)

**Gemini API 全功能智能代理服务 & 现代化液态玻璃 WebUI** —— 零门槛利用 Vercel 搭建属于你的个人专属 AI 助手（国内直连方案）

Gemini 是谷歌推出的新一代人工智能大模型。本项目通过 Vercel 边缘网络实现高性能反向代理，帮助国内用户无需改变网络环境即可稳定、高效地访问 Gemini 官方 API。

本项目采用原生 Node.js 实现，无多余第三方冗余依赖，具备 **0 安全漏洞** 架构。内置全功能**现代化液态玻璃线性动画 WebUI** 与 **OpenAI 兼容接口**，完美支持 Google 最近更新的 **Gemini 2.5 Pro / 2.5 Flash / 2.0 Thinking / 联网搜索 (Google Search Grounding) / 思考链 (Reasoning)** 等全系功能特性。

---

## 🌟 主要特性 (v3.5 重构与升级)

### 1. 🛡️ 安全防御全面加固（0 漏洞）
- **零漏洞依赖**：移除存在 CVE 漏洞的 `uuid` 包，升级至最新 Express 5，全量采用 Node.js 原生 `crypto.randomUUID()`，冷启动更快、体积更小。
- **DoS 内存耗尽防御**：重构速率限制（滑动窗口 + 定时清理机制），严密防范 IP 伪造攻击与 Map 内存泄漏。
- **路径遍历与注入拦截**：严格过滤 `..`、`%2e`、控制字符、CRLF 换行及非法 URL 字符。
- **XSS 严格阻断**：全量集成 `DOMPurify` 消毒管道，强化 `Content-Security-Policy (CSP)`、`X-Content-Type-Options`、`X-Frame-Options` 等现代安全标头。
- **资源保护**：监听客户端断开事件并立即销毁上游请求，彻底防止长连接悬挂与 API Quota 浪费。

### 2. ⚡ 深度适配 Google 最新功能性模型
- **Gemini 2.5 Pro**：旗舰级复杂逻辑推理、超强代码生成与长程任务规划。
- **Gemini 2.5 Flash**：新一代全能高效模型，平衡自适应思考速度与顶级推理质量。
- **Gemini 2.0 Flash / 2.0 Flash Lite**：GA 正式版极速多模态与超低延迟生成。
- **Gemini 2.0 Flash Thinking Exp**：深度思考推理模型，完整输出内部思考脉络。
- **🧠 深度思考链（Reasoning / Thought Trace）**：
  - WebUI 内支持实时折叠查看思考推理过程（带动态流光指示）。
  - OpenAI 兼容接口输出 `delta.reasoning_content`，无缝兼容 DeepSeek / OpenAI o1 格式的第三方客户端（如 NextChat / Cherry Studio / LobeChat）。
- **🌐 实时联网检索（Google Search Grounding）**：一键开启 Google 官方搜索引擎联网检索，回复自动附带参考来源引文与可点击卡片。
- **🛡️ 宽松安全审查策略**：默认放宽敏感词误报，防止编程调试与学术创作被过度拦截。

### 3. ✨ 现代化液态玻璃 WebUI（Liquid Glass UI）
- **拟态液态玻璃质感**：多层动态流体光球背景（Liquid Mesh Orbs）、高斯模糊毛玻璃面板、微米级镜面高光与微边框。
- **平滑线性流体动画**：自然弹簧物理过渡、动态呼吸光标、思考过程平滑折叠展开。
- **更方便的交互体验**：
  - **顶部一键切换模型**：无需反复打开设置弹窗，顶部 Pill 快速下拉切换模型。
  - **快捷功能 Pill**：顶部直接点击开关 Google 实时联网与深度思考。
  - **多模态全支持**：支持直接粘贴截图（`Ctrl+V`）、文件拖拽上传、气泡内图片与附件缩略图预览（彻底修复旧版历史记录丢失图片的 Bug）。
  - **代码块增强**：深色代码高亮、语言徽章展示、一键复制代码带反馈动画。
  - **会话管理**：支持实时搜索历史会话、一键导出 Markdown / JSON 备份、清空与单条删除。

### 4. 🔄 双模式 OpenAI 兼容接口
提供两种调用方式，完美对接 NextChat、ChatBox、LobeChat、Cherry Studio、Claude Dev 等第三方客户端：
- **方式一（路径传参，经典模式）**：
  ```
  https://your-domain.com/turnopenai/{YOUR_GEMINI_API_KEY}/v1
  ```
- **方式二（标准 Bearer Auth 模式）**：
  ```
  Base URL: https://your-domain.com/v1
  Header:   Authorization: Bearer {YOUR_GEMINI_API_KEY}
  ```

---

## 🚀 快速部署（一键完成）

1. **Fork 项目**  
   访问本项目仓库，点击右上角 **Fork** 按钮保存到你的 GitHub。

2. **关联 Vercel 部署**  
   进入 [vercel.com](https://vercel.com)，点击 **Add New...** → **Project**，导入 Fork 的 `VERCELGP` 项目，直接点击 **Deploy**。

3. **绑定自定义域名（强烈推荐）**  
   进入项目 **Settings** → **Domains** 添加你的域名。为获得最快速度，建议将 CNAME 解析至 `cname-china.vercel-dns.com`。

4. **开始使用**  
   访问域名即可体验液态玻璃 WebUI，填入 API Key 即可畅享 Gemini 2.5 / 2.0 强大能力！

---

## 📡 API 调用示例

### 1. 原生 Gemini API 透明代理
```bash
curl -X POST "https://your-domain.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?key=YOUR_API_KEY&alt=sse" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [{ "role": "user", "parts": [{ "text": "你好，请自我介绍！" }] }]
  }'
```

### 2. OpenAI 兼容流式补全（含 Reasoning 思考链）
```bash
curl -X POST "https://your-domain.com/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "gemini-2.5-pro",
    "stream": true,
    "messages": [
      {"role": "user", "content": "请推导三门问题的概率"}
    ]
  }'
```

---

## 🛠️ 本地开发与调试

```bash
# 1. 克隆代码并安装依赖
npm install

# 2. 启动服务
npm start

# 3. 访问 WebUI
http://localhost:3000
```

---

## 📄 许可证

MIT License © Cnfte
