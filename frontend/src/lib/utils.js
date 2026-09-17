import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** The shadcn class merger: conditional classes, with later Tailwind utilities winning. */
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

/**
 * Acronyms that must survive humanise() intact.
 *
 * The naive "lowercase everything, capitalise the first letter" produced `Pocso`,
 * `At fsl`, `Referred to fsl` and `District sp` on almost every screen. POCSO and FSL
 * are not words, and an Indian audience reads `Pocso` as a typo.
 */
const ACRONYMS = new Set([
  'AI', 'BNS', 'BNSS', 'CCTV', 'CCTNS', 'CD', 'CNR', 'DNA', 'DVD', 'DVR', 'FIR', 'FSL', 'GPS', 'HDD',
  'ID', 'IMEI', 'IO', 'IP', 'IT', 'MMS', 'OTP', 'PDF', 'PII', 'PIS', 'POCSO', 'QR',
  'SHO', 'SIM', 'SP', 'SSD', 'UID', 'USB', 'UPI', 'URL',
]);

/**
 * Codes that are a single legal name rather than words to split. `SC_ST` is the
 * Scheduled Castes and Tribes (Prevention of Atrocities) Act; split, it read "Sc st".
 */
const WHOLE_CODES = Object.freeze({
  SC_ST: 'SC/ST',
  SPECIAL_SC_ST: 'Special (SC/ST)',
  SPECIAL_POCSO: 'Special (POCSO)',
  NDPS: 'NDPS',
});

/** SEIZED -> "Seized", REFERRED_TO_FSL -> "Referred to FSL", POCSO -> "POCSO". */
export const humanise = (code) =>
  !code
    ? ''
    : WHOLE_CODES[String(code)] ??
      String(code)
        .split('_')
        .filter(Boolean)
        .map((word, i) => {
          const upper = word.toUpperCase();
          if (ACRONYMS.has(upper)) return upper;
          const lower = word.toLowerCase();
          return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
        })
        .join(' ');

export function fmtDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export const shortHash = (value, keep = 12) =>
  !value ? '—' : `${value.slice(0, keep)}…${value.slice(-6)}`;
