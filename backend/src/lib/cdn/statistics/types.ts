export interface ResourceSummary {
  /** 访问带宽峰值 */
  bw: number;
  /** 回源带宽峰值 */
  bs_bw: number;
  /** 访问流量 */
  flux: number;
  /** 回源流量 */
  bs_flux: number;
}

export interface ResourceDetail {
  bw: number[];
  bs_bw: number[];
  flux: number[];
  bs_flux: number[];
}

export interface ResourceStatistics {
  resource_summary: ResourceSummary;
  resource_detail: ResourceDetail;
}

export interface VisitsSummary {
  /** 请求总数 */
  req_num: number;
  /** 命中流量 */
  hit_flux: number;
  /** 请求命中次数 */
  hit_num: number;
  /** 回源请求数 */
  bs_num: number;
}

export interface VisitsDetail {
  req_num: number[];
  hit_flux: number[];
  hit_num: number[];
  bs_num: number[];
}

export interface VisitsStatistics {
  visits_summary: VisitsSummary;
  visits_detail: VisitsDetail;
}

export interface HttpCodeStatusStatistics {
  /** [2xx, 3xx, 4xx, 5xx] */
  status_summary: number[];
  status_detail: number[][];
  /** 回源状态码 */
  bs_status_summary: number[];
  bs_status_detail: number[][];
}

export interface CdnStatisticsResult {
  labels: string[];
  resource?: ResourceStatistics;
  visits?: VisitsStatistics;
  status?: HttpCodeStatusStatistics;
}

export type StatisticsType = 'Resource' | 'Visits' | 'HttpCodeStatus' | 'All';

export interface StatisticsDomain {
  name: string;
  route: string;
  zoneId?: string | null;
  serviceArea?: string | null;
}

export interface StatisticsQuery {
  type: StatisticsType;
  start: Date;
  end: Date;
}
