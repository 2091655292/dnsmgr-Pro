import { Aliyun } from '../../clients/Aliyun.js';
import type { CdnStatisticsResult, StatisticsDomain } from './types.js';
import { alignSeries, buildLabels, max, sum } from './util.js';

function formatIso(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export async function queryAliyunCdnStatistics(
  config: Record<string, any>,
  domains: StatisticsDomain[],
  start: Date,
  end: Date,
  type: string,
): Promise<CdnStatisticsResult> {
  const client = new Aliyun(config.AccessKeyId, config.AccessKeySecret, 'cdn.aliyuncs.com', '2018-05-10');
  const { labels, interval } = buildLabels(start, end);
  const len = labels.length;
  const result: CdnStatisticsResult = { labels };

  const intervalSec = interval === 'day' ? '86400' : '3600';

  async function usage(domain: string, field: string): Promise<number[]> {
    try {
      const resp = await client.request({
        Action: 'DescribeDomainUsageData',
        DomainName: domain,
        Field: field,
        Type: 'all',
        DataProtocol: 'all',
        Area: 'all',
        Interval: intervalSec,
        StartTime: formatIso(start),
        EndTime: formatIso(end),
      });
      const items = resp?.UsageDataPerInterval?.DataModule || [];
      return items.map((it: any) => {
        const num = Number(it?.Value);
        return Number.isFinite(num) ? Math.ceil(num) : 0;
      });
    } catch {
      return [];
    }
  }

  async function hitRate(domain: string): Promise<number[]> {
    try {
      const resp = await client.request({
        Action: 'DescribeDomainHitRateData',
        DomainName: domain,
        Interval: intervalSec,
        StartTime: formatIso(start),
        EndTime: formatIso(end),
      });
      const items = resp?.HitRatePerInterval || [];
      return items.map((it: any) => {
        const num = Number(it?.HitRate);
        return Number.isFinite(num) ? num : 0;
      });
    } catch {
      return [];
    }
  }

  const bw = new Array(len).fill(0);
  const flux = new Array(len).fill(0);
  const hitFlux = new Array(len).fill(0);

  for (const d of domains) {
    const add = (target: number[], values: number[]) => {
      const aligned = alignSeries(values, len);
      for (let i = 0; i < len; i++) target[i] += aligned[i] || 0;
    };

    if (type === 'Resource' || type === 'All') {
      const domainFlux = await usage(d.name, 'traf');
      add(flux, domainFlux);
      add(bw, await usage(d.name, 'bps'));
      if (type === 'All') {
        const rates = alignSeries(await hitRate(d.name), len);
        const alignedFlux = alignSeries(domainFlux, len);
        for (let i = 0; i < len; i++) hitFlux[i] += Math.round(((alignedFlux[i] || 0) * (rates[i] || 0)) / 100);
      }
    }
  }

  if (type === 'Resource' || type === 'All') {
    result.resource = {
      resource_detail: {
        bw,
        bs_bw: new Array(len).fill(0),
        flux,
        bs_flux: new Array(len).fill(0),
      },
      resource_summary: { bw: max(bw), bs_bw: 0, flux: sum(flux), bs_flux: 0 },
    };
  }
  if (type === 'All') {
    // 阿里云 CDN 仅提供流量命中率，据此推算命中流量；请求命中率/状态码暂不提供
    result.visits = {
      visits_detail: {
        req_num: new Array(len).fill(0),
        hit_flux: hitFlux,
        hit_num: new Array(len).fill(0),
        bs_num: new Array(len).fill(0),
      },
      visits_summary: { req_num: 0, hit_flux: sum(hitFlux), hit_num: 0, bs_num: 0 },
    };
  }
  return result;
}
