/**
 * Batch download URL expansion using the `*` wildcard template.
 *
 * Reverse-engineered behaviour (spec §6, strings 1553/1547/1555): the user
 * supplies a template such as `http://host/pictures/img*.jpg`; the asterisk is
 * replaced by a zero-padded counter of the configured width, running between a
 * start and end value.
 */

export interface BatchSpec {
  /** URL template containing exactly one `*`. */
  template: string;
  /** First numeric value substituted for `*`. */
  from: number;
  /** Last numeric value (inclusive). */
  to: number;
  /**
   * Zero-pad width for the substituted number. `0` or a width narrower than the
   * number produces no padding, matching the original "wildcard length" field.
   */
  width: number;
  /** Optional non-numeric prefix/suffix behaviour is handled by the template. */
}

export interface BatchExpansion {
  urls: string[];
  /** Problems that prevented full expansion. */
  issues: string[];
}

export const BATCH_MAX_URLS = 5000;

/** Validate a template and expand it into concrete URLs. */
export function expandBatch(spec: BatchSpec): BatchExpansion {
  const issues: string[] = [];
  const template = spec.template.trim();

  if (!template) return { urls: [], issues: ['The URL template is empty.'] };

  const stars = (template.match(/\*/g) ?? []).length;
  if (stars === 0) {
    return { urls: [template], issues: [] };
  }
  if (stars > 1) {
    return { urls: [], issues: ['The template must contain at most one wildcard (*).'] };
  }
  if (!/^https?:\/\//i.test(template)) {
    return { urls: [], issues: ['Only http and https URLs can be added in a batch.'] };
  }
  if (!Number.isInteger(spec.from) || !Number.isInteger(spec.to)) {
    return { urls: [], issues: ['The range boundaries must be whole numbers.'] };
  }

  const low = Math.min(spec.from, spec.to);
  const high = Math.max(spec.from, spec.to);
  if (low < 0) return { urls: [], issues: ['The range must not contain negative numbers.'] };
  const count = high - low + 1;
  if (count > BATCH_MAX_URLS) {
    return { urls: [], issues: [`A batch is limited to ${BATCH_MAX_URLS} URLs; this range produces ${count}.`] };
  }

  const width = Math.max(0, Math.floor(spec.width));
  const urls: string[] = [];
  for (let value = low; value <= high; value += 1) {
    const text = width > 0 ? String(value).padStart(width, '0') : String(value);
    urls.push(template.replace('*', text));
  }
  return { urls, issues };
}

/** Derive a sensible default zero-pad width from the upper bound. */
export function suggestWidth(to: number): number {
  return Math.max(0, String(Math.abs(to)).length);
}