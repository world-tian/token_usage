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
        loadSignatureConfig();
        loadBoard();
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

function updateSignaturePreview(row, metric) {
  const el = document.querySelector('#signature-copy');
  if (!row) {
    el.textContent = metric === 'today' ? '今日暂无大模型用量 🌊 待自动采集' : '暂无大模型用量 🌊 待自动采集';
    return;
  }
  const usage = metric === 'today' ? `今日消耗token ${compact(row.total_tokens)}` : `累计token消耗 ${compact(row.total_tokens)}`;
  const timePart = row.last_sync_at ? `｜${formatTime(row.last_sync_at)}` : '';
  el.textContent = `${row.animal.emoji} ${row.animal.name} Lv.${row.animal.level}｜${usage}｜≈${money(row.cost_cny)}${timePart}`;
}

// 按口径(today/total)拉取对应数据并渲染签名预览，便于切换/复制不同口径的签名
async function renderSignatureForMetric(metric) {
  const deviceId = localStorage.getItem('device_id');
  const period = metric === 'today' ? 'today' : 'total';
  try {
    const res = await fetch(`/api/v1/leaderboard?period=${period}`);
    const { data } = await res.json();
    const row = (deviceId ? data.find((r) => r.device_id === deviceId) : data[0]) || null;
    updateSignaturePreview(row, metric);
  } catch {
    updateSignaturePreview(null, metric);
  }
}

async function loadSignatureConfig() {
  const token = localStorage.getItem('device_token');
  const deviceId = localStorage.getItem('device_id');
  const headers = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  
  const response = await fetch('/api/v1/signature/config', { headers });
  if (response.status === 401) {
    localStorage.removeItem('device_token');
    localStorage.removeItem('device_id');
    await loadSignatureConfig();
    return;
  }
  
  const config = await response.json();
  
  // 更新定时采集 Checkbox 状态
  document.querySelector('#auto-collect').checked = !!config.auto_collect_enabled;
  
  // 填入飞书签名 URL（专属链接）
  if (deviceId) {
    document.querySelector('#signature-url').value = config.signature_url || `${window.location.origin}/signature?device_id=${deviceId}`;
  } else {
    document.querySelector('#signature-url').value = '配对成功后在此生成专属 URL';
  }
  
  // 更新顶部用户状态：飞书头像是图片 URL → 渲染成圆形头像；否则当 emoji 文本
  const profile = config.profile || { display_name: '本机用户', avatar: '👤' };
  const nameEl = document.querySelector('#user-display-name');
  const avatar = profile.avatar || '👤';
  nameEl.dataset.name = profile.display_name;
  if (typeof avatar === 'string' && avatar.startsWith('http')) {
    nameEl.innerHTML = `<img src="${escapeHtml(avatar)}" alt="" style="width:20px;height:20px;border-radius:50%;vertical-align:middle;margin-right:6px;object-fit:cover;">${escapeHtml(profile.display_name)}`;
  } else {
    nameEl.textContent = `${avatar} ${profile.display_name}`;
  }
  
  const feishuBtn = document.querySelector('#feishu-login-btn');
  if (config.feishu_status === 'connected') {
    feishuBtn.style.display = 'none';
  } else {
    feishuBtn.style.display = 'inline-block';
  }
  
  document.querySelectorAll('#metric-choice .choice').forEach((item) => item.classList.toggle('active', item.dataset.value === config.metric));
  document.querySelector('#interval').value = String(config.interval_minutes);
  document.querySelector('#last-collect').textContent = formatTime(config.last_collect_at);
  document.querySelector('#next-collect').textContent = config.auto_collect_enabled && config.next_collect_at ? formatTime(config.next_collect_at) : '未安排';
  
  // 针对配对状态对界面进行友好引导限制
  const saveBtn = document.querySelector('#save-signature');
  const editProfileBtn = document.querySelector('#edit-profile-btn');
  
  if (!token) {
    document.querySelector('#scheduler-state').textContent = '未配对';
    document.querySelector('#feishu-state').textContent = '未配对';
    saveBtn.disabled = true;
    saveBtn.textContent = '请先配对设备';
    editProfileBtn.style.display = 'none';
  } else {
    saveBtn.disabled = false;
    saveBtn.textContent = '保存显示偏好';
    editProfileBtn.style.display = 'inline-block';
    
    // 更新状态文字
    document.querySelector('#scheduler-state').textContent = config.auto_collect_enabled ? '已启用' : '未启用';
    document.querySelector('#feishu-state').textContent = config.feishu_status === 'connected' ? '已连接' : '待接入 OAuth';
  }
  
  const statusEl = document.querySelector('#signature-status');
  if (token && config.auto_collect_enabled) {
    statusEl.textContent = '已启用定时采集';
    statusEl.className = 'status-success';
  } else {
    statusEl.textContent = '尚未启用定时采集';
    statusEl.className = 'status-warn';
  }
  
  updateSignaturePreview(config.preview, config.metric);
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

// 复制飞书签名 URL 事件
document.querySelector('#copy-signature-url').addEventListener('click', async (event) => {
  const urlInput = document.querySelector('#signature-url');
  await navigator.clipboard.writeText(urlInput.value);
  const btn = event.currentTarget;
  btn.textContent = '已复制';
  btn.classList.add('copied');
  toast('已复制签名 URL');
  setTimeout(() => {
    btn.textContent = '复制 URL';
    btn.classList.remove('copied');
  }, 1500);
});

// 飞书签名编辑器需要带显示文本的富文本链接，裸 URL 只会显示域名。
document.querySelector('#copy-signature-rich').addEventListener('click', async (event) => {
  const label = document.querySelector('#signature-copy').textContent.trim();
  const url = document.querySelector('#signature-url').value.trim();
  if (!url.startsWith('http')) return alert('请先完成设备配对，生成专属签名 URL。');

  const safeUrl = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const safeLabel = label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = `<a href="${safeUrl}">${safeLabel}</a>`;
  try {
    if (window.ClipboardItem && navigator.clipboard.write) {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([label], { type: 'text/plain' })
      })]);
    } else {
      const holder = document.createElement('div');
      holder.contentEditable = 'true';
      holder.innerHTML = html;
      holder.style.position = 'fixed';
      holder.style.left = '-9999px';
      document.body.appendChild(holder);
      const range = document.createRange();
      range.selectNodeContents(holder);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('copy');
      holder.remove();
      selection.removeAllRanges();
    }
    const button = event.currentTarget;
    button.textContent = '已复制，去飞书粘贴';
    toast('已复制飞书签名，去个性签名框粘贴');
    setTimeout(() => { button.textContent = '复制飞书签名'; }, 2200);
  } catch {
    alert('富文本复制失败，请使用 Chrome/Edge/Safari 并允许剪贴板权限。');
  }
});

document.querySelector('#refresh-feishu-signature').addEventListener('click', async (event) => {
  const token = localStorage.getItem('device_token');
  if (!token) return alert('请先完成设备配对。');
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = '正在通知飞书…';
  try {
    const response = await fetch('/api/v1/feishu/preview/refresh', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    const result = await response.json();
    if (result.status === 'success') { button.textContent = `已刷新 ${result.count} 个签名`; toast(`已通知飞书刷新 ${result.count} 个签名`); }
    else if (result.status === 'waiting_for_preview_token') { button.textContent = '请先粘贴一次飞书签名'; toast('请先在飞书粘贴一次签名链接'); }
    else if (result.status === 'waiting_for_app_credentials') { button.textContent = '飞书应用未配置'; toast('飞书应用未配置'); }
    else { button.textContent = '刷新失败，请查看服务日志'; toast('刷新失败，请查看服务日志'); }
  } catch {
    button.textContent = '刷新失败';
    toast('刷新失败');
  }
  setTimeout(() => { button.disabled = false; button.textContent = '立即刷新飞书签名'; }, 2500);
});

// 复制飞书签名纯文本事件
document.querySelector('#copy-signature-text').addEventListener('click', async (event) => {
  const signatureText = document.querySelector('#signature-copy').textContent;
  await navigator.clipboard.writeText(signatureText);
  const btn = event.currentTarget;
  const oldText = btn.textContent;
  btn.textContent = '已复制文本';
  btn.classList.add('copied');
  toast('已复制纯文本签名');
  setTimeout(() => {
    btn.textContent = oldText;
    btn.classList.remove('copied');
  }, 1500);
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
  const activeMetric = document.querySelector('#metric-choice .choice.active')?.dataset.value || 'today';
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
    // 采集完后刷新页面数据
    await Promise.all([loadBoard(), loadSignatureConfig(), renderSignatureForMetric(activeMetric)]);
    const stamp = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    document.querySelector('#refresh-stamp').textContent = `数据刷新于 ${stamp}`;
    button.textContent = '已刷新';
    if (feishuPushed) {
      toast(`采集完成，新增 ${accepted} 条，飞书签名已推送`);
    } else if (accepted > 0) {
      toast(`采集完成，新增 ${accepted} 条，签名下次访问自动更新`);
    } else {
      toast('已是最新数据，飞书签名实时生效');
    }
  } catch {
    button.textContent = '刷新失败，请重试';
    toast('采集失败，请检查服务状态');
  }
  setTimeout(() => { button.disabled = false; button.textContent = '立即刷新数据'; }, 3000);
});

loadBoard();
loadSignatureConfig();
