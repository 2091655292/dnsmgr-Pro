import type {
  CdnStatisticsResult,
  HttpCodeStatusStatistics,
  ResourceStatistics,
  VisitsStatistics,
} from './types.js';

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * 依据查询跨度生成时间标签，与 multi-cloud-cdn CdnDomainStatisticsService.getLabels 保持一致：
 * 跨度大于 1 天按天，否则按小时。
 */
export function buildLabels(start: Date, end: Date): { labels: string[]; interval: 'hour' | 'day' } {
  const diffDays = (end.getTime() - start.getTime()) / 86400000;
  if (diffDays > 1) {
    const labels: string[] = [];
    const cursor = new Date(start.getTime());
    while (cursor.getTime() < end.getTime()) {
      labels.push(`${pad(cursor.getMonth() + 1)}-${pad(cursor.getDate())}`);
      cursor.setDate(cursor.getDate() + 1);
    }
    if (!labels.length) labels.push(`${pad(start.getMonth() + 1)}-${pad(start.getDate())}`);
    return { labels, interval: 'day' };
  }
  const hours = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 3600000));
  const labels: string[] = [];
  for (let i = 0; i < hours; i++) labels.push(`${i}-${i + 1}`);
  return { labels, interval: 'hour' };
}

/** 将任意长度的数值序列对齐到目标长度：点过多则按桶求和，过少补 0。 */
export function alignSeries(values: number[], targetLen: number): number[] {
  const result = new Array(targetLen).fill(0);
  if (targetLen <= 0) return result;
  if (values.length <= targetLen) {
    for (let i = 0; i < values.length; i++) result[i] = values[i] || 0;
    return result;
  }
  const perBucket = values.length / targetLen;
  for (let i = 0; i < targetLen; i++) {
    const from = Math.floor(i * perBucket);
    const to = Math.min(values.length, Math.floor((i + 1) * perBucket));
    let sum = 0;
    for (let j = from; j < to; j++) sum += values[j] || 0;
    result[i] = sum;
  }
  return result;
}

export function sumSeries(a: number[] | undefined, b: number[] | undefined, len: number): number[] {
  const base = alignSeries(a || [], len);
  const add = alignSeries(b || [], len);
  return base.map((v, i) => v + (add[i] || 0));
}

export function sum(values: number[]): number {
  return values.reduce((acc, v) => acc + (v || 0), 0);
}

export function max(values: number[]): number {
  return values.reduce((acc, v) => Math.max(acc, v || 0), 0);
}

/** 将 object 形式的 CdnData 明细值转换为数组（用于腾讯云 API 的 DetailData） */
export function parseValueSeries(items: any[] | undefined, key = 'Value'): number[] {
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    const raw = item?.[key];
    const num = Number(raw);
    return Number.isFinite(num) ? Math.ceil(num) : 0;
  });
}

export function emptyResource(len: number): ResourceStatistics {
  return {
    resource_summary: { bw: 0, bs_bw: 0, flux: 0, bs_flux: 0 },
    resource_detail: {
      bw: new Array(len).fill(0),
      bs_bw: new Array(len).fill(0),
      flux: new Array(len).fill(0),
      bs_flux: new Array(len).fill(0),
    },
  };
}

export function emptyVisits(len: number): VisitsStatistics {
  return {
    visits_summary: { req_num: 0, hit_flux: 0, hit_num: 0, bs_num: 0 },
    visits_detail: {
      req_num: new Array(len).fill(0),
      hit_flux: new Array(len).fill(0),
      hit_num: new Array(len).fill(0),
      bs_num: new Array(len).fill(0),
    },
  };
}

export function emptyStatus(len: number): HttpCodeStatusStatistics {
  const detail = () => [0, 1, 2, 3].map(() => new Array(len).fill(0));
  return {
    status_summary: [0, 0, 0, 0],
    status_detail: detail(),
    bs_status_summary: [0, 0, 0, 0],
    bs_status_detail: detail(),
  };
}

export function emptyResult(labels: string[]): CdnStatisticsResult {
  return { labels };
}

/** 合并同一类型的两份结果（多账户 / 多批次聚合） */
export function mergeResult(base: CdnStatisticsResult, add: CdnStatisticsResult): CdnStatisticsResult {
  const len = base.labels.length;
  if (base.resource && add.resource) base.resource = mergeResource(base.resource, add.resource, len);
  if (base.visits && add.visits) base.visits = mergeVisits(base.visits, add.visits, len);
  if (base.status && add.status) base.status = mergeStatus(base.status, add.status, len);
  return base;
}

function mergeResource(base: ResourceStatistics, add: ResourceStatistics, len: number): ResourceStatistics {
  const d = base.resource_detail;
  const a = add.resource_detail;
  const out: ResourceStatistics = {
    resource_summary: {
      bw: Math.max(base.resource_summary?.bw || 0, add.resource_summary?.bw || 0),
      bs_bw: Math.max(base.resource_summary?.bs_bw || 0, add.resource_summary?.bs_bw || 0),
      flux: (base.resource_summary?.flux || 0) + (add.resource_summary?.flux || 0),
      bs_flux: (base.resource_summary?.bs_flux || 0) + (add.resource_summary?.bs_flux || 0),
    },
    resource_detail: {
      bw: sumSeries(d?.bw, a?.bw, len),
      bs_bw: sumSeries(d?.bs_bw, a?.bs_bw, len),
      flux: sumSeries(d?.flux, a?.flux, len),
      bs_flux: sumSeries(d?.bs_flux, a?.bs_flux, len),
    },
  };
  // 带宽曲线合并后以逐点求和展示，重新计算峰值
  out.resource_summary.bw = max(out.resource_detail.bw);
  out.resource_summary.bs_bw = max(out.resource_detail.bs_bw);
  return out;
}

function mergeVisits(base: VisitsStatistics, add: VisitsStatistics, len: number): VisitsStatistics {
  const d = base.visits_detail;
  const a = add.visits_detail;
  const detail = {
    req_num: sumSeries(d?.req_num, a?.req_num, len),
    hit_flux: sumSeries(d?.hit_flux, a?.hit_flux, len),
    hit_num: sumSeries(d?.hit_num, a?.hit_num, len),
    bs_num: sumSeries(d?.bs_num, a?.bs_num, len),
  };
  return {
    visits_detail: detail,
    visits_summary: {
      req_num: sum(detail.req_num),
      hit_flux: sum(detail.hit_flux),
      hit_num: sum(detail.hit_num),
      bs_num: sum(detail.bs_num),
    },
  };
}

function mergeStatus(base: HttpCodeStatusStatistics, add: HttpCodeStatusStatistics, len: number): HttpCodeStatusStatistics {
  const sd: number[][] = [];
  const bsd: number[][] = [];
  for (let i = 0; i < 4; i++) {
    sd.push(sumSeries(base.status_detail?.[i], add.status_detail?.[i], len));
    bsd.push(sumSeries(base.bs_status_detail?.[i], add.bs_status_detail?.[i], len));
  }
  return {
    status_detail: sd,
    status_summary: sd.map((arr) => sum(arr)),
    bs_status_detail: bsd,
    bs_status_summary: bsd.map((arr) => sum(arr)),
  };
}

/** 按查询类型决定结果中需要包含哪些部分 */
export function ensureSections(result: CdnStatisticsResult, type: string, len: number): CdnStatisticsResult {
  if (type === 'Resource' || type === 'All') result.resource = result.resource || emptyResource(len);
  if (type === 'Visits' || type === 'All') result.visits = result.visits || emptyVisits(len);
  if (type === 'HttpCodeStatus' || type === 'All') result.status = result.status || emptyStatus(len);
  return result;
}
