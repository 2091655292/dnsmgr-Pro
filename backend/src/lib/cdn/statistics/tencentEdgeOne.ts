import { TencentCloud } from '../../clients/TencentCloud.js';
import type { CdnStatisticsResult, StatisticsDomain } from './types.js';
import { alignSeries, buildLabels, max, sum } from './util.js';

const ACCESS_FLUX = 'l7Flow_outFlux';
const ACCESS_BANDWIDTH = 'l7Flow_outBandwidth';
const ACCESS_REQUEST = 'l7Flow_request';
const HIT_FLUX = 'l7Flow_hit_outFlux';
const ORIGIN_FLUX = 'l7Flow_inFlux_hy';
const ORIGIN_BANDWIDTH = 'l7Flow_inBandwidth_hy';
const ORIGIN_REQUEST = 'l7Flow_request_hy';

function toArea(serviceArea?: string | null): string {
  if (serviceArea === 'mainland_china') return 'mainland';
  if (serviceArea === 'overseas' || serviceArea === 'outside_mainland_china') return 'overseas';
  return 'global';
}

function formatTime(d: Date): string {
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function extractSeries(records: any[] | undefined, metricName: string): number[] {
  if (!Array.isArray(records)) return [];
  const values: number[] = [];
  for (const record of records) {
    for (const tv of record?.TypeValue || []) {
      if (tv?.MetricName !== metricName) continue;
      const detail = tv.Detail;
      if (Array.isArray(detail) && detail.length) {
        const sorted = [...detail].sort((a, b) => Number(a?.Timestamp || 0) - Number(b?.Timestamp || 0));
        for (const item of sorted) {
          const num = Number(item?.Value);
          values.push(Number.isFinite(num) ? Math.ceil(num) : 0);
        }
      } else if (Number(tv?.Sum) > 0) {
        values.push(Math.ceil(Number(tv.Sum)));
      }
    }
  }
  return values;
}

export async function queryTencentEdgeOneStatistics(
  config: Record<string, any>,
  domains: StatisticsDomain[],
  start: Date,
  end: Date,
  type: string,
): Promise<CdnStatisticsResult> {
  const client = new TencentCloud(config.SecretId, config.SecretKey, 'teo.tencentcloudapi.com', 'teo', '2022-09-01');
  const { labels, interval } = buildLabels(start, end);
  const len = labels.length;
  const result: CdnStatisticsResult = { labels };

  async function access(zoneId: string, domain: string, area: string, metricNames: string[]): Promise<any[]> {
    try {
      const resp = await client.request('DescribeTimingL7AnalysisData', {
        ZoneIds: [zoneId],
        MetricNames: metricNames,
        StartTime: formatTime(start),
        EndTime: formatTime(end),
        Interval: interval,
        Area: area,
        Filters: [{ Key: 'domain', Operator: 'equals', Value: [domain] }],
      });
      return resp?.TimingDataRecords || [];
    } catch {
      return [];
    }
  }

  async function origin(zoneId: string, domain: string, metricNames: string[]): Promise<any[]> {
    try {
      const resp = await client.request('DescribeTimingL7OriginPullData', {
        ZoneIds: [zoneId],
        MetricNames: metricNames,
        StartTime: formatTime(start),
        EndTime: formatTime(end),
        Interval: interval,
        Filters: [{ Key: 'domain', Operator: 'equals', Value: [domain] }],
      });
      return resp?.TimingDataRecords || [];
    } catch {
      return [];
    }
  }

  const bw = new Array(len).fill(0);
  const bsBw = new Array(len).fill(0);
  const flux = new Array(len).fill(0);
  const bsFlux = new Array(len).fill(0);
  const reqNum = new Array(len).fill(0);
  const hitFlux = new Array(len).fill(0);
  const bsNum = new Array(len).fill(0);

  for (const d of domains) {
    const zoneId = d.zoneId || '';
    if (!zoneId) continue;
    const area = toArea(d.serviceArea);
    const add = (target: number[], values: number[]) => {
      const aligned = alignSeries(values, len);
      for (let i = 0; i < len; i++) target[i] += aligned[i] || 0;
    };

    if (type === 'Resource' || type === 'All') {
      const accessRecords = await access(zoneId, d.name, area, [ACCESS_FLUX, ACCESS_BANDWIDTH]);
      add(flux, extractSeries(accessRecords, ACCESS_FLUX));
      add(bw, extractSeries(accessRecords, ACCESS_BANDWIDTH));
      const originRecords = await origin(zoneId, d.name, [ORIGIN_FLUX, ORIGIN_BANDWIDTH]);
      add(bsFlux, extractSeries(originRecords, ORIGIN_FLUX));
      add(bsBw, extractSeries(originRecords, ORIGIN_BANDWIDTH));
    }
    if (type === 'Visits' || type === 'All') {
      const accessRecords = await access(zoneId, d.name, area, [ACCESS_REQUEST, HIT_FLUX]);
      add(reqNum, extractSeries(accessRecords, ACCESS_REQUEST));
      add(hitFlux, extractSeries(accessRecords, HIT_FLUX));
      const originRecords = await origin(zoneId, d.name, [ORIGIN_REQUEST]);
      add(bsNum, extractSeries(originRecords, ORIGIN_REQUEST));
    }
  }

  if (type === 'Resource' || type === 'All') {
    result.resource = {
      resource_detail: { bw, bs_bw: bsBw, flux, bs_flux: bsFlux },
      resource_summary: { bw: max(bw), bs_bw: max(bsBw), flux: sum(flux), bs_flux: sum(bsFlux) },
    };
  }
  if (type === 'Visits' || type === 'All') {
    result.visits = {
      visits_detail: {
        req_num: reqNum,
        hit_flux: hitFlux,
        // EdgeOne 未提供请求命中次数指标，命中率以流量维度计算
        hit_num: new Array(len).fill(0),
        bs_num: bsNum,
      },
      visits_summary: { req_num: sum(reqNum), hit_flux: sum(hitFlux), hit_num: 0, bs_num: sum(bsNum) },
    };
  }
  return result;
}
