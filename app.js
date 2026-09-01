'use strict';

const STORAGE_KEY = 'qc-scan-records';

const $ = (id) => document.getElementById(id);

const els = {
  reader: $('reader'),
  readerWrap: $('reader-wrap'),
  scanStatus: $('scan-status'),
  zoomPanel: $('zoom-panel'),
  zoomModeTip: $('zoom-mode-tip'),
  btnStart: $('btn-start'),
  btnStop: $('btn-stop'),
  toggleManual: $('toggle-manual'),
  manualForm: $('manual-form'),
  manualInput: $('manual-input'),
  emptyTip: $('empty-tip'),
  resultBody: $('result-body'),
  resultCard: $('result-card'),
  codeText: $('code-text'),
  overrideTip: $('override-tip'),
  btnPass: $('btn-pass'),
  btnFail: $('btn-fail'),
  btnSubmit: $('btn-submit'),
  stats: $('stats'),
  tbody: $('record-tbody'),
  btnExport: $('btn-export'),
  btnClear: $('btn-clear'),
  toast: $('toast'),
  storageWarning: $('storage-warning'),
  browserTip: $('browser-tip'),
  csvModal: $('csv-modal'),
  csvText: $('csv-text'),
  csvModalTip: $('csv-modal-tip'),
  btnCopyCsv: $('btn-copy-csv'),
  btnCloseCsv: $('btn-close-csv'),
  btnCopyData: $('btn-copy-data'),
};

let scanning = false;      // 摄像头是否运行中
let currentCode = null;    // 当前待提交的产品编号
let selectedResult = null; // '合格' | '不合格'
let autoResume = false;    // 提交后是否自动继续扫码
let toastTimer = null;
let zoomMode = null;       // 'native'=摄像头原生变焦 | 'css'=数码放大 | null=未检测
let zoomValue = 1;         // 当前放大倍率（作为偏好保留，扫码重启后自动恢复）
let zoomCaps = null;       // 原生变焦能力范围 { min, max, step }

/* ---------- 数据存取 ---------- */

function loadRecords() {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function saveRecords(records) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
    return true;
  } catch {
    // 存储失败（通常是空间已满）：显示醒目常驻警告，并保留当前表单以便清理后重试
    els.storageWarning.textContent =
      '警告：记录保存失败，本地存储已满或不可用！请立即导出 Excel，导出后清空记录，再重新提交本条记录。';
    els.storageWarning.classList.remove('hidden');
    toast('保存失败：存储空间已满，请先导出并清空', 'error');
    return false;
  }
}

/* 浏览器一般为 localStorage 提供约 5MB 空间 */
const STORAGE_QUOTA = 5 * 1024 * 1024;

function updateStorageWarning() {
  let used = 0;
  try {
    used = (localStorage.getItem(STORAGE_KEY) || '').length;
  } catch { return; }
  const ratio = used / STORAGE_QUOTA;
  if (ratio >= 0.8) {
    els.storageWarning.textContent =
      `注意：本地存储已用约 ${Math.round(ratio * 100)}%（约 ${Math.round(used / 1024)}KB），存满后新记录将无法保存。请尽快导出 Excel，并在导出后清空记录。`;
    els.storageWarning.classList.remove('hidden');
  } else {
    els.storageWarning.classList.add('hidden');
  }
}

/* ---------- 工具 ---------- */

function pad(n) { return String(n).padStart(2, '0'); }

function formatTime(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function toast(msg, type = 'info') {
  els.toast.textContent = msg;
  els.toast.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2200);
}

/* ---------- 微信环境检测与导出兜底 ---------- */

const UA = navigator.userAgent || '';

function isWeChatEnv() {
  // 微信与企业微信的 UA 均包含 MicroMessenger
  return /MicroMessenger/i.test(UA);
}

function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function recordsToCsv(records) {
  const rows = [['产品编号', '质检结果', '首次扫码时间', '最近提交时间']];
  for (const r of records) {
    rows.push([r.code, r.result, r.scanTime, r.updateTime]);
  }
  // 前置 BOM，保证用 Excel 打开 csv 时中文不乱码
  return '\uFEFF' + rows.map((row) => row.map(csvEscape).join(',')).join('\r\n');
}

function copyCsvText() {
  const text = els.csvText.value;
  const fallback = () => {
    els.csvText.focus();
    els.csvText.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    toast(ok ? '已复制，请粘贴发送到电脑' : '请长按文字全选后手动复制', ok ? 'success' : 'error');
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text)
      .then(() => toast('已复制，请粘贴发送到电脑', 'success'))
      .catch(fallback);
  } else {
    fallback();
  }
}

function openCopyModal() {
  const records = loadRecords();
  if (!records.length) {
    toast('暂无记录可复制', 'error');
    return;
  }
  els.csvText.value = recordsToCsv(records);
  els.csvModalTip.textContent = isWeChatEnv()
    ? '微信内能否下载文件视设备而定（苹果手机一般可正常下载）。若「导出 Excel」没有反应，可使用此复制方式：复制后粘贴发送到电脑（如文件传输助手），保存为 .csv 文件即可用 Excel 打开。'
    : '复制后可粘贴到电脑或其他设备：粘贴到记事本另存为 .csv 文件可用 Excel 打开，也可直接粘贴到 Excel 表格中使用。';
  els.csvModal.classList.remove('hidden');
}

/* ---------- 扫码（BarcodeDetector + jsQR 双引擎） ---------- */

/* 解码引擎参数 */
const DECODE_INTERVAL = 66;  // 快速扫描节流（约 15 次/秒）
const FAST_MAX_EDGE = 800;   // 快速扫描画布长边：降采样后先快速定位解码
const SLOW_MAX_EDGE = 1600;  // 精扫画布长边：小码/远码增强
const SLOW_EVERY = 4;        // 每 N 次快速扫描穿插一次精扫
const SCAN_TIP_INTERVAL = 6000; // 识别失败时切换提示的间隔
const SCAN_TIPS = [
  '未识别到二维码：请靠近一些',
  '可点按下方「放大」辅助识别小二维码',
  '请检查二维码是否清晰、无反光遮挡',
];

/* 解码用离屏画布 */
const fastCanvas = document.createElement('canvas');
const fastCtx = fastCanvas.getContext('2d', { willReadFrequently: true });
const slowCanvas = document.createElement('canvas');
const slowCtx = slowCanvas.getContext('2d', { willReadFrequently: true });
const tinyCanvas = document.createElement('canvas');
tinyCanvas.width = 32;
tinyCanvas.height = 32;
const tinyCtx = tinyCanvas.getContext('2d', { willReadFrequently: true });

/* 扫码运行时状态 */
let videoEl = null;         // <video> 元素
let cameraStream = null;    // 摄像头媒体流
let rafId = 0;              // 解码循环句柄
let decoding = false;       // 是否正在解码（防止重入）
let frameCount = 0;         // 解码帧计数（用于精扫节流）
let lastDecodeAt = 0;       // 上次解码时间戳
let scanStartAt = 0;        // 本次扫码开始时间
let barcodeDetector = null; // 原生 BarcodeDetector 引擎（不可用时回退 jsQR）
let brightTimer = 0;        // 亮度检测定时器
let isDark = false;         // 画面是否偏暗
let lastTipAt = 0;          // 上次切换提示的时间
let tipIdx = 0;             // 提示轮换索引

function setStatus(text, type = '') {
  els.scanStatus.textContent = text;
  els.scanStatus.className = `scan-status${type ? ` ${type}` : ''}`;
  els.scanStatus.classList.remove('hidden');
}

function getVideoTrack() {
  return cameraStream ? cameraStream.getVideoTracks()[0] : null;
}

async function startScan() {
  if (scanning) return;
  if (typeof jsQR !== 'function' && !('BarcodeDetector' in window)) {
    toast('扫码组件加载失败，请检查网络，或改用手动输入', 'error');
    return;
  }
  els.readerWrap.classList.remove('hidden');
  els.reader.innerHTML = '';
  setStatus('正在启动摄像头…');
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: 'environment',
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        // 直接在初始约束中请求连续自动对焦：远近切换时自动合焦，小码更清晰
        advanced: [{ focusMode: 'continuous' }],
      },
    });
  } catch (err) {
    cameraStream = null;
    els.readerWrap.classList.add('hidden');
    els.scanStatus.classList.add('hidden');
    const reason = err && err.message ? err.message : '未知错误';
    toast(`无法启动摄像头（${reason}），可改用手动输入`, 'error');
    return;
  }

  videoEl = document.createElement('video');
  videoEl.setAttribute('playsinline', '');
  videoEl.setAttribute('webkit-playsinline', '');
  videoEl.playsInline = true;
  videoEl.muted = true;
  videoEl.autoplay = true;
  videoEl.srcObject = cameraStream;
  els.reader.appendChild(videoEl);
  try { await videoEl.play(); } catch { /* 部分浏览器自动播放限制，静默处理 */ }

  // 按视频流实际宽高比固定取景容器比例，避免画面变形
  if (videoEl.videoWidth && videoEl.videoHeight) {
    els.readerWrap.style.aspectRatio = `${videoEl.videoWidth} / ${videoEl.videoHeight}`;
  }

  // 首选浏览器原生 BarcodeDetector（硬件加速、速度快）；
  // 构造或调用失败（部分微信内核）时自动回退 jsQR
  barcodeDetector = null;
  if ('BarcodeDetector' in window) {
    try { barcodeDetector = new window.BarcodeDetector({ formats: ['qr_code'] }); }
    catch { barcodeDetector = null; }
  }

  scanning = true;
  autoResume = false;
  frameCount = 0;
  lastDecodeAt = 0;
  decoding = false;
  scanStartAt = performance.now();
  lastTipAt = 0;
  tipIdx = 0;
  isDark = false;
  updateScanButtons();
  initZoomSupport();
  applyZoomOnStart();
  applyCssZoomPreview();
  setStatus('请将二维码置于取景框内');

  rafId = requestAnimationFrame(decodeLoop);
  brightTimer = setInterval(checkBrightness, 900);
}

async function stopScan() {
  if (!scanning) return;
  scanning = false;
  cancelAnimationFrame(rafId);
  clearInterval(brightTimer);
  try { if (cameraStream) cameraStream.getTracks().forEach((t) => t.stop()); } catch { /* 忽略 */ }
  if (videoEl) {
    try { videoEl.srcObject = null; } catch { /* 忽略 */ }
    videoEl.remove();
  }
  videoEl = null;
  cameraStream = null;
  barcodeDetector = null;
  els.readerWrap.classList.add('hidden');
  els.zoomPanel.classList.add('hidden');
  els.scanStatus.classList.add('hidden');
  updateScanButtons();
}

async function onScanSuccess(decodedText) {
  if (!scanning) return;
  // 识别成功震动反馈（支持的设备）
  if (navigator.vibrate) { try { navigator.vibrate(60); } catch { /* 忽略 */ } }
  await stopScan();
  autoResume = true; // 提交后自动继续扫码，无需再点一次
  useCode(String(decodedText).trim());
}

function updateScanButtons() {
  els.btnStart.classList.toggle('hidden', scanning);
  els.btnStop.classList.toggle('hidden', !scanning);
}

/* ---------- 解码循环：全画面识别，两段式解码 ---------- */

function decodeLoop(ts) {
  if (!scanning) return;
  rafId = requestAnimationFrame(decodeLoop);
  if (!videoEl || videoEl.readyState < 2 || decoding) return;
  if (ts - lastDecodeAt < DECODE_INTERVAL) return;
  lastDecodeAt = ts;
  decoding = true;
  decodeFrame()
    .then((text) => { if (text && scanning) onScanSuccess(text); })
    .catch(() => { /* 单帧解码失败不影响后续 */ })
    .finally(() => { decoding = false; });
}

// 数码放大时：解码只取中心 1/倍率 区域（原始分辨率），等效放大二维码
function getZoomCrop() {
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (zoomMode === 'css' && zoomValue > 1 && vw && vh) {
    const sw = vw / zoomValue;
    const sh = vh / zoomValue;
    return { sx: (vw - sw) / 2, sy: (vh - sh) / 2, sw, sh };
  }
  return { sx: 0, sy: 0, sw: vw, sh: vh };
}

function drawCrop(canvas, ctx, crop, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(crop.sw, crop.sh));
  const w = Math.max(1, Math.round(crop.sw * scale));
  const h = Math.max(1, Math.round(crop.sh * scale));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.drawImage(videoEl, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, w, h);
}

async function decodeFrame() {
  const crop = getZoomCrop();
  drawCrop(fastCanvas, fastCtx, crop, FAST_MAX_EDGE);
  frameCount++;

  // 第一优先：原生 BarcodeDetector（自带定位与解码，速度最快）
  if (barcodeDetector) {
    try {
      const codes = await barcodeDetector.detect(fastCanvas);
      if (codes && codes.length && codes[0].rawValue) return codes[0].rawValue;
    } catch {
      barcodeDetector = null; // 引擎不可用（部分微信内核），后续帧走 jsQR
    }
  }

  if (typeof jsQR !== 'function') return null;

  // 快速扫描：降采样帧直接解码（不做反色尝试，速度优先）
  const fast = jsQRFromCanvas(fastCanvas, fastCtx, 'dontInvert');
  if (fast) return fast;

  // 周期性精扫：更高分辨率 + 尝试反色，专攻小码/远码/浅色码
  if (frameCount % SLOW_EVERY === 0) {
    drawCrop(slowCanvas, slowCtx, crop, SLOW_MAX_EDGE);
    const slow = jsQRFromCanvas(slowCanvas, slowCtx, 'attemptBoth');
    if (slow) return slow;
  }
  return null;
}

function jsQRFromCanvas(canvas, ctx, inversion) {
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const res = jsQR(img.data, img.width, img.height, { inversionAttempts: inversion });
  return res && res.data ? res.data : null;
}

/* ---------- 扫码实时反馈 ---------- */

function checkBrightness() {
  if (!scanning || !videoEl || videoEl.readyState < 2) return;
  try {
    tinyCtx.drawImage(videoEl, 0, 0, 32, 32);
    const d = tinyCtx.getImageData(0, 0, 32, 32).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) {
      sum += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    }
    isDark = sum / (d.length / 4) < 55;
  } catch { /* 忽略 */ }
  refreshScanStatus();
}

function refreshScanStatus() {
  if (!scanning) return;
  const now = performance.now();
  if (isDark) {
    setStatus('光线偏暗，请增加光照或调整角度', 'warn');
    return;
  }
  if (now - scanStartAt > SCAN_TIP_INTERVAL && now - lastTipAt > SCAN_TIP_INTERVAL) {
    lastTipAt = now;
    setStatus(SCAN_TIPS[tipIdx++ % SCAN_TIPS.length], 'warn');
    return;
  }
  if (now - lastTipAt > SCAN_TIP_INTERVAL) setStatus('请将二维码置于取景框内');
}

/* ---------- 放大功能（小二维码增强） ---------- */

function initZoomSupport() {
  zoomMode = null;
  zoomCaps = null;
  const track = getVideoTrack();
  if (track && typeof track.getCapabilities === 'function') {
    try {
      const caps = track.getCapabilities();
      if (caps && caps.zoom && caps.zoom.max > caps.zoom.min) {
        zoomCaps = caps.zoom;
        zoomMode = 'native';
      }
    } catch { /* 不支持则走数码放大 */ }
  }
  if (!zoomMode) zoomMode = 'css';

  els.zoomModeTip.textContent = zoomMode === 'native' ? '摄像头变焦' : '数码放大';
  els.zoomPanel.classList.remove('hidden');
  updateZoomButtonsUI();
}

async function applyZoomOnStart() {
  if (zoomValue <= 1 || zoomMode !== 'native') return;
  await applyNativeZoom(zoomValue);
}

async function applyNativeZoom(value) {
  const track = getVideoTrack();
  if (!track || !zoomCaps) return null;
  const v = Math.min(Math.max(value, zoomCaps.min), zoomCaps.max);
  try {
    await track.applyConstraints({ advanced: [{ zoom: v }] });
    return v;
  } catch {
    return null;
  }
}

// 数码放大：视频预览整体放大；解码改为只裁剪中心 1/倍率 区域（原始分辨率），
// 无需重启摄像头即可生效
function applyCssZoomPreview() {
  if (!videoEl) return;
  const f = zoomMode === 'css' && zoomValue > 1 ? zoomValue : 1;
  videoEl.style.transform = f > 1 ? `scale(${f})` : '';
}

async function setZoom(value) {
  if (value === zoomValue) return;
  zoomValue = value;
  updateZoomButtonsUI();
  if (!scanning) return; // 未在扫码时仅记住偏好，下次启动时生效
  if (zoomMode === 'native') {
    const applied = await applyNativeZoom(value);
    if (applied == null) {
      toast('变焦失败，该设备可能不支持', 'error');
    } else if (applied !== value) {
      toast(`该摄像头最大支持 ${applied}×`);
    }
  } else {
    applyCssZoomPreview();
  }
}

function updateZoomButtonsUI() {
  document.querySelectorAll('#zoom-btns .zoom-btn').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.zoom) === zoomValue);
  });
}

/* ---------- 判定与提交 ---------- */

function useCode(code) {
  if (!code) return;
  currentCode = code;
  selectedResult = null;
  els.codeText.textContent = code;
  els.emptyTip.classList.add('hidden');
  els.resultBody.classList.remove('hidden');
  els.btnPass.classList.remove('active');
  els.btnFail.classList.remove('active');
  els.btnSubmit.disabled = true;

  const exists = loadRecords().some((r) => r.code === code);
  if (exists) {
    els.overrideTip.textContent = '该产品编号已有质检记录，本次提交将覆盖之前的记录。';
    els.overrideTip.classList.remove('hidden');
  } else {
    els.overrideTip.classList.add('hidden');
  }
  els.resultCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function selectResult(result) {
  selectedResult = result;
  els.btnPass.classList.toggle('active', result === '合格');
  els.btnFail.classList.toggle('active', result === '不合格');
  els.btnSubmit.disabled = false;
}

function submit() {
  if (!currentCode || !selectedResult) return;
  const now = formatTime(new Date());
  const records = loadRecords();
  const idx = records.findIndex((r) => r.code === currentCode);

  if (idx >= 0) {
    // 覆盖旧记录：保留首次扫码时间，更新结果与时间，并移到列表最前
    const updated = {
      code: currentCode,
      result: selectedResult,
      scanTime: records[idx].scanTime,
      updateTime: now,
    };
    records.splice(idx, 1);
    records.unshift(updated);
    if (!saveRecords(records)) return; // 保存失败时保留表单，清理后可重新提交
    renderHistory();
    toast('已覆盖之前的记录', 'success');
  } else {
    records.unshift({ code: currentCode, result: selectedResult, scanTime: now, updateTime: now });
    if (!saveRecords(records)) return;
    renderHistory();
    toast('已保存', 'success');
  }

  resetResultForm();
  if (autoResume) {
    autoResume = false;
    // 稍作延迟，给摄像头留出释放与重启的时间，避免重启后黑屏
    setTimeout(startScan, 300);
  }
}

function resetResultForm() {
  currentCode = null;
  selectedResult = null;
  els.resultBody.classList.add('hidden');
  els.emptyTip.classList.remove('hidden');
  els.overrideTip.classList.add('hidden');
}

/* ---------- 记录列表 ---------- */

function renderHistory() {
  const records = loadRecords();
  const total = records.length;
  const passCount = records.filter((r) => r.result === '合格').length;

  els.stats.innerHTML = '';
  if (total) {
    let used = '';
    try {
      const kb = Math.round((localStorage.getItem(STORAGE_KEY) || '').length / 1024);
      if (kb > 0) used = ` · 存储 ${kb}KB`;
    } catch { /* 忽略 */ }
    els.stats.innerHTML =
      `共 <b>${total}</b> 条 · 合格 <b class="c-pass">${passCount}</b> · 不合格 <b class="c-fail">${total - passCount}</b>${used}`;
  }
  updateStorageWarning();

  els.tbody.innerHTML = '';
  if (!total) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.className = 'td-empty';
    td.textContent = '暂无记录';
    tr.appendChild(td);
    els.tbody.appendChild(tr);
    return;
  }

  for (const r of records) {
    const tr = document.createElement('tr');

    const tdCode = document.createElement('td');
    tdCode.className = 'code';
    tdCode.textContent = r.code;
    tr.appendChild(tdCode);

    const tdResult = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `badge ${r.result === '合格' ? 'pass' : 'fail'}`;
    badge.textContent = r.result;
    tdResult.appendChild(badge);
    tr.appendChild(tdResult);

    const tdTime = document.createElement('td');
    tdTime.textContent = r.updateTime;
    if (r.updateTime !== r.scanTime) tdTime.title = `首次扫码：${r.scanTime}`;
    tr.appendChild(tdTime);

    const tdOp = document.createElement('td');
    const del = document.createElement('button');
    del.className = 'del-btn';
    del.type = 'button';
    del.textContent = '×';
    del.title = '删除该条记录';
    del.addEventListener('click', () => deleteRecord(r.code));
    tdOp.appendChild(del);
    tr.appendChild(tdOp);

    els.tbody.appendChild(tr);
  }
}

function deleteRecord(code) {
  if (!window.confirm(`确定删除产品编号「${code}」的记录吗？`)) return;
  saveRecords(loadRecords().filter((r) => r.code !== code));
  renderHistory();
  toast('已删除该条记录');
}

function clearAll() {
  if (!loadRecords().length) {
    toast('暂无记录');
    return;
  }
  if (!window.confirm('确定清空全部质检记录吗？此操作不可恢复，建议先导出 Excel。')) return;
  localStorage.removeItem(STORAGE_KEY);
  renderHistory();
  toast('已清空全部记录');
}

/* ---------- 导出 Excel ---------- */

function exportExcel() {
  const records = loadRecords();
  if (!records.length) {
    toast('暂无记录可导出', 'error');
    return;
  }
  if (typeof XLSX === 'undefined') {
    toast('Excel 组件加载失败，请检查网络后重试', 'error');
    return;
  }
  const data = records.map((r) => ({
    '产品编号': r.code,
    '质检结果': r.result,
    '首次扫码时间': r.scanTime,
    '最近提交时间': r.updateTime,
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = [{ wch: 34 }, { wch: 10 }, { wch: 20 }, { wch: 20 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '质检记录');
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_` +
                `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  XLSX.writeFile(wb, `质检记录_${stamp}.xlsx`);
  // 微信内下载是否成功视设备而定（苹果通常可以），失败时引导用「复制数据」
  toast(isWeChatEnv() ? '已尝试下载 Excel；若未成功，请点「复制数据」' : 'Excel 已导出', 'success');
}

/* ---------- 手动输入 ---------- */

els.toggleManual.addEventListener('click', () => {
  const willShow = els.manualForm.classList.contains('hidden');
  els.manualForm.classList.toggle('hidden', !willShow);
  els.toggleManual.textContent = willShow ? '收起输入' : '手动输入';
  if (willShow) els.manualInput.focus();
});

els.manualForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const value = els.manualInput.value.trim();
  if (!value) {
    toast('请输入产品编号', 'error');
    return;
  }
  els.manualInput.value = '';
  autoResume = false;
  if (scanning) stopScan();
  useCode(value);
});

/* ---------- 事件绑定与初始化 ---------- */

els.btnStart.addEventListener('click', startScan);
document.querySelectorAll('#zoom-btns .zoom-btn').forEach((btn) => {
  btn.addEventListener('click', () => setZoom(Number(btn.dataset.zoom)));
});
els.btnStop.addEventListener('click', () => {
  autoResume = false;
  stopScan();
});
els.btnPass.addEventListener('click', () => selectResult('合格'));
els.btnFail.addEventListener('click', () => selectResult('不合格'));
els.btnSubmit.addEventListener('click', submit);
els.btnExport.addEventListener('click', exportExcel);
els.btnClear.addEventListener('click', clearAll);
els.btnCopyCsv.addEventListener('click', copyCsvText);
els.btnCloseCsv.addEventListener('click', () => els.csvModal.classList.add('hidden'));
els.btnCopyData.addEventListener('click', openCopyModal);

// 微信/企业微信环境提示：建议用浏览器打开以获得完整功能
if (isWeChatEnv()) {
  els.browserTip.classList.remove('hidden');
}

renderHistory();
