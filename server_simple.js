// 设置控制台编码为UTF-8（Windows系统）
if (process.platform === 'win32') {
    process.stdout.setEncoding('utf8');
}

const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const cron = require('node-cron');
const nodemailer = require('nodemailer');

// 启动时加载项目根目录的 .env，支持本地 npm start 使用邮件配置。
require('dotenv').config();
// 使用统一结构化日志输出，便于容器采集、筛选和关联请求。
const { logger, runWithLogContext, activeLogFormat, activeLogLevel } = require('./logger');

const app = express();
// 读取登录用户名，生产环境必须通过环境变量设置。
const AUTH_USERNAME = String(process.env.AUTH_USERNAME || '').trim();
// 读取登录密码，生产环境必须通过环境变量设置。
const AUTH_PASSWORD = String(process.env.AUTH_PASSWORD || '');
// 读取登录 Cookie 有效期配置，默认 7 天。
const configuredSessionTtlHours = Number.parseInt(process.env.AUTH_SESSION_TTL_HOURS || '168', 10);
// 将非法或过短配置收敛到至少 5 分钟，避免 NaN 导致会话永不过期。
const AUTH_SESSION_TTL_MS = Number.isFinite(configuredSessionTtlHours) && configuredSessionTtlHours > 0
    ? Math.max(5 * 60 * 1000, configuredSessionTtlHours * 60 * 60 * 1000)
    : 168 * 60 * 60 * 1000;
// 保存当前进程中的登录会话，服务重启后会自动失效。
const authSessions = new Map();
// 保存登录失败次数，用于限制暴力尝试。
const authFailures = new Map();
// 登录 Cookie 名称固定，避免和业务数据命名冲突。
const AUTH_COOKIE_NAME = 'xhs_monitor_session';
// 登录失败窗口时长。
const AUTH_FAILURE_WINDOW_MS = 15 * 60 * 1000;
// 单个来源在失败窗口内允许的最大失败次数。
const AUTH_MAX_FAILURES = 10;
// 未配置凭据时直接拒绝启动，确保公网部署不会意外开放。
if (!AUTH_USERNAME || !AUTH_PASSWORD) {
    logger.fatal('config.auth_missing', '缺少登录凭据，服务拒绝启动', {
        auth_username_configured: Boolean(AUTH_USERNAME),
        auth_password_configured: Boolean(AUTH_PASSWORD)
    });
    process.exit(1);
}
// 读取服务端口配置，未配置时使用 3001。
const PORT = parseInt(process.env.PORT || '3001', 10);
// 记录是否由用户显式指定端口，避免静默改变部署配置。
const PORT_IS_EXPLICIT = Boolean(process.env.PORT);
// Windows 可能保留默认端口，权限失败时使用本机备用端口。
const FALLBACK_PORT = 3200;
// 保存当前实际监听端口，默认值用于服务启动前的接口处理。
let activePort = PORT;
// 读取轮询间隔默认值，配置页保存后会更新运行时值。
const DEFAULT_CHECK_INTERVAL_MINUTES = Math.max(1, parseInt(process.env.CHECK_INTERVAL_MINUTES || '5', 10));
// 保存当前运行中的轮询间隔。
let checkIntervalMinutes = DEFAULT_CHECK_INTERVAL_MINUTES;
// 读取实时监控默认间隔，限制在设置页允许的秒数范围内。
const DEFAULT_REAL_TIME_CHECK_INTERVAL_SECONDS = 10;
// 保存当前运行中的实时监控间隔。
let realTimeCheckIntervalSeconds = normalizeRealTimeCheckIntervalSeconds(process.env.REAL_TIME_CHECK_INTERVAL_SECONDS, DEFAULT_REAL_TIME_CHECK_INTERVAL_SECONDS);
// 读取是否使用无头浏览器的配置。
const HEADLESS = String(process.env.HEADLESS || 'true').toLowerCase() !== 'false';
// 保存浏览器登录态的目录，避免每次抓取都重新登录。
const USER_DATA_DIR = process.env.XHS_USER_DATA_DIR || path.join(__dirname, 'data', 'browser-profile');
// 缺货文案只用于库存判断，不包含“已售”等销量文案。
const OUT_OF_STOCK_WORDS = ['已售罄', '售罄', '暂时无货', '暂无库存', '库存不足', '缺货', '补货通知', '到货通知', '无法购买', '不可购买'];
// 可购买控件文案用于确认商品当前可能有货。
const IN_STOCK_WORDS = ['立即购买', '马上抢', '立即抢购', '加入购物车', '去购买', '购买'];
// 缓存邮件发送器，避免每次通知重复创建连接配置。
let mailTransporter = null;
// 复用单个浏览器实例，避免同一登录目录被多个 Chromium 进程锁定。
let browserInstance = null;
// 保存正在进行的浏览器启动 Promise，避免并发重复启动。
let browserLaunchPromise = null;
// 标记浏览器是否由服务主动关闭，用于区分正常退出和异常断连。
let browserClosing = false;

// 清理上一次 Chromium 异常退出或跨主机复制留下的 profile 锁文件。
function clearStaleBrowserProfileLocks() {
    // Chromium 使用这三个文件标记用户数据目录的独占锁。
    const lockFileNames = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
    // 获取当前运行环境的主机名，用于识别跨主机遗留锁。
    const currentHostname = os.hostname();
    // 读取主锁文件指向的主机和进程信息。
    let lockTarget = null;

    try {
        // 主锁通常是指向“主机名-PID”的符号链接。
        const lockPath = path.join(USER_DATA_DIR, 'SingletonLock');
        const lockStats = fs.lstatSync(lockPath);
        if (lockStats.isSymbolicLink()) {
            lockTarget = fs.readlinkSync(lockPath);
        }
    } catch (error) {
        // 没有锁文件时无需处理；其他读取异常交给 Chromium 返回明确错误。
        if (error.code !== 'ENOENT') {
            logger.warn('browser.profile_lock_check_failed', '检查 Chromium profile 锁文件失败', { error });
        }
        return false;
    }

    // 无法解析锁归属时不主动删除，避免误伤仍在运行的 Chromium。
    if (!lockTarget) return false;
    // 从锁目标中拆出主机名和 Chromium 进程 PID。
    const lockMatch = String(lockTarget).match(/^(.*)-(\d+)$/);
    if (!lockMatch) return false;
    // 读取锁文件记录的主机名。
    const lockHostname = lockMatch[1];
    // 读取锁文件记录的进程号。
    const lockPid = Number.parseInt(lockMatch[2], 10);
    // 只有跨主机锁，或同主机但对应进程已退出时，才视为遗留锁。
    let staleLock = lockHostname !== currentHostname;
    if (!staleLock && Number.isInteger(lockPid) && lockPid > 0) {
        try {
            // 仅探测进程是否存在，不向目标进程发送实际信号。
            process.kill(lockPid, 0);
        } catch (error) {
            // ESRCH 表示进程已退出；其他错误按无法确认处理并保留锁。
            staleLock = error.code === 'ESRCH';
        }
    }
    if (!staleLock) return false;

    // 只删除文件或符号链接，不递归删除 profile 目录中的其他内容。
    let removed = false;
    for (const lockFileName of lockFileNames) {
        // 计算当前待清理锁文件的完整路径。
        const lockPath = path.join(USER_DATA_DIR, lockFileName);
        try {
            // 通过 lstat 避免跟随 SingletonSocket 指向 profile 外部目标。
            const lockStats = fs.lstatSync(lockPath);
            if (!lockStats.isFile() && !lockStats.isSymbolicLink()) continue;
            fs.unlinkSync(lockPath);
            removed = true;
        } catch (error) {
            // 某个锁文件不存在或已被 Chromium 自己清理时继续处理其他文件。
            if (error.code !== 'ENOENT') {
                logger.warn('browser.profile_lock_remove_failed', '清理 Chromium profile 锁文件失败', {
                    lock_file: lockFileName,
                    error
                });
            }
        }
    }
    if (removed) {
        logger.warn('browser.stale_profile_lock_removed', '已清理遗留的 Chromium profile 锁', {
            lock_target: lockTarget
        });
    }
    return removed;
}

// 记录 API 请求完成情况，健康检查默认静默以降低容器日志噪声。
app.use((req, res, next) => {
    // 读取请求日志总开关，默认开启。
    const requestLoggingEnabled = envBoolean('LOG_REQUESTS', true);
    // 读取健康检查日志开关，默认关闭。
    const healthLoggingEnabled = envBoolean('LOG_HEALTH_CHECKS', false);
    // 仅跟踪 API 与按需启用的健康检查，不记录静态资源轮询。
    const shouldTrackRequest = requestLoggingEnabled && (req.path.startsWith('/api/') || (healthLoggingEnabled && req.path === '/health'));
    if (!shouldTrackRequest) return next();

    // 优先复用网关传入的安全请求编号，否则生成新的 UUID。
    const incomingRequestId = String(req.get('x-request-id') || '');
    // 限制请求编号字符和长度，避免把任意请求头原样写入日志。
    const requestId = /^[A-Za-z0-9._:-]{1,100}$/.test(incomingRequestId) ? incomingRequestId : crypto.randomUUID();
    // 记录请求耗时起点。
    const startedAt = process.hrtime.bigint();
    // 向客户端返回关联编号，便于前后端共同排查。
    res.setHeader('x-request-id', requestId);

    return runWithLogContext({ request_id: requestId }, () => {
        res.once('finish', () => {
            // 计算请求总耗时，保留到毫秒整数即可。
            const durationMs = Number((process.hrtime.bigint() - startedAt) / BigInt(1_000_000));
            // 构造不包含查询参数和请求体的安全请求摘要。
            const fields = {
                method: req.method,
                path: req.path,
                status_code: res.statusCode,
                duration_ms: durationMs
            };
            if (res.statusCode >= 500) {
                logger.error('http.request_completed', 'API 请求失败', fields);
            } else if (res.statusCode >= 400) {
                logger.warn('http.request_completed', 'API 请求被拒绝', fields);
            } else if (req.method === 'GET') {
                logger.debug('http.request_completed', 'API 请求完成', fields);
            } else {
                logger.info('http.request_completed', 'API 请求完成', fields);
            }
        });
        return next();
    });
});

// 在请求日志上下文建立后解析 JSON，确保格式错误也能记录 requestId 和状态码。
app.use(express.json());

// 使用常量时间比较敏感字符串，减少密码比对的时序侧信道。
function safeEqual(left, right) {
    // 长度不同也执行一次哈希比较，避免直接暴露长度信息。
    const leftHash = crypto.createHash('sha256').update(String(left)).digest();
    const rightHash = crypto.createHash('sha256').update(String(right)).digest();
    return crypto.timingSafeEqual(leftHash, rightHash);
}

// 解析请求头中的 Cookie。
function parseCookies(cookieHeader) {
    // 将 Cookie 文本拆分为键值对，并忽略格式异常项。
    return String(cookieHeader || '').split(';').reduce((cookies, part) => {
        const separator = part.indexOf('=');
        if (separator <= 0) return cookies;
        const key = part.slice(0, separator).trim();
        const value = part.slice(separator + 1).trim();
        try {
            cookies[key] = decodeURIComponent(value);
        } catch (error) {
            // 忽略无法解码的 Cookie，后续按未登录处理。
        }
        return cookies;
    }, {});
}

// 获取当前请求携带且仍有效的登录会话。
function getAuthSession(req) {
    // 从 Cookie 中取出会话令牌。
    const token = parseCookies(req.headers.cookie)[AUTH_COOKIE_NAME];
    if (!token) return null;
    // 校验会话是否存在且未过期。
    const session = authSessions.get(token);
    if (!session || session.expiresAt <= Date.now()) {
        authSessions.delete(token);
        return null;
    }
    // 滑动更新过期时间，保持活跃用户登录状态。
    session.expiresAt = Date.now() + AUTH_SESSION_TTL_MS;
    return session;
}

// 判断请求是否来自登录页或健康检查等公开入口。
function isPublicRequest(req) {
    // 登录页所需静态资源保持公开，业务脚本和数据接口仍需登录。
    const publicPaths = new Set(['/login.html', '/login.js', '/login.css', '/favicon.ico', '/health']);
    return publicPaths.has(req.path) || (req.path === '/api/auth/login' && req.method === 'POST');
}

// 保护业务页面和 API，未登录请求统一返回 401 或跳转登录页。
function requireAuth(req, res, next) {
    // 公开入口无需会话校验。
    if (isPublicRequest(req)) return next();
    // 已登录请求继续访问业务资源。
    if (getAuthSession(req)) return next();
    // API 调用返回机器可读错误，页面访问跳转到登录页。
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: '请先登录' });
    return res.redirect('/login.html');
}

// 清理过期会话和登录失败记录，避免内存持续增长。
setInterval(() => {
    // 删除已经过期的会话。
    const now = Date.now();
    for (const [token, session] of authSessions) {
        if (session.expiresAt <= now) authSessions.delete(token);
    }
    // 删除已经离开失败窗口的来源记录。
    for (const [key, failure] of authFailures) {
        if (failure.resetAt <= now) authFailures.delete(key);
    }
}, 60 * 1000).unref();

// 登录接口：校验凭据并签发 HttpOnly 会话 Cookie。
app.post('/api/auth/login', (req, res) => {
    // 按来源 IP 限制失败尝试，避免通过轮换用户名绕过限流。
    const sourceKey = req.ip;
    const now = Date.now();
    const failure = authFailures.get(sourceKey);
    if (failure && failure.resetAt > now && failure.count >= AUTH_MAX_FAILURES) {
        return res.status(429).json({ error: '登录尝试过于频繁，请 15 分钟后再试' });
    }

    // 比对用户名和密码，不向客户端透露具体错误字段。
    const usernameValid = safeEqual(req.body?.username || '', AUTH_USERNAME);
    const passwordValid = safeEqual(req.body?.password || '', AUTH_PASSWORD);
    if (!usernameValid || !passwordValid) {
        const nextFailure = failure && failure.resetAt > now
            ? { count: failure.count + 1, resetAt: failure.resetAt }
            : { count: 1, resetAt: now + AUTH_FAILURE_WINDOW_MS };
        authFailures.set(sourceKey, nextFailure);
        return res.status(401).json({ error: '用户名或密码错误' });
    }

    // 登录成功后清除失败记录并创建不可预测的随机会话令牌。
    authFailures.delete(sourceKey);
    const token = crypto.randomBytes(32).toString('hex');
    authSessions.set(token, { username: AUTH_USERNAME, expiresAt: now + AUTH_SESSION_TTL_MS });
    const secureCookie = process.env.AUTH_COOKIE_SECURE === 'true' || (process.env.AUTH_COOKIE_SECURE !== 'false' && req.secure);
    const cookieParts = [
        `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
        'HttpOnly',
        'Path=/',
        'SameSite=Strict',
        `Max-Age=${Math.floor(AUTH_SESSION_TTL_MS / 1000)}`
    ];
    if (secureCookie) cookieParts.push('Secure');
    res.setHeader('Set-Cookie', cookieParts.join('; '));
    return res.json({ message: '登录成功' });
});

// 查询当前登录状态，供前端恢复页面时使用。
app.get('/api/auth/status', (req, res) => {
    // 返回最小必要用户信息，不暴露会话令牌。
    const session = getAuthSession(req);
    if (!session) return res.status(401).json({ authenticated: false });
    return res.json({ authenticated: true, username: session.username });
});

// 注销当前会话并清除浏览器 Cookie。
app.post('/api/auth/logout', (req, res) => {
    // 删除服务端会话，令旧令牌立即失效。
    const token = parseCookies(req.headers.cookie)[AUTH_COOKIE_NAME];
    if (token) authSessions.delete(token);
    // 通过过期 Cookie 清除客户端凭据。
    res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`);
    return res.json({ message: '已退出登录' });
});

// 在静态资源中间件前保护业务页面和文件。
app.use(requireAuth);
app.use(express.static('public'));

// 数据文件路径
const DATA_DIR = path.join(__dirname, 'data');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const SALES_DATA_FILE = path.join(DATA_DIR, 'sales_data.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// 确保数据目录存在
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR);
    logger.info('storage.data_directory_created', '已创建数据目录', { data_directory: DATA_DIR });
}
// 创建浏览器登录态目录。
if (!fs.existsSync(USER_DATA_DIR)) {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
}

// 数据存储
let products = [];
let salesData = [];
let nextId = 1;
// 保存配置页覆盖的收件人列表，未设置时回退到环境变量。
let mailRecipientsOverride = null;
// 防止定时任务与手动刷新同时执行造成浏览器和数据文件竞争。
let refreshInProgress = false;
// 保存当前定时任务实例，配置变更时先停止旧任务。
let refreshTask = null;
// 保存每个实时商品的独立定时器。
const realtimeRefreshTimers = new Map();
// 保存每个商品正在执行的刷新 promise，避免同一商品重复查询。
const productRefreshPromises = new Map();
// 保存 SKU 读取告警的最近输出时间，避免实时监控失败时每几秒重复刷屏。
const skuWarningLastLoggedAt = new Map();
// 同一商品 SKU 读取告警的最短输出间隔。
const SKU_WARNING_INTERVAL_MS = 5 * 60 * 1000;

// 将刷新间隔转换为受支持的分钟数。
function normalizeCheckIntervalMinutes(value, fallback = DEFAULT_CHECK_INTERVAL_MINUTES) {
    // 仅接受 1 到 59 分钟，确保 node-cron 的分钟步长有效。
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 59 ? parsed : fallback;
}

// 将实时监控间隔转换为受支持的秒数。
function normalizeRealTimeCheckIntervalSeconds(value, fallback = DEFAULT_REAL_TIME_CHECK_INTERVAL_SECONDS) {
    // 仅接受 2 到 60 秒的整数，避免请求过于频繁或失去实时性。
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 2 && parsed <= 60 ? parsed : fallback;
}

// 将收件人输入转换为去重后的邮箱列表。
function normalizeMailRecipients(value) {
    // 同时支持数组、逗号、分号和换行分隔的输入。
    const text = Array.isArray(value) ? value.join(',') : String(value || '');
    const recipients = text.split(/[;,\n]/).map(item => item.trim()).filter(Boolean);
    return [...new Set(recipients)];
}

// 校验邮箱地址格式并返回无效项。
function findInvalidMailRecipients(recipients) {
    // 使用轻量格式校验，避免把明显错误的地址写入配置。
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return recipients.filter(recipient => !emailPattern.test(recipient));
}

// 将环境变量文本转换为布尔值。
function envBoolean(name, defaultValue) {
    // 读取指定环境变量并兼容常见布尔值写法。
    const value = process.env[name];
    if (value === undefined) return defaultValue;
    return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).toLowerCase());
}

// 生成适合日志展示的 URL，移除可能包含追踪参数或临时凭据的查询字符串。
function getSafeUrlForLog(value) {
    try {
        // 仅保留协议、主机与路径，避免把 query/hash 写入容器日志。
        const parsedUrl = new URL(String(value));
        return `${parsedUrl.origin}${parsedUrl.pathname}`;
    } catch (error) {
        // 非标准 URL 不输出原文，只保留长度，避免分享文本中的无关内容进入日志。
        return `[unparseable-url:length=${String(value || '').length}]`;
    }
}

// 创建带持久化登录态的 Puppeteer 浏览器实例。
async function launchBrowser() {
    // 使用统一的浏览器配置，保证短链接解析和商品抓取共享登录状态。
    if (browserInstance) return browserInstance;
    if (browserLaunchPromise) return browserLaunchPromise;
    browserClosing = false;
    // 启动前清理可确认已经失效的 Chromium profile 锁，兼容容器迁移和异常退出。
    clearStaleBrowserProfileLocks();
    // 记录浏览器启动耗时起点。
    const startedAt = Date.now();
    logger.info('browser.launch_started', '正在启动共享 Chromium 实例', {
        headless: HEADLESS,
        profile_directory: USER_DATA_DIR
    });
    // 保存启动 Promise，令同一时刻的多个请求共享一次 Chromium 启动过程。
    browserLaunchPromise = puppeteer.launch({
        headless: HEADLESS ? 'new' : false,
        protocolTimeout: 60000,
        userDataDir: USER_DATA_DIR,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-features=VizDisplayCompositor',
            '--no-first-run',
            '--no-zygote',
            '--disable-extensions'
        ],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH || undefined
    }).then(browser => {
        browserInstance = browser;
        logger.info('browser.launch_completed', '共享 Chromium 实例已启动', {
            duration_ms: Date.now() - startedAt,
            browser_pid: browser.process()?.pid
        });
        browser.on('disconnected', () => {
            // 浏览器异常断开时清理缓存，下一次任务可以重新启动。
            const expectedDisconnect = browserClosing;
            browserInstance = null;
            browserClosing = false;
            if (expectedDisconnect) {
                logger.debug('browser.disconnected', '共享 Chromium 实例已正常断开');
            } else {
                logger.warn('browser.disconnected', '共享 Chromium 实例意外断开');
            }
        });
        return browser;
    }).catch(error => {
        logger.error('browser.launch_failed', '共享 Chromium 实例启动失败', {
            duration_ms: Date.now() - startedAt,
            error
        });
        throw error;
    }).finally(() => {
        // 启动完成后释放并发启动锁。
        browserLaunchPromise = null;
    });
    return browserLaunchPromise;
}

// 在服务退出时关闭共享浏览器实例。
async function closeBrowser() {
    // 只在浏览器确实启动过时执行关闭。
    if (browserInstance) {
        logger.info('browser.close_started', '正在关闭共享 Chromium 实例');
        browserClosing = true;
        try {
            await browserInstance.close();
            browserInstance = null;
            logger.info('browser.close_completed', '共享 Chromium 实例已关闭');
        } finally {
            browserClosing = false;
        }
    }
}

// 安全关闭单个 Puppeteer 页面，避免 Chromium 已退出时的清理异常覆盖业务错误。
async function closePageSafely(page, context) {
    // 页面不存在或已经关闭时无需重复发送关闭命令。
    if (!page || page.isClosed()) return;
    try {
        await page.close();
    } catch (error) {
        // 清理失败只记录上下文，真正的抓取错误应由原调用链负责返回。
        logger.warn('browser.page_close_failed', '浏览器页面关闭失败', { context, error });
    }
}

// 创建邮件传输器；未配置密码时返回空值并跳过邮件发送。
function getMailTransporter() {
    // 邮件配置全部来自环境变量，避免将密码写入代码或数据文件。
    const username = process.env.MAIL_USERNAME;
    const password = process.env.MAIL_PASSWORD;
    if (!username || !password) return null;
    if (!mailTransporter) {
        mailTransporter = nodemailer.createTransport({
            host: process.env.MAIL_HOST || 'smtp.163.com',
            port: parseInt(process.env.MAIL_PORT || '465', 10),
            secure: envBoolean('MAIL_SECURE', true),
            auth: { user: username, pass: password }
        });
    }
    return mailTransporter;
}

// 读取邮件收件人配置；优先使用多收件人变量并兼容旧的单收件人变量。
function getMailRecipients() {
    // 配置页设置过收件人时，允许显式保存空列表以关闭通知。
    if (Array.isArray(mailRecipientsOverride)) return mailRecipientsOverride;
    // 获取多收件人配置文本，未设置时回退到旧配置。
    const recipientsText = process.env.MAIL_RECIPIENTS || process.env.MAIL_RECIPIENT || '';
    // 支持英文逗号和分号分隔，并过滤空白项。
    return normalizeMailRecipients(recipientsText);
}

// 发送商品恢复库存通知邮件。
async function sendRestockEmail(product, productData) {
    // 未配置邮件账号时只记录日志，不阻断商品监控任务。
    const transporter = getMailTransporter();
    // 获取本次邮件的全部收件人。
    const recipients = getMailRecipients();
    if (!transporter || recipients.length === 0) {
        logger.warn('mail.restock_skipped', '邮件配置不完整，跳过补货通知', {
            product_id: product.id,
            transporter_configured: Boolean(transporter),
            recipient_count: recipients.length
        });
        return false;
    }
    // 发送包含商品名称、价格、库存状态、指定 SKU 和直达链接的邮件。
    await transporter.sendMail({
        from: process.env.MAIL_USERNAME,
        to: recipients,
        subject: `小红书商品补货提醒：${productData.name || product.name || '未知商品'}`,
        text: [
            '检测到小红书商品可能已补货。',
            `商品：${productData.name || product.name || '未知商品'}`,
            `价格：${productData.price || product.price || '未知'}`,
            `库存状态：${productData.stockStatus}`,
            `检测依据：${productData.stockReason || '可购买控件'}`,
            ...(Array.isArray(productData.monitoredSkuStatuses) && productData.monitoredSkuStatuses.length > 0
                ? [`指定 SKU：${productData.monitoredSkuStatuses.map(sku => `${sku.name}（${sku.stockStatus}）`).join('；')}`]
                : []),
            `链接：${product.url}`
        ].join('\n')
    });
    logger.info('mail.restock_sent', '补货通知邮件已发送', {
        product_id: product.id,
        product_name: productData.name || product.name,
        recipient_count: recipients.length
    });
    return true;
}

// 写入最新商品数据，并在缺货恢复有货时发送一次邮件。
async function applyProductData(product, productData) {
    // 仅把明确的 OUT_OF_STOCK -> IN_STOCK 迁移视为补货事件。
    const previousStockStatus = product.stockStatus || 'UNKNOWN';
    // 未读取规格时保留历史 SKU 数据，避免整商品刷新后无法再次编辑监控范围。
    const nextProductData = { ...productData };
    if ((!Array.isArray(productData.skus) || productData.skus.length === 0) && Array.isArray(product.skus) && product.skus.length > 0) {
        delete nextProductData.skus;
        delete nextProductData.skuOptions;
    }
    Object.assign(product, nextProductData, { last_checked_at: new Date().toISOString() });
    const restocked = previousStockStatus === 'OUT_OF_STOCK' && productData.stockStatus === 'IN_STOCK';
    if (restocked) {
        try {
            product.last_restock_at = new Date().toISOString();
            const notificationSent = await sendRestockEmail(product, productData);
            if (notificationSent) {
                product.last_notification_sent_at = new Date().toISOString();
            }
        } catch (error) {
            // 邮件失败只记录错误，不能让后续商品停止监控。
            logger.error('mail.restock_failed', '补货通知邮件发送失败', {
                product_id: product.id,
                product_name: productData.name || product.name,
                error
            });
        }
    }
    return restocked;
}

// 加载数据
function loadData() {
    try {
        // 加载商品数据
        if (fs.existsSync(PRODUCTS_FILE)) {
            const productsJson = fs.readFileSync(PRODUCTS_FILE, 'utf8');
            products = JSON.parse(productsJson);
            // 兼容旧商品数据，未配置实时监控时继续使用原来的全局刷新任务。
            products = products.map(product => ({
                ...product,
                realtime_monitoring: product.realtime_monitoring === true
            }));
        }

        // 加载销量数据
        if (fs.existsSync(SALES_DATA_FILE)) {
            const salesJson = fs.readFileSync(SALES_DATA_FILE, 'utf8');
            salesData = JSON.parse(salesJson);
        }

        // 加载配置数据
        if (fs.existsSync(CONFIG_FILE)) {
            const configJson = fs.readFileSync(CONFIG_FILE, 'utf8');
            const config = JSON.parse(configJson);
            nextId = config.nextId || 1;
            // 读取配置页保存的收件人，兼容旧配置文件没有该字段的情况。
            if (Object.prototype.hasOwnProperty.call(config, 'mail_recipients')) {
                mailRecipientsOverride = normalizeMailRecipients(config.mail_recipients);
            }
            // 读取配置页保存的刷新间隔，非法值回退到环境变量默认值。
            if (Object.prototype.hasOwnProperty.call(config, 'check_interval_minutes')) {
                checkIntervalMinutes = normalizeCheckIntervalMinutes(config.check_interval_minutes);
            }
            // 读取配置页保存的实时监控间隔，非法值回退到默认值。
            if (Object.prototype.hasOwnProperty.call(config, 'real_time_check_interval_seconds')) {
                realTimeCheckIntervalSeconds = normalizeRealTimeCheckIntervalSeconds(config.real_time_check_interval_seconds);
            }
        }

        // 如果有商品但nextId为1，重新计算nextId
        if (products.length > 0 && nextId === 1) {
            nextId = Math.max(...products.map(p => p.id)) + 1;
        }
        logger.info('storage.data_loaded', '监控数据加载完成', {
            product_count: products.length,
            sales_record_count: salesData.length,
            next_product_id: nextId,
            realtime_product_count: products.filter(product => product.realtime_monitoring === true).length,
            check_interval_minutes: checkIntervalMinutes,
            realtime_check_interval_seconds: realTimeCheckIntervalSeconds
        });
    } catch (error) {
        logger.error('storage.data_load_failed', '监控数据加载失败，将使用当前内存状态继续启动', { error });
    }
}

// 保存数据
function saveData() {
    try {
        // 保存商品数据
        fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(products, null, 2));

        // 保存销量数据
        fs.writeFileSync(SALES_DATA_FILE, JSON.stringify(salesData, null, 2));

        // 保存配置数据，覆盖环境变量默认值以便重启后继续生效。
        const config = {
            nextId,
            mail_recipients: getMailRecipients(),
            check_interval_minutes: checkIntervalMinutes,
            real_time_check_interval_seconds: realTimeCheckIntervalSeconds
        };
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));

        logger.debug('storage.data_saved', '监控数据已保存', {
            product_count: products.length,
            sales_record_count: salesData.length
        });
    } catch (error) {
        logger.error('storage.data_save_failed', '监控数据保存失败', { error });
    }
}

// 清理指定商品已有的实时监控定时器。
function clearRealtimeProductRefreshTimer(productId) {
    // 取出并取消该商品的待执行任务。
    const timer = realtimeRefreshTimers.get(productId);
    if (timer) clearTimeout(timer);
    realtimeRefreshTimers.delete(productId);
}

// 在商品查询完成后安排下一次实时监控查询。
function scheduleRealtimeProductRefresh(product) {
    // 先取消旧任务，保证同一商品最多只有一个定时器。
    clearRealtimeProductRefreshTimer(product.id);
    if (product.realtime_monitoring !== true) return;
    // 从本次查询完成时开始计算实时监控间隔。
    const timer = setTimeout(() => runWithLogContext({}, async () => {
        realtimeRefreshTimers.delete(product.id);
        const currentProduct = products.find(item => item.id === product.id);
        if (!currentProduct || currentProduct.realtime_monitoring !== true) return;
        try {
            await refreshProductData(currentProduct, { source: 'realtime' });
        } catch (error) {
            // 查询失败已由 refreshProductData 统一记录，finally 会继续安排下一次查询。
        }
    }), realTimeCheckIntervalSeconds * 1000);
    realtimeRefreshTimers.set(product.id, timer);
}

// 按指定商品执行一次查询、保存库存和销量数据。
function refreshProductData(product, options = {}) {
    // 已有查询时复用同一个 promise，避免不同来源重复访问小红书。
    const existingPromise = productRefreshPromises.get(product.id);
    if (existingPromise) {
        logger.debug('monitor.product_refresh_reused', '复用正在执行的商品刷新任务', {
            product_id: product.id,
            source: options.source || 'manual'
        });
        return existingPromise;
    }

    // 记录调用来源和手动刷新是否需要覆盖当天销量记录。
    const source = options.source || 'manual';
    const replaceToday = options.replaceToday === true;
    // 为本次商品刷新生成关联编号。
    const refreshId = crypto.randomUUID();
    // 记录刷新开始时间，用于输出耗时。
    const refreshStartedAt = Date.now();
    // 保存刷新前库存状态，用于识别真正的状态变化。
    const previousStockStatus = product.stockStatus || 'UNKNOWN';
    logger.debug('monitor.product_refresh_started', '开始刷新商品数据', {
        refresh_id: refreshId,
        batch_id: options.batchId,
        product_id: product.id,
        product_name: product.name,
        source
    });
    const refreshPromise = (async () => {
        try {
            // 实时监控和指定 SKU 商品都需要读取规格组合。
            const productData = await scrapeProductData(product.url, {
                includeSkus: Array.isArray(product.monitored_skus) && product.monitored_skus.length > 0,
                monitoredSkuIds: product.monitored_skus || [],
                refreshId,
                productId: product.id
            });
            // 更新商品库存、名称和最后查询时间。
            const restocked = await applyProductData(product, productData);

            // 记录销量数据；实时查询最多每小时追加一条历史记录。
            const now = new Date();
            const today = now.toISOString().split('T')[0];
            const existingTodayData = salesData.find(item => item.product_id === product.id && item.crawl_date === today);
            let salesRecorded = false;
            if (replaceToday) {
                salesData = salesData.filter(item => !(item.product_id === product.id && item.crawl_date === today));
                salesData.push({
                    product_id: product.id,
                    product_sales: productData.productSales,
                    shop_sales: productData.shopSales,
                    crawl_date: today,
                    crawl_time: now.toISOString()
                });
                salesRecorded = true;
            } else if (!existingTodayData || (now - new Date(existingTodayData.crawl_time)) > 60 * 60 * 1000) {
                salesData.push({
                    product_id: product.id,
                    product_sales: productData.productSales,
                    shop_sales: productData.shopSales,
                    crawl_date: today,
                    crawl_time: now.toISOString()
                });
                salesRecorded = true;
            }
            // 持久化商品、销量和配置数据。
            saveData();
            if (previousStockStatus !== productData.stockStatus) {
                logger.info('monitor.stock_status_changed', '商品库存状态发生变化', {
                    refresh_id: refreshId,
                    batch_id: options.batchId,
                    product_id: product.id,
                    product_name: product.name,
                    source,
                    previous_stock_status: previousStockStatus,
                    stock_status: productData.stockStatus,
                    stock_reason: productData.stockReason,
                    restocked
                });
            }
            // 组合商品刷新完成日志的公共字段。
            const completionFields = {
                refresh_id: refreshId,
                batch_id: options.batchId,
                product_id: product.id,
                product_name: product.name,
                source,
                duration_ms: Date.now() - refreshStartedAt,
                stock_status: productData.stockStatus,
                product_sales: productData.productSales,
                sales_recorded: salesRecorded
            };
            // 实时监控每轮输出一条 info 心跳，便于直接确认高频轮询服务仍在运行。
            if (source === 'realtime') {
                logger.info('monitor.realtime_poll_completed', '实时监控轮询完成', completionFields);
            } else if (source === 'manual') {
                logger.info('monitor.product_refresh_completed', '商品刷新完成', completionFields);
            } else {
                // 全局批量任务已有批次汇总，单商品完成细节保持 debug 以避免重复刷屏。
                logger.debug('monitor.product_refresh_completed', '商品刷新完成', completionFields);
            }
            return { productData, salesRecorded, source };
        } catch (error) {
            logger.error('monitor.product_refresh_failed', '商品刷新失败', {
                refresh_id: refreshId,
                batch_id: options.batchId,
                product_id: product.id,
                product_name: product.name,
                source,
                duration_ms: Date.now() - refreshStartedAt,
                error
            });
            throw error;
        }
    })();

    // 无论成功还是失败，都从完成时刻开始安排下一次实时查询。
    const trackedPromise = refreshPromise.finally(() => {
        productRefreshPromises.delete(product.id);
        const currentProduct = products.find(item => item.id === product.id);
        if (currentProduct && currentProduct.realtime_monitoring === true) {
            scheduleRealtimeProductRefresh(currentProduct);
        }
    });
    productRefreshPromises.set(product.id, trackedPromise);
    return trackedPromise;
}

// 服务启动时恢复所有已开启的实时监控任务。
function scheduleAllRealtimeProductRefreshes() {
    // 旧商品默认关闭实时监控，不会被意外切换到高频查询。
    for (const [productId] of realtimeRefreshTimers) {
        const product = products.find(item => item.id === productId);
        if (!product || product.realtime_monitoring !== true) clearRealtimeProductRefreshTimer(productId);
    }
    products.filter(product => product.realtime_monitoring === true).forEach(scheduleRealtimeProductRefresh);
}

// 启动时加载数据
loadData();

// 使用浏览器解析短链接
async function resolveShortUrl(shortUrl) {
    // 记录短链接解析耗时起点。
    const startedAt = Date.now();
    logger.debug('link.resolve_started', '开始解析小红书短链接', { url: getSafeUrlForLog(shortUrl) });

    // 使用统一浏览器实例以复用小红书登录态。
    const browser = await launchBrowser();

    let page = null;
    try {
        page = await browser.newPage();

        // 设置更真实的浏览器环境
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // 设置视口大小
        await page.setViewport({ width: 1366, height: 768 });

        // 设置额外的请求头
        await page.setExtraHTTPHeaders({
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'DNT': '1',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
        });

        // 隐藏webdriver属性
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined,
            });
        });

        // 尝试多种方式访问短链接
        let finalUrl = shortUrl;

        try {
            // 方法1: 等待网络空闲
            logger.debug('link.resolve_attempt', '尝试解析短链接', { strategy: 'networkidle2' });
            await page.goto(shortUrl, {
                waitUntil: 'networkidle2',
                timeout: 12000
            });
            finalUrl = page.url();
        } catch (error) {
            logger.debug('link.resolve_attempt_failed', '短链接解析策略失败', { strategy: 'networkidle2', error });
            try {
                // 方法2: 等待加载完成
                logger.debug('link.resolve_attempt', '尝试解析短链接', { strategy: 'load' });
                await page.goto(shortUrl, {
                    waitUntil: 'load',
                    timeout: 10000
                });
                finalUrl = page.url();
            } catch (error2) {
                logger.debug('link.resolve_attempt_failed', '短链接解析策略失败', { strategy: 'load', error: error2 });
                try {
                    // 方法3: 不等待，直接获取重定向
                    logger.debug('link.resolve_attempt', '尝试解析短链接', { strategy: 'domcontentloaded' });
                    await page.goto(shortUrl, {
                        waitUntil: 'domcontentloaded',
                        timeout: 8000
                    });
                    // 等待一下让重定向完成
                    await page.waitForTimeout(3001);
                    finalUrl = page.url();
                } catch (error3) {
                    logger.debug('link.resolve_attempt_failed', '短链接解析策略失败', { strategy: 'domcontentloaded', error: error3 });
                    try {
                        // 方法4: 最简单的访问方式
                        logger.debug('link.resolve_attempt', '尝试解析短链接', { strategy: 'default' });
                        await page.goto(shortUrl, { timeout: 6000 });
                        await page.waitForTimeout(2000);
                        finalUrl = page.url();
                    } catch (error4) {
                        logger.debug('link.resolve_attempt_failed', '短链接解析策略失败', { strategy: 'default', error: error4 });
                        finalUrl = shortUrl;
                    }
                }
            }
        }

        if (finalUrl !== shortUrl) {
            logger.info('link.resolve_completed', '小红书短链接解析成功', {
                source_url: getSafeUrlForLog(shortUrl),
                resolved_url: getSafeUrlForLog(finalUrl),
                duration_ms: Date.now() - startedAt
            });
        } else {
            logger.warn('link.resolve_fallback', '小红书短链接解析失败，继续使用原链接', {
                url: getSafeUrlForLog(shortUrl),
                duration_ms: Date.now() - startedAt
            });
        }

        return finalUrl;

    } catch (error) {
        logger.error('link.resolve_failed', '小红书短链接解析过程出错', {
            url: getSafeUrlForLog(shortUrl),
            duration_ms: Date.now() - startedAt,
            error
        });
        // 解析失败时返回原URL
        return shortUrl;
    } finally {
        // 只关闭当前页面，浏览器实例继续供其他任务复用。
        await closePageSafely(page, '短链接解析');
    }
}

// 提取和处理小红书链接
async function processXhsUrl(inputText) {
    // 支持的链接格式
    const urlPatterns = [
        // 完整的小红书商品链接
        /https?:\/\/www\.xiaohongshu\.com\/goods-detail\/[^\s]+/g,
        // 小红书短链接
        /https?:\/\/xhslink\.com\/[^\s]+/g,
    ];

    let extractedUrl = null;

    // 尝试提取链接
    for (const pattern of urlPatterns) {
        const matches = inputText.match(pattern);
        if (matches && matches.length > 0) {
            extractedUrl = matches[0].trim();
            break;
        }
    }

    if (!extractedUrl) {
        throw new Error('未找到有效的小红书链接');
    }

    // 如果是短链接，尝试转换为长链接
    if (extractedUrl.includes('xhslink.com')) {
        logger.debug('link.short_link_detected', '检测到小红书短链接');
        extractedUrl = await resolveShortUrl(extractedUrl);
    }

    // 验证最终链接是否为小红书商品链接
    if (!extractedUrl.includes('xiaohongshu.com/goods-detail/')) {
        if (extractedUrl.includes('xhslink.com')) {
            throw new Error('短链接解析失败，请手动转换：\n1. 在浏览器中打开短链接\n2. 复制重定向后的长链接\n3. 使用长链接添加商品\n\n或者检查网络连接后重试');
        } else {
            throw new Error('链接不是小红书商品页面');
        }
    }

    logger.debug('link.validation_completed', '小红书商品链接校验完成', {
        url: getSafeUrlForLog(extractedUrl)
    });
    return extractedUrl;
}

// 解析销量数字（处理万+格式）
function parseSalesNumber(salesText) {
    if (!salesText) return 0;

    const text = salesText.toString().toLowerCase();

    if (text.includes('万')) {
        const number = parseFloat(text.replace('万', '').replace('+', ''));
        return Math.floor(number * 10000);
    }

    return parseInt(text.replace(/[^\d]/g, '')) || 0;
}

// 将小红书 variant 接口的库存枚举转换为系统统一状态。
function normalizeSkuStockStatus(status) {
    // 小红书 1 表示有货，2 表示售罄，其他状态暂不做乐观判断。
    if (status === 1 || status === '1' || status === 'STOCK_STATUS_NORMAL') return 'IN_STOCK';
    if (status === 2 || status === '2' || status === 'STOCK_STATUS_SOLDOUT') return 'OUT_OF_STOCK';
    return 'UNKNOWN';
}

// 从 variant 接口响应中提取规格选项和完整 SKU 组合。
function extractSkuDataFromVariantResponse(payload) {
    // 兼容接口字段的 snake_case 和当前页面返回的嵌套结构。
    const commonData = payload?.data?.common_data || payload?.data?.commonData || {};
    const skuListCommon = commonData.skuListCommon || commonData.sku_list_common || {};
    const skuList = Array.isArray(skuListCommon.skuList || skuListCommon.sku_list)
        ? (skuListCommon.skuList || skuListCommon.sku_list)
        : [];
    const firstSkuList = skuList[0] || {};
    const rawOptions = Array.isArray(firstSkuList.skuOptions || firstSkuList.sku_options)
        ? (firstSkuList.skuOptions || firstSkuList.sku_options)
        : [];
    const options = rawOptions.map(option => ({
        id: String(option.id || ''),
        name: String(option.name || ''),
        values: Array.isArray(option.values) ? option.values.map(value => String(value)) : [],
        soldOutValues: Array.isArray(option.soldOutValues || option.sold_out_values)
            ? (option.soldOutValues || option.sold_out_values).map(value => String(value))
            : []
    })).filter(option => option.id && option.name && option.values.length > 0);

    // variant 数据可能分布在一个或多个 template_data 项中。
    const templateData = Array.isArray(payload?.data?.template_data || payload?.data?.templateData)
        ? (payload.data.template_data || payload.data.templateData)
        : [];
    const skus = [];
    templateData.forEach(item => {
        // 每个 contentE1 对应一个可监控的完整规格组合。
        const content = item?.contentE1 || item?.content_e1;
        if (!content?.id || !Array.isArray(content.variants)) return;
        const variants = content.variants.map(variant => ({
            id: String(variant.id || ''),
            name: String(variant.name || ''),
            value: String(variant.value || '')
        })).filter(variant => variant.id && variant.name && variant.value);
        if (variants.length === 0) return;
        // 同一组合在部分页面版本中会在多个展示区重复出现，只保留一份。
        if (skus.some(sku => sku.id === String(content.id))) return;
        skus.push({
            id: String(content.id),
            name: variants.map(variant => `${variant.name}: ${variant.value}`).join(' / '),
            variants,
            price: Number(content.price) || 0,
            stockStatus: normalizeSkuStockStatus(content.stockStatus),
            stockReason: normalizeSkuStockStatus(content.stockStatus) === 'IN_STOCK' ? '可购买' :
                (normalizeSkuStockStatus(content.stockStatus) === 'OUT_OF_STOCK' ? '已售罄' : '库存状态待确认')
        });
    });

    return { options, skus };
}

// 打开商品规格弹层并读取小红书返回的完整 SKU 组合。
async function fetchSkuData(page, context = {}) {
    // 通过页面真实点击触发 variant 接口，避免猜测接口签名或绕过页面上下文。
    try {
        // 先确认页面存在规格入口，避免创建无人等待的响应 Promise 后直接返回。
        const hasSkuTrigger = await page.evaluate(() => Array.from(document.querySelectorAll('body *'))
            .some(element => (element.textContent || '').trim() === '已选'));
        if (!hasSkuTrigger) return { options: [], skus: [] };

        // 同时注册响应监听和执行点击，确保页面关闭或等待超时都由当前 try/catch 接管。
        const [response] = await Promise.all([
            page.waitForResponse(response =>
                response.request().method() === 'GET' &&
                response.url().includes('/api/store/jpd/edith/detail/h5/toc/variant'),
                { timeout: 12000 }
            ),
            page.evaluate(() => {
                // 再次获取目标，兼容预检查后页面节点被前端重新渲染的情况。
                const target = Array.from(document.querySelectorAll('body *'))
                    .find(element => (element.textContent || '').trim() === '已选');
                if (!target) throw new Error('商品规格入口已失效');
                target.click();
            })
        ]);
        const payload = await response.json();
        return extractSkuDataFromVariantResponse(payload);
    } catch (error) {
        // 规格弹层不可用时保留空结果，商品级监控仍按原有逻辑运行。
        // 使用商品编号或预览场景作为告警限频键。
        const warningKey = context.productId === undefined ? 'preview' : String(context.productId);
        // 读取上次告警时间，五分钟内重复失败仅在 debug 中展示。
        const lastLoggedAt = skuWarningLastLoggedAt.get(warningKey) || 0;
        // 记录本次失败时间。
        const now = Date.now();
        // 组合 SKU 读取失败的诊断字段。
        const fields = {
            refresh_id: context.refreshId,
            product_id: context.productId,
            error
        };
        if (now - lastLoggedAt >= SKU_WARNING_INTERVAL_MS) {
            skuWarningLastLoggedAt.set(warningKey, now);
            logger.warn('scrape.sku_read_failed', '读取商品 SKU 数据失败，降级为商品级监控', fields);
        } else {
            logger.debug('scrape.sku_read_failed_suppressed', '重复的商品 SKU 读取告警已限频', fields);
        }
        return { options: [], skus: [] };
    }
}

// 根据用户指定的 SKU 汇总商品级库存状态。
function applyMonitoredSkuStatus(productData, monitoredSkuIds) {
    // 空数组代表未指定 SKU，保持原有整商品监控行为。
    const ids = Array.isArray(monitoredSkuIds) ? monitoredSkuIds.map(id => String(id)) : [];
    if (ids.length === 0) return productData;
    const selectedSkus = ids.map(id => productData.skus.find(sku => sku.id === id)).filter(Boolean);
    const selectedStatuses = ids.map(id => {
        const sku = productData.skus.find(item => item.id === id);
        return sku ? { id, name: sku.name, stockStatus: sku.stockStatus, stockReason: sku.stockReason } :
            { id, name: id, stockStatus: 'UNKNOWN', stockReason: '未找到该 SKU' };
    });
    const hasInStock = selectedSkus.some(sku => sku.stockStatus === 'IN_STOCK');
    const allOutOfStock = selectedSkus.length === ids.length && selectedSkus.every(sku => sku.stockStatus === 'OUT_OF_STOCK');
    productData.monitoredSkuStatuses = selectedStatuses;
    productData.stockStatus = hasInStock ? 'IN_STOCK' : (allOutOfStock ? 'OUT_OF_STOCK' : 'UNKNOWN');
    productData.stockReason = hasInStock ? '指定 SKU 有货' : (allOutOfStock ? '指定 SKU 均已售罄' : '指定 SKU 状态待确认');
    return productData;
}

// 爬取商品数据
async function scrapeProductData(url, options = {}) {
    // 记录单次页面抓取耗时起点。
    const startedAt = Date.now();
    logger.debug('scrape.started', '开始抓取商品页面', {
        refresh_id: options.refreshId,
        product_id: options.productId,
        url: getSafeUrlForLog(url),
        include_skus: options.includeSkus === true
    });

    // 使用统一浏览器实例以复用小红书登录态。
    const browser = await launchBrowser();

    let page = null;
    try {
        page = await browser.newPage();

        // 设置用户代理
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

        try {
            await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
        } catch (error) {
            logger.debug('scrape.navigation_timeout', '商品页面加载未在期限内完成，继续尝试提取', {
                refresh_id: options.refreshId,
                product_id: options.productId,
                error
            });
        }

        // 等待页面加载
        await page.waitForTimeout(5000);

        // 仅在显式开启诊断开关时截图，避免实时监控持续产生无意义磁盘 IO。
        if (envBoolean('SCRAPE_DEBUG_SCREENSHOT', false)) {
            await page.screenshot({ path: 'debug_screenshot.png', fullPage: true });
            logger.debug('scrape.debug_screenshot_saved', '商品页面诊断截图已保存', {
                path: path.join(__dirname, 'debug_screenshot.png')
            });
        }

        const data = await page.evaluate(() => {
            // 获取页面所有文本内容用于解析。
            const pageText = document.body.innerText;

            // 尝试多种选择器来获取商品信息
            const getTextBySelectors = (selectors, description) => {
                for (const selector of selectors) {
                    const elements = document.querySelectorAll(selector);
                    if (elements.length > 0) {
                        for (const element of elements) {
                            const text = element.textContent.trim();
                            if (text) {
                                return text;
                            }
                        }
                    }
                }
                return '';
            };

            // 商品名称 - 扩展更多选择器
            const name = getTextBySelectors([
                'h1',
                '[class*="title"]',
                '[class*="Title"]',
                '[class*="name"]',
                '[class*="Name"]',
                '.goods-title',
                '.product-title',
                '.item-title',
                '[data-testid*="title"]',
                '[data-testid*="name"]'
            ], '商品名称');

            // 商品价格 - 扩展更多选择器
            const priceText = getTextBySelectors([
                '[class*="price"]',
                '[class*="Price"]',
                '[class*="money"]',
                '[class*="Money"]',
                '[class*="yuan"]',
                '[class*="Yuan"]',
                '.current-price',
                '.sale-price',
                '.price-current',
                '[data-testid*="price"]'
            ], '商品价格');

            // 商品销量 - 扩展更多选择器
            const salesText = getTextBySelectors([
                '[class*="sales"]',
                '[class*="Sales"]',
                '[class*="sold"]',
                '[class*="Sold"]',
                '[class*="sell"]',
                '[class*="Sell"]',
                '[class*="buy"]',
                '[class*="Buy"]',
                '.sales-count',
                '.sold-count',
                '[data-testid*="sales"]',
                '[data-testid*="sold"]'
            ], '商品销量');

            // 店铺名称
            const shopName = getTextBySelectors([
                '[class*="shop"]',
                '[class*="Shop"]',
                '[class*="store"]',
                '[class*="Store"]',
                '[class*="brand"]',
                '[class*="Brand"]',
                '.shop-name',
                '.store-name',
                '[data-testid*="shop"]',
                '[data-testid*="store"]'
            ], '店铺名称');

            // 店铺销量
            const shopSalesText = getTextBySelectors([
                '[class*="shop"][class*="sales"]',
                '[class*="store"][class*="sales"]',
                '.shop-sales',
                '.store-sales'
            ], '店铺销量');

            // 智能从页面文本中提取信息
            let extractedName = '未知商品';
            let extractedPrice = 0;
            let extractedSales = '0';
            let extractedShopName = '未知店铺';
            let extractedShopSales = '0';

            // 改进的商品名称提取逻辑
            const namePatterns = [
                // 针对果壳铃商品的特殊格式：【云水】三果33颗果壳摇铃 么几果壳铃 · 草绳33颗
                /【[^】]+】[^\n]*(?:果壳|摇铃|风铃)[^\n]*·[^\n]*/,
                // 匹配已售数字后的商品名称（针对果壳铃的格式）
                /已售\d+[万千]?\n([^\n]{8,100}?)(?=\n(?:保障|跨店铺|已选|发货))/,
                // 匹配包含【】或·符号的商品名称
                /([^\n]*(?:【[^】]+】|·)[^\n]{8,}?)(?=\n(?:保障|已选|发货))/,
                // 匹配特定品牌的商品名称（包含云水、果壳等关键词）
                /((?:花栖|森野植愈|么几果壳铃|自明|小飞基|云水|果壳|摇铃)[^\n]{3,}?)(?=\n(?:保障|已选|发货))/,
                // 匹配包含商品特征词的名称
                /([^\n]*(?:果壳|摇铃|风铃|挂件|手铃|种子|白噪音|瑜伽|冥想|三果|颗)[^\n]{3,}?)(?=\n(?:保障|已选|发货))/,
                // 匹配长商品名称（在关键词前）
                /([^\n¥]{12,80}?)(?=\n(?:保障|已选|发货|跨店铺))/,
                // 匹配包含特殊符号的商品名称
                /([^\n]*[｜·][^\n]{6,}?)(?=\n(?:保障|已选|发货))/,
                // 匹配价格后面的商品名称
                /¥\s*\d+(?:\.\d+)?\n([^\n]{8,80}?)(?=\n(?:保障|已选|发货|跨店铺))/,
                // 新增：匹配包含数字+颗的商品名称（针对果壳铃）
                /([^\n]*\d+颗[^\n]{3,}?)(?=\n(?:保障|已选|发货))/,
                // 新增：匹配草绳相关的商品名称
                /([^\n]*(?:草绳|三果)[^\n]{3,}?)(?=\n(?:保障|已选|发货))/,
                // 新增：专门针对【云水】三果33颗果壳摇铃的模式
                /(【云水】[^\n]*(?:果壳|摇铃)[^\n]*)/,
                // 新增：匹配跨店铺优惠后的商品名称
                /跨店铺[^\n]*\n([^\n]{10,}?)(?=\n(?:保障|已选|发货))/
            ];

            // 如果上述模式都没有匹配到，尝试从页面文本中直接提取商品名称
            if (extractedName === '未知商品') {
                // 从你的日志中可以看到，商品名称通常出现在价格和保障之间
                // 尝试更宽松的匹配模式
                const fallbackPatterns = [
                    // 匹配价格后到保障前的内容，过滤掉跨店铺等信息
                    /¥\s*\d+(?:\.\d+)?[^\n]*\n([^\n]+?)(?=\n(?:保障|跨店铺))/,
                    // 匹配已售后到保障前的内容
                    /已售\d+[万千]?[^\n]*\n([^\n]+?)(?=\n保障)/,
                    // 匹配包含中文字符的较长文本行（可能是商品名称）
                    /([^\n]*[\u4e00-\u9fa5]{5,}[^\n]{10,}?)(?=\n(?:保障|已选|发货))/
                ];

                for (const pattern of fallbackPatterns) {
                    const match = pageText.match(pattern);
                    if (match) {
                        let candidateName = match[1] || match[0];
                        candidateName = candidateName.trim();

                        // 更宽松的过滤条件
                        if (!candidateName.includes('卖家口碑') &&
                            !candidateName.includes('粉丝数') &&
                            !candidateName.includes('进店逛逛') &&
                            !candidateName.includes('已售') &&
                            !candidateName.includes('¥') &&
                            !candidateName.includes('跨店铺') &&
                            candidateName.length > 5 &&
                            candidateName.length < 200) {
                            extractedName = candidateName;
                            break;
                        }
                    }
                }
            }

            for (const pattern of namePatterns) {
                const match = pageText.match(pattern);
                if (match) {
                    let candidateName = match[1] || match[0];
                    candidateName = candidateName.trim();

                    // 过滤掉明显不是商品名称的内容
                    if (!candidateName.includes('卖家口碑') &&
                        !candidateName.includes('粉丝数') &&
                        !candidateName.includes('进店逛逛') &&
                        !candidateName.includes('已售') &&
                        !candidateName.includes('¥') &&
                        candidateName.length > 8 &&
                        candidateName.length < 150) {
                        extractedName = candidateName;
                        break;
                    }
                }
            }

            // 提取价格（寻找 ¥ 符号后的数字）
            const priceMatch = pageText.match(/¥\s*(\d+(?:\.\d+)?)/);
            if (priceMatch) {
                extractedPrice = parseFloat(priceMatch[1]);
            }

            // 提取商品销量（寻找"已售"后的数字）
            const salesMatch = pageText.match(/已售\s*(\d+(?:\.\d+)?[万千]?)/);
            if (salesMatch) {
                extractedSales = salesMatch[1];
            }

            // 提取店铺名称（寻找店铺名称模式）
            const shopMatch = pageText.match(/([^¥\n]{3,20}?)(?:的店|店铺)/);
            if (shopMatch) {
                extractedShopName = shopMatch[1].trim();
            }

            // 提取店铺销量（寻找店铺相关的已售数字）
            const shopSalesMatches = pageText.match(/已售\s*(\d+(?:\.\d+)?[万千]?)/g);
            if (shopSalesMatches && shopSalesMatches.length > 1) {
                // 如果有多个"已售"，第二个通常是店铺销量
                const shopSalesMatch = shopSalesMatches[1].match(/(\d+(?:\.\d+)?[万千]?)/);
                if (shopSalesMatch) {
                    extractedShopSales = shopSalesMatch[1];
                }
            }

            // 使用提取到的信息，优先使用智能提取的结果
            const finalName = name || extractedName;
            // 价格只取第一个货币数字，避免把“已售294”等后续数字拼进价格。
            const selectorPriceMatch = priceText.match(/¥\s*(\d+(?:\.\d+)?)/);
            const finalPrice = parseFloat(selectorPriceMatch ? selectorPriceMatch[1] : '') || extractedPrice || 0;
            const finalSales = salesText || extractedSales;
            const finalShopName = shopName || extractedShopName;
            const finalShopSales = shopSalesText || extractedShopSales;
            // 读取商品页中可见的库存/购买状态文本，排除“已售”销量文案。
            const pageLowerText = pageText.toLowerCase();
            // 定义页面上下文可用的缺货关键词。
            const outOfStockWords = ['已售罄', '售罄', '暂时无货', '暂无库存', '库存不足', '缺货', '补货通知', '到货通知', '无法购买', '不可购买'];
            // 定义页面上下文可用的购买按钮关键词。
            const inStockWords = ['立即购买', '马上抢', '立即抢购', '加入购物车', '去购买', '购买'];
            const visibleActionTexts = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'))
                .map(element => (element.innerText || element.value || '').trim().toLowerCase())
                .filter(Boolean);
            // 先判断明确缺货文案，避免相关商品区域的购买按钮造成误报。
            const outOfStockReason = outOfStockWords.find(word => pageLowerText.includes(word.toLowerCase()));
            const inStockReason = visibleActionTexts.find(text => inStockWords.some(word => text === word || text.includes(word)));
            // 未找到明确依据时保持 UNKNOWN，只有明确可购买时才进入有货状态。
            const stockStatus = outOfStockReason ? 'OUT_OF_STOCK' : (inStockReason ? 'IN_STOCK' : 'UNKNOWN');

            return {
                name: finalName,
                price: finalPrice,
                salesText: finalSales,
                shopName: finalShopName,
                shopSalesText: finalShopSales,
                stockStatus,
                stockReason: outOfStockReason || inStockReason || '未找到明确库存依据',
                // 调试信息
                debug: {
                    originalPriceText: priceText,
                    originalSalesText: salesText,
                    pageTextSample: pageText.substring(0, 300),
                    extractedInfo: {
                        name: extractedName,
                        price: extractedPrice,
                        sales: extractedSales,
                        shopName: extractedShopName,
                        shopSales: extractedShopSales
                    }
                }
            };
        });

        // 预览、新增指定 SKU 或已有指定 SKU 刷新时读取规格组合。
        const skuData = options.includeSkus
            ? await fetchSkuData(page, { productId: options.productId, refreshId: options.refreshId })
            : { options: [], skus: [] };

        const result = {
            name: data.debug.extractedInfo.name || data.name,
            price: data.debug.extractedInfo.price || data.price,
            productSales: parseSalesNumber(data.debug.extractedInfo.sales || data.salesText),
            shopName: data.debug.extractedInfo.shopName || data.shopName,
            shopSales: parseSalesNumber(data.debug.extractedInfo.shopSales || data.shopSalesText),
            stockStatus: data.stockStatus || 'UNKNOWN',
            stockReason: data.stockReason || '未找到明确库存依据',
            skuOptions: skuData.options,
            skus: skuData.skus
        };

        // 指定 SKU 时，以选中组合的库存结果覆盖商品级文案。
        applyMonitoredSkuStatus(result, options.monitoredSkuIds);
        logger.debug('scrape.completed', '商品页面抓取完成', {
            refresh_id: options.refreshId,
            product_id: options.productId,
            duration_ms: Date.now() - startedAt,
            product_name: result.name,
            price: result.price,
            product_sales: result.productSales,
            shop_sales: result.shopSales,
            stock_status: result.stockStatus,
            stock_reason: result.stockReason,
            sku_count: result.skus.length
        });
        return result;
    } finally {
        // 只关闭当前页面，浏览器实例继续供其他任务复用。
        await closePageSafely(page, '商品抓取');
    }
}

// 预览商品及其可选 SKU，不写入监控列表。
app.post('/api/products/preview', async (req, res) => {
    // 读取前端提交的商品链接或分享文本。
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: '请提供商品链接或分享文本' });
    try {
        // 先解析短链接，再抓取商品和完整规格组合。
        const processedUrl = await processXhsUrl(url);
        const productData = await scrapeProductData(processedUrl, { includeSkus: true });
        return res.json({ url: processedUrl, product: productData });
    } catch (error) {
        // 预览失败不改动已有商品数据。
        logger.error('product.preview_failed', '预览商品失败', {
            url: getSafeUrlForLog(url),
            error
        });
        return res.status(500).json({ error: '获取商品 SKU 失败: ' + error.message });
    }
});

// 添加商品
app.post('/api/products', async (req, res) => {
    // 同时兼容前端使用的 skuIds 和直接传入的 skus 字段。
    const { url, skuIds, skus: requestedSkus } = req.body || {};
    const monitoredSkuIds = Array.isArray(skuIds)
        ? [...new Set(skuIds.map(id => String(id).trim()).filter(Boolean))]
        : (Array.isArray(requestedSkus)
            ? [...new Set(requestedSkus.map(sku => String(sku?.id || sku).trim()).filter(Boolean))]
            : []);

    if (!url) {
        return res.status(400).json({ error: '请提供商品链接或分享文本' });
    }

    try {
        logger.debug('product.create_started', '开始添加商品', { url: getSafeUrlForLog(url) });

        // 处理和提取小红书链接
        const processedUrl = await processXhsUrl(url);

        // 检查是否已存在
        const existingProduct = products.find(p => p.url === processedUrl);
        if (existingProduct) {
            return res.status(400).json({ error: '该商品已存在' });
        }

        // 爬取商品数据和 SKU 组合，并按用户选择汇总库存状态。
        const productData = await scrapeProductData(processedUrl, {
            includeSkus: true,
            monitoredSkuIds
        });

        // 选中的 SKU 必须来自当前商品，避免保存失效或伪造的编号。
        const availableSkuIds = new Set(productData.skus.map(sku => sku.id));
        const invalidSkuIds = monitoredSkuIds.filter(id => !availableSkuIds.has(id));
        if (invalidSkuIds.length > 0) {
            return res.status(400).json({ error: `指定的 SKU 不存在或已失效：${invalidSkuIds.join('、')}` });
        }

        // 保存商品信息
        const product = {
            id: nextId++,
            url: processedUrl, // 保存处理后的长链接
            ...productData,
            monitored_skus: monitoredSkuIds,
            // 新增商品默认开启实时监控。
            realtime_monitoring: true,
            created_at: new Date().toISOString()
        };

        products.push(product);

        // 保存销量数据
        const today = new Date().toISOString().split('T')[0];
        salesData.push({
            product_id: product.id,
            product_sales: productData.productSales,
            shop_sales: productData.shopSales,
            crawl_date: today,
            crawl_time: new Date().toISOString()
        });

        // 保存数据到文件
        saveData();
        // 新商品首次查询已完成，从此刻开始计算下一次实时查询。
        scheduleRealtimeProductRefresh(product);

        logger.info('product.created', '商品添加成功', {
            product_id: product.id,
            product_name: product.name,
            stock_status: product.stockStatus,
            monitored_sku_count: product.monitored_skus.length,
            realtime_monitoring: product.realtime_monitoring
        });
        res.json({
            message: '商品添加成功',
            product
        });

    } catch (error) {
        logger.error('product.create_failed', '添加商品失败', {
            url: getSafeUrlForLog(url),
            error
        });
        res.status(500).json({ error: '添加商品失败: ' + error.message });
    }
});

// 获取所有商品数据
app.get('/api/products', (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];

        const result = products.map(product => {
            // 获取今天的数据
            const todayData = salesData.find(s =>
                s.product_id === product.id && s.crawl_date === today
            );

            // 获取昨天的数据
            const yesterdayData = salesData.find(s =>
                s.product_id === product.id && s.crawl_date === yesterday
            );

            const dailyProductSales = todayData && yesterdayData ?
                todayData.product_sales - yesterdayData.product_sales : 0;

            const dailyShopSales = todayData && yesterdayData ?
                todayData.shop_sales - yesterdayData.shop_sales : 0;

            return {
                ...product,
                // 商品总销量（当前销量）
                product_total_sales: todayData ? todayData.product_sales : (product.productSales || 0),
                // 店铺总销量
                shop_total_sales: todayData ? todayData.shop_sales : (product.shopSales || 0),
                // 商品日销量
                daily_product_sales: dailyProductSales,
                // 店铺日销量  
                daily_shop_sales: dailyShopSales,
                // 商品日GMV
                daily_gmv: dailyProductSales * product.price,
                // 最后更新时间优先使用库存查询时间，实时监控时不会被销量采样时间掩盖。
                last_update: product.last_checked_at || (todayData ? todayData.crawl_time : product.created_at),
                // 确保店铺名称正确显示
                shop_name: product.shopName || '未知店铺'
            };
        });

        res.json(result);
    } catch (error) {
        logger.error('product.list_failed', '获取商品列表失败', { error });
        res.status(500).json({ error: '获取数据失败' });
    }
});

// 刷新单个商品数据
app.post('/api/products/:id/refresh', async (req, res) => {
    const productId = parseInt(req.params.id);

    const product = products.find(p => p.id === productId);
    if (!product) {
        return res.status(404).json({ error: '商品不存在' });
    }

    try {
        const result = await refreshProductData(product, { source: 'manual', replaceToday: true });
        res.json({ message: '数据刷新成功', data: result.productData });

    } catch (error) {
        res.status(500).json({ error: '刷新数据失败: ' + error.message });
    }
});

// 更新商品名称、指定监控 SKU 或实时监控开关，仅允许修改明确的配置字段。
app.patch('/api/products/:id', (req, res) => {
    // 解析路由中的商品编号。
    const productId = parseInt(req.params.id, 10);
    // 查找需要更新的商品记录。
    const product = products.find(item => item.id === productId);
    if (!product) {
        return res.status(404).json({ error: '商品不存在' });
    }

    // 读取并清理前端提交的商品名称。
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (name && name.length > 200) {
        return res.status(400).json({ error: '商品名称不能超过 200 个字符' });
    }

    // 兼容 skuIds 和 monitoredSkuIds 两种请求字段。
    const skuField = Object.prototype.hasOwnProperty.call(req.body || {}, 'skuIds')
        ? req.body.skuIds
        : req.body?.monitoredSkuIds;
    const hasSkuUpdate = skuField !== undefined;
    // 兼容前端使用的 realtimeMonitoring 和持久化字段名。
    const realtimeField = Object.prototype.hasOwnProperty.call(req.body || {}, 'realtimeMonitoring')
        ? req.body.realtimeMonitoring
        : req.body?.realtime_monitoring;
    // 判断本次请求是否包含实时监控开关变更。
    const hasRealtimeUpdate = realtimeField !== undefined;
    if (hasRealtimeUpdate && typeof realtimeField !== 'boolean') {
        return res.status(400).json({ error: 'realtimeMonitoring 必须是布尔值' });
    }
    let monitoredSkuIds = product.monitored_skus || [];
    if (hasSkuUpdate) {
        if (!Array.isArray(skuField)) {
            return res.status(400).json({ error: 'skuIds 必须是数组' });
        }
        monitoredSkuIds = [...new Set(skuField.map(id => String(id).trim()).filter(Boolean))];
        const availableSkuIds = new Set(Array.isArray(product.skus) ? product.skus.map(sku => String(sku.id)) : []);
        const invalidSkuIds = monitoredSkuIds.filter(id => !availableSkuIds.has(id));
        if (invalidSkuIds.length > 0) {
            return res.status(400).json({ error: `指定的 SKU 不存在或已失效：${invalidSkuIds.join('、')}` });
        }
        product.monitored_skus = monitoredSkuIds;
        applyMonitoredSkuStatus(product, monitoredSkuIds);
    }
    // 更新实时监控开关并同步对应的独立定时器。
    if (hasRealtimeUpdate) {
        product.realtime_monitoring = realtimeField;
        if (realtimeField) {
            scheduleRealtimeProductRefresh(product);
        } else {
            clearRealtimeProductRefreshTimer(product.id);
        }
    }

    // 没有商品名称时允许只更新 SKU 配置。
    if (name) product.name = name;
    if (!name && !hasSkuUpdate && !hasRealtimeUpdate) {
        return res.status(400).json({ error: '请提供商品名称、skuIds 或 realtimeMonitoring' });
    }
    saveData();

    logger.info('product.monitoring_updated', '商品监控配置已更新', {
        product_id: product.id,
        product_name: product.name,
        monitored_sku_count: Array.isArray(product.monitored_skus) ? product.monitored_skus.length : 0,
        realtime_monitoring: product.realtime_monitoring
    });

    res.json({
        message: hasRealtimeUpdate || hasSkuUpdate ? '商品监控配置更新成功' : '商品名称更新成功',
        product
    });
});

// 获取商品销量趋势数据
app.get('/api/products/:id/trend', (req, res) => {
    const productId = parseInt(req.params.id);

    try {
        // 查找商品
        const product = products.find(p => p.id === productId);
        if (!product) {
            return res.status(404).json({ error: '商品不存在' });
        }

        // 获取该商品的所有历史销量数据
        const productSalesData = salesData
            .filter(s => s.product_id === productId)
            .sort((a, b) => new Date(a.crawl_date) - new Date(b.crawl_date));

        if (productSalesData.length === 0) {
            return res.json({
                productName: product.name,
                totalSales: product.productSales || 0,
                avgDailySales: 0,
                maxDailySales: 0,
                monitorDays: 0,
                chartData: {
                    dates: [],
                    totalSales: [],
                    dailySales: []
                }
            });
        }

        // 准备图表数据
        const chartData = {
            dates: [],
            totalSales: [],
            dailySales: []
        };

        let previousSales = 0;
        let totalDailySales = 0;
        let maxDailySales = 0;

        productSalesData.forEach((data, index) => {
            const date = new Date(data.crawl_date);
            const dateStr = date.toLocaleDateString('zh-CN', {
                month: 'short',
                day: 'numeric'
            });

            chartData.dates.push(dateStr);
            chartData.totalSales.push(data.product_sales);

            // 计算日销量（除了第一天）
            let dailySales = 0;
            if (index > 0) {
                dailySales = Math.max(0, data.product_sales - previousSales);
                totalDailySales += dailySales;
                maxDailySales = Math.max(maxDailySales, dailySales);
            }
            chartData.dailySales.push(dailySales);

            previousSales = data.product_sales;
        });

        // 计算统计数据
        const monitorDays = productSalesData.length;
        const avgDailySales = monitorDays > 1 ? Math.round(totalDailySales / (monitorDays - 1)) : 0;
        const currentTotalSales = productSalesData[productSalesData.length - 1].product_sales;

        res.json({
            productName: product.name,
            totalSales: currentTotalSales,
            avgDailySales: avgDailySales,
            maxDailySales: maxDailySales,
            monitorDays: monitorDays,
            chartData: chartData
        });

    } catch (error) {
        logger.error('product.trend_failed', '获取商品销量趋势失败', {
            product_id: productId,
            error
        });
        res.status(500).json({ error: '获取趋势数据失败' });
    }
});

// 删除商品
app.delete('/api/products/:id', (req, res) => {
    const productId = parseInt(req.params.id);

    // 删除商品前取消其待执行的实时监控任务。
    clearRealtimeProductRefreshTimer(productId);
    productRefreshPromises.delete(productId);
    skuWarningLastLoggedAt.delete(String(productId));

    // 删除商品
    products = products.filter(p => p.id !== productId);

    // 删除相关销量数据
    salesData = salesData.filter(s => s.product_id !== productId);

    // 保存数据到文件
    saveData();

    logger.info('product.deleted', '商品及其销量数据已删除', { product_id: productId });

    res.json({ message: '商品删除成功' });
});

// 获取当前运行中的邮件收件人和刷新间隔配置。
app.get('/api/settings', (req, res) => {
    // 不返回邮件密码等敏感信息，仅提供设置页需要展示的配置。
    res.json({
        mailRecipients: getMailRecipients(),
        checkIntervalMinutes: checkIntervalMinutes,
        realTimeCheckIntervalSeconds: realTimeCheckIntervalSeconds
    });
});

// 保存设置页提交的收件人和刷新间隔，并立即应用到当前进程。
app.post('/api/settings', (req, res) => {
    // 读取前端提交的配置字段。
    const { mailRecipients, checkIntervalMinutes: requestedInterval, realTimeCheckIntervalSeconds: requestedRealtimeInterval } = req.body || {};
    // 统一解析收件人输入，支持字符串和数组格式。
    const recipients = mailRecipients === undefined ? getMailRecipients() : normalizeMailRecipients(mailRecipients);
    // 校验邮箱格式，避免错误地址进入邮件发送流程。
    const invalidRecipients = findInvalidMailRecipients(recipients);
    if (invalidRecipients.length > 0) {
        return res.status(400).json({ error: `邮箱格式不正确：${invalidRecipients.join('、')}` });
    }
    // 校验刷新间隔，限制在 node-cron 支持的分钟步长范围内。
    const nextInterval = requestedInterval === undefined
        ? checkIntervalMinutes
        : normalizeCheckIntervalMinutes(requestedInterval, null);
    if (nextInterval === null) {
        return res.status(400).json({ error: '刷新间隔必须是 1 到 59 之间的整数分钟' });
    }
    // 校验实时监控间隔，限制在 2 到 60 秒。
    const nextRealtimeInterval = requestedRealtimeInterval === undefined
        ? realTimeCheckIntervalSeconds
        : normalizeRealTimeCheckIntervalSeconds(requestedRealtimeInterval, null);
    if (nextRealtimeInterval === null) {
        return res.status(400).json({ error: '实时监控间隔必须是 2 到 60 之间的整数秒' });
    }

    // 更新运行时配置，空数组表示主动关闭补货邮件通知。
    mailRecipientsOverride = recipients;
    checkIntervalMinutes = nextInterval;
    realTimeCheckIntervalSeconds = nextRealtimeInterval;
    // 持久化配置，服务重启后仍使用设置页保存的值。
    saveData();
    // 重新创建定时任务，让新的刷新间隔立即生效。
    scheduleAutoRefresh();
    // 设置变更后从当前时刻重新计算所有实时商品的下一次查询时间。
    scheduleAllRealtimeProductRefreshes();

    logger.info('config.monitoring_updated', '监控配置已更新并生效', {
        mail_recipient_count: recipients.length,
        check_interval_minutes: checkIntervalMinutes,
        realtime_check_interval_seconds: realTimeCheckIntervalSeconds
    });

    res.json({
        message: '设置已保存',
        mailRecipients: getMailRecipients(),
        checkIntervalMinutes: checkIntervalMinutes,
        realTimeCheckIntervalSeconds: realTimeCheckIntervalSeconds
    });
});

// 提供邮件配置测试接口，便于部署后验证 SMTP 参数。
app.post('/api/mail/test', async (req, res) => {
    // 使用用户指定或默认测试内容发送一封测试邮件。
    const testProduct = { name: '邮件配置测试', price: 0, stockStatus: 'IN_STOCK', stockReason: '手动测试', url: `http://localhost:${activePort}` };
    try {
        const sent = await sendRestockEmail(testProduct, testProduct);
        if (!sent) return res.status(503).json({ error: '未配置完整邮件参数，请检查 MAIL_USERNAME、MAIL_PASSWORD 和 MAIL_RECIPIENTS' });
        return res.json({ message: '测试邮件已发送' });
    } catch (error) {
        logger.error('mail.test_failed', '测试邮件发送失败', { error });
        return res.status(500).json({ error: `测试邮件发送失败: ${error.message}` });
    }
});

// 自动刷新所有商品数据的函数
async function autoRefreshAllProducts(trigger = 'schedule') {
    // 如果上一轮仍在运行，则跳过本轮，避免重复请求小红书。
    if (refreshInProgress) {
        logger.warn('monitor.batch_skipped', '上一轮自动刷新尚未完成，跳过本轮任务', { trigger });
        return;
    }
    refreshInProgress = true;
    try {
        if (products.length === 0) {
            logger.debug('monitor.batch_skipped', '没有商品需要自动刷新', { trigger, reason: 'no_products' });
            return;
        }

        // 为本轮批量刷新生成关联编号。
        const batchId = crypto.randomUUID();
        // 记录批量刷新耗时起点。
        const batchStartedAt = Date.now();
        // 实时监控商品不参与全局分钟任务。
        const scheduledProducts = products.filter(product => product.realtime_monitoring !== true);
        if (scheduledProducts.length === 0) {
            logger.debug('monitor.batch_skipped', '没有商品需要参与全局自动刷新', {
                trigger,
                reason: 'all_products_realtime',
                realtime_product_count: products.length
            });
            return;
        }
        logger.info('monitor.batch_started', '开始自动刷新商品数据', {
            batch_id: batchId,
            trigger,
            scheduled_product_count: scheduledProducts.length,
            realtime_product_count: products.length - scheduledProducts.length
        });

        // 统计本轮成功数量。
        let successCount = 0;
        // 统计本轮失败数量。
        let failCount = 0;
        // 统计执行过程中切换为实时监控而跳过的数量。
        let skippedCount = 0;

        for (const product of scheduledProducts) {
            try {
                // 商品可能在本轮开始后切换为实时监控，执行前再次确认避免重复刷新。
                if (product.realtime_monitoring === true) {
                    skippedCount++;
                    logger.debug('monitor.product_refresh_skipped', '商品已切换为实时监控，跳过全局刷新', {
                        batch_id: batchId,
                        product_id: product.id,
                        product_name: product.name
                    });
                    continue;
                }
                await refreshProductData(product, { source: 'global', batchId });
                successCount++;

                // 避免请求过于频繁，每个商品之间间隔2秒
                await new Promise(resolve => setTimeout(resolve, 2000));

            } catch (error) {
                // 失败详情已由 refreshProductData 记录，此处只累计批次结果。
                failCount++;
            }
        }

        // 保存数据。
        saveData();

        logger.info('monitor.batch_completed', '自动刷新商品数据完成', {
            batch_id: batchId,
            trigger,
            duration_ms: Date.now() - batchStartedAt,
            success_count: successCount,
            failure_count: failCount,
            skipped_count: skippedCount,
            next_run_at: new Date(Date.now() + checkIntervalMinutes * 60 * 1000).toISOString()
        });
    } finally {
        // 无论刷新正常结束还是意外异常，都释放任务锁。
        refreshInProgress = false;
    }
}

// 根据当前配置创建自动刷新任务。
function scheduleAutoRefresh() {
    // 配置发生变化时停止旧任务，避免多个定时器重复刷新。
    if (refreshTask) refreshTask.stop();
    refreshTask = cron.schedule(`*/${checkIntervalMinutes} * * * *`, () => runWithLogContext({}, () => autoRefreshAllProducts('cron')), {
        timezone: "Asia/Shanghai"
    });
}

// 启动默认自动刷新任务。
scheduleAutoRefresh();
// 恢复重启前已开启的实时监控商品。
scheduleAllRealtimeProductRefreshes();

// 健康检查端点
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        products: products.length,
        uptime: process.uptime(),
        check_interval_minutes: checkIntervalMinutes,
        real_time_check_interval_seconds: realTimeCheckIntervalSeconds,
        mail_configured: Boolean(process.env.MAIL_USERNAME && process.env.MAIL_PASSWORD && getMailRecipients().length > 0)
    });
});

// 启动服务器并处理 Windows 保留端口导致的权限错误。
function startServer(port) {
    // 创建 HTTP 服务并监听指定端口。
    const server = app.listen(port, '0.0.0.0', () => {
        // 保存实际监听端口，供日志和接口返回正确地址。
        activePort = port;
        logger.info('service.started', '小红书监控服务已启动', {
            port,
            environment: process.env.NODE_ENV || 'development',
            headless: HEADLESS,
            product_count: products.length,
            realtime_product_count: products.filter(product => product.realtime_monitoring === true).length,
            sales_record_count: salesData.length,
            data_directory: DATA_DIR,
            check_interval_minutes: checkIntervalMinutes,
            realtime_check_interval_seconds: realTimeCheckIntervalSeconds,
            mail_configured: Boolean(process.env.MAIL_USERNAME && process.env.MAIL_PASSWORD && getMailRecipients().length > 0),
            log_level: activeLogLevel,
            log_format: activeLogFormat,
            initial_refresh_delay_seconds: 10
        });

        // 启动后 10 秒执行一次初始刷新，确保服务启动后尽快建立库存基线。
        setTimeout(async () => {
            await autoRefreshAllProducts('startup');
        }, 10 * 1000);
    });

    // 监听启动错误，避免出现未处理的 error 事件导致堆栈退出。
    server.on('error', error => {
        // 默认端口被 Windows 保留时自动切换本机备用端口。
        if (error.code === 'EACCES' && !PORT_IS_EXPLICIT && port === PORT) {
            logger.warn('service.port_fallback', '默认端口无法监听，尝试备用端口', {
                port: PORT,
                fallback_port: FALLBACK_PORT,
                error
            });
            startServer(FALLBACK_PORT);
            return;
        }

        // 显式端口或其他错误必须直接提示，避免掩盖部署配置问题。
        logger.fatal('service.start_failed', '服务器启动失败', { port, error });
        process.exit(1);
    });

    return server;
}

// 防止重复执行容器退出清理流程。
let shutdownInProgress = false;

// 统一处理本地中断和容器停止信号，并记录完整生命周期。
async function shutdown(signal) {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    logger.info('service.shutdown_started', '服务开始退出', { signal });
    try {
        if (refreshTask) refreshTask.stop();
        for (const [productId] of realtimeRefreshTimers) clearRealtimeProductRefreshTimer(productId);
        await closeBrowser();
        logger.info('service.shutdown_completed', '服务已安全退出', { signal });
        process.exit(0);
    } catch (error) {
        logger.fatal('service.shutdown_failed', '服务退出清理失败', { signal, error });
        process.exit(1);
    }
}

// 进程退出时释放共享浏览器资源。
process.once('SIGINT', () => shutdown('SIGINT'));
// 捕获容器停止信号，确保登录目录锁被释放。
process.once('SIGTERM', () => shutdown('SIGTERM'));
// 记录未捕获同步异常后让容器按失败状态重启。
process.once('uncaughtException', error => {
    logger.fatal('process.uncaught_exception', '进程发生未捕获异常', { error });
    process.exit(1);
});
// 记录未处理 Promise 拒绝后让容器按失败状态重启。
process.once('unhandledRejection', reason => {
    logger.fatal('process.unhandled_rejection', '进程发生未处理的 Promise 拒绝', { error: reason });
    process.exit(1);
});

// 启动 HTTP 服务。
startServer(PORT);
