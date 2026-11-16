/**
 * Scheduler dialog: queue management plus schedule entries (spec §7).
 *
 * Uses MD3 primary tabs for the two panes, list rows for queues and a card per
 * schedule with weekday filter chips.
 */

import React, { useState } from 'react';
import type {
  AfterQueueAction,
  DownloadTask,
  IpcResult,
  Queue,
  ScheduleEntry,
} from '../../shared/types';
import {
  Button,
  Checkbox,
  Dialog,
  FilterChip,
  List,
  ListItem,
  NumberField,
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

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

const AFTER_ACTION_OPTIONS: Array<{ value: AfterQueueAction; label: string }> = [
  { value: 'none', label: '不执行任何操作' },
  { value: 'exit', label: '退出 FenxiDL' },
  { value: 'shutdown', label: '关闭计算机' },
  { value: 'sleep', label: '进入睡眠' },
  { value: 'hibernate', label: '休眠' },
  { value: 'hangup', label: '挂断调制解调器' },
];

function minutesToTime(m: number | null): string {
  if (m === null) return '00:00';
  const h = Math.floor(m / 60) % 24;
  const min = m % 60;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return Math.min(1439, Math.max(0, h * 60 + m));
}

type Pane = 'queues' | 'schedules';

export function SchedulerDialog({
  queues,
  schedules,
  tasks,
  onClose,
  onSaved,
  onError,
}: {
  queues: Queue[];
  schedules: ScheduleEntry[];
  tasks: DownloadTask[];
  onClose: () => void;
  onSaved: () => void;
  onError: (m: string) => void;
}): React.ReactElement {
  const [pane, setPane] = useState<Pane>('queues');
  const [draftQueues, setDraftQueues] = useState<Queue[]>(() => structuredClone(queues));
  const [draftSchedules, setDraftSchedules] = useState<ScheduleEntry[]>(() => structuredClone(schedules));
  const [busy, setBusy] = useState(false);

  const addQueue = (): void => {
    setDraftQueues((qs) => [
      ...qs,
      {
        id: `q${Date.now().toString(36)}`,
        name: `队列 #${qs.length}`,
        concurrency: 2,
        isPrimary: false,
      },
    ]);
  };

  const addSchedule = (): void => {
    setDraftSchedules((ss) => [
      ...ss,
      {
        id: `s${Date.now().toString(36)}`,
        queueId: null,
        enabled: true,
        mode: 'daily',
        startAt: null,
        timeOfDay: 120,
        weekdays: 0b1111111,
        intervalMinutes: 60,
        afterAction: 'none',
      },
    ]);
  };

  const commit = async (): Promise<void> => {
    setBusy(true);
    try {
      const original = new Map(queues.map((q) => [q.id, q]));
      const kept = new Set(draftQueues.map((q) => q.id));
      for (const q of queues) {
        if (!q.isPrimary && !kept.has(q.id)) await invoke('dl:removeQueue', q.id);
      }
      // Track placeholder-id → created-id so new schedules point at the real id.
      const remap = new Map<string, string>();
      for (const q of draftQueues) {
        if (q.isPrimary) {
          await invoke('dl:updateQueue', q.id, { name: q.name, concurrency: q.concurrency });
        } else if (original.has(q.id)) {
          await invoke('dl:updateQueue', q.id, { name: q.name, concurrency: q.concurrency });
        } else {
          const created = await invoke<Queue>('dl:addQueue', q.name, q.concurrency);
          remap.set(q.id, created.id);
        }
      }
      const finalSchedules = draftSchedules.map((s) =>
        s.queueId && remap.has(s.queueId) ? { ...s, queueId: remap.get(s.queueId)! } : s,
      );
      await invoke('dl:setSchedules', finalSchedules);
      onSaved();
      onClose();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const patchSchedule = (id: string, patch: Partial<ScheduleEntry>): void => {
    setDraftSchedules((ss) => ss.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  };

  const queueOptions = [
    { value: '', label: '主要下载队列' },
    ...draftQueues.filter((q) => !q.isPrimary).map((q) => ({ value: q.id, label: q.name })),
  ];

  return (
    <Dialog
      headline="计划任务及下载队列"
      subhead="安排队列在指定时间自动开始"
      size="wide"
      onClose={onClose}
      actions={
        <>
          <span className="spacer md-supporting" style={{ margin: 0 }}>
            {busy ? '正在保存…' : `${draftQueues.length} 个队列 · ${draftSchedules.length} 个计划`}
          </span>
          <Button variant="text" onClick={onClose}>取消</Button>
          <Button variant="filled" onClick={() => void commit()} disabled={busy}>
            保存
          </Button>
        </>
      }
    >
      <Tabs
        tabs={[
          { id: 'queues' as Pane, label: '队列' },
          { id: 'schedules' as Pane, label: '计划任务' },
        ]}
        value={pane}
        onChange={setPane}
      />

      <div style={{ paddingTop: 20 }}>
        {pane === 'queues' && (
          <>
            <Supporting>
              任务表中的「Q」列表示文件所属队列：主队列显示 M，其余显示序号。
              每个队列可独立设置同时进行的任务数。
            </Supporting>
            <List>
              {draftQueues.map((q, idx) => (
                <ListItem key={q.id}>
                  <span className="md-queue-marker" style={{ flex: '0 0 auto' }}>
                    {q.isPrimary ? 'M' : idx}
                  </span>
                  <input
                    className="md-input"
                    style={{ height: 40, flex: 1 }}
                    value={q.name}
                    onChange={(e) =>
                      setDraftQueues((qs) =>
                        qs.map((x) => (x.id === q.id ? { ...x, name: e.target.value } : x)),
                      )
                    }
                  />
                  <div style={{ width: 96, flex: '0 0 96px' }}>
                    <NumberField
                      value={q.concurrency}
                      onChange={(v) =>
                        setDraftQueues((qs) =>
                          qs.map((x) => (x.id === q.id ? { ...x, concurrency: v } : x)),
                        )
                      }
                      min={1}
                      max={50}
                    />
                  </div>
                  <span className="md-badge" style={{ flex: '0 0 auto' }}>
                    {tasks.filter((t) => (t.queueId ?? null) === (q.isPrimary ? null : q.id)).length} 个文件
                  </span>
                  {!q.isPrimary && (
                    <Button
                      variant="text"
                      onClick={() => setDraftQueues((qs) => qs.filter((x) => x.id !== q.id))}
                    >
                      删除
                    </Button>
                  )}
                </ListItem>
              ))}
            </List>
            <div style={{ marginTop: 12 }}>
              <Button variant="outlined" icon="add" onClick={addQueue}>
                新建队列
              </Button>
            </div>
          </>
        )}

        {pane === 'schedules' && (
          <>
            <Supporting>
              FenxiDL 必须处于运行状态（可最小化到托盘）才能在预定时间执行队列。
              队列完成后可以执行关机、睡眠等操作。
            </Supporting>

            {draftSchedules.length === 0 && (
              <div style={{ padding: '20px 0' }}>
                <Supporting>尚未设置计划任务。</Supporting>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
              {draftSchedules.map((s) => (
                <div
                  key={s.id}
                  style={{
                    border: '1px solid var(--md-outline-variant)',
                    borderRadius: 'var(--md-shape-md)',
                    padding: 16,
                    background: 'var(--md-surface-container)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                    <Checkbox
                      checked={s.enabled}
                      onChange={(v) => patchSchedule(s.id, { enabled: v })}
                    >
                      启用
                    </Checkbox>
                    <div className="md-spacer" />
                    <Button
                      variant="text"
                      onClick={() => setDraftSchedules((ss) => ss.filter((x) => x.id !== s.id))}
                    >
                      删除
                    </Button>
                  </div>

                  <div className="md-row">
                    <SelectField
                      label="目标队列"
                      value={s.queueId ?? ''}
                      options={queueOptions}
                      onChange={(v) => patchSchedule(s.id, { queueId: v || null })}
                    />
                    <SelectField
                      label="模式"
                      value={s.mode}
                      options={[
                        { value: 'once' as const, label: '仅一次' },
                        { value: 'daily' as const, label: '每天' },
                        { value: 'weekly' as const, label: '每周' },
                        { value: 'interval' as const, label: '按间隔' },
                      ]}
                      onChange={(v) => patchSchedule(s.id, { mode: v })}
                    />
                    {s.mode === 'once' ? (
                      <TextField
                        label="开始时间"
                        type="datetime-local"
                        value={
                          s.startAt
                            ? new Date(s.startAt - new Date(s.startAt).getTimezoneOffset() * 60000)
                                .toISOString()
                                .slice(0, 16)
                            : ''
                        }
                        onChange={(v) =>
                          patchSchedule(s.id, { startAt: v ? new Date(v).getTime() : null })
                        }
                      />
                    ) : s.mode === 'interval' ? (
                      <NumberField
                        label="间隔（分钟）"
                        value={s.intervalMinutes ?? 60}
                        onChange={(v) => patchSchedule(s.id, { intervalMinutes: v })}
                        min={1}
                        max={1440}
                      />
                    ) : (
                      <TextField
                        label="开始时间"
                        type="time"
                        value={minutesToTime(s.timeOfDay)}
                        onChange={(v) => patchSchedule(s.id, { timeOfDay: timeToMinutes(v) })}
                      />
                    )}
                  </div>

                  <div className="md-row">
                    <SelectField
                      label="队列完成后"
                      value={s.afterAction}
                      options={AFTER_ACTION_OPTIONS}
                      onChange={(v) => patchSchedule(s.id, { afterAction: v })}
                    />
                  </div>

                  {s.mode === 'weekly' && (
                    <>
                      <div className="md-field__label" style={{ marginTop: 4 }}>执行的星期</div>
                      <div className="md-chip-set">
                        {WEEKDAYS.map((label, day) => {
                          const on = (s.weekdays & (1 << day)) !== 0;
                          return (
                            <FilterChip
                              key={label}
                              label={label}
                              selected={on}
                              onClick={() =>
                                patchSchedule(s.id, { weekdays: s.weekdays ^ (1 << day) })
                              }
                            />
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>

            <div style={{ marginTop: 12 }}>
              <Button variant="outlined" icon="add" onClick={addSchedule}>
                新建计划任务
              </Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
