/**
 * Hand a fetched blob to the user.
 *
 * Authenticated downloads cannot be plain links (a link carries no Authorization
 * header), so the bytes arrive through `fetchBlob` and leave through here. The object
 * URL is revoked shortly after, so a decrypted exhibit does not linger in the tab.
 */

/** Save `blob` as `filename`. */
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Open `blob` in a new tab when the browser can show it (images, PDFs, video), and
 * save it otherwise. Anything that could run as active content (HTML, SVG) is saved,
 * never opened — the server sends such files as attachments for the same reason.
 */
export function openBlob(blob, filename) {
  const viewable = /^(image\/(png|jpeg|gif|webp)|application\/pdf|video\/|audio\/)/.test(blob.type);
  if (!viewable) return saveBlob(blob, filename);
  const url = URL.createObjectURL(blob);
  // Not `noopener` in the features string: with it, window.open returns null even on
  // success, and a popup-blocked tab would be indistinguishable from an opened one.
  const tab = window.open(url, '_blank');
  if (tab) tab.opener = null;
  else saveBlob(blob, filename);
  setTimeout(() => URL.revokeObjectURL(url), 120_000);
  return undefined;
}

/** Copy text; resolves true when it worked. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(String(text));
    return true;
  } catch {
    return false;
  }
}
