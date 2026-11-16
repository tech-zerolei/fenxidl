/**
 * Preload bridge. Exposes a narrow, typed API to the renderer; no Node
 * primitives leak through contextIsolation.
 */

import { contextBridge, ipcRenderer } from 'electron';

type Unsubscribe = () => void;

function on<T>(channel: string, handler: (payload: T) => void): Unsubscribe {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  invoke: <T>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args) as Promise<T>,

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