'use strict';

/* 扫码解码 Worker：在后台线程运行 BarcodeDetector / jsQR，
   避免同步解码阻塞页面主线程（卡顿、无法滑动的根源） */

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

self.onmessage = async (e) => {
  const { id, width, height, buffer, inversion } = e.data;
  const data = new Uint8ClampedArray(buffer);
  let text = null;
  try {
    // 优先原生 BarcodeDetector（硬件加速、速度快）
    if (detector) {
      const bitmap = await createImageBitmap(new ImageData(data, width, height));
      try {
        const codes = await detector.detect(bitmap);
        if (codes && codes.length && codes[0].rawValue) text = codes[0].rawValue;
      } finally {
        try { bitmap.close(); } catch { /* 忽略 */ }
      }
    }
    // 回退 jsQR
    if (text == null && jsQRLoaded) {
      const res = jsQR(data, width, height, { inversionAttempts: inversion || 'dontInvert' });
      if (res && res.data) text = res.data;
    }
  } catch { /* 单帧解码失败忽略 */ }
  self.postMessage({ id, text });
};
