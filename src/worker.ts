import { buildPreview } from './transform';
import { generateCsv } from './csv';
import type { Capture, ColumnConfig } from './contracts';

self.onmessage = (event: MessageEvent<{ requestId: string; capture: Capture; columns: ColumnConfig[] }>) => {
  try {
    const preview = buildPreview(event.data.capture, event.data.columns);
    const bytes = preview.errorCount ? undefined : generateCsv(preview);
    self.postMessage({ requestId: event.data.requestId, preview, bytes }, bytes ? [bytes.buffer] : []);
  } catch {
    self.postMessage({ requestId: event.data.requestId, error: '設定または取得結果が不正です。再設定・再取得してください。' });
  }
};
