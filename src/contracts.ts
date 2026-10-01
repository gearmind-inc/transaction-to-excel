// MVP contract, fixed before the evaluator and product implementation.
export const LIMITS = { rows: 5000, columns: 50, cellChars: 10000, textChars: 2_000_000, presets: 50 } as const;
export type DateFormat = 'YYYY-MM-DD' | 'YYYY/MM/DD' | 'YYYY年M月D日' | 'MM/DD/YYYY' | 'DD/MM/YYYY';
export type AmountFormat = { symbol: '' | '¥' | '円' | '$' | '€'; grouping: '' | ',' | '.'; decimal: '.' | ','; negative: 'minus' | 'parentheses' };
export type ColumnConfig = { sourceIndex: number; outputName: string; kind: 'text' | 'date' | 'amount'; required: boolean; dateFormat: DateFormat; dateOutput: 'YYYY-MM-DD' | 'YYYY/MM/DD'; amount: AmountFormat };
export type TableCandidate = { index: number; key: string; headers: string[]; rowCount: number; error?: string };
export type Capture = { schemaVersion: 1; requestId: string; tableKey: string; headers: string[]; sourceIndexes: number[]; rows: string[][]; scope: 'current-page'; capturedAt: string };
export type CellPreview = { raw: string; logical: string; output: string; kind: ColumnConfig['kind']; error?: string; protection?: string; warning?: string };
export type Preview = { headers: string[]; rows: CellPreview[][]; sourceCount: number; emptyCount: number; errorCount: number; protectionCount: number; scope: 'current-page'; requestId: string };
export type InspectRequest = { mode: 'list' | 'highlight' | 'capture'; expectedUrl: string; requestId: string; tableIndex?: number; tableKey?: string; headers?: string[]; sourceIndexes?: number[]; limits: typeof LIMITS };
export type InspectResult = { schemaVersion: 1; requestId: string; url: string; tables?: TableCandidate[]; capture?: Capture; error?: string };
export type Preset = { schemaVersion: 1; id: string; version: number; name: string; origin: string; path: string; tableKey: string; headers: string[]; columns: ColumnConfig[] };
export type SaveState = 'generated' | 'saving' | 'saved' | 'cancelled' | 'interrupted' | 'unknown';
export type SaveAttempt = { schemaVersion: 1; exportId: string; digest: string; state: SaveState; startedAt: string; downloadId?: number; reason?: string };
