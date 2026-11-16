/**
 * Material Design 3 primitives.
 *
 * Each component maps to one MD3 spec component and only carries the variants
 * this application uses. Accessibility props (role, aria-*) follow the spec
 * so the surface stays usable with a keyboard and a screen reader.
 */

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Icon, type IconName } from './icons';

/* ========================================================================== */
/* Buttons                                                                     */
/* ========================================================================== */

export type ButtonVariant = 'filled' | 'tonal' | 'outlined' | 'text' | 'elevated' | 'danger';

export function Button({
  variant = 'filled',
  icon,
  children,
  onClick,
  disabled,
  type = 'button',
  title,
  fullWidth,
}: {
  variant?: ButtonVariant;
  icon?: IconProp;
  children?: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: 'button' | 'submit';
  title?: string;
  fullWidth?: boolean;
}): React.ReactElement {
  return (
    <button
      type={type}
      className={`md-btn md-btn--${variant}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={fullWidth ? { width: '100%' } : undefined}
    >
      {icon !== undefined &&
        (isIconName(icon) ? (
          <Icon name={icon} size={18} />
        ) : (
          <span className="md-btn__icon" aria-hidden>{icon}</span>
        ))}
      {children}
    </button>
  );
}

/**
 * Icon props accept a Material icon *name* or a rendered element — never an
 * arbitrary string. Using ReactElement (not ReactNode) is what makes a misspelt
 * name like "adx" a compile error instead of a silent runtime fallback.
 */
type IconProp = IconName | React.ReactElement;

/** True when the prop is an icon *name* (a string) rather than a custom node. */
function isIconName(v: IconProp): v is IconName {
  return typeof v === 'string';
}

export function IconButton({
  icon,
  onClick,
  disabled,
  label,
  toggled,
  className,
  size = 20,
}: {
  /** Either a Material icon name or a custom node. */
  icon: IconProp;
  onClick?: () => void;
  disabled?: boolean;
  /** Accessible name; required because the button shows only an icon. */
  label: string;
  toggled?: boolean;
  className?: string;
  size?: number;
}): React.ReactElement {
  return (
    <button
      type="button"
      className={`md-icon-btn${toggled ? ' toggled' : ''}${className ? ` ${className}` : ''}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      aria-pressed={toggled === undefined ? undefined : toggled}
    >
      {isIconName(icon) ? <Icon name={icon} size={size} /> : icon}
    </button>
  );
}

export function Fab({
  icon,
  children,
  onClick,
  size = 'regular',
  label,
}: {
  icon: IconProp;
  children?: React.ReactNode;
  onClick?: () => void;
  size?: 'regular' | 'small';
  label?: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      className={`md-fab${size === 'small' ? ' md-fab--small' : ''}`}
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      {isIconName(icon) ? (
        <Icon name={icon} size={24} />
      ) : (
        <span aria-hidden style={{ fontSize: 20, lineHeight: 1 }}>{icon}</span>
      )}
      {children}
    </button>
  );
}

/* ========================================================================== */
/* Text fields                                                                 */
/* ========================================================================== */

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  disabled,
  help,
  error,
  mono,
  rows,
}: {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: 'text' | 'password' | 'number' | 'time' | 'datetime-local';
  disabled?: boolean;
  help?: string;
  error?: string;
  mono?: boolean;
  /** When set the control renders as a textarea with this many rows. */
  rows?: number;
}): React.ReactElement {
  const id = useId();
  const common = {
    id,
    value,
    disabled,
    placeholder,
    style: mono ? { fontFamily: 'var(--md-font-mono)', fontSize: 13 } : undefined,
  };
  return (
    <div className="md-field">
      {label && (
        <label className="md-field__label" htmlFor={id}>
          {label}
        </label>
      )}
      {rows ? (
        <textarea
          {...common}
          rows={rows}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={!!error}
        />
      ) : (
        <input
          {...common}
          type={type}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={!!error}
        />
      )}
      {(help || error) && (
        <div className={`md-field__help${error ? ' error' : ''}`}>{error ?? help}</div>
      )}
    </div>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step,
  disabled,
  help,
}: {
  label?: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  help?: string;
}): React.ReactElement {
  const id = useId();
  return (
    <div className="md-field">
      {label && (
        <label className="md-field__label" htmlFor={id}>
          {label}
        </label>
      )}
      <input
        id={id}
        type="number"
        value={Number.isFinite(value) ? value : 0}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(e) => {
          const n = Number(e.target.value);
          // An empty field is reported as 0 rather than NaN so callers keep a
          // numeric invariant; clamping happens at the call site.
          onChange(Number.isFinite(n) ? n : 0);
        }}
      />
      {help && <div className="md-field__help">{help}</div>}
    </div>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  help,
}: {
  label?: string;
  value: T;
  options: Array<{ value: T; label: string; disabled?: boolean }>;
  onChange: (value: T) => void;
  disabled?: boolean;
  help?: string;
}): React.ReactElement {
  const id = useId();
  return (
    <div className="md-field">
      {label && (
        <label className="md-field__label" htmlFor={id}>
          {label}
        </label>
      )}
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      {help && <div className="md-field__help">{help}</div>}
    </div>
  );
}

export function SearchBar({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}): React.ReactElement {
  return (
    <div className="md-search">
      <Icon name="search" size={20} style={{ color: 'var(--md-on-surface-variant)', flex: '0 0 auto' }} />
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        aria-label={placeholder ?? 'Search'}
      />
    </div>
  );
}

/* ========================================================================== */
/* Selection controls                                                          */
/* ========================================================================== */

export function Checkbox({
  checked,
  onChange,
  children,
  supporting,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: React.ReactNode;
  supporting?: string;
  disabled?: boolean;
}): React.ReactElement {
  const id = useId();
  return (
    <label className="md-check" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="md-check__box" aria-hidden />
      <span className="md-check__text">
        {children}
        {supporting && <small>{supporting}</small>}
      </span>
    </label>
  );
}

export function FilterChip({
  label,
  selected,
  onClick,
  icon,
}: {
  label: string;
  selected?: boolean;
  onClick?: () => void;
  icon?: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      className={`md-chip${selected ? ' selected' : ''}`}
      onClick={onClick}
      aria-pressed={!!selected}
    >
      {selected && <Icon name="check" size={16} />}
      {icon && <span aria-hidden>{icon}</span>}
      {label}
    </button>
  );
}

/* ========================================================================== */
/* Progress                                                                    */
/* ========================================================================== */

export function LinearProgress({
  value,
  variant,
  height,
}: {
  /** 0–100; pass NaN for an indeterminate look (rendered as 0). */
  value: number;
  variant?: 'completed' | 'error' | 'paused';
  height?: number;
}): React.ReactElement {
  const pct = Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
  return (
    <div
      className="md-linear-progress"
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      style={height ? { height } : undefined}
    >
      <div
        className={`md-linear-progress__bar${variant ? ` ${variant}` : ''}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function CircularProgress(): React.ReactElement {
  return <span className="md-circular-progress" role="progressbar" aria-label="Loading" />;
}

export function StatusBadge({
  status,
  label,
}: {
  status: string;
  label: string;
}): React.ReactElement {
  return <span className={`md-badge ${status}`}>{label}</span>;
}

/* ========================================================================== */
/* Dialog                                                                      */
/* ========================================================================== */

export function Dialog({
  headline,
  subhead,
  children,
  actions,
  onClose,
  size = 'regular',
  dismissOnScrimClick = true,
}: {
  headline: React.ReactNode;
  subhead?: React.ReactNode;
  children: React.ReactNode;
  actions?: React.ReactNode;
  onClose: () => void;
  size?: 'regular' | 'wide' | 'narrow';
  dismissOnScrimClick?: boolean;
}): React.ReactElement {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Move focus into the dialog so keyboard users land inside it.
  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    const target = node.querySelector<HTMLElement>(
      'input:not([type="hidden"]), select, textarea, button',
    );
    target?.focus();
  }, []);

  return (
    <div
      className="md-scrim"
      onMouseDown={(e) => {
        if (dismissOnScrimClick && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={`md-dialog${size === 'wide' ? ' md-dialog--wide' : size === 'narrow' ? ' md-dialog--narrow' : ''}`}
        role="dialog"
        aria-modal="true"
      >
        <div className="md-dialog__header">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="md-dialog__headline">{headline}</div>
            {subhead && <div className="md-dialog__subhead">{subhead}</div>}
          </div>
          <IconButton icon="close" onClick={onClose} label="关闭" />
        </div>
        <div className="md-dialog__content">{children}</div>
        {actions && <div className="md-dialog__actions">{actions}</div>}
      </div>
    </div>
  );
}

/* ========================================================================== */
/* Tabs                                                                        */
/* ========================================================================== */

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: Array<{ id: T; label: string }>;
  value: T;
  onChange: (id: T) => void;
}): React.ReactElement {
  return (
    <div className="md-tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={value === t.id}
          className="md-tab"
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/* ========================================================================== */
/* Snackbar                                                                    */
/* ========================================================================== */

export interface SnackbarMessage {
  id: string;
  message: string;
  kind: 'info' | 'success' | 'error';
}

export function SnackbarStack({
  messages,
  onDismiss,
}: {
  messages: SnackbarMessage[];
  onDismiss: (id: string) => void;
}): React.ReactElement | null {
  if (messages.length === 0) return null;
  return (
    <div className="md-snackbar-stack" role="status" aria-live="polite">
      {messages.slice(-3).map((m) => (
        <div
          key={m.id}
          className={`md-snackbar${m.kind !== 'info' ? ` md-snackbar--${m.kind}` : ''}`}
        >
          <span className="md-snackbar__text">{m.message}</span>
          <button
            type="button"
            className="md-snackbar__action"
            onClick={() => onDismiss(m.id)}
          >
            关闭
          </button>
        </div>
      ))}
    </div>
  );
}

/* ========================================================================== */
/* Navigation rail                                                             */
/* ========================================================================== */

export interface RailItem<T extends string> {
  id: T;
  label: string;
  icon: IconProp;
  count?: number;
}

export function NavigationRail<T extends string>({
  items,
  value,
  onChange,
  header,
  footer,
}: {
  items: RailItem<T>[];
  value: T;
  onChange: (id: T) => void;
  header?: React.ReactNode;
  footer?: React.ReactNode;
}): React.ReactElement {
  return (
    <nav className="md-nav-rail" aria-label="主要导航">
      {header}
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="md-nav-rail__item"
          aria-current={value === item.id ? 'page' : undefined}
          onClick={() => onChange(item.id)}
          title={item.label}
        >
          <span className="md-nav-rail__indicator">
            <span className="md-nav-rail__icon" aria-hidden>
              {isIconName(item.icon) ? (
                <Icon name={item.icon} size={22} />
              ) : (
                item.icon
              )}
            </span>
            {!!item.count && item.count > 0 && (
              <span className="md-nav-rail__count" aria-label={`${item.count} items`}>
                {item.count > 99 ? '99+' : item.count}
              </span>
            )}
          </span>
          <span className="md-nav-rail__label">{item.label}</span>
        </button>
      ))}
      {footer && (
        <>
          <hr className="md-nav-rail__divider" />
          {footer}
        </>
      )}
    </nav>
  );
}

/* ========================================================================== */
/* List                                                                        */
/* ========================================================================== */

export function List({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="md-list">{children}</div>;
}

export function ListItem({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick?: () => void;
}): React.ReactElement {
  return (
    <div
      className="md-list-item"
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      style={onClick ? { cursor: 'pointer' } : undefined}
    >
      {children}
    </div>
  );
}

/* ========================================================================== */
/* Section helpers                                                             */
/* ========================================================================== */

export function SectionTitle({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="md-section-title">{children}</div>;
}

export function Supporting({ children }: { children: React.ReactNode }): React.ReactElement {
  return <p className="md-supporting">{children}</p>;
}

/** A confirm dialog used for destructive actions. */
export function ConfirmDialog({
  headline,
  body,
  confirmLabel,
  destructive,
  onConfirm,
  onCancel,
}: {
  headline: string;
  body: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): React.ReactElement {
  return (
    <Dialog
      headline={headline}
      size="narrow"
      onClose={onCancel}
      actions={
        <>
          <Button variant="text" onClick={onCancel}>取消</Button>
          <Button variant={destructive ? 'danger' : 'filled'} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="md-supporting" style={{ margin: 0 }}>{body}</p>
    </Dialog>
  );
}

/** Small helper for delayed hover state used by the app bar elevation. */
export function useScrolled(threshold = 4): boolean {
  const [scrolled, setScrolled] = useState(false);
  const onScroll = useCallback(() => {
    setScrolled(window.scrollY > threshold);
  }, [threshold]);
  useEffect(() => {
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [onScroll]);
  return scrolled;
}
