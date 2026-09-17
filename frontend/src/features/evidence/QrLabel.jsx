/**
 * The printable QR label for a physical exhibit.
 *
 * The QR encodes the exhibit's permanent label link (`exhibit.label.url`, which opens
 * `/verify?label=<token>`), so anyone holding the bag can check its lifecycle.
 *
 *   QrLabelPreview      small QR, exhibit code, "Scan to verify"
 *   PrintQrLabelButton  prints ONLY the sticker (70 x 40 mm) through a hidden iframe
 *   QrLabelSection      compact row for an exhibit dialog: preview + print
 *
 * Every piece renders nothing when the exhibit carries no label.
 */
import { useState } from 'react';
import QRCode from 'qrcode';
import { toast } from 'sonner';
import { Loader2, Printer } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { QrCode, QR_OPTIONS } from '@/components/common/QrCode';
import { cn } from '@/lib/utils';

/** The label link of an exhibit card, or null. Accepts the public payload's `labelUrl` too. */
export function labelUrlOf(exhibit) {
  const url = exhibit?.label?.url ?? exhibit?.labelUrl;
  return typeof url === 'string' && /^https?:\/\//i.test(url.trim()) ? url.trim() : null;
}

// ------------------------------------------------------------------ print ----

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

const labelDate = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

/** "lexx.example.in/verify" — readable on a sticker, without the token. */
const shortUrl = (url) => {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.replace(/\/$/, '');
  } catch {
    return '';
  }
};

const shorten = (text, max) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
};

function labelDocument({ svg, url, exhibitCode, firNumber, uploadedAt, title }) {
  const code = String(exhibitCode ?? '');
  const codeSize = code.length > 18 ? '8.5pt' : code.length > 13 ? '10pt' : '12pt';
  const lines = [
    firNumber && `FIR ${firNumber}`,
    uploadedAt && `Uploaded ${uploadedAt}`,
    title && shorten(title, 60),
  ].filter(Boolean);

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(code || 'Evidence label')}</title>
<style>
@page { size: 70mm 40mm; margin: 0; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 70mm; height: 40mm; background: #fff; color: #000; }
body { font-family: Arial, Helvetica, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.label { width: 70mm; height: 40mm; padding: 3mm; display: flex; align-items: center; gap: 2.5mm; overflow: hidden; page-break-after: avoid; }
.qr { width: 30mm; height: 30mm; flex: none; }
.qr svg { width: 100%; height: 100%; display: block; shape-rendering: crispEdges; }
.info { flex: 1; min-width: 0; height: 34mm; display: flex; flex-direction: column; justify-content: space-between; }
.brand { font-size: 6pt; font-weight: 700; letter-spacing: 0.14em; }
.code { margin-top: 0.6mm; font-family: "Courier New", Consolas, monospace; font-size: ${codeSize}; font-weight: 700; line-height: 1.05; word-break: break-all; }
.line { font-size: 6.5pt; line-height: 1.3; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; word-break: break-word; }
.line + .line { margin-top: 0.4mm; }
.foot { font-size: 5pt; line-height: 1.25; }
.url { font-family: "Courier New", Consolas, monospace; word-break: break-all; }
</style></head>
<body><div class="label">
<div class="qr">${svg}</div>
<div class="info">
<div><div class="brand">LEXX EVIDENCE</div><div class="code">${escapeHtml(code)}</div></div>
<div>${lines.map((l) => `<div class="line">${escapeHtml(l)}</div>`).join('')}</div>
<div class="foot">Scan to verify<br><span class="url">${escapeHtml(shortUrl(url))}</span></div>
</div>
</div></body></html>`;
}

/**
 * Print one label, and nothing else of the page. A zero-size iframe is used instead of a
 * new window, so there is no popup to block.
 */
export async function printQrLabel({ url, exhibitCode, firNumber, uploadedAt, title }) {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.tabIndex = -1;
  Object.assign(iframe.style, {
    position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0',
  });
  document.body.appendChild(iframe);

  const remove = () => iframe.remove();
  try {
    const svg = await QRCode.toString(url, { ...QR_OPTIONS, type: 'svg' });
    const doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    if (!doc || !win) throw new Error('Print frame unavailable');

    doc.open();
    doc.write(labelDocument({ svg, url, exhibitCode, firNumber, uploadedAt: labelDate(uploadedAt), title }));
    doc.close();

    win.addEventListener('afterprint', () => setTimeout(remove, 100), { once: true });
    // One frame for layout before the dialog opens.
    await new Promise((resolve) => setTimeout(resolve, 60));
    win.focus();
    win.print();
    // Browsers whose print() does not block and never fire afterprint.
    setTimeout(remove, 120000);
  } catch (err) {
    remove();
    throw err;
  }
}

// ------------------------------------------------------------- components ----

/**
 * @param {object} props
 * @param {object} props.exhibit           evidence card with `label.url` and `exhibitCode`
 * @param {number} [props.size=88]
 */
export function QrLabelPreview({ exhibit, size = 88, className }) {
  const url = labelUrlOf(exhibit);
  if (!url) return null;
  return (
    <div className={cn('flex items-center gap-3', className)}>
      <QrCode
        value={url}
        size={size}
        alt={`QR label for ${exhibit.exhibitCode ?? 'this exhibit'}`}
        className="border"
      />
      <div className="min-w-0">
        <code className="block truncate font-mono text-sm font-medium text-foreground">{exhibit.exhibitCode}</code>
        <p className="text-meta text-muted-foreground">Scan to verify</p>
      </div>
    </div>
  );
}

/**
 * @param {object} props
 * @param {object} props.exhibit
 * @param {{ firNumber?: string }} [props.caseInfo]
 * @param {string} [props.variant='outline']
 * @param {string} [props.size='sm']
 * @param {boolean} [props.iconOnly]   a small icon button, for table rows
 */
export function PrintQrLabelButton({ exhibit, caseInfo, variant = 'outline', size = 'sm', iconOnly = false, className }) {
  const [busy, setBusy] = useState(false);
  const url = labelUrlOf(exhibit);
  if (!url) return null;

  const onClick = async (event) => {
    // Rows around this button open a dialog on click and on Enter/Space.
    event.stopPropagation();
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await printQrLabel({
        url,
        exhibitCode: exhibit.exhibitCode,
        firNumber: caseInfo?.firNumber ?? exhibit.firNumber ?? exhibit.case?.firNumber ?? null,
        uploadedAt: exhibit.createdAt ?? exhibit.registeredAt ?? null,
        title: exhibit.titleWithheld ? null : exhibit.title,
      });
    } catch {
      toast.error('Label could not be printed');
    } finally {
      setBusy(false);
    }
  };

  const text = 'Print QR label';
  const icon = busy ? <Loader2 className="animate-spin" /> : <Printer />;

  return (
    <Button
      type="button"
      variant={iconOnly ? (variant === 'outline' ? 'ghost' : variant) : variant}
      size={iconOnly ? 'icon-sm' : size}
      onClick={onClick}
      onKeyDown={(event) => event.stopPropagation()}
      disabled={busy}
      aria-label={iconOnly ? `${text} for ${exhibit.exhibitCode ?? 'exhibit'}` : undefined}
      title={iconOnly ? text : undefined}
      className={cn(iconOnly && 'text-muted-foreground hover:text-foreground', className)}
    >
      {icon}
      {!iconOnly && text}
    </Button>
  );
}

/** A compact "QR label" row for an exhibit dialog. */
export function QrLabelSection({ exhibit, caseInfo, className }) {
  if (!labelUrlOf(exhibit)) return null;
  return (
    <section
      aria-label="QR label"
      className={cn('flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3', className)}
    >
      <div className="flex min-w-0 items-center gap-3">
        <QrLabelPreview exhibit={exhibit} size={64} />
      </div>
      <PrintQrLabelButton exhibit={exhibit} caseInfo={caseInfo} />
    </section>
  );
}
