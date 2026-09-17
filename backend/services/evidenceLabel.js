/**
 * The permanent QR label of an exhibit.
 *
 * Every exhibit carries a `labelToken` set once at upload and never changed. Printed as
 * a QR code and stuck on the physical article, it opens the public lifecycle page
 * (`/verify?label=…` on the web client, backed by `GET /public/evidence/:labelToken`).
 * Unlike a certificate's verification token it survives a certificate being superseded,
 * so a label printed on day one keeps working for the life of the exhibit.
 *
 * Anyone who may read the exhibit may print its label; the label itself discloses only
 * what the public lifecycle page does.
 */
import env from '../config/env.js';

/** The URL encoded in the printed QR code. */
export const labelUrlFor = (labelToken) =>
  labelToken ? `${env.PUBLIC_WEB_URL}/verify?label=${encodeURIComponent(labelToken)}` : null;

/** `{ token, url }` for an evidence document, or null if it has no token yet. */
export const labelFor = (evidence) =>
  evidence?.labelToken ? { token: evidence.labelToken, url: labelUrlFor(evidence.labelToken) } : null;

export default { labelUrlFor, labelFor };
