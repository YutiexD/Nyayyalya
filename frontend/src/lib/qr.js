/**
 * QR helpers — data only, no DOM.
 *
 * The rendering belongs to React; this module's job is to turn a value into a data
 * URL and to parse the two payload shapes this system prints, so both the custody
 * label and the certificate verifier read them the same way.
 *
 * # What a QR here is and is not
 *
 * A custody label identifies an item. It carries no authority to move it: every scan
 * still goes through the resolver, which decides whether this user may touch this
 * item at this station. A label that granted access would be a physical credential
 * anyone could photograph off a shelf.
 */
import QRCode from 'qrcode';

/**
 * Render `text` as a PNG data URL.
 *
 * Returns null rather than throwing: a QR that will not render is a degraded panel,
 * not a broken page, and the caller shows the payload as text instead.
 */
export async function qrDataUrl(text, size = 180) {
  if (!text) return null;
  try {
    return await QRCode.toDataURL(String(text), {
      width: size,
      margin: 1,
      errorCorrectionLevel: 'M',
      // Fixed black on white regardless of theme. A QR inverted for dark mode is
      // unreadable to most scanners, and this one is meant to be scanned off a
      // projector by a phone in the room.
      color: { dark: '#000000', light: '#ffffff' },
    });
  } catch {
    return null;
  }
}

/** The custody label payload, which is JSON with an HMAC the server checks. */
export function parseQrPayload(raw) {
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

/**
 * Pull a certificate verification token out of whatever the user pasted.
 *
 * People paste the whole URL off the certificate, the whole URL from their browser
 * bar, or just the token. All three have to work — a verifier that only accepts one
 * of them fails exactly the person it exists for.
 */
export function verificationTokenFrom(raw) {
  if (!raw) return null;
  const text = String(raw).trim();

  // A bare token: 32 bytes, base64url.
  if (/^[A-Za-z0-9_-]{43}$/.test(text)) return text;

  // `?token=…` from the verifier page.
  const queryMatch = text.match(/[?&]token=([A-Za-z0-9_-]{43})/);
  if (queryMatch) return queryMatch[1];

  // `/public/verify/…` — the raw API route, which older certificates point at.
  const pathMatch = text.match(/\/public\/verify\/([A-Za-z0-9_-]{43})/);
  if (pathMatch) return pathMatch[1];

  return null;
}
