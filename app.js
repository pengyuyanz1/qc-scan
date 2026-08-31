'use strict';

const STORAGE_KEY = 'qc-scan-records';

const $ = (id) => document.getElementById(id);

const els = {
  reader: $('reader'),
  readerWrap: $('reader-wrap'),
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
  debugBar: $('debug-bar'),
};

let scanning = false;      // 摄像头是否运行中
let mediaStream = null;    // 摄像头视频流
let videoEl = null;        // 取景画面元素
let decodeTimer = null;    // 解码循环定时器
let decoding = false;      // 是否有一帧解码正在进行
let barcodeDetector = null; // 浏览器原生条码检测器（安卓 Chrome 等，优先使用）
let zxingReader = null;    // ZXing MultiFormatReader（iOS 等不支持原生检测器时的后备）
let zxingHints = null;     // ZXing 解码提示（每帧解码时需传入）
const decodeCanvas = document.createElement('canvas');
const decodeCtx = decodeCanvas.getContext('2d', { willReadFrequently: true });
let decodeCount = 0;       // 解码帧计数（用于统计帧率）
let decodeFps = 0;         // 每秒完成的解码帧数
let lastDecodeError = '';  // 最近一次解码异常（显示在调试条上）
let debugTimer = null;     // 调试信息刷新定时器
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

/* ---------- 扫码 ---------- */

function initZxingDecoder() {
  if (zxingReader || typeof ZXing === 'undefined') return !!zxingReader;
  // 使用 ZXing 核心类手动构建解码管线（不依赖 Browser* 浏览器辅助类，
  // 核心类在所有发布版本中都稳定存在）
  if (!(ZXing.MultiFormatReader && ZXing.RGBLuminanceSource &&
        ZXing.BinaryBitmap && ZXing.HybridBinarizer &&
        ZXing.BarcodeFormat && ZXing.DecodeHintType)) {
    console.warn('ZXing 核心类缺失');
    return false;
  }
  try {
    zxingHints = new Map();
    zxingHints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.QR_CODE]);
    zxingHints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    zxingReader = new ZXing.MultiFormatReader();
    zxingReader.setHints(zxingHints);
  } catch (e) {
    console.warn('ZXing 初始化失败：', e);
    zxingReader = null;
  }
  return !!zxingReader;
}

async function openCamera() {
  // 先请求高分辨率后置摄像头（多数设备会自动降级到支持的档位），
  // 失败时逐步退回最简约束，最大化兼容各类浏览器
  const attempts = [
    { audio: false, video: { facingMode: 'environment', width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30 } } },
    { audio: false, video: { facingMode: 'environment' } },
    { audio: false, video: true },
  ];
  let lastErr = null;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function startScan() {
  if (scanning) return;
  try {
    await stopCamera(); // 清理可能残留的旧摄像头资源
    els.reader.innerHTML = '';

    // 初始化解码器：优先浏览器原生 BarcodeDetector（快且准），
    // 其次 ZXing 核心解码器（iOS Safari 等环境不支持原生检测器）
    if (!barcodeDetector && 'BarcodeDetector' in window) {
      try { barcodeDetector = new BarcodeDetector({ formats: ['qr_code'] }); }
      catch (e) { console.warn('BarcodeDetector 初始化失败：', e); barcodeDetector = null; }
    }
    if (!barcodeDetector && !zxingReader) initZxingDecoder();
    if (!barcodeDetector && !zxingReader) {
      toast('扫码组件加载失败，请检查网络，或改用手动输入', 'error');
      return;
    }

    // 创建取景画面与视觉引导框
    videoEl = document.createElement('video');
    videoEl.setAttribute('playsinline', '');
    videoEl.muted = true; // iOS 要求：静音状态才允许自动播放
    videoEl.autoplay = true;
    els.reader.appendChild(videoEl);
    const frame = document.createElement('div');
    frame.className = 'scan-frame';
    els.reader.appendChild(frame);

    els.readerWrap.classList.remove('hidden');
    applyReaderWidth(); // 数码放大偏好（纯视觉缩放，不影响解码）

    mediaStream = await openCamera();
    videoEl.srcObject = mediaStream;
    await videoEl.play();
    if (!videoEl.videoWidth) {
      await new Promise((res) => videoEl.addEventListener('loadedmetadata', res, { once: true }));
    }

    scanning = true;
    autoResume = false;
    updateScanButtons();
    await initZoomSupport();
    await applyZoomOnStart();
    startDecodeLoop();
  } catch (err) {
    await stopCamera();
    els.readerWrap.classList.add('hidden');
    const reason = err && err.message ? err.message : '未知错误';
    toast(`无法启动摄像头（${reason}），可改用手动输入`, 'error');
  }
}

async function stopCamera() {
  stopDecodeLoop();
  if (mediaStream) {
    try {
      mediaStream.getTracks().forEach((t) => t.stop());
    } catch { /* 忽略 */ }
    mediaStream = null;
  }
  videoEl = null;
}

async function stopScan() {
  if (!scanning) return;
  scanning = false;
  await stopCamera();
  els.reader.innerHTML = '';
  els.readerWrap.classList.add('hidden');
  els.zoomPanel.classList.add('hidden');
  updateScanButtons();
}

async function onDecoded(text) {
  if (!scanning) return;
  await stopScan();
  autoResume = true; // 提交后自动继续扫码，无需再点一次
  useCode(String(text).trim());
}

function startDecodeLoop() {
  stopDecodeLoop();
  decodeCount = 0;
  decodeFps = 0;
  lastDecodeError = '';
  els.debugBar.classList.remove('hidden');
  updateDebugBar();
  // 原生检测器性能好，间隔短；ZXing 为纯 JS 解码，间隔放长
  decodeTimer = setInterval(decodeFrame, barcodeDetector ? 160 : 350);
  debugTimer = setInterval(() => {
    decodeFps = decodeCount;
    decodeCount = 0;
    updateDebugBar();
  }, 1000);
}

function stopDecodeLoop() {
  if (decodeTimer) { clearInterval(decodeTimer); decodeTimer = null; }
  if (debugTimer) { clearInterval(debugTimer); debugTimer = null; }
  els.debugBar.classList.add('hidden');
}

function updateDebugBar() {
  const engine = barcodeDetector ? '原生' : (zxingReader ? 'ZXing' : '无');
  const size = videoEl && videoEl.videoWidth
    ? `${videoEl.videoWidth}×${videoEl.videoHeight}`
    : '无画面';
  els.debugBar.textContent = `调试 引擎:${engine} | 画面:${size} | 解码:${decodeFps}帧/秒` +
    (lastDecodeError ? ` | 异常:${lastDecodeError}` : '');
  els.debugBar.classList.toggle('has-error', !!lastDecodeError);
}

async function decodeFrame() {
  if (!scanning || decoding || !videoEl || videoEl.readyState < 2) return;
  decoding = true;
  try {
    const vw = videoEl.videoWidth;
    const vh = videoEl.videoHeight;
    if (!vw || !vh) return;

    let text = null;
    if (barcodeDetector) {
      // 原生检测器直接分析视频当前帧（全画面，微信同款思路）
      try {
        const codes = await barcodeDetector.detect(videoEl);
        if (codes && codes.length > 0 && codes[0].rawValue) {
          text = codes[0].rawValue;
        }
      } catch (e) {
        console.warn('BarcodeDetector 解码异常：', e);
        // "service unavailable"：常见于无谷歌服务的安卓设备（如华为），
        // 检测器构造成功但系统扫码服务不可用，自动切换到 ZXing 备用引擎
        if (/unavailable/i.test(String(e && e.message))) {
          barcodeDetector = null;
          if (initZxingDecoder()) {
            lastDecodeError = '';
            toast('已切换备用解码引擎', 'info');
            startDecodeLoop(); // 按备用引擎的节奏重启解码循环
            return;
          }
        }
        lastDecodeError = `原生解码:${e && e.message ? e.message : e}`;
      }
    } else if (zxingReader) {
      try {
        // 手动构建解码管线：视频帧 → RGBA 像素 → 灰度 → 二值化 → 解码
        const maxW = 1280;
        const scale = Math.min(1, maxW / vw);
        decodeCanvas.width = Math.round(vw * scale);
        decodeCanvas.height = Math.round(vh * scale);
        decodeCtx.drawImage(videoEl, 0, 0, decodeCanvas.width, decodeCanvas.height);
        const imageData = decodeCtx.getImageData(0, 0, decodeCanvas.width, decodeCanvas.height);
        const pixels = new Int32Array(imageData.data.buffer);
        const source = new ZXing.RGBLuminanceSource(pixels, decodeCanvas.width, decodeCanvas.height);
        const bitmap = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(source));
        zxingReader.reset();
        const result = zxingReader.decode(bitmap, zxingHints);
        if (result) text = result.getText();
      } catch (e) {
        const isNotFound = (ZXing.NotFoundException && e instanceof ZXing.NotFoundException) ||
                           (e && e.name === 'NotFoundException');
        if (!isNotFound) {
          lastDecodeError = `ZXing:${e && e.message ? e.message : e}`;
          console.warn('ZXing 解码异常：', e);
        }
      }
    }

    decodeCount++;
    if (text) await onDecoded(text);
  } catch { /* 单帧解码异常忽略 */ }
  finally { decoding = false; }
}

function updateScanButtons() {
  els.btnStart.classList.toggle('hidden', scanning);
  els.btnStop.classList.toggle('hidden', !scanning);
}

/* ---------- 放大功能（小二维码增强） ---------- */

async function initZoomSupport() {
  zoomMode = null;
  zoomCaps = null;
  const track = mediaStream ? mediaStream.getVideoTracks()[0] : null;

  if (track && typeof track.getCapabilities === 'function') {
    try {
      const caps = track.getCapabilities();
      if (caps && caps.zoom && caps.zoom.max > caps.zoom.min) {
        zoomCaps = caps.zoom;
        zoomMode = 'native';
      }
    } catch { /* 忽略 */ }
  }
  if (!zoomMode) zoomMode = 'css';

  // 按视频流实际宽高比固定取景框高度，放大时画面居中裁剪
  if (videoEl && videoEl.videoWidth && videoEl.videoHeight) {
    els.readerWrap.style.aspectRatio = `${videoEl.videoWidth} / ${videoEl.videoHeight}`;
  }

  els.zoomModeTip.textContent = zoomMode === 'native' ? '摄像头变焦' : '数码放大';
  els.zoomPanel.classList.remove('hidden');
  updateZoomButtonsUI();

  // 尝试开启连续自动对焦：近拍小码更清晰，不支持则静默忽略
  if (track && typeof track.applyConstraints === 'function') {
    try {
      await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
    } catch { /* 忽略 */ }
  }
}

async function applyZoomOnStart() {
  if (zoomValue <= 1 || zoomMode !== 'native') return;
  await applyNativeZoom(zoomValue);
}

function applyReaderWidth() {
  // 数码放大：把取景容器宽度撑大，超出部分被居中裁剪。
  // 纯视觉缩放，解码始终基于完整原始画面，不受此影响
  const factor = zoomMode === 'css' && zoomValue > 1 ? zoomValue : 1;
  els.reader.style.width = factor > 1
    ? `${Math.round(els.readerWrap.clientWidth * factor)}px`
    : '';
}

async function applyNativeZoom(value) {
  const track = mediaStream ? mediaStream.getVideoTracks()[0] : null;
  if (!track) return null;
  const v = Math.min(Math.max(value, zoomCaps.min), zoomCaps.max);
  try {
    // 注意：变焦请求会整体替换摄像头约束，必须把连续自动对焦一并带上，
    // 否则变焦后对焦失效，画面模糊、对不上焦
    await track.applyConstraints({
      advanced: [{ zoom: v }, { focusMode: 'continuous' }],
    });
    return v;
  } catch {
    return null;
  }
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
    // 数码放大为纯视觉缩放：解码始终基于完整原始画面，切换即时生效，无需重启
    applyReaderWidth();
    if (value > 1) {
      toast(`已放大 ${value}×：保持 10~20 厘米距离，模糊时降低倍数`, 'info');
    }
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
