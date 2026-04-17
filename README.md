# VERCELGP v3.0

**Gemini API 代理服务** —— 零门槛利用 Vercel 搭建属于你的 Gemini 专属 AI 助手（国内直连方案）

Gemini 是谷歌推出的新一代人工智能大模型，在代码理解、网页开发等领域表现出色，且 Google AI Studio 提供了免费的 Gemini API。本项目通过 Vercel 边缘网络实现反向代理，帮助国内用户无需改变网络环境即可稳定、高效地访问 Gemini API。项目采用原生 Node.js `https` 模块实现，部署简单、轻量高效，同时内置现代化 WebUI 与 OpenAI 兼容接口，适合个人使用、二次开发或对接第三方 AI 客户端。

> **免责声明**：  
> 本工具及相关教程仅用于网络科普与技术交流示范。请务必在遵守相关法律法规的前提下使用。严禁利用本工具谋取非法利益或从事违法活动，由此产生的任何法律后果与作者无关。

## 主要特性（v3.0 重构）

- **极致轻量**：移除 axios 依赖，使用 Node.js 内置 `https`/`http` 模块，冷启动更快、部署体积更小。
- **速率限制**：内置内存级 IP 限流（默认 180 次/分钟），防止滥用。
- **安全强化**：路径注入防护、完整 CORS 支持、安全响应头（`X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy` 等），移除 `X-Powered-By`。
- **OpenAI 兼容接口**：提供 `/turnopenai/{GEMINI_KEY}/v1/` 路由，可直接对接 NextChat、ChatBox、LobeChat 等第三方 AI 客户端。
- **现代化 WebUI**：
  - 暗黑主题 + 流式动画、打字机效果
  - Markdown 渲染、代码块一键复制
  - 对话管理（新建、删除、导出 Markdown）
  - System Prompt 设置、Temperature 滑块调节
  - 多模态支持（图片上传分析）
  - Toast 通知 + 响应式移动端适配
- **智能兼容**：自动处理 `v1`/`v1beta` 版本切换及字段兼容性（`systemInstruction` 等字段自动过滤）。
- **健康检查**：`GET /health` 端点。
- **Vercel 原生优化**：单文件 Serverless 部署，无需额外配置。

## 前期准备

开始前，请确保你已拥有以下工具：

1. **GitHub 账号**：用于托管代码。
2. **一个域名**（推荐）：支持 CNAME 解析即可。若没有域名，可前往 [dpdns.org](https://dpdns.org) 免费获取二级域名。
3. **网络访问环境**：用于初始获取 Gemini API Key（来自 [Google AI Studio](https://aistudio.google.com)）。
4. **Vercel 账号**：用于部署服务。

## 快速部署（一键完成）

1. **Fork 项目**  
   访问 [https://github.com/Cnfte/VERCELGP](https://github.com/Cnfte/VERCELGP)，点击右上角 **Fork** 按钮保存到你的仓库。

2. **关联 Vercel**  
   进入 [vercel.com](https://vercel.com)，选择 **Continue with GitHub** 登录。

3. **导入并部署**  
   在 Vercel 控制台点击 **Add New...** → **Project**，找到你 Fork 的 `VERCELGP` 项目，点击 **Import**。无需修改任何参数，直接点击 **Deploy**。部署通常在 30 秒内完成。

4. **绑定自定义域名（强烈推荐）**  
   部署完成后，进入项目 **Settings** → **Domains**，添加你的自定义域名。  
   在你的 DNS 服务商处添加一条 **CNAME** 记录。  
   **进阶建议**：为获得更快的国内访问速度，将 CNAME 指向 `cname-china.vercel-dns.com`。

5. **开始使用**  
   域名解析生效后，访问你的自定义域名即可进入 WebUI。输入 Gemini API Key 后即可畅聊。  
   也可将部署链接作为 API 代理地址对接其他 AI 客户端。

## 使用说明

### 1. WebUI 使用
- 打开部署后的域名（推荐使用自定义域名）。
- 点击设置面板输入你的 Gemini API Key。
- 支持新建对话、历史管理、图片上传、模型切换、温度调节、System Prompt 等功能。

### 2. OpenAI 兼容接口（推荐第三方客户端）
将客户端的 **Base URL** 设置为：

```
https://your-domain.com/turnopenai/{YOUR_GEMINI_API_KEY}/v1
```

**支持端点**：
- `GET /v1/models` —— 模型列表
- `POST /v1/chat/completions` —— 对话补全（支持流式输出）

WebUI 设置面板会自动生成并提供一键复制地址。

### 3. 原生 Gemini API 调用
所有请求自动透明转发至 Google 官方接口：

```bash
curl -X POST "https://your-domain.com/v1beta/models/gemini-2.0-flash:generateContent?key=YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [{ "parts": [{ "text": "你好，Gemini！" }] }]
  }'
```

## 文件结构

```
.
├── server.js          # 核心服务（WebUI + 代理 + OpenAI 兼容 + 安全中间件）
├── package.json       # 项目配置与依赖
├── vercel.json        # Vercel 路由配置
├── .gitignore
└── README.md
```

## 注意事项

- **API Key 安全**：Key 仅通过请求传递，服务器不存储。
- **Vercel 免费版限制**：
  - 请求 Body 大小上限约 4.5MB（大图片可能返回 413 错误）。
  - 函数执行时长限制请参考 Vercel 官方文档。
- **速率限制**：基于内存实现，重启后清零；多实例环境下独立计数。
- **域名建议**：使用自定义域名 + `cname-china.vercel-dns.com` 可显著提升国内访问速度。
- **本地开发**：
  ```bash
  npm install
  npm start
  ```
  访问 `http://localhost:3000` 测试。

## 技术栈

- **运行时**：Node.js >= 18
- **框架**：Express
- **代理实现**：原生 `https` + `http` 模块
- **WebUI**：Tailwind CSS + Marked + Highlight.js（全部内嵌）

## 许可证

MIT License © Cnfte

---

**项目地址**：https://github.com/Cnfte/VERCELGP

通过 Vercel 的边缘计算能力与自定义域名的结合，你已拥有一个稳定、高效的个人 Gemini AI 助手。技术应当连接智慧，而非制造隔阂。欢迎在 GitHub 提交 Issue 或 Pull Request 共同完善项目！
