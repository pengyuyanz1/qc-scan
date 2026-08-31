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
};

let scanner = null;        // html5-qrcode 实例
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
  } catch {
    toast('保存失败：浏览器存储不可用', 'error');
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

/* ---------- 扫码 ---------- */

async function startScan() {
  if (scanning) return;
  if (typeof Html5Qrcode === 'undefined') {
    toast('扫码组件加载失败，请检查网络，或改用手动输入', 'error');
    return;
  }
  try {
    // 每次都用全新实例启动：规避复用旧实例在部分设备上重启后黑屏的问题
    if (scanner) {
      try { await scanner.stop(); } catch { /* 已停止则忽略 */ }
    }
    els.reader.innerHTML = '';
    scanner = new Html5Qrcode('reader', { verbose: false });
    applyReaderWidth(); // 数码放大模式下按倍率预设取景宽度
    els.readerWrap.classList.remove('hidden');
    await scanner.start(
      { facingMode: 'environment' },
      {
        fps: 10,
        // 扫描框保持固定大小：放大取景宽度后，解码裁剪区随之缩小，
        // 二维码在解码画布中被等效放大，识别率更高
        qrbox: (vw, vh) => {
          const size = Math.max(Math.min(200, Math.min(vw, vh) - 40), 90);
          return { width: size, height: size };
        },
        // 请求高分辨率视频流：小二维码在画面中的像素更多，识别更准
        videoConstraints: {
          facingMode: 'environment',
          width: { ideal: 2560 },
          height: { ideal: 1440 },
        },
        // 支持时使用浏览器原生 BarcodeDetector，识别性能更好
        experimentalFeatures: { useBarCodeDetectorIfSupported: true },
      },
      onScanSuccess
    );
    scanning = true;
    autoResume = false;
    updateScanButtons();
    await initZoomSupport();
    await applyZoomOnStart();
  } catch (err) {
    els.readerWrap.classList.add('hidden');
    const reason = err && err.message ? err.message : '未知错误';
    toast(`无法启动摄像头（${reason}），可改用手动输入`, 'error');
  }
}

async function stopScan() {
  if (!scanning) return;
  scanning = false;
  try { await scanner.stop(); } catch { /* 忽略停止过程中的异常 */ }
  els.readerWrap.classList.add('hidden');
  els.zoomPanel.classList.add('hidden');
  updateScanButtons();
}

async function onScanSuccess(decodedText) {
  if (!scanning) return;
  await stopScan();
  autoResume = true; // 提交后自动继续扫码，无需再点一次
  useCode(String(decodedText).trim());
}

function updateScanButtons() {
  els.btnStart.classList.toggle('hidden', scanning);
  els.btnStop.classList.toggle('hidden', !scanning);
}

/* ---------- 放大功能（小二维码增强） ---------- */

async function initZoomSupport() {
  zoomMode = null;
  zoomCaps = null;
  try {
    const caps = scanner.getRunningTrackCapabilities();
    if (caps && caps.zoom && caps.zoom.max > caps.zoom.min) {
      zoomCaps = caps.zoom;
      zoomMode = 'native';
    }
  } catch { /* 不支持则走数码放大 */ }
  if (!zoomMode) zoomMode = 'css';

  // 按视频流实际宽高比固定取景框高度，放大时画面居中裁剪
  const video = els.reader.querySelector('video');
  if (video && video.videoWidth && video.videoHeight) {
    els.readerWrap.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
  }

  els.zoomModeTip.textContent = zoomMode === 'native' ? '摄像头变焦' : '数码放大';
  els.zoomPanel.classList.remove('hidden');
  updateZoomButtonsUI();

  // 尝试开启连续自动对焦：近拍小码更清晰，不支持则静默忽略
  try {
    await scanner.applyVideoConstraints({ advanced: [{ focusMode: 'continuous' }] });
  } catch { /* 忽略 */ }
}

async function applyZoomOnStart() {
  if (zoomValue <= 1 || zoomMode !== 'native') return;
  await applyNativeZoom(zoomValue);
}

function applyReaderWidth() {
  // 数码放大：把取景容器宽度撑大，超出部分被居中裁剪，
  // 视频画面与解码裁剪区同步放大，解码画布保持高分辨率
  const factor = zoomMode === 'css' && zoomValue > 1 ? zoomValue : 1;
  els.reader.style.width = factor > 1
    ? `${Math.round(els.readerWrap.clientWidth * factor)}px`
    : '';
}

async function applyNativeZoom(value) {
  const v = Math.min(Math.max(value, zoomCaps.min), zoomCaps.max);
  try {
    await scanner.applyVideoConstraints({ advanced: [{ zoom: v }] });
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
    // 数码放大：放大取景宽度后重启扫码，扫描框重新居中，
    // 解码画布保持高分辨率，小二维码识别更灵敏
    applyReaderWidth();
    await restartScan();
  }
}

async function restartScan() {
  if (!scanning) return;
  scanning = false;
  try { await scanner.stop(); } catch { /* 忽略 */ }
  await startScan();
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
    saveRecords(records);
    renderHistory();
    toast('已覆盖之前的记录', 'success');
  } else {
    records.unshift({ code: currentCode, result: selectedResult, scanTime: now, updateTime: now });
    saveRecords(records);
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
    els.stats.innerHTML =
      `共 <b>${total}</b> 条 · 合格 <b class="c-pass">${passCount}</b> · 不合格 <b class="c-fail">${total - passCount}</b>`;
  }

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
  toast('Excel 已导出', 'success');
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

renderHistory();
