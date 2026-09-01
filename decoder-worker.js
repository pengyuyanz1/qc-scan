'use strict';

/* 扫码解码 Worker（仅 DataMatrix）：在后台线程运行 BarcodeDetector / ZXing，
   避免解码阻塞页面主线程 */

const ZXING_CDN = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';
const DETECT_TIMEOUT = 2000; // detect 挂起保护（无 GMS 设备可能构造成功但调用挂起）

let detector = null;
if (typeof BarcodeDetector !== 'undefined') {
  // 仅 DataMatrix：构造失败（不支持该格式）则禁用，全部走 ZXing 软解
  try {
    detector = new BarcodeDetector({ formats: ['data_matrix'] });
  } catch { detector = null; }
}

let zxingReader = null;
let zxingHints = null;
let GrayLuminanceSource = null; // 灰度图适配器（Worker 内无 DOM，无法用 canvas 版）
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

    zxingHints = new Map();
    zxingHints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.DATA_MATRIX]);
    zxingReader = new ZXing.MultiFormatReader();
  }
} catch { zxingReader = GrayLuminanceSource = null; }

self.postMessage({
  type: 'ready',
  hasDetector: !!detector,
  hasZxing: !!zxingReader,
});

// ZXing 解码 DataMatrix（invert=true 时解反色码，金属雕刻反色 DM 较常见）
function zxingDecode(data, width, height, invert) {
  try {
    const gray = new Uint8ClampedArray(width * height);
    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
      const v = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
      gray[j] = invert ? 255 - v : v;
    }
    const bitmap = new ZXing.BinaryBitmap(
      new ZXing.GlobalHistogramBinarizer(new GrayLuminanceSource(width, height, gray))
    );
    const result = zxingReader.decode(bitmap, zxingHints);
    if (result) return result.getText();
  } catch { /* NotFoundException 等无结果，忽略 */ }
  finally {
    try { zxingReader.reset(); } catch { /* 忽略 */ }
  }
  return null;
}

self.onmessage = async (e) => {
  const { id, width, height, buffer, inversion } = e.data;
  const data = new Uint8ClampedArray(buffer);
  let text = null;

  // ① 原生 BarcodeDetector 优先。部分无 GMS 设备（如华为）构造成功但
  //    detect 抛错/挂起——失败一次即永久禁用，本帧立即降级 ZXing 软解
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

  // ② ZXing 软解 DataMatrix；深扫帧附带反色尝试
  if (text == null && zxingReader) {
    text = zxingDecode(data, width, height, false);
    if (text == null && inversion === 'attemptBoth') {
      text = zxingDecode(data, width, height, true);
    }
  }

  self.postMessage({ id, text });
};
