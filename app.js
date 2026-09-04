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
let zoomPref = 1;          // 用户手动选择的放大偏好（跨扫码记忆）
let zoomValue = 1;         // 当前生效倍率（含自动放大）
let zoomUserSet = false;   // 本次扫码中用户是否手动设置过放大
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

/* ---------- 扫码（仅 DataMatrix，Worker 后台解码） ---------- */

/* 解码引擎参数 */
const JOB_INTERVAL = 50;       // 提交解码任务的最小间隔（Worker 空闲即提交）
const FALLBACK_INTERVAL = 220; // 无 Worker 时主线程解码限频（避免卡顿）
const WORKER_URL = 'decoder-worker.js?v=4';
const FAST_MAX_EDGE = 640;     // 快速扫描画布长边：全帧降采样，先解大码
const MEDIUM_INTERVAL = 350;   // 中速全帧扫最小间隔（覆盖偏离中心的较大条码）
const MEDIUM_MAX_EDGE = 1280;  // 中速精扫画布长边：全帧较高分辨率
const DEEP_INTERVAL = 500;     // 深扫"标记轮"间隔（用于轮换反色尝试）
const DEEP_CROP_EDGE = 800;    // 深扫中心方形区域原始像素上限
const DEEP_SCALE = 2;          // 深扫放大倍数：小码采样密度提升 4 倍
const JOB_TIMEOUT = 3000;      // 单个解码任务超时保护
const AUTO_ZOOM_DELAY = 1200;  // 多久无识别后开始自动放大（小码场景尽早放大）
const AUTO_ZOOM_STEP = 1200;   // 自动放大的逐级间隔
const AUTO_ZOOM_MAX = 5;       // 自动放大上限
const SCAN_TIP_INTERVAL = 6000; // 识别失败时切换提示的间隔
const CAMERA_START_TIMEOUT = 12000; // 摄像头启动超时：部分设备 getUserMedia 会长时间不返回
const CAMERA_RETRY_TIMEOUT = 8000;   // 用最简约束重试摄像头时的超时
const BLACK_SCREEN_TIMEOUT = 10000;  // 有流但一直无画面（黑屏）的判定时间
const PLAY_TIMEOUT = 3000;           // video.play() 无画面时可能挂起，超时放行
const SCAN_TIPS = [
  '未识别到条码：请调整距离或角度',
  '小条码请置于取景框中心，保持 10–25cm 距离',
  '可点按下方「放大」辅助识别小条码',
  '请检查条码是否清晰、无反光遮挡',
];

/* 解码用离屏画布 */
const fastCanvas = document.createElement('canvas');
const fastCtx = fastCanvas.getContext('2d', { willReadFrequently: true });
const mediumCanvas = document.createElement('canvas');
const mediumCtx = mediumCanvas.getContext('2d', { willReadFrequently: true });
const deepCanvas = document.createElement('canvas');
const deepCtx = deepCanvas.getContext('2d', { willReadFrequently: true });
const tinyCanvas = document.createElement('canvas');
tinyCanvas.width = 32;
tinyCanvas.height = 32;
const tinyCtx = tinyCanvas.getContext('2d', { willReadFrequently: true });

/* 扫码运行时状态 */
let videoEl = null;         // <video> 元素
let cameraStream = null;    // 摄像头媒体流
let decodeWorker = null;    // 解码 Worker（后台线程解码，页面不卡顿）
let jobId = 0;              // 解码任务编号
let jobInFlight = false;    // 是否有任务在 Worker 中执行
let jobSentAt = 0;          // 任务提交时间（超时保护）
let rafId = 0;              // 解码循环句柄
let decoding = false;       // 主线程兜底解码进行中（无 Worker 时）
let lastDecodeAt = 0;       // 上次提交解码时间戳
let scanStartAt = 0;        // 本次扫码开始时间
let cameraStartAt = 0;      // 摄像头启动时刻（用于黑屏检测）
let barcodeDetector = null; // 主线程原生引擎（仅作无 Worker 时的兜底）
let lastMediumAt = 0;       // 上次中速精扫时间戳
let lastDeepAt = 0;         // 上次深扫时间戳
let deepSweepCount = 0;     // 深扫轮次（用于隔次尝试反色）
let watchTimer = 0;         // 亮度/自动放大/状态提示定时器
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

// 带超时的摄像头启动：部分设备/浏览器 getUserMedia 可能长时间不返回，
// 超时后即使稍后拿到流也立即释放，避免"正在启动摄像头"永久卡死
function openCamera(constraints, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      reject(new Error('摄像头启动超时'));
    }, timeoutMs);
    navigator.mediaDevices.getUserMedia(constraints).then(
      (stream) => {
        if (timedOut) {
          // 迟到的流直接释放，防止占用摄像头
          try { stream.getTracks().forEach((t) => t.stop()); } catch { /* 忽略 */ }
          return;
        }
        clearTimeout(timer);
        resolve(stream);
      },
      (err) => {
        if (timedOut) return; // 超时已处理，忽略迟到的错误
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function startScan() {
  if (scanning) return;
  initDecodeWorker();
  if (!decodeWorker && !('BarcodeDetector' in window)) {
    toast('扫码组件加载失败，请检查网络，或改用手动输入', 'error');
    return;
  }
  els.readerWrap.classList.remove('hidden');
  els.reader.innerHTML = '';
  setStatus('正在启动摄像头…');
  cameraStartAt = performance.now();
  // 完整约束：高分辨率 + 连续对焦（识别小码的基础）
  const fullConstraints = {
    audio: false,
    video: {
      facingMode: 'environment',
      // 请求尽可能高的分辨率（不支持 4K 的设备自动回退 1080p 等）：
      // 小条码在传感器上的像素更多，是识别小码的基础
      width: { ideal: 3840 },
      height: { ideal: 2160 },
      // 请求 30fps：部分设备 4K 下会降到低帧率，低帧率画面更新慢、
      // 自动对焦收敛也慢，ideal 30 让浏览器优先选高帧率模式
      frameRate: { ideal: 30 },
      // 直接在初始约束中请求连续自动对焦：远近切换时自动合焦，小码更清晰
      advanced: [{ focusMode: 'continuous' }],
    },
  };
  // 最简约束：排除"约束过重导致相机服务卡死"的情况
  const simpleConstraints = { audio: false, video: { facingMode: 'environment' } };
  try {
    cameraStream = await openCamera(fullConstraints, CAMERA_START_TIMEOUT);
  } catch (err) {
    // 首次失败或超时：用最简约束重试一次（摄像头临时卡死时也常能自愈）
    setStatus('摄像头响应缓慢，正在重试…');
    try {
      cameraStream = await openCamera(simpleConstraints, CAMERA_RETRY_TIMEOUT);
    } catch (err2) {
      cameraStream = null;
      els.readerWrap.classList.add('hidden');
      els.scanStatus.classList.add('hidden');
      const reason = err2 && err2.message ? err2.message : '未知错误';
      toast(`无法启动摄像头（${reason}）。请关闭其他占用摄像头的应用、锁屏后解锁再试，或改用手动输入`, 'error');
      return;
    }
  }

  // 摄像头被系统或其他应用抢占（track 意外结束）时主动退出，避免黑屏挂死。
  // 注意：部分浏览器自己调用 stop() 也会异步触发 ended，且旧 track 的事件
  // 可能在下一次扫码开始后才到达，必须校验 track 身份，避免误杀新会话
  const camTrack = getVideoTrack();
  if (camTrack) {
    camTrack.onended = () => {
      if (!scanning || getVideoTrack() !== camTrack) return;
      toast('摄像头已被其他应用占用，请重新开始扫码', 'error');
      stopScan();
    };
  }

  videoEl = document.createElement('video');
  videoEl.setAttribute('playsinline', '');
  videoEl.setAttribute('webkit-playsinline', '');
  videoEl.playsInline = true;
  videoEl.muted = true;
  videoEl.autoplay = true;
  videoEl.srcObject = cameraStream;
  els.reader.appendChild(videoEl);
  try {
    // 无画面时 play() 的 Promise 可能一直挂起，超时后放行交给黑屏检测处理
    await Promise.race([
      videoEl.play(),
      new Promise((resolve) => setTimeout(resolve, PLAY_TIMEOUT)),
    ]);
  } catch { /* 部分浏览器自动播放限制，静默处理 */ }

  // 按视频流实际宽高比固定取景容器比例，避免画面变形
  if (videoEl.videoWidth && videoEl.videoHeight) {
    els.readerWrap.style.aspectRatio = `${videoEl.videoWidth} / ${videoEl.videoHeight}`;
  }

  // 首选浏览器原生 BarcodeDetector（仅 DataMatrix）；仅作无 Worker 时的主线程兜底
  barcodeDetector = null;
  if ('BarcodeDetector' in window) {
    try { barcodeDetector = new window.BarcodeDetector({ formats: ['data_matrix'] }); }
    catch { barcodeDetector = null; }
  }

  scanning = true;
  autoResume = false;
  lastDecodeAt = 0;
  lastMediumAt = 0;
  lastDeepAt = 0;
  deepSweepCount = 0;
  jobInFlight = false;
  decoding = false;
  zoomValue = zoomPref;        // 生效倍率从用户偏好起步
  zoomUserSet = zoomPref > 1;  // 用户手动设过放大则不做自动放大
  scanStartAt = performance.now();
  lastTipAt = 0;
  tipIdx = 0;
  isDark = false;
  updateScanButtons();
  initZoomSupport();
  applyZoomOnStart();
  applyCssZoomPreview();
  setStatus('请将 DataMatrix 条码置于取景框内');

  rafId = requestAnimationFrame(decodeLoop);
  watchTimer = setInterval(scanWatch, 500);
}

async function stopScan() {
  if (!scanning) return;
  scanning = false;
  cancelAnimationFrame(rafId);
  clearInterval(watchTimer);
  try {
    if (cameraStream) {
      // 主动停止前先清掉 onended，防止自己 stop() 触发的 ended 事件干扰
      cameraStream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    }
  } catch { /* 忽略 */ }
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

/* ---------- 解码循环：取帧在主线程（轻量），解码在 Worker（不卡页面） ---------- */

function initDecodeWorker() {
  if (decodeWorker) return;
  try {
    decodeWorker = new Worker(WORKER_URL);
    decodeWorker.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.type === 'ready') {
        // Worker 内解码引擎都不可用（如 CDN 加载失败）：放弃 Worker
        if (!msg.hasDetector && !msg.hasZxing) {
          try { decodeWorker.terminate(); } catch { /* 忽略 */ }
          decodeWorker = null;
          jobInFlight = false;
        }
        return;
      }
      jobInFlight = false;
      if (msg.text && scanning) onScanSuccess(msg.text);
    };
    decodeWorker.onerror = () => {
      // Worker 加载/运行失败：退回主线程原生引擎（轻量，不阻塞）
      jobInFlight = false;
      try { decodeWorker.terminate(); } catch { /* 忽略 */ }
      decodeWorker = null;
    };
  } catch { decodeWorker = null; }
}

function decodeLoop(ts) {
  if (!scanning) return;
  rafId = requestAnimationFrame(decodeLoop);
  if (!videoEl || videoEl.readyState < 2) return;

  if (decodeWorker) {
    if (ts - lastDecodeAt < JOB_INTERVAL) return;
    if (jobInFlight) {
      // 任务超时保护：Worker 卡死时丢弃该任务继续
      if (ts - jobSentAt > JOB_TIMEOUT) jobInFlight = false;
      else return;
    }
    lastDecodeAt = ts;
    submitJob(ts);
  } else {
    // 无 Worker 兜底：主线程 BarcodeDetector（限频解码，避免卡顿）
    if (decoding || ts - lastDecodeAt < FALLBACK_INTERVAL) return;
    lastDecodeAt = ts;
    decoding = true;
    mainThreadDetect().finally(() => { decoding = false; });
  }
}

// 扫描通道调度：小码场景下深扫（中心原始分辨率 + 2 倍放大）是最有效的通道，
// Worker 空闲即深扫；中速全帧扫每 MEDIUM_INTERVAL 穿插一次，覆盖偏离中心的较大条码。
// 每 DEEP_INTERVAL 的"标记轮"附带回色尝试（每 3 轮 1 次，避免深扫耗时频繁翻倍）
function submitJob(ts) {
  let canvas, ctx, inversion = 'dontInvert';
  const mediumDue = ts - lastMediumAt >= MEDIUM_INTERVAL;
  const deepDue = ts - lastDeepAt >= DEEP_INTERVAL;

  if (mediumDue && !deepDue) {
    lastMediumAt = ts;
    drawCrop(mediumCanvas, mediumCtx, getZoomCrop(), MEDIUM_MAX_EDGE);
    canvas = mediumCanvas;
    ctx = mediumCtx;
  } else {
    if (deepDue) {
      lastDeepAt = ts;
      // 每 3 轮深扫尝试 1 次反色：兼顾金属雕刻反色码，又不拖慢常规码
      inversion = deepSweepCount % 3 === 2 ? 'attemptBoth' : 'dontInvert';
      deepSweepCount++;
    }
    drawDeepCrop();
    canvas = deepCanvas;
    ctx = deepCtx;
  }

  let img;
  try { img = ctx.getImageData(0, 0, canvas.width, canvas.height); }
  catch { return; }
  jobInFlight = true;
  jobSentAt = ts;
  jobId++;
  // transferable：像素缓冲零拷贝转移给 Worker
  decodeWorker.postMessage(
    { id: jobId, width: canvas.width, height: canvas.height, buffer: img.data.buffer, inversion },
    [img.data.buffer]
  );
}

// 深扫：取（放大裁剪后的）画面中心方形区域，按原始分辨率 2 倍放大。
// 5mm 小码像素有限，插值放大能把临界小码提升到可解码的采样密度
function drawDeepCrop() {
  const crop = getZoomCrop();
  const edge = Math.min(DEEP_CROP_EDGE, crop.sw, crop.sh);
  const sx = crop.sx + (crop.sw - edge) / 2;
  const sy = crop.sy + (crop.sh - edge) / 2;
  const size = Math.round(edge * DEEP_SCALE);
  if (deepCanvas.width !== size || deepCanvas.height !== size) {
    deepCanvas.width = size;
    deepCanvas.height = size;
  }
  deepCtx.drawImage(videoEl, sx, sy, edge, edge, 0, 0, size, size);
}

// 主线程兜底解码（仅在 Worker 不可用时执行）：原生 BarcodeDetector
async function mainThreadDetect() {
  drawCrop(fastCanvas, fastCtx, getZoomCrop(), FAST_MAX_EDGE);
  if (!barcodeDetector) return;
  try {
    const codes = await Promise.race([
      barcodeDetector.detect(fastCanvas),
      new Promise((_, reject) => setTimeout(() => reject(new Error('detect timeout')), 2000)),
    ]);
    if (codes && codes.length && codes[0].rawValue && scanning) {
      onScanSuccess(codes[0].rawValue);
    }
  } catch {
    barcodeDetector = null; // 引擎不可用（如无 GMS 设备）
  }
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

/* ---------- 扫码实时反馈与自动放大 ---------- */

// 周期巡检：黑屏检测 + 亮度检测 + 自动放大 + 状态提示刷新
function scanWatch() {
  if (!scanning) return;
  // 黑屏检测：流已建立但长时间无画面（摄像头被占用或相机服务卡死）
  if (videoEl && (!videoEl.videoWidth || videoEl.readyState < 2)) {
    if (performance.now() - cameraStartAt > BLACK_SCREEN_TIMEOUT) {
      setStatus('摄像头无画面：可能被其他应用占用或相机服务卡死，请关闭后台相机应用（如微信扫一扫）、锁屏解锁后，点「停止扫码」再重试', 'error');
    }
    return;
  }
  checkBrightness();
  autoZoomTick();
  refreshScanStatus();
}

function checkBrightness() {
  if (!videoEl || videoEl.readyState < 2) return;
  try {
    tinyCtx.drawImage(videoEl, 0, 0, 32, 32);
    const d = tinyCtx.getImageData(0, 0, 32, 32).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) {
      sum += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    }
    isDark = sum / (d.length / 4) < 55;
  } catch { /* 忽略 */ }
}

// 自动放大：小二维码像素有限，持续无识别时逐级放大（优先摄像头原生变焦，
// 不支持则裁剪中心区域按原始分辨率解码，等效数码放大）。用户手动点过放大则不干预
async function autoZoomTick() {
  if (!scanning || zoomUserSet || !zoomMode) return;
  const elapsed = performance.now() - scanStartAt;
  if (elapsed < AUTO_ZOOM_DELAY) return;
  const level = Math.min(
    2 + Math.floor((elapsed - AUTO_ZOOM_DELAY) / AUTO_ZOOM_STEP),
    AUTO_ZOOM_MAX
  );
  if (level <= zoomValue) return;
  let target = level;
  if (zoomMode === 'native' && zoomCaps) {
    const maxLevel = Math.floor(zoomCaps.max);
    if (maxLevel < 2) return; // 原生变焦上限不足，放弃自动放大
    target = Math.min(target, maxLevel);
  }
  if (target <= zoomValue) return;
  await setEffectiveZoom(target);
  lastTipAt = performance.now();
  setStatus(`已自动放大至 ${target}×，请将小二维码对准画面中心`, 'warn');
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
  if (now - lastTipAt > SCAN_TIP_INTERVAL) setStatus('请将 DataMatrix 条码置于取景框内');
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
  if (zoomPref <= 1 || zoomMode !== 'native') return;
  await applyNativeZoom(zoomPref);
}

async function applyNativeZoom(value) {
  const track = getVideoTrack();
  if (!track || !zoomCaps) return null;
  const v = Math.min(Math.max(value, zoomCaps.min), zoomCaps.max);
  try {
    await track.applyConstraints({ advanced: [{ zoom: v }] });
    // 变焦后部分设备会退出连续自动对焦：立即重新请求，加快重新合焦速度
    try {
      await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
    } catch { /* 不支持则忽略 */ }
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
  if (value === zoomPref && value === zoomValue) return;
  zoomPref = value;
  zoomUserSet = true; // 用户手动设置后，本次扫码不再自动放大
  if (!scanning) { // 未在扫码时仅记住偏好，下次启动时生效
    zoomValue = value;
    updateZoomButtonsUI();
    return;
  }
  await setEffectiveZoom(value);
}

// 设置当前生效的放大倍率（用户手动或自动放大统一走这里）
async function setEffectiveZoom(value) {
  zoomValue = value;
  updateZoomButtonsUI();
  if (!scanning || !videoEl) return;
  if (zoomMode === 'native') {
    const applied = await applyNativeZoom(value);
    if (applied == null) {
      // 原生变焦失败：本次扫码改用数码放大（裁剪解码区域）
      zoomMode = 'css';
      els.zoomModeTip.textContent = '数码放大';
      applyCssZoomPreview();
    } else if (applied !== value) {
      zoomValue = applied;
      updateZoomButtonsUI();
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
    // 稍作延迟，给摄像头留出足够的释放与重启时间，避免重启后黑屏
    // （部分设备释放较慢，300ms 不够会导致下一次启动卡死）
    setTimeout(startScan, 800);
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

// 预加载解码 Worker（后台线程），首次扫码无需等待
initDecodeWorker();

renderHistory();
