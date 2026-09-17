/**
 * Copy a value to the clipboard.
 *
 *   CopyButton     a small icon button: check mark and a short "Copied" toast on success.
 *   CopyableValue  the value (monospaced by default) followed by a CopyButton.
 *
 * Clicks and key presses never reach the surrounding element, so a copy inside a
 * clickable row copies and does nothing else. Inside an element that is itself a
 * `<button>` (a `Row` with `onSelect`), pass `nested` so the control renders as a
 * focusable span instead of an illegal button-in-button.
 */
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Check, Copy } from 'lucide-react';

import { Button, buttonVariants } from '@/components/ui/button';
import { copyText } from '@/lib/download';
import { cn } from '@/lib/utils';

const COPIED_MS = 1500;

/**
 * @param {object} props
 * @param {string} props.value
 * @param {string} [props.label='Copy']        accessible name, e.g. "Copy CNR"
 * @param {string} [props.size='icon-sm']      a Button size
 * @param {boolean} [props.nested=false]       render as a span (inside another button)
 */
export function CopyButton({ value, label = 'Copy', size = 'icon-sm', nested = false, className }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  if (value === null || value === undefined || value === '') return null;

  const copy = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (await copyText(value)) {
      setCopied(true);
      toast.success('Copied', { duration: COPIED_MS });
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    } else {
      toast.error('Could not copy');
    }
  };

  const onKeyDown = (event) => {
    // Enter on a focused copy control must not also open the row it sits in.
    event.stopPropagation();
    if (nested && (event.key === 'Enter' || event.key === ' ')) copy(event);
  };

  const icon = copied ? <Check className="text-ok" /> : <Copy />;
  const classes = cn('text-muted-foreground hover:text-foreground', className);

  if (nested) {
    return (
      <span
        role="button"
        tabIndex={0}
        aria-label={copied ? 'Copied' : label}
        title={label}
        onClick={copy}
        onKeyDown={onKeyDown}
        onPointerDown={(e) => e.stopPropagation()}
        className={cn(buttonVariants({ variant: 'ghost', size }), 'cursor-pointer', classes)}
      >
        {icon}
      </span>
    );
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size={size}
      aria-label={copied ? 'Copied' : label}
      title={label}
      onClick={copy}
      onKeyDown={onKeyDown}
      className={classes}
    >
      {icon}
    </Button>
  );
}

/**
 * A value with a copy button right after it.
 *
 * @param {object} props
 * @param {string} props.value
 * @param {React.ReactNode} [props.children]   what to show instead of the raw value (the value is still what is copied)
 * @param {boolean} [props.mono=true]
 * @param {string} [props.placeholder='—']
 * @param {string} [props.label]               accessible name of the button
 * @param {boolean} [props.nested]             see CopyButton
 * @param {boolean} [props.breakAll]           wrap long digests instead of overflowing
 */
export function CopyableValue({
  value,
  children,
  mono = true,
  placeholder = '—',
  label = 'Copy',
  nested = false,
  breakAll = false,
  className,
  valueClassName,
}) {
  if (value === null || value === undefined || value === '') {
    return <span className="text-muted-foreground">{placeholder}</span>;
  }
  return (
    <span className={cn('inline-flex min-w-0 max-w-full items-center gap-0.5 align-middle', className)}>
      <span className={cn('min-w-0', mono && 'font-mono', breakAll ? 'break-all' : 'truncate', valueClassName)}>
        {children ?? value}
      </span>
      <CopyButton
        value={value}
        label={label}
        nested={nested}
        size="icon-sm"
        className="size-6 shrink-0 [&_svg]:size-3.5"
      />
    </span>
  );
}
