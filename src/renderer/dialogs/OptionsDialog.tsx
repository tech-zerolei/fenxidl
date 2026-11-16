/**
 * Options dialog with the seven tabs observed in the original (spec §9):
 * General, Connection, Downloads, Proxy, Sites, Dial-up, Sounds.
 *
 * Rebuilt on MD3 primitives: primary tabs, outlined fields, checkboxes,
 * section titles and a scrollable content area. All settings behaviour is
 * unchanged from the previous implementation.
 */

import React, { useState } from 'react';
import type { AppSettings, IpcResult, ProxySettings, Queue } from '../../shared/types';
import {
  Button,
  Checkbox,
  Dialog,
  List,
  ListItem,
  NumberField,
  SectionTitle,
  SelectField,
  Supporting,
  Tabs,
  TextField,
} from '../md3/components';

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = await window.fenxi.invoke<IpcResult<T>>(channel, ...args);
  if (!res.ok) throw new Error(res.error);
  return res.value;
}

type TabId = 'general' | 'connection' | 'downloads' | 'proxy' | 'sites' | 'dialup' | 'sounds';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'general', label: '常规' },
  { id: 'connection', label: '连接' },
  { id: 'downloads', label: '下载' },
  { id: 'proxy', label: '代理' },
  { id: 'sites', label: '站点管理' },
  { id: 'dialup', label: '拨号连接' },
  { id: 'sounds', label: '声音事件' },
];

const CONNECTION_TYPES = [
  { value: 'unlimited', label: '不限制' },
  { value: '256k', label: '256K Cable/DSL/其他' },
  { value: '300k', label: '300K Cable/DSL/其他' },
  { value: '512k', label: '512K Cable/DSL/其他' },
  { value: '1m', label: '1M Cable/DSL/其他' },
  { value: '2m', label: '2M Cable/DSL/其他' },
  { value: '5m', label: '5M Cable/DSL/其他' },
  { value: '10m', label: '10M Cable/DSL/其他' },
];

function ProxySection({
  title,
  value,
  onChange,
  showPassive,
  passive,
  onPassive,
}: {
  title: string;
  value: ProxySettings;
  onChange: (v: ProxySettings) => void;
  showPassive?: boolean;
  passive?: boolean;
  onPassive?: (v: boolean) => void;
}): React.ReactElement {
  const [confirm, setConfirm] = useState(value.password);
  const mismatch = confirm.length > 0 && confirm !== value.password;
  return (
    <div style={{ marginBottom: 8 }}>
      <SectionTitle>{title} 代理</SectionTitle>
      <Checkbox checked={value.enabled} onChange={(v) => onChange({ ...value, enabled: v })}>
        使用 {title} 代理
      </Checkbox>
      <div className="md-row" style={{ marginTop: 8 }}>
        <div style={{ flex: 2 }}>
          <TextField
            label="地址"
            value={value.host}
            onChange={(v) => onChange({ ...value, host: v })}
            disabled={!value.enabled}
            placeholder="proxy.example.com"
          />
        </div>
        <NumberField
          label="端口"
          value={value.port}
          onChange={(v) => onChange({ ...value, port: v })}
          min={1}
          max={65535}
          disabled={!value.enabled}
        />
      </div>
      <div className="md-row">
        <TextField
          label="用户名"
          value={value.username}
          onChange={(v) => onChange({ ...value, username: v })}
          disabled={!value.enabled}
        />
        <TextField
          label="密码"
          type="password"
          value={value.password}
          onChange={(v) => onChange({ ...value, password: v })}
          disabled={!value.enabled}
        />
        <TextField
          label="确认密码"
          type="password"
          value={confirm}
          onChange={setConfirm}
          disabled={!value.enabled}
          error={mismatch ? '两次输入的密码不一致' : undefined}
        />
      </div>
      {showPassive && (
        <Checkbox checked={!!passive} onChange={(v) => onPassive?.(v)}>
          FTP 使用被动 (PASV) 模式
        </Checkbox>
      )}
    </div>
  );
}

export function OptionsDialog({
  settings,
  initialTab,
  queues,
  onClose,
  onSaved,
  onError,
}: {
  settings: AppSettings;
  initialTab?: string;
  queues: Queue[];
  onClose: () => void;
  onSaved: () => void;
  onError: (m: string) => void;
}): React.ReactElement {
  const [tab, setTab] = useState<TabId>((initialTab as TabId) ?? 'general');
  const [draft, setDraft] = useState<AppSettings>(() => structuredClone(settings));
  const [busy, setBusy] = useState(false);
  const [extText, setExtText] = useState(settings.autoStartExtensions.join(' '));

  const patch = (p: Partial<AppSettings>): void => setDraft((d) => ({ ...d, ...p }));

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const next: AppSettings = {
        ...draft,
        autoStartExtensions: extText
          .split(/[\s,;]+/)
          .map((s) => s.trim().toLowerCase().replace(/^\./, ''))
          .filter(Boolean),
      };
      await invoke('dl:saveSettings', next);
      onSaved();
      onClose();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      headline="选项"
      subhead="配置下载、连接、代理与浏览器集成"
      size="wide"
      onClose={onClose}
      actions={
        <>
          <span className="spacer md-supporting" style={{ margin: 0 }}>
            队列 {queues.length} 个
          </span>
          <Button variant="text" onClick={onClose}>取消</Button>
          <Button variant="filled" onClick={() => void save()} disabled={busy}>
            {busy ? '正在保存…' : '保存'}
          </Button>
        </>
      }
    >
      <Tabs tabs={TABS} value={tab} onChange={setTab} />

      <div style={{ paddingTop: 20 }}>
        {tab === 'general' && (
          <>
            <SectionTitle>启动与监视</SectionTitle>
            <Checkbox
              checked={draft.launchAtStartup}
              onChange={(v) => patch({ launchAtStartup: v })}
              supporting="登录 Windows 后自动运行"
            >
              系统启动时运行 FenxiDL
            </Checkbox>
            <Checkbox
              checked={draft.monitorClipboard}
              onChange={(v) => patch({ monitorClipboard: v })}
              supporting="检测到链接时提示新建任务"
            >
              监视剪贴板中的下载链接
            </Checkbox>
            <Checkbox
              checked={draft.browserIntegration}
              onChange={(v) => patch({ browserIntegration: v })}
              supporting="通过扩展与本地捕获服务接管下载"
            >
              集成到浏览器
            </Checkbox>
            <Checkbox
              checked={draft.showMediaBar}
              onChange={(v) => patch({ showMediaBar: v })}
            >
              显示多媒体嗅探浮动条
            </Checkbox>

            <SectionTitle>文件类型</SectionTitle>
            <TextField
              label="自动开始下载下列类型的文件"
              value={extText}
              onChange={setExtText}
              help="以空格分隔，不含点号。例如：exe zip pdf mp4"
            />

            <SectionTitle>连接类型/速度</SectionTitle>
            <SelectField
              label="连接类型"
              value={draft.connectionTypeId}
              options={CONNECTION_TYPES}
              onChange={(v) => patch({ connectionTypeId: v })}
              help="用于估算剩余时间与建议的连接数"
            />
          </>
        )}

        {tab === 'connection' && (
          <>
            <SectionTitle>并发</SectionTitle>
            <div className="md-row">
              <NumberField
                label="默认最大连接数"
                value={draft.defaultConnections}
                onChange={(v) => patch({ defaultConnections: v })}
                min={1}
                max={32}
                help="每个任务的并发分段数上限"
              />
              <NumberField
                label="队列默认并发任务数"
                value={draft.defaultQueueConcurrency}
                onChange={(v) => patch({ defaultQueueConcurrency: v })}
                min={1}
                max={50}
              />
            </div>

            <SectionTitle>同一服务器的最大连接数（例外）</SectionTitle>
            {Object.keys(draft.serverConnectionOverrides).length === 0 ? (
              <Supporting>尚未设置例外。对于限制并发连接的站点，可以在此添加。</Supporting>
            ) : (
              <List>
                {Object.entries(draft.serverConnectionOverrides).map(([host, n]) => (
                  <ListItem key={host}>
                    <span className="grow md-mono">{host}</span>
                    <span className="md-badge">{n} 连接</span>
                    <Button
                      variant="text"
                      onClick={() => {
                        const next = { ...draft.serverConnectionOverrides };
                        delete next[host];
                        patch({ serverConnectionOverrides: next });
                      }}
                    >
                      删除
                    </Button>
                  </ListItem>
                ))}
              </List>
            )}
            <ServerOverrideAdder
              onAdd={(host, n) =>
                patch({
                  serverConnectionOverrides: {
                    ...draft.serverConnectionOverrides,
                    [host.toLowerCase()]: n,
                  },
                })
              }
            />

            <SectionTitle>下载限制（配额）</SectionTitle>
            <Checkbox
              checked={draft.quota.enabled}
              onChange={(v) => patch({ quota: { ...draft.quota, enabled: v } })}
              supporting="超额后自动暂停，进入下一时段恢复"
            >
              启用按时段的流量配额
            </Checkbox>
            <div className="md-row" style={{ marginTop: 8 }}>
              <NumberField
                label="时段开始（分钟）"
                value={draft.quota.startMinute}
                onChange={(v) => patch({ quota: { ...draft.quota, startMinute: v } })}
                min={0}
                max={1439}
                disabled={!draft.quota.enabled}
                help="0 = 00:00"
              />
              <NumberField
                label="时段结束（分钟）"
                value={draft.quota.endMinute}
                onChange={(v) => patch({ quota: { ...draft.quota, endMinute: v } })}
                min={0}
                max={1439}
                disabled={!draft.quota.enabled}
              />
              <NumberField
                label="配额 (MB)"
                value={draft.quota.megabytes}
                onChange={(v) => patch({ quota: { ...draft.quota, megabytes: v } })}
                min={0}
                disabled={!draft.quota.enabled}
              />
            </div>

            <SectionTitle>重试与限速</SectionTitle>
            <div className="md-row">
              <NumberField
                label="最大重试次数"
                value={draft.maxRetries}
                onChange={(v) => patch({ maxRetries: v })}
                min={0}
                max={50}
              />
              <NumberField
                label="重试间隔（秒）"
                value={draft.retryDelaySeconds}
                onChange={(v) => patch({ retryDelaySeconds: v })}
                min={1}
                max={300}
              />
              <NumberField
                label="全局限速 (KB/s)"
                value={Math.round(draft.globalSpeedLimit / 1024)}
                onChange={(v) => patch({ globalSpeedLimit: Math.max(0, v) * 1024 })}
                min={0}
                help="0 表示不限速"
              />
            </div>
          </>
        )}

        {tab === 'downloads' && (
          <>
            <SectionTitle>保存位置</SectionTitle>
            <TextField
              label="默认下载目录"
              value={draft.defaultDirectory}
              onChange={(v) => patch({ defaultDirectory: v })}
            />
            <TextField
              label="临时文件夹"
              value={draft.tempDirectory}
              onChange={(v) => patch({ tempDirectory: v })}
              help="分段下载中的数据先存放在这里，完成后再移动"
            />
            <Checkbox
              checked={draft.useLastPathForGeneral}
              onChange={(v) => patch({ useLastPathForGeneral: v })}
            >
              对「常规」分类使用上次的保存路径
            </Checkbox>

            <SectionTitle>对话框</SectionTitle>
            <Checkbox checked={draft.showStartDialog} onChange={(v) => patch({ showStartDialog: v })}>
              显示开始下载对话框
            </Checkbox>
            <Checkbox checked={draft.showProgressDialog} onChange={(v) => patch({ showProgressDialog: v })}>
              显示下载进度对话框
            </Checkbox>
            <Checkbox checked={draft.showCompleteDialog} onChange={(v) => patch({ showCompleteDialog: v })}>
              显示下载完成通知
            </Checkbox>

            <SectionTitle>病毒检查</SectionTitle>
            <Checkbox
              checked={draft.virusScan.enabled}
              onChange={(v) => patch({ virusScan: { ...draft.virusScan, enabled: v } })}
            >
              下载完成后进行病毒扫描
            </Checkbox>
            <div className="md-row" style={{ marginTop: 8 }}>
              <TextField
                label="病毒扫描程序"
                value={draft.virusScan.program}
                onChange={(v) => patch({ virusScan: { ...draft.virusScan, program: v } })}
                disabled={!draft.virusScan.enabled}
                placeholder="C:\Program Files\...\scanner.exe"
              />
              <TextField
                label="命令行参数"
                value={draft.virusScan.args}
                onChange={(v) => patch({ virusScan: { ...draft.virusScan, args: v } })}
                disabled={!draft.virusScan.enabled}
                placeholder="/scan %f"
                help="%f 代表下载完成的文件路径"
                mono
              />
            </div>

            <SectionTitle>分类目录</SectionTitle>
            <List>
              {draft.categories.map((c) => (
                <ListItem key={c.id}>
                  <span style={{ width: 88, flex: '0 0 88px' }}>{c.name}</span>
                  <input
                    className="md-input"
                    style={{ height: 40, flex: 1 }}
                    value={c.directory}
                    onChange={(e) => {
                      const next = draft.categories.map((x) =>
                        x.id === c.id ? { ...x, directory: e.target.value } : x,
                      );
                      patch({ categories: next });
                    }}
                  />
                  <span
                    className="md-supporting md-mono"
                    style={{ width: 160, flex: '0 0 160px', overflow: 'hidden', textOverflow: 'ellipsis' }}
                  >
                    {c.extensions.slice(0, 6).join(' ') || '—'}
                  </span>
                </ListItem>
              ))}
            </List>
          </>
        )}

        {tab === 'proxy' && (
          <>
            <Supporting>
              代理设置会应用到所有下载请求（含分段请求）。HTTPS 目标优先使用 HTTPS 代理，
              未启用时回退到 HTTP 代理；HTTPS 经代理走标准 CONNECT 隧道。
            </Supporting>
            <div style={{ marginTop: 16 }}>
              <ProxySection
                title="HTTP"
                value={draft.httpProxy}
                onChange={(v) => patch({ httpProxy: v })}
              />
              <ProxySection
                title="HTTPS"
                value={draft.httpsProxy}
                onChange={(v) => patch({ httpsProxy: v })}
              />
              <ProxySection
                title="FTP"
                value={draft.ftpProxy}
                onChange={(v) => patch({ ftpProxy: v })}
                showPassive
                passive={draft.ftpPassive}
                onPassive={(v) => patch({ ftpPassive: v })}
              />
            </div>
          </>
        )}

        {tab === 'sites' && (
          <>
            <SectionTitle>服务器/站点的用户名和密码</SectionTitle>
            <Supporting>
              在此保存的凭据会按主机名自动匹配，无需在每次新建任务时输入。
            </Supporting>
            <List>
              {draft.credentials.length === 0 && (
                <ListItem>
                  <span className="grow md-supporting" style={{ margin: 0 }}>尚未保存任何站点凭据</span>
                </ListItem>
              )}
              {draft.credentials.map((c) => (
                <ListItem key={c.id}>
                  <input
                    className="md-input"
                    style={{ height: 40, flex: 2 }}
                    value={c.site}
                    placeholder="站点/路径"
                    onChange={(e) =>
                      patch({
                        credentials: draft.credentials.map((x) =>
                          x.id === c.id ? { ...x, site: e.target.value } : x,
                        ),
                      })
                    }
                  />
                  <input
                    className="md-input"
                    style={{ height: 40, flex: 1 }}
                    value={c.username}
                    placeholder="用户名"
                    onChange={(e) =>
                      patch({
                        credentials: draft.credentials.map((x) =>
                          x.id === c.id ? { ...x, username: e.target.value } : x,
                        ),
                      })
                    }
                  />
                  <input
                    className="md-input"
                    style={{ height: 40, flex: 1 }}
                    type="password"
                    value={c.password}
                    placeholder="密码"
                    onChange={(e) =>
                      patch({
                        credentials: draft.credentials.map((x) =>
                          x.id === c.id ? { ...x, password: e.target.value } : x,
                        ),
                      })
                    }
                  />
                  <Button
                    variant="text"
                    onClick={() =>
                      patch({ credentials: draft.credentials.filter((x) => x.id !== c.id) })
                    }
                  >
                    删除
                  </Button>
                </ListItem>
              ))}
            </List>
            <div style={{ marginTop: 12 }}>
              <Button
                variant="outlined"
                icon="add"
                onClick={() =>
                  patch({
                    credentials: [
                      ...draft.credentials,
                      { id: `c${Date.now()}`, site: '', username: '', password: '' },
                    ],
                  })
                }
              >
                新建
              </Button>
            </div>
          </>
        )}

        {tab === 'dialup' && (
          <>
            <SectionTitle>拨号设置</SectionTitle>
            <Checkbox checked={draft.useDialup} onChange={(v) => patch({ useDialup: v })}>
              使用 Windows 拨号网络
            </Checkbox>
            <div className="md-row" style={{ marginTop: 10 }}>
              <NumberField
                label="重拨尝试"
                value={draft.redialAttempts}
                onChange={(v) => patch({ redialAttempts: v })}
                min={0}
                max={99}
                help="0 表示不断重拨"
              />
              <NumberField
                label="重拨间隔（秒）"
                value={draft.redialIntervalSeconds}
                onChange={(v) => patch({ redialIntervalSeconds: v })}
                min={1}
                max={600}
              />
            </div>
            <Supporting>
              本实现通过操作系统的连接管理组件建立拨号连接；如果系统未配置拨号条目，此项不生效。
            </Supporting>
          </>
        )}

        {tab === 'sounds' && (
          <>
            <SectionTitle>声音事件</SectionTitle>
            <Supporting>
              原产品允许为下列事件分别指定声音文件：任务开始、任务完成、任务失败、队列完成、调度触发。
              本实现使用系统通知代替自定义声音，以避免捆绑任何第三方音频资源。
              可以在操作系统的「通知与操作」设置中为 FenxiDL 单独配置提示音。
            </Supporting>
            <SectionTitle>通知</SectionTitle>
            <Checkbox
              checked={draft.showCompleteDialog}
              onChange={(v) => patch({ showCompleteDialog: v })}
            >
              下载完成时显示系统通知
            </Checkbox>
            <Checkbox
              checked={draft.showTipsOnStartup}
              onChange={(v) => patch({ showTipsOnStartup: v })}
            >
              启动时显示使用提示
            </Checkbox>
          </>
        )}
      </div>
    </Dialog>
  );
}

function ServerOverrideAdder({
  onAdd,
}: {
  onAdd: (host: string, n: number) => void;
}): React.ReactElement {
  const [host, setHost] = useState('');
  const [n, setN] = useState(1);
  return (
    <div className="md-row" style={{ marginTop: 12, alignItems: 'flex-start' }}>
      <div style={{ flex: 2 }}>
        <TextField label="服务器" value={host} onChange={setHost} placeholder="example.com" />
      </div>
      <NumberField label="连接数" value={n} onChange={setN} min={1} max={32} />
      <div style={{ flex: '0 0 auto', paddingTop: 27 }}>
        <Button
          variant="tonal"
          onClick={() => {
            onAdd(host.trim(), n);
            setHost('');
          }}
          disabled={!host.trim()}
        >
          添加
        </Button>
      </div>
    </div>
  );
}
