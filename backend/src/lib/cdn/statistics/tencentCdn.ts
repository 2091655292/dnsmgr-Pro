import { TencentCloud } from '../../clients/TencentCloud.js';
import type { CdnStatisticsResult, StatisticsDomain } from './types.js';
import { alignSeries, buildLabels, max, parseValueSeries, sum } from './util.js';

const STATUS_CODES = ['2xx', '3xx', '4xx', '5xx'] as const;

function toAreaList(serviceArea?: string | null): string[] {
  if (serviceArea === 'overseas' || serviceArea === 'outside_mainland_china') return ['overseas'];
  if (serviceArea === 'global') return ['mainland', 'overseas'];
  return ['mainland'];
}

function formatTime(d: Date): string {
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export async function queryTencentCdnStatistics(
  config: Record<string, any>,
  domains: StatisticsDomain[],
  start: Date,
  end: Date,
  type: string,
): Promise<CdnStatisticsResult> {
  const client = new TencentCloud(config.SecretId, config.SecretKey, 'cdn.tencentcloudapi.com', 'cdn', '2018-06-06');
  const { labels, interval } = buildLabels(start, end);
  const len = labels.length;
  const result: CdnStatisticsResult = { labels };

  async function cdnData(domain: string, metric: string, area: string): Promise<number[]> {
    try {
      const resp = await client.request('DescribeCdnData', {
        StartTime: formatTime(start),
        EndTime: formatTime(end),
        Metric: metric,
        Interval: interval,
        Domains: [domain],
        Area: area,
      });
      const detail = resp?.Data?.[0]?.CdnData?.[0]?.DetailData;
      return parseValueSeries(detail);
    } catch {
      return [];
    }
  }

  async function originData(domain: string, metric: string, area: string): Promise<number[]> {
    try {
      const resp = await client.request('DescribeOriginData', {
        StartTime: formatTime(start),
        EndTime: formatTime(end),
        Metric: metric,
        Interval: interval,
        Domains: [domain],
        Area: area,
      });
      const detail = resp?.Data?.[0]?.OriginData?.[0]?.DetailData;
      return parseValueSeries(detail);
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
  const hitNum = new Array(len).fill(0);
  const bsNum = new Array(len).fill(0);
  const statusDetail = STATUS_CODES.map(() => new Array(len).fill(0));
  const bsStatusDetail = STATUS_CODES.map(() => new Array(len).fill(0));

  for (const d of domains) {
    for (const area of toAreaList(d.serviceArea)) {
      const add = (target: number[], values: number[]) => {
        const aligned = alignSeries(values, len);
        for (let i = 0; i < len; i++) target[i] += aligned[i] || 0;
      };

      if (type === 'Resource' || type === 'All') {
        add(bw, await cdnData(d.name, 'bandwidth', area));
        add(bsBw, await originData(d.name, 'bandwidth', area));
        add(flux, await cdnData(d.name, 'flux', area));
        add(bsFlux, await originData(d.name, 'flux', area));
      }
      if (type === 'Visits' || type === 'All') {
        add(reqNum, await cdnData(d.name, 'request', area));
        add(hitFlux, await cdnData(d.name, 'hitFlux', area));
        add(hitNum, await cdnData(d.name, 'hitRequest', area));
        add(bsNum, await originData(d.name, 'request', area));
      }
      if (type === 'HttpCodeStatus' || type === 'All') {
        for (let i = 0; i < STATUS_CODES.length; i++) {
          add(statusDetail[i], await cdnData(d.name, STATUS_CODES[i], area));
          add(bsStatusDetail[i], await originData(d.name, STATUS_CODES[i], area));
        }
      }
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
      visits_detail: { req_num: reqNum, hit_flux: hitFlux, hit_num: hitNum, bs_num: bsNum },
      visits_summary: {
        req_num: sum(reqNum),
        hit_flux: sum(hitFlux),
        hit_num: sum(hitNum),
        bs_num: sum(bsNum),
      },
    };
  }
  if (type === 'HttpCodeStatus' || type === 'All') {
    result.status = {
      status_detail: statusDetail,
      status_summary: statusDetail.map((arr) => sum(arr)),
      bs_status_detail: bsStatusDetail,
      bs_status_summary: bsStatusDetail.map((arr) => sum(arr)),
    };
  }
  return result;
}
