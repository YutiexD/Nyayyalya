/**
 * A QR code for `value`, rendered once per value.
 *
 * Fixed black on white whatever the theme (see lib/qr.js): an inverted code is
 * unreadable to most scanners, and these are meant to be scanned off a screen or a
 * printed label by a phone in the room. If the code cannot be drawn, the caller's
 * text fallback is what shows — the value is always printed beside it anyway.
 */
import { useEffect, useState } from 'react';
import { qrDataUrl } from '@/lib/qr';
import { cn } from '@/lib/utils';

export function useQrDataUrl(value, size = 180) {
  // Keyed on what it was drawn for, so a stale image is never shown for a new value
  // without having to clear state inside the effect.
  const key = value ? `${size}|${value}` : null;
  const [drawn, setDrawn] = useState({ key: null, src: null });
  useEffect(() => {
    let alive = true;
    if (key) qrDataUrl(value, size).then((src) => alive && setDrawn({ key, src }));
    return () => {
      alive = false;
    };
  }, [key, value, size]);
  return drawn.key === key ? drawn.src : null;
}

export function QrImage({ value, size = 160, alt = 'QR code', className }) {
  const src = useQrDataUrl(value, size * 2);
  if (!value) return null;
  return src ? (
    <img
      src={src}
      width={size}
      height={size}
      alt={alt}
      className={cn('rounded-md border bg-white p-1', className)}
    />
  ) : (
    <div
      aria-busy="true"
      style={{ width: size, height: size }}
      className={cn('animate-pulse rounded-md border bg-muted', className)}
    />
  );
}
