/**
 * QR: generate labels, read scans.
 *
 * The library is bundled from npm, not fetched from a CDN — a police station demo
 * has to work with the network unplugged, and a station terminal should not be
 * reaching out to a third party to render an evidence label.
 *
 * # What a QR code is, and is not
 *
 * A custody label carries `LEXX:v1:<itemCode>:<HMAC>`. The HMAC proves the label was
 * printed by this system; it does not prove the holder may move the item. The server
 * runs the access resolver on the resolved item exactly as it would on a typed id
 * (see `backend/routes/custody.js`), and this module repeats that in the text it
 * renders so nobody reads a successful scan as an authorisation.
 */
import QRCode from 'qrcode';
import { el } from './ui.js';

/** Rendering options tuned for a projector: high contrast, generous quiet zone. */
const RENDER = {
  errorCorrectionLevel: 'M',
  margin: 2,
  color: { dark: '#0b1220', light: '#ffffff' },
};

/**
 * Draw a QR code into a canvas element.
 * @param {string} text payload or URL to encode
 * @param {number} size pixel width/height
 */
export async function qrCanvas(text, size = 180) {
  const canvas = el('canvas.qr-canvas', { width: size, height: size });
  try {
    await QRCode.toCanvas(canvas, String(text), { ...RENDER, width: size });
  } catch {
    // A payload too long for a QR code is a data problem, not a reason to break the
    // page — the caller still shows the payload as selectable text below.
    return el('div.qr-failed', 'Could not render a QR code for this value.');
  }
  return canvas;
}

/**
 * A labelled QR block: the code, the exact payload as selectable text, and a caption.
 * The payload is always shown in text as well, so a camera-less demo still works.
 */
export async function qrBlock(text, { caption, size = 180 } = {}) {
  return el('div.qr-block', [
    await qrCanvas(text, size),
    el('div.qr-block__body', [
      caption ? el('div.qr-block__caption', caption) : null,
      el('code.qr-block__payload', String(text)),
    ]),
  ]);
}

/** A printable custody label from the server's `qr.printable` object. */
export async function custodyLabel(qr) {
  const p = qr?.printable ?? {};
  return el('div.label-card', [
    await qrCanvas(qr?.payload ?? '', 160),
    el('div.label-card__body', [
      el('div.label-card__code', p.itemCode ?? qr?.itemCode ?? '—'),
      el('div.label-card__row', [el('strong', 'Exhibit: '), p.exhibit ?? '—']),
      el('div.label-card__row', [el('strong', 'Seal: '), p.sealNumber ?? '—']),
      el('div.label-card__row', [el('strong', 'FIR: '), p.firNumber ?? '—']),
      el('div.label-card__row', [el('strong', 'Station: '), p.stationCode ?? '—']),
      el(
        'p.label-card__notice',
        p.notice ?? 'This label identifies the item. It grants no authority to move it.'
      ),
    ]),
  ]);
}

// ------------------------------------------------------------------ reading ----

const QR_PATTERN = /^LEXX:v1:([A-Za-z0-9-]+):([A-Za-z0-9_-]+)$/;

/**
 * Parse a scanned or pasted payload.
 * Shape only — the HMAC is verified by the server, which is the only party holding
 * the secret. A client-side "valid" here would mean nothing.
 */
export function parseQrPayload(raw) {
  const text = String(raw ?? '').trim();
  const match = QR_PATTERN.exec(text);
  if (!match) {
    return { ok: false, reason: 'NOT_A_LEXX_LABEL', payload: text };
  }
  return { ok: true, payload: text, itemCode: match[1] };
}

/**
 * Read a verification token out of a URL or a bare token.
 * The QR printed on a section 63 certificate points at `/public/verify/:token`.
 */
export function verificationTokenFrom(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const match = /\/public\/verify\/([A-Za-z0-9_-]{16,})/.exec(text);
  if (match) return match[1];
  return /^[A-Za-z0-9_-]{16,}$/.test(text) ? text : null;
}

/**
 * Camera scanning, where the platform provides it.
 *
 * Chromium exposes `BarcodeDetector`; Firefox and Safari do not. Rather than ship a
 * decoder for a capability most demo machines already have, this returns null when
 * unsupported and every caller keeps a paste-the-payload field alongside. A scanner
 * that silently fails is worse than a text box that always works.
 */
export const cameraScanSupported = () =>
  typeof window.BarcodeDetector === 'function' && Boolean(navigator.mediaDevices?.getUserMedia);

/**
 * Open the camera and resolve with the first QR payload seen.
 * @returns {{video: HTMLElement, stop: Function, result: Promise<string>}|null}
 */
export function startCameraScan() {
  if (!cameraScanSupported()) return null;

  const video = el('video.qr-video', { autoplay: '', playsinline: '', muted: '' });
  const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
  let stream = null;
  let timer = null;
  let stopped = false;

  const stop = () => {
    stopped = true;
    if (timer) clearInterval(timer);
    if (stream) stream.getTracks().forEach((t) => t.stop());
  };

  const result = new Promise((resolve, reject) => {
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' } })
      .then((s) => {
        if (stopped) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        video.srcObject = s;
        timer = setInterval(async () => {
          try {
            const codes = await detector.detect(video);
            if (codes.length) {
              stop();
              resolve(codes[0].rawValue);
            }
          } catch {
            /* a frame that cannot be decoded is normal; keep looking */
          }
        }, 300);
      })
      .catch(reject);
  });

  return { video, stop, result };
}
