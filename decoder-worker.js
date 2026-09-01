'use strict';

/* 扫码解码 Worker：在后台线程运行 BarcodeDetector / jsQR，避免解码阻塞页面 */

let detector = null;
if (typeof BarcodeDetector !== 'undefined') {
  try { detector = new BarcodeDetector({ formats: ['qr_code'] }); } catch { detector = null; }
}

let jsQRLoaded = false;
try {
  importScripts('https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js');
  jsQRLoaded = typeof jsQR === 'function';
} catch { jsQRLoaded = false; }

self.postMessage({ type: 'ready', hasDetector: !!detector, hasJsQR: jsQRLoaded });

const DETECT_TIMEOUT = 2000; // detect 挂起保护（无 GMS 设备可能构造成功但调用挂起）

self.onmessage = async (e) => {
  const { id, width, height, buffer, inversion } = e.data;
  const data = new Uint8ClampedArray(buffer);
  let text = null;

  // 原生 BarcodeDetector 优先。注意：部分无 GMS 的设备（如华为）构造成功但
  // detect 抛错/挂起——失败一次即永久禁用，本帧立即降级 jsQR，不会再卡在坏引擎上
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

  // jsQR 解码（detector 不可用/没解出时执行）
  if (text == null && jsQRLoaded) {
    try {
      const res = jsQR(data, width, height, { inversionAttempts: inversion || 'dontInvert' });
      if (res && res.data) text = res.data;
    } catch { /* 单帧失败忽略 */ }
  }

  self.postMessage({ id, text });
};
