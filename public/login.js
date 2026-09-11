// 获取登录表单节点。
const loginForm = document.getElementById('loginForm');
// 获取错误提示节点。
const loginError = document.getElementById('loginError');
// 获取登录按钮节点。
const loginButton = document.getElementById('loginButton');

// 提交登录凭据并在成功后进入监控台。
loginForm.addEventListener('submit', async event => {
    // 阻止表单默认提交，避免暴露凭据到地址栏。
    event.preventDefault();
    loginError.hidden = true;
    loginButton.disabled = true;
    loginButton.textContent = '登录中...';
    try {
        // 通过同源请求提交账号密码，Cookie 由浏览器自动保存。
        const response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: document.getElementById('username').value.trim(),
                password: document.getElementById('password').value
            })
        });
        // 读取后端的统一错误信息。
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '登录失败');
        // 使用 replace 避免用户返回上一页再次看到登录表单。
        window.location.replace('/');
    } catch (error) {
        // 在页面中展示可理解的错误，不输出用户密码。
        loginError.textContent = error.message || '网络错误，请稍后重试';
        loginError.hidden = false;
        loginButton.disabled = false;
        loginButton.textContent = '登录';
    }
});
