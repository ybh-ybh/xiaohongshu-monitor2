# 小红书商品库存与销量监控系统

[![Build Status](https://github.com/baiqunfan/rxiaohongshu-monitor2/workflows/Build%20and%20Deploy%20to%20Docker%20Hub/badge.svg)](https://github.com/baiqunfan/rxiaohongshu-monitor2/actions)
[![Docker Pulls](https://img.shields.io/docker/pulls/baiqunfan/rxiaohongshu-monitor2)](https://hub.docker.com/r/baiqunfan/rxiaohongshu-monitor2)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

一个功能强大的小红书商品销量监控系统，支持自动数据采集、趋势分析和云端部署。

## ✨ 主要功能

- 🔍 **智能爬取**: 自动提取小红书商品信息和销量数据
- 📊 **实时监控**: 24/7 自动监控商品销量变化
- 📈 **趋势分析**: 可视化销量趋势图表和数据分析
- 🌐 **Web界面**: 美观易用的管理界面
- ☁️ **云端部署**: 支持 Docker 容器化部署
- 💾 **数据持久化**: 自动保存历史数据，重启不丢失
- 📦 **库存监控**: 识别商品页“已售罄/无货”和“立即购买/加入购物车”等状态
- ✉️ **补货通知**: 仅在 `OUT_OF_STOCK -> IN_STOCK` 时发送邮件，避免重复打扰
- ⏰ **定时任务**: 默认每 5 分钟刷新，可通过环境变量调整

## 🚀 快速开始

### 本地运行

```bash
# 克隆项目
git clone https://github.com/Baiqun1011/xiaohongshu-monitor.git
cd xiaohongshu-monitor

# 安装依赖
npm install

# 启动系统
npm start
# 或使用批处理脚本（Windows）
.\start_clean.bat
```

首次启动前请先在 `.env` 中配置 `AUTH_USERNAME` 和 `AUTH_PASSWORD`，服务未检测到这两个变量时会拒绝启动，避免误将未鉴权的管理后台暴露到公网。启动后访问 http://localhost:3001，会先进入登录页。

### Docker 运行

```bash
# 构建镜像
docker build -t xiaohongshu-monitor .

# 运行容器
docker run -d \
  --name xiaohongshu-monitor \
  --env-file ./.env \
  -p 3001:3001 \
  -v /www/wwwdata/xiaohongshu-monitor2:/app/data \
  xiaohongshu-monitor
```

### 使用 Docker Hub 镜像

```bash
docker run -d \
  --name xiaohongshu-monitor \
  --env-file ./.env \
  -p 3001:3001 \
  -v $(pwd)/data:/app/data \
  YOUR_USERNAME/xiaohongshu-monitor:latest
```

## 📖 使用指南

### 添加商品监控

1. 在小红书APP中找到要监控的商品
2. 点击分享 → 复制链接
3. 在监控系统中点击"添加商品"
4. 粘贴链接，系统会自动提取商品信息

首次使用建议先以有头模式启动一次完成小红书登录。登录态保存在 `data/browser-profile`，后续无头定时任务会复用该登录态：

```powershell
$env:HEADLESS="false"
npm start
```

登录完成后停止服务，再用 `HEADLESS=true` 运行监控。

### 邮件配置

不要把邮箱密码写入代码或提交到 Git。复制 `.env.example` 为项目根目录的 `.env`（该文件已加入 `.gitignore`），再填入你自己的邮箱配置：

```text
HEADLESS=true
CHECK_INTERVAL_MINUTES=5
XHS_USER_DATA_DIR=./data/browser-profile
AUTH_USERNAME=admin
AUTH_PASSWORD=请替换为至少16位的随机强密码
AUTH_COOKIE_SECURE=false
AUTH_SESSION_TTL_HOURS=168
MAIL_HOST=smtp.163.com
MAIL_PORT=465
MAIL_SECURE=true
MAIL_USERNAME=你的163邮箱
MAIL_PASSWORD=你的163授权码
MAIL_RECIPIENTS=收件人1@example.com,收件人2@example.com
```

`MAIL_RECIPIENTS` 支持多个收件人，地址之间用英文逗号或分号分隔。为兼容旧配置，也可以继续使用单个 `MAIL_RECIPIENT`；当两者同时配置时优先使用 `MAIL_RECIPIENTS`。

本地运行 `npm start` 时会自动加载 `.env`；修改配置后需要重启服务。

### 管理后台登录

- `AUTH_USERNAME`：管理后台登录用户名。
- `AUTH_PASSWORD`：管理后台登录密码，建议使用密码管理器生成的随机强密码，不要提交到 Git。
- `AUTH_COOKIE_SECURE`：HTTPS 访问时设为 `true`；本地使用 HTTP 调试时设为 `false`。未显式设置时，服务会根据请求是否为 HTTPS 自动判断。
- `AUTH_SESSION_TTL_HOURS`：登录会话有效期，默认 168 小时（7 天）；服务重启后现有会话会失效。

登录凭据只保存在环境变量中。登录失败会按来源限流，业务页面和 `/api/*` 接口均要求有效会话；`/health` 保持公开，供 Docker/Kubernetes 健康检查使用。生产环境还应通过反向代理启用 HTTPS，并避免直接把容器端口暴露到公网。

启动服务后可用下面接口验证邮件配置：

```bash
curl -X POST http://localhost:3001/api/mail/test
```

163 邮箱通常要求使用“客户端授权码”，不是网页登录密码。邮件通知只在明确检测到缺货恢复有货时触发；首次采集不会发送补货邮件。库存无法确认时会显示为 `UNKNOWN`/“待确认”，不会当作有货。

### 支持的链接格式

- 完整链接: `https://www.xiaohongshu.com/goods-detail/xxxxx`
- 短链接: `https://xhslink.com/xxxxx`
- 分享文本: 直接粘贴小红书分享的完整文本

### 功能说明

- **商品列表**: 查看所有监控商品的实时数据
- **手动刷新**: 点击刷新按钮获取最新数据
- **趋势分析**: 查看详细的销量变化图表
- **数据导出**: 支持数据备份和导出功能

## 🌐 云端部署

### GitHub Actions 自动部署

1. Fork 本项目到你的 GitHub
2. 设置 GitHub Secrets:
   - `DOCKER_USERNAME`: Docker Hub 用户名
   - `DOCKER_PASSWORD`: Docker Hub 密码
3. 推送代码自动触发构建和部署

### ClawCloud 部署

详细部署步骤请参考 [云端部署指南](./云端部署指南.md)

## 🛠️ 开发

### 项目结构

```
xiaohongshu_monitor/
├── server_simple.js        # 主服务器文件
├── public/                 # 前端静态文件
├── data/                   # 数据存储目录
├── Dockerfile             # Docker 配置
├── docker-compose.yml     # Docker Compose 配置
├── .github/workflows/     # GitHub Actions 工作流
└── docs/                  # 文档目录
```

### 技术栈

- **后端**: Node.js + Express
- **爬虫**: Puppeteer
- **定时任务**: node-cron
- **前端**: HTML + CSS + JavaScript
- **部署**: Docker + Kubernetes

### 本地开发

```bash
# 安装依赖
npm install

# 开发模式运行
npm run dev

# 修复商品名称
npm run fix-names

# Docker 本地测试
.\docker-test.bat
```

## 📊 系统监控

### 健康检查

系统提供健康检查端点：`/health`

```bash
curl http://localhost:3001/health
```

### 数据备份

```bash
# Windows
.\backup.bat

# Linux/Mac
./backup.sh
```

## 🔧 配置说明

### 环境变量

- `NODE_ENV`: 运行环境 (development/production)
- `PORT`: 服务端口 (默认: 3001)
- `TZ`: 时区设置 (默认: Asia/Shanghai)
- `AUTH_USERNAME` / `AUTH_PASSWORD`: 管理后台登录凭据（必填）
- `AUTH_COOKIE_SECURE`: 是否为登录 Cookie 启用 Secure（HTTPS 生产环境建议 `true`）
- `AUTH_SESSION_TTL_HOURS`: 登录会话有效期（小时，默认 168）

### 数据存储

- `data/products.json`: 商品信息
- `data/sales_data.json`: 销量历史数据
- `data/config.json`: 系统配置

商品记录还会保存 `stockStatus`、`stockReason`、`last_restock_at` 和 `last_notification_sent_at`，便于审计库存变化。

## 🚨 注意事项

- 请合理使用，避免频繁请求导致IP被限制
- 建议设置合适的刷新间隔（默认5分钟），过于频繁可能触发验证码或访问限制
- 云端部署时注意配置持久化存储
- 定期备份重要数据

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

1. Fork 本项目
2. 创建特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 开启 Pull Request

## 📄 许可证

本项目采用 MIT 许可证 - 查看 [LICENSE](LICENSE) 文件了解详情

## 📞 支持

如果你觉得这个项目有用，请给它一个 ⭐️！

- 问题反馈: [GitHub Issues](https://github.com/YOUR_USERNAME/xiaohongshu-monitor/issues)
- 功能建议: [GitHub Discussions](https://github.com/YOUR_USERNAME/xiaohongshu-monitor/discussions)

---

**免责声明**: 本工具仅供学习和研究使用，请遵守相关网站的使用条款和法律法规。
