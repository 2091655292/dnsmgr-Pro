import type { CdnStatisticsResult, StatisticsDomain } from './types.js';
import { queryTencentCdnStatistics } from './tencentCdn.js';
import { queryTencentEdgeOneStatistics } from './tencentEdgeOne.js';
import { queryAliyunCdnStatistics } from './aliyunCdn.js';
import { queryAliyunEsaStatistics } from './aliyunEsa.js';

export type { CdnStatisticsResult, StatisticsDomain } from './types.js';
export { buildLabels } from './util.js';

type StatisticsHandler = (
  config: Record<string, any>,
  domains: StatisticsDomain[],
  start: Date,
  end: Date,
  type: string,
) => Promise<CdnStatisticsResult>;

const handlers: Record<string, StatisticsHandler> = {
  tencent_cdn: queryTencentCdnStatistics,
  tencent_edgeone: queryTencentEdgeOneStatistics,
  aliyun_cdn: queryAliyunCdnStatistics,
  aliyun_esa: queryAliyunEsaStatistics,
};

export function hasCdnStatistics(route: string): boolean {
  return typeof handlers[route] === 'function';
}

export function queryByRoute(
  route: string,
  config: Record<string, any>,
  domains: StatisticsDomain[],
  start: Date,
  end: Date,
  type: string,
): Promise<CdnStatisticsResult> {
  const handler = handlers[route];
  if (!handler) return Promise.resolve({ labels: [] });
  return handler(config, domains, start, end, type);
}
