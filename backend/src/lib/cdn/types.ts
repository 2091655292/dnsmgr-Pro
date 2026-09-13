export interface CdnDomainItem {
  domain: string;
  cname: string;
  status: string;
  area?: string;
  zoneId?: string;
  origin?: string;
  origin_type?: string;
  origin_host?: string;
  origin_protocol?: string;
  http_port?: number;
  https_port?: number;
  https_enabled?: boolean;
  force_redirect?: boolean;
}

export interface CdnProvider {
  getError(): string;
  check(): Promise<boolean>;
  createDomain(domain: string, origin: string, originType: string, serviceArea: string, zoneId?: string | null): Promise<string | false>;
  getDomainCname(domain: string): Promise<string | false>;
  listDomains(): Promise<CdnDomainItem[] | false>;
  deleteDomain(domain: string): Promise<boolean>;
  setDomainStatus(domain: string, status: string): Promise<boolean>;
  updateOrigin(domain: string, origin: string, originType: string, originHost: string, originProtocol: string, httpPort: number, httpsPort: number): Promise<boolean>;
  setCacheRules(domain: string, rules: any[]): Promise<boolean>;
  setHttps(domain: string, enabled: boolean, forceRedirect: boolean): Promise<boolean>;
  getZoneSetting?(zoneId: string): Promise<Record<string, any> | false>;
  updateZoneSetting?(zoneId: string, zoneConfig: Record<string, any>): Promise<boolean>;
  getZones?(): Promise<any[]>;
  setZoneId?(zoneId: string): void;
  purge?(urls: string[], type: 'url' | 'dir'): Promise<string | false>;
  preheat?(urls: string[]): Promise<string | false>;
  getAccess?(domain: string): Promise<Record<string, any> | false>;
  setAccess?(domain: string, config: Record<string, any>): Promise<boolean>;
}