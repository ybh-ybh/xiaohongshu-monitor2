// 设置控制台编码为UTF-8（Windows系统）
if (process.platform === 'win32') {
    process.stdout.setEncoding('utf8');
}

const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const cron = require('node-cron');
const nodemailer = require('nodemailer');

// 启动时加载项目根目录的 .env，支持本地 npm start 使用邮件配置。
require('dotenv').config();

const app = express();
// 读取服务端口配置，未配置时使用 3001。
const PORT = parseInt(process.env.PORT || '3001', 10);
// 读取轮询间隔配置，默认每 5 分钟检查一次。
const CHECK_INTERVAL_MINUTES = Math.max(1, parseInt(process.env.CHECK_INTERVAL_MINUTES || '5', 10));
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

// 中间件
app.use(express.json());
app.use(express.static('public'));

// 数据文件路径
const DATA_DIR = path.join(__dirname, 'data');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const SALES_DATA_FILE = path.join(DATA_DIR, 'sales_data.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// 确保数据目录存在
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR);
    console.log('创建数据目录:', DATA_DIR);
}
// 创建浏览器登录态目录。
if (!fs.existsSync(USER_DATA_DIR)) {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
}

// 数据存储
let products = [];
let salesData = [];
let nextId = 1;
// 防止定时任务与手动刷新同时执行造成浏览器和数据文件竞争。
let refreshInProgress = false;

// 将环境变量文本转换为布尔值。
function envBoolean(name, defaultValue) {
    // 读取指定环境变量并兼容常见布尔值写法。
    const value = process.env[name];
    if (value === undefined) return defaultValue;
    return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).toLowerCase());
}

// 创建带持久化登录态的 Puppeteer 浏览器实例。
async function launchBrowser() {
    // 使用统一的浏览器配置，保证短链接解析和商品抓取共享登录状态。
    if (browserInstance) return browserInstance;
    if (browserLaunchPromise) return browserLaunchPromise;
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
        browser.on('disconnected', () => {
            // 浏览器异常断开时清理缓存，下一次任务可以重新启动。
            browserInstance = null;
        });
        return browser;
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
        await browserInstance.close();
        browserInstance = null;
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

// 发送商品恢复库存通知邮件。
async function sendRestockEmail(product, productData) {
    // 未配置邮件账号时只记录日志，不阻断商品监控任务。
    const transporter = getMailTransporter();
    const recipient = process.env.MAIL_RECIPIENT;
    if (!transporter || !recipient) {
        console.warn('未配置完整邮件参数，跳过补货邮件通知。');
        return false;
    }
    // 发送包含商品名称、价格、库存状态和直达链接的邮件。
    await transporter.sendMail({
        from: process.env.MAIL_USERNAME,
        to: recipient,
        subject: `小红书商品补货提醒：${productData.name || product.name || '未知商品'}`,
        text: [
            '检测到小红书商品可能已补货。',
            `商品：${productData.name || product.name || '未知商品'}`,
            `价格：${productData.price || product.price || '未知'}`,
            `库存状态：${productData.stockStatus}`,
            `检测依据：${productData.stockReason || '可购买控件'}`,
            `链接：${product.url}`
        ].join('\n')
    });
    console.log(`补货邮件已发送: ${product.url}`);
    return true;
}

// 写入最新商品数据，并在缺货恢复有货时发送一次邮件。
async function applyProductData(product, productData) {
    // 仅把明确的 OUT_OF_STOCK -> IN_STOCK 迁移视为补货事件。
    const previousStockStatus = product.stockStatus || 'UNKNOWN';
    Object.assign(product, productData, { last_checked_at: new Date().toISOString() });
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
            console.error(`补货邮件发送失败: ${error.message}`);
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
            console.log(`加载了 ${products.length} 个商品数据`);
        }

        // 加载销量数据
        if (fs.existsSync(SALES_DATA_FILE)) {
            const salesJson = fs.readFileSync(SALES_DATA_FILE, 'utf8');
            salesData = JSON.parse(salesJson);
            console.log(`加载了 ${salesData.length} 条销量数据`);
        }

        // 加载配置数据
        if (fs.existsSync(CONFIG_FILE)) {
            const configJson = fs.readFileSync(CONFIG_FILE, 'utf8');
            const config = JSON.parse(configJson);
            nextId = config.nextId || 1;
            console.log(`下一个ID: ${nextId}`);
        }

        // 如果有商品但nextId为1，重新计算nextId
        if (products.length > 0 && nextId === 1) {
            nextId = Math.max(...products.map(p => p.id)) + 1;
            console.log(`重新计算nextId: ${nextId}`);
        }

    } catch (error) {
        console.error('加载数据失败:', error);
        console.log('将使用空数据开始');
    }
}

// 保存数据
function saveData() {
    try {
        // 保存商品数据
        fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(products, null, 2));

        // 保存销量数据
        fs.writeFileSync(SALES_DATA_FILE, JSON.stringify(salesData, null, 2));

        // 保存配置数据
        const config = { nextId };
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));

        console.log('数据保存成功');
    } catch (error) {
        console.error('保存数据失败:', error);
    }
}

// 启动时加载数据
loadData();

// 使用浏览器解析短链接
async function resolveShortUrl(shortUrl) {
    console.log('开始解析短链接:', shortUrl);

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

        console.log('正在访问短链接...');

        // 尝试多种方式访问短链接
        let finalUrl = shortUrl;

        try {
            // 方法1: 等待网络空闲
            console.log('尝试方法1: 等待网络空闲...');
            await page.goto(shortUrl, {
                waitUntil: 'networkidle2',
                timeout: 12000
            });
            finalUrl = page.url();
            console.log('方法1成功，获取到URL:', finalUrl);
        } catch (error) {
            console.log('方法1失败，尝试方法2...');
            try {
                // 方法2: 等待加载完成
                console.log('尝试方法2: 等待加载完成...');
                await page.goto(shortUrl, {
                    waitUntil: 'load',
                    timeout: 10000
                });
                finalUrl = page.url();
                console.log('方法2成功，获取到URL:', finalUrl);
            } catch (error2) {
                console.log('方法2失败，尝试方法3...');
                try {
                    // 方法3: 不等待，直接获取重定向
                    console.log('尝试方法3: 快速访问...');
                    await page.goto(shortUrl, {
                        waitUntil: 'domcontentloaded',
                        timeout: 8000
                    });
                    // 等待一下让重定向完成
                    await page.waitForTimeout(3001);
                    finalUrl = page.url();
                    console.log('方法3成功，获取到URL:', finalUrl);
                } catch (error3) {
                    console.log('方法3失败，尝试方法4...');
                    try {
                        // 方法4: 最简单的访问方式
                        console.log('尝试方法4: 最简单访问...');
                        await page.goto(shortUrl, { timeout: 6000 });
                        await page.waitForTimeout(2000);
                        finalUrl = page.url();
                        console.log('方法4成功，获取到URL:', finalUrl);
                    } catch (error4) {
                        console.log('所有方法都失败，使用原链接');
                        finalUrl = shortUrl;
                    }
                }
            }
        }

        if (finalUrl !== shortUrl) {
            console.log('短链接解析成功:', shortUrl, '->', finalUrl);
        } else {
            console.log('短链接解析失败，使用原链接');
        }

        return finalUrl;

    } catch (error) {
        console.error('短链接解析过程出错:', error);
        // 解析失败时返回原URL
        return shortUrl;
    } finally {
        // 只关闭当前页面，浏览器实例继续供其他任务复用。
        if (page) await page.close();
    }
}

// 提取和处理小红书链接
async function processXhsUrl(inputText) {
    console.log('处理输入文本:', inputText);

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
        console.log('检测到短链接，正在转换...');
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

    console.log('最终处理的链接:', extractedUrl);
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

// 爬取商品数据
async function scrapeProductData(url) {
    console.log('开始爬取商品数据:', url);

    // 使用统一浏览器实例以复用小红书登录态。
    const browser = await launchBrowser();

    let page = null;
    try {
        page = await browser.newPage();

        // 设置用户代理
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

        console.log('正在访问页面...');
        try {
            await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
            console.log('页面加载完成');
        } catch (error) {
            console.log('页面加载超时，尝试继续...');
        }

        // 等待页面加载
        console.log('等待页面渲染...');
        await page.waitForTimeout(5000);

        console.log('正在提取数据...');

        // 先截图保存，方便调试
        await page.screenshot({ path: 'debug_screenshot.png', fullPage: true });
        console.log('页面截图已保存为 debug_screenshot.png');

        const data = await page.evaluate(() => {
            // 获取页面所有文本内容用于调试
            const pageText = document.body.innerText;
            console.log('页面文本内容:', pageText.substring(0, 500));

            // 尝试多种选择器来获取商品信息
            const getTextBySelectors = (selectors, description) => {
                for (const selector of selectors) {
                    const elements = document.querySelectorAll(selector);
                    if (elements.length > 0) {
                        for (const element of elements) {
                            const text = element.textContent.trim();
                            if (text) {
                                console.log(`${description} - 找到 ${selector}: ${text}`);
                                return text;
                            }
                        }
                    }
                }
                console.log(`${description} - 未找到匹配的元素`);
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

            // 从页面文本中直接查找商品名称
            console.log('页面文本前500字符:', pageText.substring(0, 500));

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
                            console.log('使用备用模式提取到商品名称:', extractedName);
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
                        console.log('从文本中提取到商品名称:', extractedName);
                        break;
                    }
                }
            }

            // 提取价格（寻找 ¥ 符号后的数字）
            const priceMatch = pageText.match(/¥\s*(\d+(?:\.\d+)?)/);
            if (priceMatch) {
                extractedPrice = parseFloat(priceMatch[1]);
                console.log('从文本中提取到价格:', extractedPrice);
            }

            // 提取商品销量（寻找"已售"后的数字）
            const salesMatch = pageText.match(/已售\s*(\d+(?:\.\d+)?[万千]?)/);
            if (salesMatch) {
                extractedSales = salesMatch[1];
                console.log('从文本中提取到商品销量:', extractedSales);
            }

            // 提取店铺名称（寻找店铺名称模式）
            const shopMatch = pageText.match(/([^¥\n]{3,20}?)(?:的店|店铺)/);
            if (shopMatch) {
                extractedShopName = shopMatch[1].trim();
                console.log('从文本中提取到店铺名称:', extractedShopName);
            }

            // 提取店铺销量（寻找店铺相关的已售数字）
            const shopSalesMatches = pageText.match(/已售\s*(\d+(?:\.\d+)?[万千]?)/g);
            if (shopSalesMatches && shopSalesMatches.length > 1) {
                // 如果有多个"已售"，第二个通常是店铺销量
                const shopSalesMatch = shopSalesMatches[1].match(/(\d+(?:\.\d+)?[万千]?)/);
                if (shopSalesMatch) {
                    extractedShopSales = shopSalesMatch[1];
                    console.log('从文本中提取到店铺销量:', extractedShopSales);
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

            console.log('最终提取结果:', {
                name: finalName,
                price: finalPrice,
                sales: finalSales,
                shopName: finalShopName,
                shopSales: finalShopSales,
                stockStatus,
                stockReason: outOfStockReason || inStockReason || '未找到明确库存依据'
            });

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

        console.log('提取到的原始数据:', data);

        const result = {
            name: data.debug.extractedInfo.name || data.name,
            price: data.debug.extractedInfo.price || data.price,
            productSales: parseSalesNumber(data.debug.extractedInfo.sales || data.salesText),
            shopName: data.debug.extractedInfo.shopName || data.shopName,
            shopSales: parseSalesNumber(data.debug.extractedInfo.shopSales || data.shopSalesText),
            stockStatus: data.stockStatus || 'UNKNOWN',
            stockReason: data.stockReason || '未找到明确库存依据'
        };

        console.log('处理后的数据:', result);
        return result;

    } catch (error) {
        console.error('爬取数据失败:', error);
        throw error;
    } finally {
        // 只关闭当前页面，浏览器实例继续供其他任务复用。
        if (page) await page.close();
    }
}

// 添加商品
app.post('/api/products', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: '请提供商品链接或分享文本' });
    }

    try {
        console.log('收到添加商品请求:', url);

        // 处理和提取小红书链接
        const processedUrl = await processXhsUrl(url);

        // 检查是否已存在
        const existingProduct = products.find(p => p.url === processedUrl);
        if (existingProduct) {
            return res.status(400).json({ error: '该商品已存在' });
        }

        // 爬取商品数据
        const productData = await scrapeProductData(processedUrl);

        // 保存商品信息
        const product = {
            id: nextId++,
            url: processedUrl, // 保存处理后的长链接
            ...productData,
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

        console.log('商品添加成功:', product);
        res.json({
            message: '商品添加成功',
            product
        });

    } catch (error) {
        console.error('添加商品失败:', error);
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
                // 最后更新时间
                last_update: todayData ? todayData.crawl_time : product.created_at,
                // 确保店铺名称正确显示
                shop_name: product.shopName || '未知店铺'
            };
        });

        res.json(result);
    } catch (error) {
        console.error('获取商品数据失败:', error);
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
        console.log('刷新商品数据:', product.url);
        const productData = await scrapeProductData(product.url);

        // 更新商品基本信息
        await applyProductData(product, productData);

        // 添加新的销量数据
        const today = new Date().toISOString().split('T')[0];

        // 删除今天的旧数据（如果存在）
        salesData = salesData.filter(s =>
            !(s.product_id === productId && s.crawl_date === today)
        );

        // 添加新数据
        salesData.push({
            product_id: productId,
            product_sales: productData.productSales,
            shop_sales: productData.shopSales,
            crawl_date: today,
            crawl_time: new Date().toISOString()
        });

        // 保存数据到文件
        saveData();

        res.json({ message: '数据刷新成功', data: productData });

    } catch (error) {
        console.error('刷新数据失败:', error);
        res.status(500).json({ error: '刷新数据失败: ' + error.message });
    }
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
        console.error('获取趋势数据失败:', error);
        res.status(500).json({ error: '获取趋势数据失败' });
    }
});

// 删除商品
app.delete('/api/products/:id', (req, res) => {
    const productId = parseInt(req.params.id);

    // 删除商品
    products = products.filter(p => p.id !== productId);

    // 删除相关销量数据
    salesData = salesData.filter(s => s.product_id !== productId);

    // 保存数据到文件
    saveData();

    res.json({ message: '商品删除成功' });
});

// 提供邮件配置测试接口，便于部署后验证 SMTP 参数。
app.post('/api/mail/test', async (req, res) => {
    // 使用用户指定或默认测试内容发送一封测试邮件。
    const testProduct = { name: '邮件配置测试', price: 0, stockStatus: 'IN_STOCK', stockReason: '手动测试', url: 'http://localhost:3001' };
    try {
        const sent = await sendRestockEmail(testProduct, testProduct);
        if (!sent) return res.status(503).json({ error: '未配置完整邮件参数' });
        return res.json({ message: '测试邮件已发送' });
    } catch (error) {
        console.error('测试邮件发送失败:', error);
        return res.status(500).json({ error: `测试邮件发送失败: ${error.message}` });
    }
});

// 自动刷新所有商品数据的函数
async function autoRefreshAllProducts() {
    // 如果上一轮仍在运行，则跳过本轮，避免重复请求小红书。
    if (refreshInProgress) {
        console.warn('上一轮自动刷新尚未完成，跳过本轮任务。');
        return;
    }
    refreshInProgress = true;
    try {
        if (products.length === 0) {
            console.log('没有商品需要刷新');
            return;
        }

        console.log(`================================`);
        console.log(`开始自动刷新所有商品数据 (${new Date().toLocaleString()})`);
        console.log(`需要刷新的商品数量: ${products.length}`);
        console.log(`================================`);

        let successCount = 0;
        let failCount = 0;

        for (const product of products) {
            try {
                console.log(`正在刷新商品: ${product.name} (ID: ${product.id})`);

                // 爬取最新数据
                const productData = await scrapeProductData(product.url);

                // 更新商品基本信息
                await applyProductData(product, productData);

                // 添加新的销量数据
                const now = new Date();
                const today = now.toISOString().split('T')[0];

                // 检查今天是否已有数据
                const existingTodayData = salesData.find(s =>
                    s.product_id === product.id && s.crawl_date === today
                );

                // 如果今天还没有数据，或者距离上次更新超过1小时，则添加新数据
                if (!existingTodayData ||
                    (new Date() - new Date(existingTodayData.crawl_time)) > 60 * 60 * 1000) {

                    salesData.push({
                        product_id: product.id,
                        product_sales: productData.productSales,
                        shop_sales: productData.shopSales,
                        crawl_date: today,
                        crawl_time: now.toISOString()
                    });

                    console.log(`✅ 商品 ${product.name} 数据更新成功 - 销量: ${productData.productSales}`);
                    successCount++;
                } else {
                    console.log(`⏭️ 商品 ${product.name} 今天已更新过，跳过`);
                }

                // 避免请求过于频繁，每个商品之间间隔2秒
                await new Promise(resolve => setTimeout(resolve, 2000));

            } catch (error) {
                console.error(`❌ 商品 ${product.name} 刷新失败:`, error.message);
                failCount++;
            }
        }

        // 保存数据。
        saveData();

        console.log(`================================`);
        console.log(`自动刷新完成 (${new Date().toLocaleString()})`);
        console.log(`成功: ${successCount} 个, 失败: ${failCount} 个`);
        console.log(`下次自动刷新时间: ${new Date(Date.now() + CHECK_INTERVAL_MINUTES * 60 * 1000).toLocaleString()}`);
        console.log(`================================`);
    } finally {
        // 无论刷新正常结束还是意外异常，都释放任务锁。
        refreshInProgress = false;
    }
}

// 设置可配置的定时任务，默认每 5 分钟刷新所有商品数据。
cron.schedule(`*/${CHECK_INTERVAL_MINUTES} * * * *`, async () => {
    console.log(`⏰ 定时任务触发：开始自动刷新商品数据（每 ${CHECK_INTERVAL_MINUTES} 分钟）...`);
    await autoRefreshAllProducts();
}, {
    timezone: "Asia/Shanghai"
});

// 健康检查端点
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        products: products.length,
        uptime: process.uptime(),
        check_interval_minutes: CHECK_INTERVAL_MINUTES,
        mail_configured: Boolean(process.env.MAIL_USERNAME && process.env.MAIL_PASSWORD && process.env.MAIL_RECIPIENT)
    });
});

// 启动服务器
// 进程退出时释放共享浏览器资源。
process.once('SIGINT', async () => {
    await closeBrowser();
    process.exit(0);
});
// 捕获容器停止信号，确保登录目录锁被释放。
process.once('SIGTERM', async () => {
    await closeBrowser();
    process.exit(0);
});
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`================================`);
    console.log(`小红书监控系统已启动`);
    console.log(`访问地址: http://localhost:${PORT}`);
    console.log(`================================`);
    console.log(`当前商品数量: ${products.length}`);
    console.log(`历史数据记录: ${salesData.length} 条`);
    console.log('数据存储: JSON文件持久化');
    console.log('数据目录:', DATA_DIR);
    console.log(`================================`);
    console.log('⏰ 自动刷新功能已启用');
    console.log(`📅 刷新频率: 每 ${CHECK_INTERVAL_MINUTES} 分钟一次`);
    console.log(`================================`);

    // 启动后 10 秒执行一次初始刷新，确保服务启动后尽快建立库存基线。
    setTimeout(async () => {
        console.log('🚀 执行启动后的初始数据刷新...');
        await autoRefreshAllProducts();
    }, 10 * 1000);
});
