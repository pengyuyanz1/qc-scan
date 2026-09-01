'use strict';

/* 扫码解码 Worker：在后台线程运行 BarcodeDetector / jsQR(QR) / ZXing(DataMatrix)，
   避免解码阻塞页面主线程 */

const JSQR_CDN = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
const ZXING_CDN = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';
const DETECT_TIMEOUT = 2000; // detect 挂起保护（无 GMS 设备可能构造成功但调用挂起）

let detector = null;
if (typeof BarcodeDetector !== 'undefined') {
  // 优先同时支持 QR 与 DataMatrix；设备不支持某格式时构造会抛错，逐级降级
  try {
    detector = new BarcodeDetector({ formats: ['qr_code', 'data_matrix'] });
  } catch {
    try { detector = new BarcodeDetector({ formats: ['qr_code'] }); }
    catch { detector = null; }
  }
}

let jsQRLoaded = false;
try {
  importScripts(JSQR_CDN);
  jsQRLoaded = typeof jsQR === 'function';
} catch { jsQRLoaded = false; }

let zxingNormal = null;          // DataMatrix 普通模式
let zxingNormalHints = null;
let zxingHard = null;            // DataMatrix TRY_HARDER 模式（小码/低质量）
let zxingHardHints = null;
let GrayLuminanceSource = null;  // 灰度图适配器（Worker 内无 DOM，无法用 canvas 版）
try {
  importScripts(ZXING_CDN);
  if (typeof ZXing !== 'undefined') {
    class GraySource extends ZXing.LuminanceSource {
      constructor(width, height, gray) {
        super(width, height);
        this.gray = gray;
      }
      getRow(y, row) {
        const w = this.width;
        if (!row || row.length < w) row = new Uint8ClampedArray(w);
        row.set(this.gray.subarray(y * w, y * w + w));
        return row;
      }
      getMatrix() { return this.gray; }
      isCropSupported() { return false; }
      isRotateSupported() { return false; }
    }
    GrayLuminanceSource = GraySource;

    zxingNormalHints = new Map();
    zxingNormalHints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.DATA_MATRIX]);
    zxingNormal = new ZXing.MultiFormatReader();

    zxingHardHints = new Map(zxingNormalHints);
    zxingHardHints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    zxingHard = new ZXing.MultiFormatReader();
  }
} catch { zxingNormal = zxingHard = GrayLuminanceSource = null; }

self.postMessage({
  type: 'ready',
  hasDetector: !!detector,
  hasJsQR: jsQRLoaded,
  hasZxing: !!zxingNormal,
});

// ZXing 解码 DataMatrix（invert=true 时解反色码，金属雕刻反色 DM 较常见）。
// 注意：decode 必须显式传 hints（不传会重置为全码制扫描，又慢又易误判）
function zxingDecode(data, width, height, reader, hints, invert) {
  try {
    const gray = new Uint8ClampedArray(width * height);
    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
      const v = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
      gray[j] = invert ? 255 - v : v;
    }
    const bitmap = new ZXing.BinaryBitmap(
      new ZXing.GlobalHistogramBinarizer(new GrayLuminanceSource(width, height, gray))
    );
    const result = reader.decode(bitmap, hints);
    if (result) return result.getText();
  } catch { /* NotFoundException 等无结果，忽略 */ }
  finally {
    try { reader.reset(); } catch { /* 忽略 */ }
  }
  return null;
}

self.onmessage = async (e) => {
  const { id, width, height, buffer, inversion, zxing } = e.data;
  const data = new Uint8ClampedArray(buffer);
  let text = null;

  // ① 原生 BarcodeDetector 优先。部分无 GMS 设备（如华为）构造成功但
  //    detect 抛错/挂起——失败一次即永久禁用，本帧立即降级软件解码
  if (detector) {
    let bitmap = null;
    try {
      bitmap = await createImageBitmap(new ImageData(data, width, height));
      const codes = await Promise.race([
        detector.detect(bitmap),
        new Promise((_, reject) => setTimeout(() => reject(new Error('detect timeout')), DETECT_TIMEOUT)),
      ]);
      if (codes && codes.length && codes[0].rawValue) text = codes[0].rawValue;
    } catch {
      detector = null;
    } finally {
      if (bitmap) { try { bitmap.close(); } catch { /* 忽略 */ } }
    }
  }

  // ② jsQR 解 QR 码（速度快）
  if (text == null && jsQRLoaded) {
    try {
      const res = jsQR(data, width, height, { inversionAttempts: inversion || 'dontInvert' });
      if (res && res.data) text = res.data;
    } catch { /* 单帧失败忽略 */ }
  }

  // ③ ZXing 解 DataMatrix：快速/中速扫用普通模式，深扫用 TRY_HARDER + 反色尝试
  if (text == null && zxing && zxingNormal) {
    if (zxing === 'hard') {
      text = zxingDecode(data, width, height, zxingHard, zxingHardHints, false);
      if (text == null && inversion === 'attemptBoth') {
        text = zxingDecode(data, width, height, zxingHard, zxingHardHints, true);
      }
    } else {
      text = zxingDecode(data, width, height, zxingNormal, zxingNormalHints, false);
    }
  }

  self.postMessage({ id, text });
};
