/**
 * Preload bridge. Exposes a narrow, typed API to the renderer; no Node
 * primitives leak through contextIsolation.
 *
 * The renderer is not trusted: it can be navigated, XSS'd, or driven by a
 * compromised extension. The old bridge forwarded `invoke(channel, ...args)`
 * for *any* channel string, so a single renderer-side injection could reach
 * every `dl:*` handler (including the ones that spawn processes). The bridge
 * now only forwards a fixed allow-list of channels, so even a compromised
 * renderer cannot reach a channel that was never meant to be exposed.
 */

import { contextBridge, ipcRenderer } from 'electron';

type Unsubscribe = () => void;

/**
 * Channels the renderer may call.
 *
 * Keep this list in sync with `registerIpc()` in the main process: a channel
 * missing here is unreachable from the UI, and a channel missing from the main
 * process registers as a no-op handler error the renderer already handles.
 */
const INVOKE_CHANNELS = new Set<string>([
  // snapshots and settings
  'dl:snapshot',
  'dl:getSettings',
  'dl:saveSettings',
  'dl:uiFlags',
  'dl:languages',
  // tasks
  'dl:createTask',
  'dl:updateTask',
  'dl:setTaskOptions',
  'dl:startTask',
  'dl:pauseTask',
  'dl:stopTask',
  'dl:removeTask',
  'dl:removeCompleted',
  'dl:stopAll',
  'dl:openFile',
  'dl:openFolder',
  // queues and schedules
  'dl:addQueue',
  'dl:updateQueue',
  'dl:removeQueue',
  'dl:moveToQueue',
  'dl:startQueue',
  'dl:stopQueue',
  'dl:setSchedules',
  // batch helper
  'dl:expandBatch',
  'dl:suggestWidth',
  // filesystem helpers
  'dl:chooseDirectory',
  'dl:checkPath',
  'dl:probeUrl',
  // import / export
  'dl:exportTasks',
  'dl:importTasks',
  // grabber
  'dl:grabberStart',
  'dl:grabberStop',
  'dl:grabberAddToTasks',
  'dl:grabberSaveProject',
  'dl:grabberListProjects',
  'dl:grabberDeleteProject',
  // media sniffer
  'dl:getSniffedMedia',
  'dl:clearSniffedMedia',
  'dl:snifferInfo',
  // misc
  'dl:revealLogs',
]);

const SUBSCRIBE_CHANNELS = new Set<string>([
  'dl:snapshot',
  'dl:log',
  'dl:clipboardUrl',
  'dl:grabberStats',
  'dl:grabberFiles',
  'dl:grabberLog',
  'dl:mediaSniffed',
]);

function on<T>(channel: string, handler: (payload: T) => void): Unsubscribe {
  if (!SUBSCRIBE_CHANNELS.has(channel)) {
    throw new Error(`Unknown event channel: ${channel}`);
  }
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  invoke: <T>(channel: string, ...args: unknown[]): Promise<T> => {
    if (!INVOKE_CHANNELS.has(channel)) {
      return Promise.reject(new Error(`Unknown IPC channel: ${channel}`));
    }
    return ipcRenderer.invoke(channel, ...args) as Promise<T>;
  },

  onSnapshot: (handler: (payload: unknown) => void): Unsubscribe => on('dl:snapshot', handler),
  onLog: (handler: (message: string) => void): Unsubscribe => on('dl:log', handler),
  onClipboardUrl: (handler: (url: string) => void): Unsubscribe => on('dl:clipboardUrl', handler),
  onGrabberStats: (handler: (payload: unknown) => void): Unsubscribe => on('dl:grabberStats', handler),
  onGrabberFiles: (handler: (payload: unknown) => void): Unsubscribe => on('dl:grabberFiles', handler),
  onGrabberLog: (handler: (message: string) => void): Unsubscribe => on('dl:grabberLog', handler),
  onMediaSniffed: (handler: (payload: unknown) => void): Unsubscribe => on('dl:mediaSniffed', handler),
};

contextBridge.exposeInMainWorld('fenxi', api);

export type FenxiBridge = typeof api;