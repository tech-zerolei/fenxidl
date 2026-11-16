/**
 * Material Design 3 primitives.
 *
 * Each component maps to one MD3 spec component and only carries the variants
 * this application uses. Accessibility props (role, aria-*) follow the spec
 * so the surface stays usable with a keyboard and a screen reader.
 */

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Icon, type IconName } from './icons';

/** Selector for everything that can receive keyboard focus inside a subtree. */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Focusable descendants that are actually rendered (not display:none). */
function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

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
  // The input keeps its own draft string so the field can be emptied while
  // typing. A controlled number value cannot represent "empty": deleting the
  // last digit produced 0, which re-rendered as a literal "0" and made the
  // caret jump in front of it, so the value could never be cleared.
  const [draft, setDraft] = useState<string>(() => (Number.isFinite(value) ? String(value) : ''));
  const [focused, setFocused] = useState(false);

  // While focused the draft is authoritative; when the caller changes the value
  // from outside (e.g. a reset), mirror it.
  useEffect(() => {
    if (!focused) setDraft(Number.isFinite(value) ? String(value) : '');
  }, [value, focused]);

  /**
   * Push a draft string to the caller.
   *
   * An empty draft must stay empty *in the field* while the user is typing, so
   * it deliberately does not call onChange: doing so re-rendered the value as
   * the minimum and the caret jumped in front of it, which is why the field
   * could never be cleared. Callers keep their numeric invariant because the
   * last committed number is still theirs, and blur re-normalises the text.
   */
  const commit = (raw: string): void => {
    if (raw.trim() === '') return;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return;
    onChange(Math.min(max ?? Number.MAX_SAFE_INTEGER, Math.max(min ?? -Number.MAX_SAFE_INTEGER, parsed)));
  };

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
        inputMode="numeric"
        value={draft}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        aria-describedby={help ? `${id}-help` : undefined}
        onFocus={() => setFocused(true)}
        onChange={(e) => {
          setDraft(e.target.value);
          commit(e.target.value);
        }}
        onBlur={() => {
          setFocused(false);
          // Leaving the field empty shows the value that will actually be used
          // (the last committed one), so the field never lies about the state.
          if (draft.trim() === '') {
            setDraft(Number.isFinite(value) ? String(value) : String(min ?? 0));
            return;
          }
          const parsed = Number.parseInt(draft, 10);
          if (Number.isFinite(parsed)) {
            const clamped = Math.min(max ?? Number.MAX_SAFE_INTEGER, Math.max(min ?? -Number.MAX_SAFE_INTEGER, parsed));
            setDraft(String(clamped));
            if (clamped !== value) onChange(clamped);
          } else {
            setDraft(Number.isFinite(value) ? String(value) : String(min ?? 0));
          }
        }}
      />
      {help && (
        <div className="md-field__help" id={`${id}-help`}>
          {help}
        </div>
      )}
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
  label = '搜索',
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Accessible name; falls back to a Chinese default, never English. */
  label?: string;
}): React.ReactElement {
  return (
    <div className="md-search">
      <Icon name="search" size={20} style={{ color: 'var(--md-on-surface-variant)', flex: '0 0 auto' }} />
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
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

export function CircularProgress({ label = '正在加载' }: { label?: string } = {}): React.ReactElement {
  return <span className="md-circular-progress" role="progressbar" aria-label={label} />;
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
  const headlineRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const headlineId = useId();
  // Most call sites recreate `onClose` on every render; the key listener reads
  // it through a ref so the handler (and the trap it implements) is installed
  // exactly once for the dialog's lifetime.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  /* Remember the element that had focus before the dialog opened and give it
     back on unmount. Without this, closing dropped focus on <body> and the
     keyboard user restarted the tab order from the top of the window. */
  useEffect(() => {
    const active = document.activeElement;
    restoreRef.current = active instanceof HTMLElement ? active : null;
    return () => {
      const target = restoreRef.current;
      restoreRef.current = null;
      // A trigger that has since been removed must not throw, and focus must
      // never be handed to a detached node.
      if (target && document.body.contains(target)) {
        target.focus({ preventScroll: true });
      }
    };
  }, []);

  /* Escape closes, and Tab/Shift+Tab cycle inside the dialog.

     `aria-modal="true"` promises assistive technology that the rest of the
     document is inert, so focus has to actually stay inside; the previous
     build let one Tab reach the search box behind the scrim. Capture phase is
     used so nothing deeper can pre-empt the wrap-around. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const node = dialogRef.current;
      if (!node) return;

      const items = focusableWithin(node);
      if (items.length === 0) {
        // Nothing focusable: hold focus on the dialog container itself.
        e.preventDefault();
        node.focus({ preventScroll: true });
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;

      // Focus outside the dialog (or nowhere): pull it back to an edge.
      if (!active || !node.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  /* Initial focus.

     Prefer the first real control inside the content area (a dialog that asks
     for input should start typing immediately). Dialogues without a control —
     About, confirmations — focus the headline instead of the close button, so
     a screen reader announces the dialog's name. */
  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    const preferred = node.querySelector<HTMLElement>(
      '.md-dialog__content input:not([type="hidden"]):not([disabled]),'
      + ' .md-dialog__content select:not([disabled]),'
      + ' .md-dialog__content textarea:not([disabled]),'
      + ' .md-dialog__content button:not([disabled]),'
      + ' .md-dialog__actions button:not([disabled])',
    );
    if (preferred) {
      preferred.focus({ preventScroll: true });
      return;
    }
    const heading = headlineRef.current;
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
      return;
    }
    node.focus({ preventScroll: true });
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
        aria-labelledby={headlineId}
        tabIndex={-1}
      >
        <div className="md-dialog__header">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="md-dialog__headline" id={headlineId} ref={headlineRef}>
              {headline}
            </div>
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

export interface RailGroup<T extends string> {
  key: string;
  label: string;
  icon?: IconName;
  headline?: string;
  items: RailItem<T>[];
}

/**
 * MD3 navigation rail.
 *
 * MD3 caps a rail at 3–7 destinations, and this window can be as short as
 * 520px, so the seven file-type filters are folded into one `group` entry that
 * opens a flyout panel beside the rail. The rail therefore keeps a constant
 * height (3 primary views + 1 group entry + the About footer), and every entry
 * stays reachable at any window size without relying on an invisible scroll.
 *
 * The panel is `position: fixed` and placed from the trigger's measured rect,
 * so it can never be clipped by the rail's own `overflow: auto`.
 */
export function NavigationRail<T extends string>({
  items,
  value,
  onChange,
  header,
  footer,
  groups,
}: {
  items: RailItem<T>[];
  value: T;
  onChange: (id: T) => void;
  header?: React.ReactNode;
  footer?: React.ReactNode;
  /** Secondary destinations folded behind one expanding entry. */
  groups?: Array<RailGroup<T>>;
}): React.ReactElement {
  const railRef = useRef<HTMLElement>(null);
  const groupTriggers = useRef(new Map<string, HTMLButtonElement>());
  const panelRef = useRef<HTMLDivElement>(null);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [placement, setPlacement] = useState<{ left: number; top: number; maxHeight: number } | null>(null);

  // Re-anchor (or dismiss) the flyout when the window resizes: a stale fixed
  // position would point at nothing after the rail moves.
  useEffect(() => {
    if (openGroup === null) return;
    const place = (): void => {
      const trigger = groupTriggers.current.get(openGroup);
      if (!trigger) return;
      const r = trigger.getBoundingClientRect();
      const top = Math.max(8, Math.min(r.top, window.innerHeight - 160));
      setPlacement({
        left: r.right + 8,
        top,
        maxHeight: Math.max(160, window.innerHeight - top - 12),
      });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [openGroup]);

  // Esc closes the flyout and hands focus back to its trigger; a pointerdown
  // anywhere outside the panel does the same.
  useEffect(() => {
    if (openGroup === null) return;
    const trigger = groupTriggers.current.get(openGroup);
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      setOpenGroup(null);
      trigger?.focus();
    };
    const onPointerDown = (e: PointerEvent): void => {
      const panel = panelRef.current;
      if (panel && panel.contains(e.target as Node)) return;
      if (trigger && trigger.contains(e.target as Node)) return;
      setOpenGroup(null);
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [openGroup]);

  // Move focus into the panel when it opens so keyboard users land on the
  // first choice rather than being left on the trigger.
  useEffect(() => {
    if (openGroup === null || !placement) return;
    const first = panelRef.current?.querySelector<HTMLElement>('.md-rail-category-panel__item');
    first?.focus({ preventScroll: true });
  }, [openGroup, placement]);

  const renderItem = (item: RailItem<T>): React.ReactElement => (
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
          {isIconName(item.icon) ? <Icon name={item.icon} size={22} /> : item.icon}
        </span>
        {!!item.count && item.count > 0 && (
          <span className="md-nav-rail__count" aria-label={`${item.count} 个项目`}>
            {item.count > 99 ? '99+' : item.count}
          </span>
        )}
      </span>
      <span className="md-nav-rail__label">{item.label}</span>
    </button>
  );

  const openGroupDef = (groups ?? []).find((g) => g.key === openGroup) ?? null;

  return (
    <div className="md-nav-rail-wrap">
      <nav className="md-nav-rail" aria-label="主要导航" ref={railRef}>
        {header}
        <div className="md-nav-rail__scroll">
          {items.map(renderItem)}
          {(groups ?? []).map((group) => {
            const expanded = openGroup === group.key;
            const active = group.items.some((i) => i.id === value);
            const total = group.items.reduce((sum, i) => sum + (i.count ?? 0), 0);
            return (
              <button
                key={group.key}
                type="button"
                ref={(el) => {
                  if (el) groupTriggers.current.set(group.key, el);
                  else groupTriggers.current.delete(group.key);
                }}
                className="md-nav-rail__item md-nav-rail__item--group"
                data-rail-category={group.key}
                data-active-group={active ? 'true' : undefined}
                aria-expanded={expanded}
                aria-haspopup="true"
                aria-controls={expanded ? `rail-group-${group.key}` : undefined}
                onClick={() => setOpenGroup((prev) => (prev === group.key ? null : group.key))}
                title={expanded ? `收起${group.label}` : `展开${group.label}`}
              >
                <span className="md-nav-rail__indicator">
                  <span className="md-nav-rail__icon" aria-hidden>
                    <Icon name={group.icon ?? 'category'} size={22} />
                  </span>
                  {!expanded && active && (
                    <span className="md-nav-rail__badge-dot" aria-hidden />
                  )}
                  {!expanded && total > 0 && (
                    <span className="md-nav-rail__count" aria-label={`${total} 个项目`}>
                      {total > 99 ? '99+' : total}
                    </span>
                  )}
                </span>
                <span className="md-nav-rail__label">{group.label}</span>
              </button>
            );
          })}
        </div>
        {footer && (
          <div className="md-nav-rail__footer">
            <hr className="md-nav-rail__divider" />
            {footer}
          </div>
        )}
      </nav>

      {openGroupDef && placement && (
        <div
          ref={panelRef}
          id={`rail-group-${openGroupDef.key}`}
          className="md-rail-category-panel"
          style={{ left: placement.left, top: placement.top, maxHeight: placement.maxHeight }}
          role="group"
          aria-label={openGroupDef.label}
        >
          <div className="md-rail-category-panel__headline" aria-hidden>
            {openGroupDef.headline ?? openGroupDef.label}
          </div>
          {openGroupDef.items.map((item) => (
            <button
              key={item.id}
              type="button"
              className="md-rail-category-panel__item"
              aria-current={value === item.id ? 'true' : undefined}
              onClick={() => {
                onChange(item.id);
                setOpenGroup(null);
                groupTriggers.current.get(openGroupDef.key)?.focus();
              }}
            >
              <span className="md-rail-category-panel__icon" aria-hidden>
                {isIconName(item.icon) ? <Icon name={item.icon} size={20} /> : item.icon}
              </span>
              <span className="md-rail-category-panel__label">{item.label}</span>
              {!!item.count && item.count > 0 && (
                <span className="md-rail-category-panel__count">{item.count}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
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
