'use strict';

const STORAGE_KEY = 'qc-scan-records';

const $ = (id) => document.getElementById(id);

const els = {
  reader: $('reader'),
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
    if (!scanner) scanner = new Html5Qrcode('reader', { verbose: false });
    els.reader.classList.remove('hidden');
    await scanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 230, height: 230 } },
      onScanSuccess
    );
    scanning = true;
    autoResume = false;
    updateScanButtons();
  } catch (err) {
    els.reader.classList.add('hidden');
    const reason = err && err.message ? err.message : '未知错误';
    toast(`无法启动摄像头（${reason}），可改用手动输入`, 'error');
  }
}

async function stopScan() {
  if (!scanning) return;
  scanning = false;
  try {
    await scanner.stop();
    scanner.clear();
  } catch { /* 忽略停止过程中的异常 */ }
  els.reader.classList.add('hidden');
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
    startScan();
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
