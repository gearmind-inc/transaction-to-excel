// Hand-authored oracle. Never regenerate this file from product outputs.
import type { Capture, ColumnConfig } from '../../src/contracts.js';

export const FIXTURE_URL = 'https://fixture.example/transactions?session=do-not-store#private';
export const REQUEST_ID = 'fixture-request-1';
export const HEADERS = ['ID', '取引日', '摘要', '金額', 'メモ', '除外する列'];
export const EXPECTED_CAPTURE: Capture = {
  schemaVersion: 1, requestId: REQUEST_ID, tableKey: 'id:transactions', headers: HEADERS,
  sourceIndexes: [0, 1, 2, 3, 4], scope: 'current-page', capturedAt: '2026-10-01T00:00:00.000Z',
  rows: [
    ['00001', '2026/10/01', '日本語,"引用"\n二行目', '¥1,234.50', ''],
    ['12345678901234567890', '2024/02/29', '=SUM(1,2)', '-¥330', '0'],
    ['00003', '2026/10/02', '+81-90-0000', '¥0', ''],
    ['00004', '2026/10/02', '@name', '¥12.00', ''],
    ['00005', '2026/10/03', ' \t＝1+2', '¥00001.2300', ''],
    ['00777', '2026/10/04', '同値の別取引', '¥20.00', ''],
    ['00777', '2026/10/04', '同値の別取引', '¥20.00', ''],
    ['00008', '2026/10/05', '-1+2', '-¥0.50', '備考'],
  ],
};

const base: ColumnConfig = { sourceIndex: 0, outputName: '', kind: 'text', required: false,
  dateFormat: 'YYYY/MM/DD', dateOutput: 'YYYY-MM-DD', amount: { symbol: '¥', grouping: ',', decimal: '.', negative: 'minus' } };
export const COLUMNS: ColumnConfig[] = [
  { ...base, sourceIndex: 1, outputName: '日付', kind: 'date', required: true },
  { ...base, sourceIndex: 2, outputName: '内容' },
  { ...base, sourceIndex: 3, outputName: '取引額', kind: 'amount', required: true },
  { ...base, sourceIndex: 0, outputName: '取引ID', required: true },
  { ...base, sourceIndex: 4, outputName: '任意メモ' },
];

export type OracleCell = { raw: string; logical: string; output: string; kind: 'text' | 'date' | 'amount'; error?: true; protection?: true };
export type OraclePreview = { headers: string[]; rows: OracleCell[][]; sourceCount: number; emptyCount: number; errorCount: number; protectionCount: number; scope: 'current-page'; requestId: string };
const d = (raw: string, logical: string): OracleCell => ({ raw, logical, output: logical, kind: 'date' });
const a = (raw: string, logical: string): OracleCell => ({ raw, logical, output: logical, kind: 'amount' });
const t = (raw: string, output = raw, protection?: true): OracleCell => ({ raw, logical: raw, output, kind: 'text', ...(protection ? { protection } : {}) });
export const EXPECTED_PREVIEW: OraclePreview = {
  headers: ['日付', '内容', '取引額', '取引ID', '任意メモ'],
  sourceCount: 8, emptyCount: 6, errorCount: 0, protectionCount: 5, scope: 'current-page', requestId: REQUEST_ID,
  rows: [
    [d('2026/10/01', '2026-10-01'), t('日本語,"引用"\n二行目'), a('¥1,234.50', '1234.50'), t('00001'), t('')],
    [d('2024/02/29', '2024-02-29'), t('=SUM(1,2)', '\t=SUM(1,2)', true), a('-¥330', '-330'), t('12345678901234567890'), t('0')],
    [d('2026/10/02', '2026-10-02'), t('+81-90-0000', '\t+81-90-0000', true), a('¥0', '0'), t('00003'), t('')],
    [d('2026/10/02', '2026-10-02'), t('@name', '\t@name', true), a('¥12.00', '12.00'), t('00004'), t('')],
    [d('2026/10/03', '2026-10-03'), t(' \t＝1+2', '\t \t＝1+2', true), a('¥00001.2300', '1.2300'), t('00005'), t('')],
    [d('2026/10/04', '2026-10-04'), t('同値の別取引'), a('¥20.00', '20.00'), t('00777'), t('')],
    [d('2026/10/04', '2026-10-04'), t('同値の別取引'), a('¥20.00', '20.00'), t('00777'), t('')],
    [d('2026/10/05', '2026-10-05'), t('-1+2', '\t-1+2', true), a('-¥0.50', '-0.50'), t('00008'), t('備考')],
  ],
};

// Literal bytes are specified independently, not emitted by a CSV serializer.
export const EXPECTED_CSV = '\uFEFF"日付","内容","取引額","取引ID","任意メモ"\r\n'
  + '"2026-10-01","日本語,""引用""\n二行目","1234.50","00001",""\r\n'
  + '"2024-02-29","\t=SUM(1,2)","-330","12345678901234567890","0"\r\n'
  + '"2026-10-02","\t+81-90-0000","0","00003",""\r\n'
  + '"2026-10-02","\t@name","12.00","00004",""\r\n'
  + '"2026-10-03","\t \t＝1+2","1.2300","00005",""\r\n'
  + '"2026-10-04","同値の別取引","20.00","00777",""\r\n'
  + '"2026-10-04","同値の別取引","20.00","00777",""\r\n'
  + '"2026-10-05","\t-1+2","-0.50","00008","備考"\r\n';
