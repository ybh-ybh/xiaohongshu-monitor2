'use strict';

// 使用异步上下文保存请求级关联字段，避免逐层传递 requestId。
const { AsyncLocalStorage } = require('async_hooks');

// 定义日志级别的优先级，数值越大表示越严重。
const LOG_LEVEL_VALUES = Object.freeze({
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
    fatal: 50,
    silent: Number.POSITIVE_INFINITY
});
// 定义需要自动脱敏的字段名，防止凭据进入容器日志。
const SENSITIVE_FIELD_PATTERN = /password|authorization|cookie|secret|token/i;
// 保存当前请求的日志上下文。
const logContextStorage = new AsyncLocalStorage();
// 读取应用日志最低级别，非法配置回退为 info。
const configuredLogLevel = String(process.env.LOG_LEVEL || 'info').toLowerCase();
// 保存实际使用的最低日志级别。
const activeLogLevel = Object.prototype.hasOwnProperty.call(LOG_LEVEL_VALUES, configuredLogLevel)
    ? configuredLogLevel
    : 'info';
// 读取输出格式；生产容器默认使用便于采集的 JSON，本地可改为 pretty。
const activeLogFormat = String(process.env.LOG_FORMAT || 'json').toLowerCase() === 'pretty' ? 'pretty' : 'json';
// 读取服务名，供多容器日志平台筛选。
const serviceName = String(process.env.LOG_SERVICE || 'xiaohongshu-monitor');

// 把 Error 转换为可序列化结构，同时保留根因和堆栈。
function serializeError(error) {
    // 非 Error 值也转换为统一的错误消息。
    if (!(error instanceof Error)) return { message: String(error) };
    // 提取错误的稳定字段。
    const serialized = {
        name: error.name,
        message: error.message,
        code: error.code,
        stack: error.stack
    };
    // 递归记录标准 cause，但限制深度由 sanitizeValue 负责。
    if (error.cause !== undefined) serialized.cause = error.cause;
    return serialized;
}

// 递归清理日志字段，处理 Error、循环引用、超深对象和敏感值。
function sanitizeValue(value, key = '', seen = new WeakSet(), depth = 0) {
    // 根据字段名统一隐藏认证信息。
    if (SENSITIVE_FIELD_PATTERN.test(key)) return '[REDACTED]';
    // 保留 JSON 原生支持的空值和标量。
    if (value === null || value === undefined || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }
    // 将 bigint 转换为字符串，避免 JSON.stringify 抛错。
    if (typeof value === 'bigint') return value.toString();
    // 将 Error 转换为普通对象后继续清理。
    if (value instanceof Error) return sanitizeValue(serializeError(value), key, seen, depth + 1);
    // 函数和符号不适合作为结构化日志字段。
    if (typeof value === 'function' || typeof value === 'symbol') return String(value);
    // 限制嵌套深度，避免把大型页面数据完整写入日志。
    if (depth >= 6) return '[MAX_DEPTH]';
    // 检测对象循环引用。
    if (typeof value === 'object') {
        if (seen.has(value)) return '[CIRCULAR]';
        seen.add(value);
    }
    // 清理数组中的每个元素。
    if (Array.isArray(value)) return value.map(item => sanitizeValue(item, key, seen, depth + 1));
    // 清理普通对象中的每个字段。
    const sanitized = {};
    for (const [fieldName, fieldValue] of Object.entries(value)) {
        sanitized[fieldName] = sanitizeValue(fieldValue, fieldName, seen, depth + 1);
    }
    return sanitized;
}

// 判断指定日志级别是否达到当前输出阈值。
function shouldLog(level) {
    return LOG_LEVEL_VALUES[level] >= LOG_LEVEL_VALUES[activeLogLevel];
}

// 把结构化记录渲染为适合本地阅读的单行文本。
function formatPretty(record) {
    // 提取固定头部字段，剩余字段仍以 JSON 展示以保持可检索性。
    const { time, level, event, message, service, ...details } = record;
    // 仅在存在扩展字段时追加 JSON，确保每条日志保持单行。
    const detailText = Object.keys(details).length > 0 ? ` | ${JSON.stringify(details)}` : '';
    return `${time} ${level.toUpperCase().padEnd(5)} [${event}] ${message}${detailText}`;
}

// 输出一条结构化日志；error/fatal 走 stderr，其余级别走 stdout。
function writeLog(level, event, message, fields = {}) {
    if (!shouldLog(level)) return;
    // 合并请求上下文和本次事件字段，本次字段优先。
    const context = logContextStorage.getStore() || {};
    // 构造每行固定包含的基础字段。
    const record = sanitizeValue({
        time: new Date().toISOString(),
        level,
        service: serviceName,
        event,
        message,
        ...context,
        ...fields
    });
    // 根据配置选择 JSON 或本地友好格式。
    const output = activeLogFormat === 'pretty' ? formatPretty(record) : JSON.stringify(record);
    // 错误日志写入 stderr，便于容器平台单独采集告警流。
    const stream = level === 'error' || level === 'fatal' ? process.stderr : process.stdout;
    stream.write(`${output}\n`);
}

// 暴露固定签名的日志方法，要求每条业务日志提供稳定事件名。
const logger = Object.freeze({
    debug: (event, message, fields) => writeLog('debug', event, message, fields),
    info: (event, message, fields) => writeLog('info', event, message, fields),
    warn: (event, message, fields) => writeLog('warn', event, message, fields),
    error: (event, message, fields) => writeLog('error', event, message, fields),
    fatal: (event, message, fields) => writeLog('fatal', event, message, fields)
});

// 在指定异步调用链中附加请求或任务关联字段。
function runWithLogContext(context, callback) {
    return logContextStorage.run(context, callback);
}

module.exports = {
    logger,
    runWithLogContext,
    activeLogFormat,
    activeLogLevel
};
