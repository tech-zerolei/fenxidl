/**
 * About dialog.
 *
 * Reports this implementation's own identity and the reverse-engineering
 * provenance. It deliberately does not imitate the original product.
 */

import React from 'react';
import type { AppSettings } from '../../shared/types';
import { Button, Dialog, SectionTitle, Supporting } from '../md3/components';

export function AboutDialog({
  settings,
  onClose,
}: {
  settings: AppSettings | null;
  onClose: () => void;
}): React.ReactElement {
  return (
    <Dialog
      headline="关于 FenxiDL"
      size="narrow"
      onClose={onClose}
      actions={<Button variant="filled" onClick={onClose}>确定</Button>}
    >
      <div style={{ textAlign: 'center', padding: '8px 0 20px' }}>
        <div className="md-brand" style={{ width: 64, height: 64, margin: '0 auto 16px', fontSize: 28 }}>
          F
        </div>
        <div className="md-headline-small">FenxiDL</div>
        <div className="md-supporting" style={{ marginTop: 4 }}>高速多线程下载管理器</div>
        <div className="md-mono md-supporting" style={{ marginTop: 8 }}>版本 1.0.0</div>
      </div>

      <dl className="md-kv">
        <dt>实现方式</dt>
        <dd>基于公开行为规格的独立实现</dd>
        <dt>分析来源</dt>
        <dd>Internet Download Manager 6.43 build 18 的静态逆向</dd>
        <dt>下载引擎</dt>
        <dd>HTTP/HTTPS 分段并发，支持断点续传</dd>
        <dt>默认连接数</dt>
        <dd>{settings?.defaultConnections ?? 8}</dd>
        <dt>默认目录</dt>
        <dd className="md-mono">{settings?.defaultDirectory ?? '—'}</dd>
      </dl>

      <SectionTitle>声明</SectionTitle>
      <Supporting>
        本项目是行为兼容的独立实现，不包含原始产品的任何二进制代码、图标或资源，
        也不包含其授权机制。FenxiDL 与 Internet Download Manager 的发行方无任何关联。
      </Supporting>
    </Dialog>
  );
}
