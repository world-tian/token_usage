let currentUser = null; // { feishu_open_id, tenant_key, profile } — 从 /api/v1/me 获取
let currentLastCollectAt = null;

// ── 登录墙 ──────────────────────────────────────────────────────────────────
function showLoginOverlay(visible) {
  const overlay = document.querySelector('#login-overlay');
  if (!overlay) return;
  overlay.style.display = visible ? 'flex' : 'none';
}

function renderLoggedOut() {
  const nameEl = document.querySelector('#user-display-name');
  if (nameEl) nameEl.textContent = '👤 未登录';
  const logoutBtn = document.querySelector('#logout-btn');
  const loginBtn = document.querySelector('#feishu-login-btn');
  if (logoutBtn) logoutBtn.style.display = 'none';
  if (loginBtn) loginBtn.style.display = 'inline-block';
}

async function checkAuth() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch('/api/v1/me', { signal: controller.signal, credentials: 'same-origin' });
    if (res.ok) {
      currentUser = await res.json();
      showLoginOverlay(false);
      renderCurrentUser();
      // 如果是刚 OAuth 完成，把当前设备和飞书账号绑定
      if (new URLSearchParams(location.search).get('feishu_login') === 'success') {
        const token = localStorage.getItem('device_token');
        if (token) await fetch('/api/v1/devices/feishu-link', { method: 'POST', headers: { authorization: `Bearer ${token}` } }).catch(() => {});
        history.replaceState({}, '', '/');
      }
      // localStorage 里没有 device_token 时（换浏览器/清缓存），用飞书 session 自动恢复
      if (!localStorage.getItem('device_token')) {
        try {
          const r = await fetch('/api/v1/my-device-token');
          if (r.ok) {
            const { device_token, device_id } = await r.json();
            localStorage.setItem('device_token', device_token);
            localStorage.setItem('device_id', device_id);
          }
        } catch {}
      }
      await Promise.all([loadBoard(), loadSignatureConfig()]);
    } else {
      currentUser = null;
      renderLoggedOut();
      showLoginOverlay(true);
    }
  } catch {
    currentUser = null;
    renderLoggedOut();
    showLoginOverlay(true);
  } finally {
    clearTimeout(timeout);
  }
}

function renderCurrentUser() {
  if (!currentUser) return;
  const profile = currentUser.profile || {};
  const nameEl = document.querySelector('#user-display-name');
  const avatar = profile.avatar || '👤';
  if (typeof avatar === 'string' && avatar.startsWith('http')) {
    nameEl.innerHTML = `<img src="${escapeHtml(avatar)}" alt="" style="width:20px;height:20px;border-radius:50%;vertical-align:middle;margin-right:6px;object-fit:cover;">${escapeHtml(profile.display_name || '飞书用户')}`;
  } else {
    nameEl.textContent = `${avatar} ${profile.display_name || '飞书用户'}`;
  }
  document.querySelector('#logout-btn').style.display = 'inline-block';
  document.querySelector('#feishu-login-btn').style.display = 'none';
}

document.querySelector('#logout-btn')?.addEventListener('click', async () => {
  await fetch('/api/v1/auth/logout', { method: 'POST' });
  currentUser = null;
  localStorage.removeItem('device_token');
  localStorage.removeItem('device_id');
  showLoginOverlay(true);
  document.querySelector('#user-display-name').textContent = '👤 未登录';
  document.querySelector('#logout-btn').style.display = 'none';
});

const createButton = document.querySelector('#create-code');
const pairing = document.querySelector('#pairing');
const receipt = document.querySelector('#receipt');
let stream;
let selectedPlatform = 'macOS';

document.querySelectorAll('.tab').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((item) => item.classList.remove('active'));
    button.classList.add('active');
    selectedPlatform = button.dataset.os;
    document.querySelector('#download-copy').textContent = `下载已签名的 ${button.dataset.os} 安装包，无需手动配置。`;
  });
});

createButton.addEventListener('click', async () => {
  createButton.disabled = true;
  createButton.textContent = '正在生成…';
  const response = await fetch('/api/v1/device-codes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform: selectedPlatform })
  });
  const data = await response.json();
  document.querySelector('#code').textContent = data.code;
  document.querySelector('#command').textContent = data.command;
  pairing.classList.remove('hidden');
  createButton.textContent = '已生成配对命令';
  watch(data.id);
});

document.querySelector('#copy-command').addEventListener('click', async (event) => {
  await navigator.clipboard.writeText(document.querySelector('#command').textContent);
  event.currentTarget.textContent = '已复制';
});

function mark(status) {
  const order = ['waiting', 'paired', 'scanning', 'uploaded', 'aggregated'];
  const reached = order.indexOf(status);
  document.querySelectorAll('.progress-item').forEach((item, index) => {
    item.classList.toggle('done', index < reached);
    item.classList.toggle('active', index === reached);
  });
}

function watch(id) {
  stream?.close();
  stream = new EventSource(`/api/v1/device-codes/${id}/events`);
  ['paired', 'scanning', 'uploaded', 'aggregated'].forEach((status) => {
    stream.addEventListener(status, (event) => {
      const data = JSON.parse(event.data);
      mark(status);
      if (status === 'paired' && data.device_token && data.device_id) {
        localStorage.setItem('device_token', data.device_token);
        localStorage.setItem('device_id', data.device_id);
        if (currentUser) {
          // 竞态修复：先执行绑定，绑定成功后再触发签名配置与排行榜加载！
          fetch('/api/v1/devices/feishu-link', {
            method: 'POST',
            headers: { authorization: `Bearer ${data.device_token}` }
          })
          .then(() => {
            loadSignatureConfig();
            loadBoard();
          })
          .catch(() => {
            loadSignatureConfig();
            loadBoard();
          });
        } else {
          loadSignatureConfig();
          loadBoard();
        }
      }
      if (data.receipt) showReceipt(data.receipt);
      if (status === 'aggregated') loadBoard();
    });
  });
}

function showReceipt(data) {
  receipt.classList.remove('hidden');
  document.querySelector('#receipt-tools').textContent = data.tools.join(' · ');
  document.querySelector('#receipt-models').textContent = `${data.models.length} 个`;
  document.querySelector('#receipt-tokens').textContent = compact(data.total_tokens);
}

function compact(value) {
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 2 }).format(value || 0);
}

function money(value) {
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', maximumFractionDigits: 2 }).format(value || 0);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function modelBreakdown(models) {
  const bar = `<div class="model-bar">${models.map((item, index) => `<span style="width:${item.ratio * 100}%;--color:var(--model-${index % 5})" title="${escapeHtml(item.display_name)}: ${compact(item.tokens)} Token"></span>`).join('')}</div>`;
  const legend = `<div class="model-legend">${models.map((item, index) => `
    <div class="model-item">
      <i style="--color:var(--model-${index % 5})"></i>
      <strong>${escapeHtml(item.display_name)}</strong>
      <span>${(item.ratio * 100).toFixed(1)}%</span>
      <span>${compact(item.tokens)} Token</span>
      <span>${item.priced_tokens ? `≈${money(item.cost_cny)}` : '未计价'}</span>
    </div>`).join('')}</div>`;
  return bar + legend;
}

let currentPeriod = 'total';

async function loadBoard() {
  const response = await fetch(`/api/v1/leaderboard?period=${currentPeriod}`);
  if (response.status === 401) { showLoginOverlay(true); return; }
  const { data } = await response.json();
  document.querySelector('#board-empty').classList.toggle('hidden', data.length > 0);
  document.querySelector('#board').innerHTML = data.map((row) => `
    <article class="board-row">
      <div class="rank">#${String(row.rank).padStart(2, '0')}</div>
      <div class="badge">${row.animal.emoji}</div>
      <div class="person">
        <strong>${escapeHtml(row.display_name)} <small>Lv.${row.animal.level} ${escapeHtml(row.animal.name)}</small></strong>
        <span>工具：${row.tools.map(escapeHtml).join(' · ')}</span>
        ${modelBreakdown(row.models)}
      </div>
      <div class="tokens">
        <strong>${compact(row.total_tokens)}</strong><span>Token</span>
        <strong class="cost">≈${money(row.cost_cny)}</strong>
        <span>API 等价估算 · 覆盖 ${(row.pricing_coverage * 100).toFixed(0)}%</span>
      </div>
    </article>`).join('');
}

function formatTime(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function updateSignaturePreview(row, metric, collectedAt) {
  const el = document.querySelector('#signature-copy');
  if (!row) {
    el.textContent = metric === 'today' ? '今日暂无大模型用量 🌊 待自动采集' : '暂无大模型用量 🌊 待自动采集';
    return;
  }
  const usage = metric === 'today' ? `今日消耗token ${compact(row.total_tokens)}` : `累计token消耗 ${compact(row.total_tokens)}`;
  const displayTime = collectedAt || row.last_sync_at;
  const timePart = displayTime ? `｜${formatTime(displayTime)}` : '';
  el.textContent = `${row.animal.emoji} ${row.animal.name} Lv.${row.animal.level}｜${usage}｜≈${money(row.cost_cny)}${timePart}`;
}

// 按口径(today/total)拉取对应数据并渲染签名预览
async function renderSignatureForMetric(metric) {
  const period = metric === 'today' ? 'today' : 'total';
  try {
    const res = await fetch(`/api/v1/leaderboard?period=${period}`);
    if (res.status === 401) { updateSignaturePreview(null, metric); return; }
    const { data } = await res.json();
    // 优先用 union_id（跨应用稳定）找本人行，其次 open_id，其次 device_id
    const unionId = currentUser?.union_id;
    const feishuId = currentUser?.feishu_open_id;
    const deviceId = localStorage.getItem('device_id');
    const row = (unionId ? data.find(r => r.canonical_key === unionId || r.feishu_union_id === unionId) : null)
      ?? (feishuId ? data.find(r => r.feishu_open_id === feishuId) : null)
      ?? (deviceId ? data.find(r => r.device_id === deviceId) : null)
      ?? null;
    // total_tokens 为 0 视为该口径暂无用量，显示占位文案而非“消耗token 0”
    updateSignaturePreview(row && row.total_tokens ? row : null, metric, currentLastCollectAt);
  } catch {
    updateSignaturePreview(null, metric, currentLastCollectAt);
  }
}

async function loadSignatureConfig() {
  const token = localStorage.getItem('device_token');
  const deviceId = localStorage.getItem('device_id');
  const headers = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  
  const response = await fetch('/api/v1/signature/config', { headers });
  if (response.status === 401) {
    if (!token) return; // 避免未配对设备在获取配置返回 401 时引发无限递归死循环
    localStorage.removeItem('device_token');
    localStorage.removeItem('device_id');
    await loadSignatureConfig();
    return;
  }
  
  const config = await response.json();
  currentLastCollectAt = config.last_collect_at;
  
  // 更新定时采集 Checkbox 状态
  document.querySelector('#auto-collect').checked = !!config.auto_collect_enabled;
  
  // 签名 URL：优先 union_id（跨应用稳定），其次 config 里的 URL
  const stableId = currentUser?.union_id || config.feishu_union_id || currentUser?.feishu_open_id || config.feishu_open_id;
  if (stableId) {
    document.querySelector('#signature-url').value = `${window.location.origin}/signature?feishu_id=${stableId}`;
  } else if (config.signature_url) {
    document.querySelector('#signature-url').value = config.signature_url;
  } else {
    document.querySelector('#signature-url').value = '登录飞书后自动生成专属 URL';
  }
  
  document.querySelectorAll('#metric-choice .choice').forEach((item) => item.classList.toggle('active', item.dataset.value === config.metric));
  document.querySelector('#interval').value = String(config.interval_minutes);
  document.querySelector('#last-collect').textContent = formatTime(config.last_collect_at);
  document.querySelector('#next-collect').textContent = config.auto_collect_enabled && config.next_collect_at ? formatTime(config.next_collect_at) : '未安排';
  
  // 针对配对状态对界面进行友好引导限制
  const saveBtn = document.querySelector('#save-signature');
  const editProfileBtn = document.querySelector('#edit-profile-btn');
  const connectCard = document.querySelector('.connect-card');
  
  if (!token) {
    document.querySelector('#scheduler-state').textContent = '未配对';
    document.querySelector('#feishu-state').textContent = '未配对';
    saveBtn.disabled = true;
    saveBtn.textContent = '请先配对设备';
    editProfileBtn.style.display = 'none';
    
    // 未连接设备时，确保移除已连接横幅，恢复默认面板
    connectCard.querySelector('.connected-banner')?.remove();
    connectCard.querySelectorAll('.card-head, .tabs, .setup-grid').forEach(el => {
      el.style.display = '';
    });
  } else {
    saveBtn.disabled = false;
    saveBtn.textContent = '保存显示偏好';
    editProfileBtn.style.display = 'inline-block';
    
    // 更新状态文字
    document.querySelector('#scheduler-state').textContent = config.auto_collect_enabled ? '已启用' : '未启用';
    document.querySelector('#feishu-state').textContent = config.feishu_status === 'connected' ? '已连接' : '待接入 OAuth';

    // 智能优化：折叠已接入设备的配对命令生成框，避免反复生成采集命令的困惑
    if (connectCard && !connectCard.querySelector('.connected-banner')) {
      const banner = document.createElement('div');
      banner.className = 'connected-banner';
      const isWin = navigator.userAgent.includes('Windows');
      const startCmd = isWin 
        ? `node $env:LOCALAPPDATA\\TokenTide\\bin\\token-tide.mjs daemon --server ${window.location.origin}`
        : `node ~/.token-tide/bin/token-tide.mjs daemon --server ${window.location.origin}`;

      banner.innerHTML = `
        <div class="banner-content" style="display:flex;align-items:flex-start;justify-content:space-between;width:100%;padding:10px 0;">
          <div style="flex:1;">
            <div style="display:flex;align-items:center;gap:12px;">
              <span style="font-size:24px;color:var(--cyan);">✓</span>
              <h3 style="margin:0;color:var(--cyan);font-size:16px;">本地采集器已配对</h3>
            </div>
            <p style="margin:8px 0 0;font-size:13px;color:var(--text-muted);line-height:1.5;">
              要保持网页遥控和自动同步，请确保电脑已安装 Node.js 22+，并在终端保持运行以下长连接守护进程：
            </p>
            <div style="display:flex; gap:8px; margin-top:8px;">
              <code style="flex:1; display:block; padding:8px 12px; background:var(--bg-body); border:1px solid var(--border-color); border-radius:6px; font-size:12px; color:var(--text-color); font-family:monospace; word-break:break-all;" id="daemon-cmd">${startCmd}</code>
              <button class="button ghost small" onclick="navigator.clipboard.writeText(document.getElementById('daemon-cmd').textContent); this.textContent='已复制'; setTimeout(()=>this.textContent='复制', 2000);">复制</button>
            </div>
          </div>
          <button id="reconnect-btn" class="button ghost small" style="margin-left:16px;white-space:nowrap;margin-top:4px;">连接新设备</button>
        </div>
      `;
      connectCard.insertBefore(banner, connectCard.firstChild);
      
      // 隐藏原本的连接步骤
      connectCard.querySelectorAll('.card-head, .tabs, .setup-grid, .pairing').forEach(el => {
        if (el !== banner) el.style.display = 'none';
      });

      // 连接新设备按钮点击事件
      banner.querySelector('#reconnect-btn').addEventListener('click', () => {
        banner.remove();
        connectCard.querySelectorAll('.card-head, .tabs, .setup-grid').forEach(el => {
          el.style.display = '';
        });
        const createBtn = document.querySelector('#create-code');
        createBtn.disabled = false;
        createBtn.textContent = '生成配对命令';
        document.querySelector('#pairing').classList.add('hidden');
      });
    }
  }
  
  const statusEl = document.querySelector('#signature-status');
  if (token && config.auto_collect_enabled) {
    statusEl.textContent = '已启用定时采集';
    statusEl.className = 'status-success';
  } else {
    statusEl.textContent = '尚未启用定时采集';
    statusEl.className = 'status-warn';
  }
  
  // 后端 preview 现在是权威值：null 表示该口径（今日/累计）暂无用量，直接显示占位文案。
  // 不再回退到依赖 cookie 的 /api/v1/leaderboard，避免竞态或 401 把已显示的数据重新刷成 0。
  updateSignaturePreview(config.preview, config.metric, currentLastCollectAt);
}


// 绑定飞书签名类型选择
document.querySelectorAll('#metric-choice .choice').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('#metric-choice .choice').forEach((item) => item.classList.remove('active'));
  button.classList.add('active');
  document.querySelector('#interval').value = button.dataset.value === 'today' ? '30' : '1440';
  // 实时切换预览（今日消耗 / 累计消耗），方便直接复制对应口径的签名
  renderSignatureForMetric(button.dataset.value);
}));

// 轻量 toast 提示：所有复制/刷新动作给出明显反馈
let toastTimer;
function toast(message) {
  const el = document.querySelector('#toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

// 保存偏好设置事件
document.querySelector('#save-signature').addEventListener('click', async (event) => {
  const token = localStorage.getItem('device_token');
  if (!token) return;
  
  const metric = document.querySelector('#metric-choice .choice.active').dataset.value;
  const interval_minutes = Number(document.querySelector('#interval').value);
  const auto_collect_enabled = document.querySelector('#auto-collect').checked;
  
  await fetch('/api/v1/signature/config', { 
    method: 'PUT', 
    headers: { 
      'content-type': 'application/json',
      'authorization': `Bearer ${token}`
    }, 
    body: JSON.stringify({ metric, interval_minutes, auto_collect_enabled }) 
  });
  
  const btn = event.currentTarget;
  const oldText = btn.textContent;
  btn.textContent = '已保存偏好设置';
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = oldText;
    btn.disabled = false;
  }, 1500);
  
  await loadSignatureConfig();
});

// 复制签名链接
document.querySelector('#copy-signature-url').addEventListener('click', async (event) => {
  const urlInput = document.querySelector('#signature-url');
  const url = urlInput.value.trim();
  if (!url.startsWith('http')) return;
  const btn = event.currentTarget;
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    // execCommand 降级
    urlInput.select();
    document.execCommand('copy');
  }
  btn.textContent = '已复制 ✓';
  btn.classList.add('copied');
  toast('链接已复制，粘贴到飞书「个人资料 → 个性签名」保存即可');
  setTimeout(() => {
    btn.textContent = '复制链接';
    btn.classList.remove('copied');
  }, 2000);
});

document.querySelector('#refresh-feishu-signature')?.addEventListener('click', async (event) => {
  const token = localStorage.getItem('device_token');
  if (!token) return alert('请先完成设备配对。');
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = '正在通知飞书…';
  try {
    const response = await fetch('/api/v1/feishu/preview/refresh', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    const result = await response.json();
    if (result.status === 'success') {
      button.textContent = `已刷新 ${result.count} 个签名`;
      toast(`已通知飞书刷新 ${result.count} 个签名`);
      await loadSignatureConfig();
    } else if (result.status === 'waiting_for_preview_token') {
      button.textContent = '请先粘贴一次飞书签名';
      toast('请先在飞书粘贴一次签名链接');
    } else if (result.status === 'waiting_for_app_credentials') {
      button.textContent = '飞书应用未配置';
      toast('飞书应用未配置');
    } else {
      button.textContent = '刷新失败';
      toast(`刷新失败：${result.error || result.status}`);
      console.error('[feishu preview refresh] 失败详情:', result);
    }
  } catch {
    button.textContent = '刷新失败';
    toast('刷新失败');
  }
  setTimeout(() => { button.disabled = false; button.textContent = '立即刷新飞书签名'; }, 2500);
});

// 复制签名文字（纯文本）
document.querySelector('#copy-signature-text')?.addEventListener('click', async (event) => {
  const signatureText = document.querySelector('#signature-copy').textContent.trim();
  const btn = event.currentTarget;
  try {
    await navigator.clipboard.writeText(signatureText);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = signatureText;
    ta.style.position = 'fixed'; ta.style.left = '-9999px';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  btn.textContent = '已复制 ✓';
  btn.classList.add('copied');
  toast('已复制签名文字');
  setTimeout(() => { btn.textContent = '复制签名文字'; btn.classList.remove('copied'); }, 1500);
});

// 个人改名事件绑定
document.querySelector('#edit-profile-btn').addEventListener('click', async () => {
  const token = localStorage.getItem('device_token');
  if (!token) return;
  const nameEl = document.querySelector('#user-display-name');
  const currentName = nameEl.dataset.name || nameEl.textContent.replace(/^.*? /, '');
  const newName = prompt('请输入您的新显示名称：', currentName);
  if (newName && newName.trim().length > 0) {
    await fetch('/api/v1/profile', {
      method: 'PUT',
      headers: { 
        'content-type': 'application/json',
        'authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ display_name: newName.trim() })
    });
    await loadSignatureConfig();
    await loadBoard();
  }
});

// 飞书登录重定向
document.querySelector('#feishu-login-btn').addEventListener('click', () => {
  const button = document.querySelector('#feishu-login-btn');
  button.disabled = true;
  button.textContent = '正在打开飞书…';
  const deviceId = localStorage.getItem('device_id') || 'default';
  window.location.assign(`/api/v1/auth/feishu/login?device_id=${encodeURIComponent(deviceId)}`);
});

const authResult = new URLSearchParams(window.location.search);
if (authResult.get('feishu_login') === 'success') {
  window.history.replaceState({}, '', '/');
} else if (authResult.has('feishu_error')) {
  const error = authResult.get('feishu_error');
  window.history.replaceState({}, '', '/');
  setTimeout(() => alert(`飞书登录未完成：${error === 'invalid_state' ? '授权链接已过期，请重试' : error}`), 0);
}

// 排行榜时间周期切换
document.querySelectorAll('#board-period-choice .choice').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('#board-period-choice .choice').forEach((item) => item.classList.remove('active'));
    button.classList.add('active');
    currentPeriod = button.dataset.period;
    document.querySelector('#board-period-label').textContent = currentPeriod === 'today' ? '（今日数据）' : '（累计数据）';
    loadBoard();
  });
});

document.querySelector('#refresh-board').addEventListener('click', async () => {
  await loadBoard();
  toast('排行榜已刷新');
});

// 立即刷新数据：spawn 采集器拉最新数据 → 更新排行榜 → 推送飞书签名
document.querySelector('#refresh-now').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = '采集中…';
  toast('正在采集最新数据，请稍候…');
  try {
    const token = localStorage.getItem('device_token');
    let accepted = 0;
    let feishuPushed = false;
    if (token) {
      // 先触发服务端采集（会 spawn collector + 推送飞书）
      const res = await fetch('/api/v1/collect', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
      const result = await res.json().catch(() => ({}));
      accepted = result.accepted || 0;
      feishuPushed = result.feishu_push === 'success';
    }
    // 采集完后稍等两秒再刷新页面数据，给客户端一些上传时间
    await new Promise(resolve => setTimeout(resolve, 2000));
    // loadSignatureConfig 已按当前口径用后端权威 preview 更新签名框，无需再调 renderSignatureForMetric（避免竞态把数据刷回 0）
    await Promise.all([loadBoard(), loadSignatureConfig()]);
    const stamp = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    document.querySelector('#refresh-stamp').textContent = `最后点击触发于 ${stamp}`;
    button.textContent = '已下发';
    toast('已向在线设备下发采集指令，数据将在几秒内更新');
  } catch {
    button.textContent = '刷新失败，请重试';
    toast('采集失败，请检查服务状态');
  }
  setTimeout(() => { button.disabled = false; button.textContent = '立即刷新数据'; }, 3000);
});

checkAuth();
