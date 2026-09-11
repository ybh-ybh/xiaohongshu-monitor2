let productsData = [];

// 页面加载时获取数据
document.addEventListener('DOMContentLoaded', function() {
    loadProducts();
});

// 显示加载状态
function showLoading() {
    document.getElementById('loading').style.display = 'flex';
}

// 隐藏加载状态
function hideLoading() {
    document.getElementById('loading').style.display = 'none';
}

// 显示消息
function showMessage(text, type = 'info') {
    const messageEl = document.getElementById('message');
    messageEl.textContent = text;
    messageEl.className = `message ${type}`;
    messageEl.style.display = 'block';
    
    setTimeout(() => {
        messageEl.style.display = 'none';
    }, 3001);
}

// 格式化数字
function formatNumber(num) {
    if (num === null || num === undefined) return '0';
    return num.toLocaleString();
}

// 格式化价格
function formatPrice(price) {
    if (price === null || price === undefined) return '¥0';
    return `¥${price.toFixed(2)}`;
}

// 将库存状态转换为页面可读文本，并保留检测依据提示。
function formatStockStatus(status, reason) {
    // UNKNOWN 不展示为“有货”，避免因页面结构变化误导抢购。
    const labels = {
        IN_STOCK: '有货',
        OUT_OF_STOCK: '无货',
        UNKNOWN: '待确认'
    };
    const label = labels[status] || labels.UNKNOWN;
    return `<span title="${reason || '未找到明确库存依据'}">${label}</span>`;
}

// 格式化时间
function formatTime(timeString) {
    if (!timeString) return '暂无数据';
    const date = new Date(timeString);
    return date.toLocaleString('zh-CN');
}

// 提取小红书链接
function extractXhsUrl(text) {
    // 支持的链接格式：
    // 1. 完整链接：https://www.xiaohongshu.com/goods-detail/...
    // 2. 短链接：http://xhslink.com/...
    // 3. 分享文本中的链接
    
    const urlPatterns = [
        // 完整的小红书商品链接
        /https?:\/\/www\.xiaohongshu\.com\/goods-detail\/[^\s]+/g,
        // 小红书短链接
        /https?:\/\/xhslink\.com\/[^\s]+/g,
    ];
    
    for (const pattern of urlPatterns) {
        const matches = text.match(pattern);
        if (matches && matches.length > 0) {
            return matches[0].trim();
        }
    }
    
    return null;
}

// 添加单个商品
async function addProduct() {
    const urlInput = document.getElementById('productUrl');
    const inputText = urlInput.value.trim();
    
    if (!inputText) {
        showMessage('请输入商品链接', 'error');
        return;
    }
    
    // 提取小红书链接
    const url = extractXhsUrl(inputText);
    if (!url) {
        showMessage('请输入有效的小红书商品链接或分享文本', 'error');
        return;
    }
    
    showLoading();
    
    try {
        const response = await fetch('/api/products', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ url })
        });
        
        const result = await response.json();
        
        if (response.ok) {
            showMessage('商品添加成功', 'success');
            urlInput.value = '';
            loadProducts();
        } else {
            showMessage(result.error || '添加失败', 'error');
        }
    } catch (error) {
        console.error('添加商品失败:', error);
        showMessage('网络错误，请稍后重试', 'error');
    } finally {
        hideLoading();
    }
}

// 批量添加商品
async function addBatchProducts() {
    const batchInput = document.getElementById('batchUrls');
    const urls = batchInput.value.trim().split('\n').filter(url => url.trim());
    
    if (urls.length === 0) {
        showMessage('请输入商品链接', 'error');
        return;
    }
    
    // 提取和验证所有链接
    const extractedUrls = [];
    const invalidUrls = [];
    
    for (const line of urls) {
        const extractedUrl = extractXhsUrl(line);
        if (extractedUrl) {
            extractedUrls.push(extractedUrl);
        } else {
            invalidUrls.push(line);
        }
    }
    
    if (invalidUrls.length > 0) {
        showMessage(`发现 ${invalidUrls.length} 个无效链接，请检查链接格式`, 'error');
        console.log('无效链接:', invalidUrls);
        return;
    }
    
    showLoading();
    
    let successCount = 0;
    let failCount = 0;
    const errors = [];
    
    try {
        // 逐个添加商品（避免并发过多）
        for (let i = 0; i < extractedUrls.length; i++) {
            const url = extractedUrls[i];
            
            try {
                const response = await fetch('/api/products', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ url })
                });
                
                const result = await response.json();
                
                if (response.ok) {
                    successCount++;
                } else {
                    failCount++;
                    errors.push(`链接 ${i + 1}: ${result.error}`);
                }
            } catch (error) {
                failCount++;
                errors.push(`链接 ${i + 1}: 网络错误`);
            }
            
            // 添加延迟避免请求过于频繁
            if (i < extractedUrls.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        
        // 显示结果
        if (successCount > 0) {
            showMessage(`批量添加完成：成功 ${successCount} 个，失败 ${failCount} 个`, 
                       failCount === 0 ? 'success' : 'info');
            batchInput.value = '';
            loadProducts();
        } else {
            showMessage('所有商品添加失败', 'error');
        }
        
        // 如果有错误，在控制台显示详细信息
        if (errors.length > 0) {
            console.error('批量添加错误详情:', errors);
        }
        
    } catch (error) {
        console.error('批量添加失败:', error);
        showMessage('批量添加过程中发生错误', 'error');
    } finally {
        hideLoading();
    }
}

// 加载商品数据
async function loadProducts() {
    try {
        const response = await fetch('/api/products');
        const data = await response.json();
        
        if (response.ok) {
            productsData = data;
            updateDashboardMetrics();
            renderTable();
        } else {
            showMessage('加载数据失败', 'error');
        }
    } catch (error) {
        console.error('加载数据失败:', error);
        showMessage('网络错误，请稍后重试', 'error');
    }
}

// 同步页面顶部的监控指标与当前商品数据。
function updateDashboardMetrics() {
    // 获取监控商品数量节点。
    const metricProductsEl = document.getElementById('metricProducts');
    // 获取有货商品数量节点。
    const metricInStockEl = document.getElementById('metricInStock');
    // 获取缺货商品数量节点。
    const metricOutOfStockEl = document.getElementById('metricOutOfStock');
    // 获取商品记录数节点。
    const recordCountEl = document.getElementById('recordCount');
    // 计算当前商品总数。
    const monitoredCount = productsData.length;
    // 计算最近一次采集为有货的商品数量。
    const inStockCount = productsData.filter(product => product.stockStatus === 'IN_STOCK').length;
    // 计算最近一次采集为缺货的商品数量。
    const outOfStockCount = productsData.filter(product => product.stockStatus === 'OUT_OF_STOCK').length;

    if (metricProductsEl) metricProductsEl.textContent = formatNumber(monitoredCount);
    if (metricInStockEl) metricInStockEl.textContent = formatNumber(inStockCount);
    if (metricOutOfStockEl) metricOutOfStockEl.textContent = formatNumber(outOfStockCount);
    if (recordCountEl) recordCountEl.textContent = `${monitoredCount} 条记录`;
}

// 渲染表格
function renderTable() {
    const tbody = document.getElementById('productsTableBody');
    
    if (productsData.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="6" style="text-align: center; padding: 40px; color: #6c757d;">
                    暂无数据，请添加商品链接开始监控
                </td>
            </tr>
        `;
        return;
    }
    
    tbody.innerHTML = productsData.map(product => `
        <tr>
            <td>
                <div class="product-name" title="${product.name || '未知商品'}">
                    ${product.name || '未知商品'}
                </div>
            </td>
            <td class="price">${formatPrice(product.price)}</td>
            <td class="stock-status ${String(product.stockStatus || 'UNKNOWN').toLowerCase()}">
                ${formatStockStatus(product.stockStatus, product.stockReason)}
            </td>
            <td>
                <div class="shop-name" title="${product.shop_name || product.shopName || '未知店铺'}">
                    ${product.shop_name || product.shopName || '未知店铺'}
                </div>
            </td>
            <td class="update-time">${formatTime(product.last_update)}</td>
            <td>
                <a href="${product.url}" target="_blank" rel="noopener noreferrer" class="btn btn-info btn-small" aria-label="查看${product.name || '商品'}">查看商品</a>
                <button onclick="refreshProduct(${product.id})" class="btn btn-success btn-small">刷新</button>
                <button onclick="deleteProduct(${product.id})" class="btn btn-danger btn-small">删除</button>
            </td>
        </tr>
    `).join('');
}

// 排序表格
function sortTable() {
    const sortBy = document.getElementById('sortBy').value;
    const sortOrder = document.getElementById('sortOrder').value;
    
    productsData.sort((a, b) => {
        let aVal = a[sortBy];
        let bVal = b[sortBy];
        
        // 将库存状态映射为可排序的优先级。
        if (sortBy === 'stockStatus') {
            // 定义库存状态排序优先级，缺货商品排在前面便于处理。
            const stockRank = { OUT_OF_STOCK: 2, UNKNOWN: 1, IN_STOCK: 0 };
            aVal = stockRank[a.stockStatus] ?? stockRank.UNKNOWN;
            bVal = stockRank[b.stockStatus] ?? stockRank.UNKNOWN;
        }
        
        // 处理null/undefined值
        if (aVal === null || aVal === undefined) aVal = 0;
        if (bVal === null || bVal === undefined) bVal = 0;
        
        // 数字比较
        if (typeof aVal === 'number' && typeof bVal === 'number') {
            return sortOrder === 'asc' ? aVal - bVal : bVal - aVal;
        }
        
        // 字符串比较
        const aStr = String(aVal).toLowerCase();
        const bStr = String(bVal).toLowerCase();
        
        if (sortOrder === 'asc') {
            return aStr.localeCompare(bStr);
        } else {
            return bStr.localeCompare(aStr);
        }
    });
    
    renderTable();
}

// 刷新单个商品数据
async function refreshProduct(productId) {
    showLoading();
    
    try {
        const response = await fetch(`/api/products/${productId}/refresh`, {
            method: 'POST'
        });
        
        const result = await response.json();
        
        if (response.ok) {
            showMessage('数据刷新成功', 'success');
            loadProducts();
        } else {
            showMessage(result.error || '刷新失败', 'error');
        }
    } catch (error) {
        console.error('刷新数据失败:', error);
        showMessage('网络错误，请稍后重试', 'error');
    } finally {
        hideLoading();
    }
}

// 刷新所有数据
async function refreshAllData() {
    if (productsData.length === 0) {
        showMessage('暂无商品数据', 'info');
        return;
    }
    
    showLoading();
    
    try {
        const promises = productsData.map(product => 
            fetch(`/api/products/${product.id}/refresh`, { method: 'POST' })
        );
        
        await Promise.all(promises);
        showMessage('所有数据刷新完成', 'success');
        loadProducts();
    } catch (error) {
        console.error('批量刷新失败:', error);
        showMessage('部分数据刷新失败', 'error');
        loadProducts();
    } finally {
        hideLoading();
    }
}

// 测试当前邮件配置是否能够发送邮件。
async function testEmail() {
    // 显示邮件测试请求的加载状态。
    showLoading();

    try {
        // 调用后端邮件测试接口，向配置的收件人发送测试邮件。
        const response = await fetch('/api/mail/test', {
            method: 'POST'
        });
        // 读取后端返回的成功或错误信息。
        const result = await response.json();

        if (response.ok) {
            showMessage(result.message || '测试邮件已发送，请检查收件箱', 'success');
        } else {
            showMessage(result.error || '测试邮件发送失败', 'error');
        }
    } catch (error) {
        // 处理接口不可用或网络异常。
        console.error('测试邮件失败:', error);
        showMessage('网络错误，请稍后重试', 'error');
    } finally {
        // 无论请求结果如何都关闭加载状态。
        hideLoading();
    }
}

// 删除商品
async function deleteProduct(productId) {
    if (!confirm('确定要删除这个商品吗？删除后将无法恢复历史数据。')) {
        return;
    }
    
    try {
        const response = await fetch(`/api/products/${productId}`, {
            method: 'DELETE'
        });
        
        const result = await response.json();
        
        if (response.ok) {
            showMessage('商品删除成功', 'success');
            loadProducts();
        } else {
            showMessage(result.error || '删除失败', 'error');
        }
    } catch (error) {
        console.error('删除失败:', error);
        showMessage('网络错误，请稍后重试', 'error');
    }
}

// 回车键添加商品
document.getElementById('productUrl').addEventListener('keypress', function(e) {
    if (e.key === 'Enter') {
        addProduct();
    }
});

// 标签页切换功能
function switchTab(tabName) {
    // 移除所有活动状态
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
        btn.setAttribute('aria-selected', 'false');
    });
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));

    // 激活选中的标签页
    event.target.classList.add('active');
    event.target.setAttribute('aria-selected', 'true');
    document.getElementById(tabName + 'Tab').classList.add('active');
}



// 清空批量输入
function clearBatchInput() {
    document.getElementById('batchUrls').value = '';
    document.getElementById('batchProgress').style.display = 'none';
}
