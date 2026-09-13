import { Aliyun } from '../../clients/Aliyun.js';
import type { CdnStatisticsResult, StatisticsDomain } from './types.js';
import { alignSeries, buildLabels, max, sum } from './util.js';

function formatIso(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function pickSeries(data: any[], fieldName: string): number[] {
  for (const item of data || []) {
    if (item?.FieldName !== fieldName) continue;
    const detail = item.DetailData;
    if (!Array.isArray(detail)) continue;
    const sorted = [...detail].sort((a, b) => String(a?.TimeStamp || '').localeCompare(String(b?.TimeStamp || '')));
    return sorted.map((it) => {
      const num = Number(it?.Value);
      return Number.isFinite(num) ? Math.ceil(num) : 0;
    });
  }
  return [];
}

export async function queryAliyunEsaStatistics(
  config: Record<string, any>,
  domains: StatisticsDomain[],
  start: Date,
  end: Date,
  type: string,
): Promise<CdnStatisticsResult> {
  const client = new Aliyun(config.AccessKeyId, config.AccessKeySecret, 'esa.aliyuncs.com', '2024-09-10');
  const { labels, interval } = buildLabels(start, end);
  const len = labels.length;
  const result: CdnStatisticsResult = { labels };
  const intervalSec = interval === 'day' ? '86400' : '3600';

  const bw = new Array(len).fill(0);
  const flux = new Array(len).fill(0);
  const reqNum = new Array(len).fill(0);
  const hitFlux = new Array(len).fill(0);

  for (const d of domains) {
    if (!d.zoneId) continue;
    const fields: any[] = [
      { FieldName: 'Traffic', Dimension: ['ALL'] },
      { FieldName: 'Bandwidth', Dimension: ['ALL'] },
    ];
    if (type === 'Visits' || type === 'All') {
      fields.push({ FieldName: 'Requests', Dimension: ['ALL'] });
      fields.push({ FieldName: 'HitRate', Dimension: ['ALL'] });
    }
    let data: any[] = [];
    try {
      const resp = await client.request({
        Action: 'DescribeSiteTimeSeriesData',
        SiteId: d.zoneId,
        StartTime: formatIso(start),
        EndTime: formatIso(end),
        Interval: intervalSec,
        Fields: JSON.stringify(fields),
      });
      data = resp?.Data || [];
    } catch {
      data = [];
    }

    if (type === 'Resource' || type === 'All') {
      const fluxSeries = alignSeries(pickSeries(data, 'Traffic'), len);
      const bwSeries = alignSeries(pickSeries(data, 'Bandwidth'), len);
      for (let i = 0; i < len; i++) {
        flux[i] += fluxSeries[i] || 0;
        bw[i] += bwSeries[i] || 0;
      }
      if (type === 'All') {
        const rateSeries = alignSeries(pickSeries(data, 'HitRate'), len);
        // HitRate 可能为百分比（0-100）或比例（0-1），按最大值自适应
        const asPercent = Math.max(...rateSeries, 0) > 1.5;
        for (let i = 0; i < len; i++) {
          const rate = asPercent ? (rateSeries[i] || 0) / 100 : rateSeries[i] || 0;
          hitFlux[i] += Math.round((fluxSeries[i] || 0) * rate);
        }
      }
    }
    if (type === 'Visits' || type === 'All') {
      const reqSeries = alignSeries(pickSeries(data, 'Requests'), len);
      for (let i = 0; i < len; i++) reqNum[i] += reqSeries[i] || 0;
    }
  }

  if (type === 'Resource' || type === 'All') {
    result.resource = {
      resource_detail: { bw, bs_bw: new Array(len).fill(0), flux, bs_flux: new Array(len).fill(0) },
      resource_summary: { bw: max(bw), bs_bw: 0, flux: sum(flux), bs_flux: 0 },
    };
  }
  if (type === 'Visits' || type === 'All') {
    result.visits = {
      visits_detail: {
        req_num: reqNum,
        hit_flux: hitFlux,
        hit_num: new Array(len).fill(0),
        bs_num: new Array(len).fill(0),
      },
      visits_summary: { req_num: sum(reqNum), hit_flux: sum(hitFlux), hit_num: 0, bs_num: 0 },
    };
  }
  return result;
}
