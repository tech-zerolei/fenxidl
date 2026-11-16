/**
 * Central input validation and security policy for the main process.
 *
 * Every IPC handler must pass attacker-controlled values (the renderer is
 * treated as untrusted: it can be navigated to a remote page, XSS'd, or driven
 * by a compromised extension) through these helpers before they reach the
 * download engine, the filesystem or a child process.
 *
 * Design notes:
 *  - The module is pure Node (no `electron` import) so it can be unit tested
 *    and reused by the engine without pulling Electron into a test process.
 *  - Paths are always compared after `realpath` resolution when they exist, so
 *    a symlink cannot be used to hop out of an allowed root.
 *  - The allow-list is *functional*: the default download root, every
 *    configured category folder, the app's temp/userData folders, and any
 *    folder the user actually picked through a native dialog are writable.
 *    Everything else is refused, and a hard deny-list protects locations that
 *    turn a file write into code execution (cron, autostart, shell rc files,
 *    SSH keys...).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------- primitives

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function asString(v: unknown, field: string, maxLen = 8192): string {
  if (typeof v !== 'string') throw new Error(`${field} must be a string.`);
  if (v.length > maxLen) throw new Error(`${field} is too long.`);
  if (v.includes('\u0000')) throw new Error(`${field} contains an invalid character.`);
  return v;
}

export function asOptionalString(v: unknown, field: string, maxLen = 8192): string | undefined {
  if (v === undefined || v === null) return undefined;
  return asString(v, field, maxLen);
}

export function asStringOrNull(v: unknown, field: string, maxLen = 8192): string | null {
  if (v === undefined || v === null) return null;
  return asString(v, field, maxLen);
}

export function asNumber(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${field} must be a number.`);
  return v;
}

export function asInt(v: unknown, field: string, min: number, max: number): number {
  const n = asNumber(v, field);
  if (!Number.isInteger(n)) throw new Error(`${field} must be a whole number.`);
  if (n < min || n > max) throw new Error(`${field} must be between ${min} and ${max}.`);
  return n;
}

export function asOptionalInt(v: unknown, field: string, min: number, max: number): number | undefined {
  if (v === undefined || v === null) return undefined;
  return asInt(v, field, min, max);
}

export function asBoolean(v: unknown, field: string): boolean {
  if (typeof v !== 'boolean') throw new Error(`${field} must be true or false.`);
  return v;
}

export function asOptionalBoolean(v: unknown, field: string): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  return asBoolean(v, field);
}

export function asEnum<T extends string>(v: unknown, field: string, allowed: readonly T[]): T {
  const s = asString(v, field, 64);
  if (!(allowed as readonly string[]).includes(s)) {
    throw new Error(`${field} must be one of: ${allowed.join(', ')}.`);
  }
  return s as T;
}

export function asOptionalEnum<T extends string>(
  v: unknown,
  field: string,
  allowed: readonly T[],
): T | undefined {
  if (v === undefined || v === null) return undefined;
  return asEnum(v, field, allowed);
}

export function asArray<T>(v: unknown, field: string, maxItems: number): T[] {
  if (!Array.isArray(v)) throw new Error(`${field} must be a list.`);
  if (v.length > maxItems) throw new Error(`${field} has too many entries (max ${maxItems}).`);
  return v as T[];
}

// ---------------------------------------------------------------------- URLs

/** Strip nothing but reject anything that is not plain http(s). */
export function parseHttpUrl(raw: unknown, field = 'url'): URL {
  const text = asString(raw, field, 4096).trim();
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw new Error(`${field} must be a valid absolute URL, including http:// or https://.`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`${field} must use http:// or https://.`);
  }
  if (u.username || u.password) {
    // Credentials in the URL would leak into logs and be re-sent on redirects.
    throw new Error(`${field} must not embed a user name or password.`);
  }
  return u;
}

export function assertHttpUrl(raw: unknown, field = 'url'): string {
  return parseHttpUrl(raw, field).toString();
}

function ipv4ToInt(host: string): number | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value * 256) + n;
  }
  return value >>> 0;
}

/** Link-local / unspecified / multicast targets: never a legitimate download. */
const BLOCKED_V4: Array<[number, number]> = [
  [0x00000000, 0x00ffffff], // 0.0.0.0/8 "this network"
  [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16 link-local + cloud metadata
  [0xe0000000, 0xefffffff], // multicast
  [0xf0000000, 0xffffffff], // reserved / broadcast
];

/** Loopback: blocked for paths the renderer can point at an arbitrary host. */
const LOOPBACK_V4: Array<[number, number]> = [[0x7f000000, 0x7fffffff]];

export interface HostPolicyOptions {
  /** Also refuse loopback (127.0.0.0/8, ::1, localhost). */
  blockLoopback?: boolean;
  /**
   * Also refuse RFC 1918 private ranges (10/8, 172.16/12, 192.168/16).
   *
   * A download manager must be able to fetch from a NAS or intranet host, so
   * this is off by default. It is enabled for paths where the *page*, not the
   * user, chooses the URL: there an intranet address is an SSRF probe, not a
   * download.
   */
  blockPrivate?: boolean;
}

/** RFC 1918 private address ranges. */
const PRIVATE_V4: Array<[number, number]> = [
  [0x0a000000, 0x0affffff], // 10.0.0.0/8
  [0xac100000, 0xac1fffff], // 172.16.0.0/12
  [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16
];

function ipv6Kind(host: string): 'loopback' | 'linklocal' | 'unspecified' | 'other' {
  const h = host.toLowerCase();
  if (h === '::1') return 'loopback';
  if (h === '::' ) return 'unspecified';
  if (h.startsWith('fe80') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) return 'linklocal';
  if (h.startsWith('fd00:ec2')) return 'linklocal'; // AWS IMDS over IPv6
  if (h.startsWith('ff')) return 'linklocal'; // multicast
  return 'other';
}

/**
 * Refuse hosts that can never be a legitimate download target, and (optionally)
 * loopback addresses that let a page drive the app at local admin services.
 *
 * Private LAN ranges are deliberately allowed: downloading from a NAS or an
 * intranet server is a core feature of a download manager.
 */
export function assertOutboundHostAllowed(rawUrl: string, opts: HostPolicyOptions = {}): URL {
  const u = new URL(rawUrl);
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (host === 'localhost' || host.endsWith('.localhost')) {
    if (opts.blockLoopback) throw new Error('Requests to the local machine are not allowed here.');
    return u;
  }
  if (host === 'metadata.google.internal' || host === 'metadata' || host.endsWith('.metadata.google.internal')) {
    throw new Error('Requests to the cloud metadata endpoint are not allowed.');
  }
  if (host.includes(':')) {
    const kind = ipv6Kind(host);
    if (kind === 'unspecified' || kind === 'linklocal') {
      throw new Error('Requests to link-local or unspecified addresses are not allowed.');
    }
    if (kind === 'loopback' && opts.blockLoopback) {
      throw new Error('Requests to the local machine are not allowed here.');
    }
    return u;
  }
  const v4 = ipv4ToInt(host);
  if (v4 !== null) {
    for (const [lo, hi] of BLOCKED_V4) {
      if (v4 >= lo && v4 <= hi) {
        throw new Error('Requests to link-local, multicast or reserved addresses are not allowed.');
      }
    }
    if (opts.blockLoopback) {
      for (const [lo, hi] of LOOPBACK_V4) {
        if (v4 >= lo && v4 <= hi) throw new Error('Requests to the local machine are not allowed here.');
      }
    }
    if (opts.blockPrivate) {
      for (const [lo, hi] of PRIVATE_V4) {
        if (v4 >= lo && v4 <= hi) throw new Error('Requests to a private network address are not allowed here.');
      }
    }
    return u;
  }
  // Decimal / octal / hex IPv4 encodings resolve to the same address in some stacks.
  if (/^(0x[0-9a-f]+|\d+)$/i.test(host)) {
    throw new Error('Numeric host forms other than dotted IPv4 are not allowed.');
  }
  return u;
}

/**
 * Strict site matching for stored credentials.
 *
 * `url.includes(site)` let `http://evil.example/?bank.example` receive the
 * bank's Basic auth. Only an exact host or a real sub-domain may match.
 */
export function hostMatchesSite(host: string, site: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  const s = site
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
  if (!h || !s) return false;
  if (h === s) return true;
  return h.endsWith(`.${s}`);
}

/** Parse a `Host`-style value (may include a port) and match it strictly. */
export function urlMatchesSite(rawUrl: string, site: string): boolean {
  try {
    const u = new URL(rawUrl);
    return hostMatchesSite(u.hostname, site);
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------- paths

const POSIX_DENY_PREFIXES = [
  '/etc',
  '/boot',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib32',
  '/lib64',
  '/libx32',
  '/proc',
  '/sys',
  '/dev',
  '/root',
  '/run',
  '/var/lib',
  '/var/spool/cron',
  '/var/spool/at',
  '/var/at',
  '/snap',
  '/System',
  '/Library/LaunchDaemons',
  '/Library/LaunchAgents',
  '/private/etc',
  '/private/var/root',
];

/**
 * Path segments that make a write lead to code execution or secret theft.
 * Deliberately narrow: system-wide locations such as /etc and /usr already
 * carry a prefix deny, so only user-scoped high-value folders are listed here
 * (a plain download folder named "videos" must never be caught by this).
 */
const DENY_SEGMENTS = new Set([
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.password-store',
  '.config/autostart',
  'autostart',
  'autostart-scripts',
  'launchagents',
  'launchdaemons',
  'start menu',
  '.config/systemd',
  '.local/share/applications',
  '.local/bin',
]);

/** Basenames that must never be written: they run on login or on shell start. */
const DENY_BASENAMES = new Set([
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.bash_logout',
  '.profile',
  '.zshrc',
  '.zshenv',
  '.zprofile',
  '.zlogin',
  '.cshrc',
  '.tcshrc',
  '.kshrc',
  '.xprofile',
  '.xsession',
  '.xinitrc',
  '.environment',
  'authorized_keys',
  'crontab',
  'desktop.ini',
]);

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

function normalizeForCompare(p: string): string {
  const resolved = path.resolve(p);
  const posix = toPosix(resolved);
  return process.platform === 'win32' ? posix.toLowerCase() : posix;
}

/** Resolve symlinks for the longest existing prefix so a link cannot escape. */
export function safeResolve(target: string): string {
  const absolute = path.resolve(target);
  let current = absolute;
  const suffix: string[] = [];
  for (let i = 0; i < 64; i += 1) {
    try {
      const real = fs.realpathSync.native(current);
      return suffix.length ? path.join(real, ...suffix.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      suffix.push(path.basename(current));
      current = parent;
    }
  }
  return absolute;
}

/**
 * True for locations where a downloaded file becomes code execution (cron,
 * autostart, shell rc files, SSH authorized_keys, system directories).
 */
export function isSensitivePath(target: string): boolean {
  const resolved = normalizeForCompare(safeResolve(target));
  for (const prefix of POSIX_DENY_PREFIXES) {
    const deny = process.platform === 'win32' ? prefix.toLowerCase() : prefix;
    if (resolved === deny || resolved.startsWith(`${deny}/`)) return true;
  }
  const winRoot = process.env.SystemRoot ?? process.env.windir;
  if (process.platform === 'win32' && winRoot) {
    const root = normalizeForCompare(winRoot);
    if (resolved === root || resolved.startsWith(`${root}/`)) return true;
  }
  const segments = resolved.split('/').filter(Boolean);
  const lowerSegments = segments.map((s) => s.toLowerCase());
  for (const segment of lowerSegments) {
    if (DENY_SEGMENTS.has(segment)) return true;
  }
  // Multi-segment deny entries such as ".config/autostart".
  const joined = `/${lowerSegments.join('/')}`;
  for (const deny of DENY_SEGMENTS) {
    if (deny.includes('/') && (joined.includes(`/${deny}/`) || joined.endsWith(`/${deny}`))) return true;
  }
  const base = lowerSegments[lowerSegments.length - 1] ?? '';
  if (DENY_BASENAMES.has(base)) return true;
  return false;
}

export function isWithin(root: string, target: string): boolean {
  const r = normalizeForCompare(safeResolve(root));
  const t = normalizeForCompare(safeResolve(target));
  if (r === t) return true;
  return t.startsWith(r.endsWith('/') ? r : `${r}/`);
}

export interface DirectoryPolicy {
  /** Directories writes are allowed inside. */
  roots: string[];
  /**
   * Also allow folders under the user's home directory that are not hidden.
   *
   * A download manager legitimately lets the user type a save folder (the
   * batch and site-grabber dialogs are free-text), so refusing anything outside
   * the configured roots alone would break normal use. Hidden folders are still
   * refused: on Unix they hold per-application configuration, credentials and
   * autostart entries, which is exactly where a compromised renderer would aim.
   */
  allowHomeSubtree?: boolean;
}

/** Any `.hidden` path segment inside the home directory. */
function hasHiddenSegment(relative: string): boolean {
  return relative
    .split('/')
    .filter(Boolean)
    .some((segment) => segment.startsWith('.'));
}

export function assertSafePath(target: unknown, field: string, policy: DirectoryPolicy): string {
  const raw = asString(target, field, 4096).trim();
  if (!raw) throw new Error(`${field} must not be empty.`);
  if (raw.includes('\u0000')) throw new Error(`${field} contains an invalid character.`);
  if (!path.isAbsolute(raw) && !raw.startsWith('~')) {
    throw new Error(`${field} must be an absolute path.`);
  }
  const expanded = raw.startsWith('~')
    ? path.join(os.homedir(), raw.replace(/^~[\\/]?/, ''))
    : raw;
  const resolved = safeResolve(expanded);
  if (isSensitivePath(resolved)) {
    throw new Error(`${field} points at a protected system location.`);
  }
  const allowed = policy.roots.some((root) => {
    try {
      return isWithin(root, resolved);
    } catch {
      return false;
    }
  });
  if (allowed) return resolved;

  if (policy.allowHomeSubtree) {
    const home = safeResolve(os.homedir());
    if (isWithin(home, resolved)) {
      const relative = normalizeForCompare(resolved).slice(normalizeForCompare(home).length);
      if (!hasHiddenSegment(relative)) return resolved;
      throw new Error(`${field} must not point into a hidden folder.`);
    }
  }
  throw new Error(
    `${field} must be a folder you can write to: your download folder, ` +
      'one of its sub-folders, or a folder picked with the folder button.',
  );
}

/** Validate a file name that will be joined onto a directory. */
export function assertSafeFileName(name: unknown, field = 'fileName'): string {
  const raw = asString(name, field, 260).trim();
  if (!raw) throw new Error(`${field} must not be empty.`);
  if (raw === '.' || raw === '..') throw new Error(`${field} is not a valid file name.`);
  // eslint-disable-next-line no-control-regex
  if (/[\\/\u0000-\u001f<>:"|?*]/.test(raw)) {
    throw new Error(`${field} must be a plain file name without path separators.`);
  }
  if (process.platform === 'win32' && /[. ]$/.test(raw)) {
    throw new Error(`${field} must not end with a dot or space.`);
  }
  return raw;
}

/** HTTP headers a renderer must never set (they would rewrite the request). */
const FORBIDDEN_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'upgrade',
  'expect',
  'te',
  'trailer',
  'proxy-authorization',
  'proxy-connection',
  // Credential headers (V-07). The engine already drops `username/password` and
  // the range headers when a redirect crosses origins, but a custom header
  // record travels through `options.headers`, which that filter does not cover:
  // a task carrying `Authorization: Bearer ...` or `Cookie: ...` would send it
  // to whatever host the redirect names. Credentials belong in the task's
  // `username`/`password` fields or the site credential store, both of which are
  // matched against the *original* host, so nothing legitimate is lost here —
  // the new-task dialog has no free-form header editor.
  'authorization',
  'cookie',
]);

export function sanitizeHeaderRecord(
  raw: unknown,
  field = 'headers',
  maxEntries = 64,
): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw new Error(`${field} must be an object of string values.`);
  const entries = Object.entries(raw);
  if (entries.length > maxEntries) throw new Error(`${field} has too many entries.`);
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    const name = asString(key, `${field} name`, 128).trim();
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
      throw new Error(`${field} contains an invalid header name.`);
    }
    if (FORBIDDEN_HEADERS.has(name.toLowerCase())) {
      throw new Error(`${field} must not override the ${name} header.`);
    }
    const text = asString(value, `${field}.${name}`, 4096);
    if (/[\r\n]/.test(text)) throw new Error(`${field}.${name} must not contain line breaks.`);
    out[name] = text;
  }
  return out;
}

// ------------------------------------------------------------ child processes

/** Interpreters and shell launchers: never a legitimate virus scanner. */
const PROGRAM_DENY = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'tcsh', 'fish', 'ash', 'busybox',
  'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe',
  'wscript', 'wscript.exe', 'cscript', 'cscript.exe', 'mshta', 'mshta.exe',
  'rundll32', 'rundll32.exe', 'regsvr32', 'regsvr32.exe',
  'osascript', 'open', 'xdg-open', 'gio', 'env', 'nohup', 'setsid',
  'python', 'python3', 'python.exe', 'perl', 'ruby', 'node', 'node.exe',
  'find', 'xargs', 'tar', 'curl', 'wget', 'chmod', 'chown', 'cp', 'mv', 'ln',
]);

const TEMP_MARKERS = [
  os.tmpdir(),
  '/tmp',
  '/var/tmp',
  '/dev/shm',
  '/run/user',
  'windows/temp',
  'appdata/local/temp',
  'users/public',
];

/** Secret/autostart folders: never a place a scanner binary should live. */
const PROGRAM_DENY_SEGMENTS = new Set([
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.password-store',
  '.config/autostart',
  'autostart',
  'launchagents',
  'launchdaemons',
  'start menu',
]);

/**
 * Validate a scanner/helper program path.
 *
 * This is deliberately *not* the download path policy: a real antivirus lives
 * in `/usr/bin`, `/opt` or `C:\Program Files`, so those stay allowed. What is
 * refused is the set of choices that turn "scan finished downloads" into
 * arbitrary code execution:
 *   - shells and interpreters (`/bin/sh -c ...` needs no other trick);
 *   - executables in a shared temp folder or any world-writable directory,
 *     because another local user could plant them;
 *   - paths inside credential/autostart folders.
 *
 * The renderer also controls the argument template, so keeping shells out is
 * what stops `program + args` from becoming a command line.
 */
export function assertExecutableProgram(program: unknown, field = 'virusScan.program'): string {
  const raw = asString(program, field, 1024).trim();
  if (!raw) throw new Error(`${field} must not be empty.`);
  if (!path.isAbsolute(raw)) throw new Error(`${field} must be an absolute path.`);
  const resolved = safeResolve(raw);
  const lower = normalizeForCompare(resolved);
  for (const marker of TEMP_MARKERS) {
    const m = process.platform === 'win32' ? marker.toLowerCase() : marker;
    if (lower === m || lower.startsWith(`${m}/`)) {
      throw new Error(`${field} must not point into a temporary folder.`);
    }
  }
  const segments = lower.split('/').filter(Boolean);
  if (segments.some((segment) => PROGRAM_DENY_SEGMENTS.has(segment))) {
    throw new Error(`${field} must not point at a credential or autostart folder.`);
  }
  const base = path.basename(resolved).toLowerCase();
  if (PROGRAM_DENY.has(base)) {
    throw new Error(`${field} must be a dedicated scanner, not a shell or interpreter.`);
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`${field} does not exist.`);
  }
  if (!stat.isFile()) throw new Error(`${field} must be a regular file.`);
  try {
    fs.accessSync(resolved, fs.constants.X_OK);
  } catch {
    throw new Error(`${field} is not executable.`);
  }
  // A world-writable folder lets any local account replace the binary.
  try {
    const dirStat = fs.statSync(path.dirname(resolved));
    if (process.platform !== 'win32' && (dirStat.mode & 0o002) !== 0) {
      throw new Error(`${field} must not live in a world-writable folder.`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(field)) throw err;
  }
  return resolved;
}

/**
 * Split a scanner argument template into an argv array.
 *
 * The old code did `args.split(/\s+/)`, which tore `/tmp/a b.bin` into two
 * arguments. Here quoting is honoured and `%f` expands to exactly one argument
 * holding the whole file path.
 */
export function buildScanArgv(argsTemplate: unknown, filePath: string): string[] {
  const template = typeof argsTemplate === 'string' ? argsTemplate : '';
  if (!template.trim()) return [filePath];
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const ch of template) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started || current) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started || current) tokens.push(current);
  const expanded = tokens.map((token) => (token.includes('%f') ? token.split('%f').join(filePath) : token));
  if (!expanded.some((t) => t.includes(filePath))) expanded.push(filePath);
  return expanded;
}

// ----------------------------------------------------------------- file modes

/** Restrict a sensitive file to the current user (no-op on Windows ACLs). */
export function hardenFilePermissions(target: string, mode = 0o600): void {
  if (process.platform === 'win32') return;
  try {
    fs.chmodSync(target, mode);
  } catch {
    /* best effort: the file may not exist yet */
  }
}

export const FENXI_ENC_PREFIX = 'fenxi-enc:v1:';

export interface SecretCodec {
  /** Encrypt plaintext into a storable string; null when encryption is unavailable. */
  protect: (plain: string) => string | null;
  /** Decrypt a stored string; throws when it cannot be decrypted. */
  unprotect: (stored: string) => string;
}

/** Encrypt a secret for disk storage, or return null when unavailable. */
export function protectSecret(value: string, codec: SecretCodec | null): string | null {
  if (!value) return '';
  if (!codec) return null;
  return codec.protect(value);
}

export function unprotectSecret(stored: string, codec: SecretCodec | null): string {
  if (!stored) return '';
  if (!stored.startsWith(FENXI_ENC_PREFIX)) return stored;
  if (!codec) throw new Error('Stored secret cannot be decrypted without OS encryption.');
  return codec.unprotect(stored);
}