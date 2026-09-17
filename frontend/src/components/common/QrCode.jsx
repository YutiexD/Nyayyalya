/**
 * A QR code for a URL or token, rendered locally with `qrcode` (nothing leaves the browser).
 *
 * Black on white regardless of theme, so a phone camera reads it off a dark screen too.
 */
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

import { cn } from '@/lib/utils';

export const QR_OPTIONS = Object.freeze({
  errorCorrectionLevel: 'M',
  margin: 1,
  color: { dark: '#000000', light: '#ffffff' },
});

/**
 * @param {object} props
 * @param {string} props.value      what the code encodes
 * @param {number} [props.size=96]  rendered size in CSS pixels
 * @param {string} [props.alt]
 */
export function QrCode({ value, size = 96, alt, className }) {
  const [rendered, setRendered] = useState({ value: null, src: null });

  useEffect(() => {
    if (!value) return undefined;
    let live = true;
    // Rendered at 4x and scaled down with pixelated sampling: crisp on high-DPI screens.
    QRCode.toDataURL(value, { ...QR_OPTIONS, width: Math.round(size * 4) })
      .then((src) => live && setRendered({ value, src }))
      .catch(() => live && setRendered({ value, src: null }));
    return () => {
      live = false;
    };
  }, [value, size]);

  if (!value) return null;
  const src = rendered.value === value ? rendered.src : null;

  if (!src) {
    return (
      <span
        aria-hidden
        className={cn('block shrink-0 animate-pulse rounded-sm bg-muted', className)}
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <img
      src={src}
      width={size}
      height={size}
      alt={alt ?? 'QR code'}
      className={cn('block shrink-0 rounded-sm bg-white [image-rendering:pixelated]', className)}
    />
  );
}
