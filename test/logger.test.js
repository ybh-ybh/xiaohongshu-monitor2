'use strict';

// 使用 Node 内置测试框架验证日志契约，无需新增生产依赖。
const test = require('node:test');
// 使用严格断言避免宽松类型转换掩盖错误。
const assert = require('node:assert/strict');
// 在独立进程中加载 logger，确保每个用例使用自己的环境变量。
const { spawnSync } = require('node:child_process');
// 解析测试进程的项目根目录。
const path = require('node:path');

// 保存仓库根目录，供子进程正确加载 logger.js。
const projectRoot = path.resolve(__dirname, '..');

// 使用指定环境运行一段日志代码并返回结果。
function runLoggerSnippet(script, environment) {
    // 启动隔离的 Node 进程，避免模块缓存固定上一个用例的日志配置。
    return spawnSync(process.execPath, ['-e', script], {
        cwd: projectRoot,
        env: { ...process.env, ...environment },
        encoding: 'utf8'
    });
}

// 验证 JSON 日志可以过滤级别并自动隐藏凭据。
test('JSON 日志按级别过滤并脱敏', () => {
    // 输出一条应被过滤的 debug 和一条应保留的 info。
    const result = runLoggerSnippet(
        "const { logger } = require('./logger'); logger.debug('test.hidden', '隐藏'); logger.info('test.visible', '可见', { password: 'secret', request_id: 'req-1' });",
        { LOG_LEVEL: 'info', LOG_FORMAT: 'json' }
    );
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    // 每个事件必须只占一行。
    const lines = result.stdout.trim().split(/\r?\n/);
    assert.equal(lines.length, 1);
    // 解析结构化字段并验证稳定事件名与脱敏结果。
    const record = JSON.parse(lines[0]);
    assert.equal(record.event, 'test.visible');
    assert.equal(record.request_id, 'req-1');
    assert.equal(record.password, '[REDACTED]');
});

// 验证本地 pretty 格式同样保持单行，便于终端筛选。
test('pretty 日志保持单行', () => {
    // 输出带扩展字段的本地日志。
    const result = runLoggerSnippet(
        "const { logger } = require('./logger'); logger.warn('test.pretty', '可读日志', { batch_id: 'batch-1' });",
        { LOG_LEVEL: 'debug', LOG_FORMAT: 'pretty' }
    );
    assert.equal(result.status, 0);
    // 去除结尾换行后不能再出现物理换行。
    const output = result.stdout.trim();
    assert.equal(output.split(/\r?\n/).length, 1);
    assert.match(output, /WARN\s+\[test\.pretty\] 可读日志/);
    assert.match(output, /"batch_id":"batch-1"/);
});

// 验证后台任务可以主动清除创建它的 HTTP 请求上下文。
test('后台任务不会继承旧请求编号', () => {
    // 在请求上下文中创建定时器，再用空上下文运行后台日志。
    const result = runLoggerSnippet(
        "const { logger, runWithLogContext } = require('./logger'); runWithLogContext({ request_id: 'stale-request' }, () => setTimeout(() => runWithLogContext({}, () => logger.info('test.background', '后台任务')), 1));",
        { LOG_LEVEL: 'info', LOG_FORMAT: 'json' }
    );
    assert.equal(result.status, 0);
    // 解析后台任务日志并确认旧请求编号已被清除。
    const record = JSON.parse(result.stdout.trim());
    assert.equal(record.event, 'test.background');
    assert.equal(Object.prototype.hasOwnProperty.call(record, 'request_id'), false);
});
