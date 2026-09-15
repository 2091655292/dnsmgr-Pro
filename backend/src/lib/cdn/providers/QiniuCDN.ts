import { Qiniu } from '../../clients/Qiniu.js';
import type { CdnProvider, CdnDomainItem } from '../types.js';
import { catalogPath, fileExtensions, normalizeValue, parsePathRule } from '../pathRule.js';

const geoCoverMap: Record<string, string> = { mainland_china: 'china', global: 'global' };

function toCacheTime(seconds: number): { time: number; timeunit: number } {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (s <= 0) return { time: 0, timeunit: 0 };
  if (s % 86400 === 0) return { time: s / 86400, timeunit: 3 };
  if (s % 3600 === 0) return { time: s / 3600, timeunit: 2 };
  if (s % 60 === 0) return { time: s / 60, timeunit: 1 };
  return { time: s, timeunit: 0 };
}

export class QiniuCDN implements CdnProvider {
  private client: Qiniu;
  private error = '';

  constructor(config: Record<string, any>) {
    this.client = new Qiniu(config.AccessKey, config.SecretKey, 'api.qiniu.com');
  }

  getError() {
    return this.error;
  }

  private async call(method: string, path: string, query?: Record<string, any> | null, params?: Record<string, any> | null): Promise<any> {
    try {
      return await this.client.request(method, path, query, params);
    } catch (e: any) {
      this.error = e.message || String(e);
      return false;
    }
  }

  async check() {
    return (await this.call('GET', '/domain')) !== false;
  }

  async createDomain(domain: string, origin: string, originType: string, serviceArea: string): Promise<string | false> {
    const advancedSources = origin
      .split(';')
      .map((v) => v.trim())
      .filter((v) => v !== '')
      .map((v) => ({ addr: v, backup: false, weight: 1 }));
    const body = {
      type: 'normal',
      platform: 'web',
      geoCover: geoCoverMap[serviceArea] ?? 'china',
      protocol: 'http',
      IpTypes: 1,
      source: { sourceType: 'advanced', advancedSources, testURLPath: '/' },
      cache: { cacheControls: [{ type: 'all', rule: '*', time: 30, timeunit: 3 }] },
    };
    if (!(await this.call('POST', `/domain/${domain}`, null, body))) return false;
    for (let i = 0; i < 10; i++) {
      const cname = await this.getDomainCname(domain);
      if (cname) return cname;
      await new Promise((r) => setTimeout(r, 1000));
    }
    this.error = '未获取到 CNAME，请稍后在列表刷新重试';
    return false;
  }

  async getDomainCname(domain: string): Promise<string | false> {
    const data = await this.call('GET', `/domain/${domain}`);
    if (!data) return false;
    return data && data.cname ? String(data.cname) : false;
  }

  async listDomains(): Promise<CdnDomainItem[] | false> {
    const list: CdnDomainItem[] = [];
    let marker = '';
    do {
      const query: Record<string, any> = { limit: 100 };
      if (marker) query.marker = marker;
      const data = await this.call('GET', '/domain', query);
      if (!data) return false;
      const domains = data.domains || [];
      for (const d of domains) {
        const name = d.name || '';
        if (!name) continue;
        const detail = await this.call('GET', `/domain/${name}`);
        if (!detail) continue;
        list.push(this.mapDomain(detail));
      }
      marker = data.marker || '';
      if (!domains.length) break;
    } while (marker);
    return list;
  }

  private mapDomain(d: any): CdnDomainItem {
    const source = d.source || {};
    const advanced = source.advancedSources || [];
    const origins: string[] = [];
    for (const s of advanced) {
      if (s.backup) continue;
      if (s.addr) origins.push(String(s.addr));
    }
    if (!origins.length && source.sourceDomain) origins.push(String(source.sourceDomain));
    if (!origins.length && source.sourceIPs) {
      for (const ip of source.sourceIPs) origins.push(String(ip));
    }
    const originType = source.sourceType === 'domain' ? 'domain' : 'ipaddr';
    return {
      domain: d.name || '',
      cname: d.cname || '',
      status: String(d.operatingState || '').toLowerCase() === 'failure' ? 'offline' : 'online',
      area: d.geoCover === 'global' ? 'global' : 'mainland_china',
      origin: origins.join(';'),
      origin_type: originType,
      origin_host: source.sourceHost || '',
      origin_protocol: 'follow',
      http_port: 80,
      https_port: 443,
      https_enabled: !!d.https?.certId,
      force_redirect: d.https?.forceHttps === true,
    };
  }

  async deleteDomain(domain: string) {
    return (await this.call('DELETE', `/domain/${domain}`, null, {})) !== false;
  }

  async setDomainStatus(domain: string, status: string) {
    const path = status === 'offline' ? `/domain/${domain}/offline` : `/domain/${domain}/online`;
    return (await this.call('POST', path, null, {})) !== false;
  }

  async updateOrigin(domain: string, origin: string, originType: string, originHost: string, originProtocol: string, httpPort: number, httpsPort: number) {
    const advancedSources = origin
      .split(';')
      .map((v) => v.trim())
      .filter((v) => v !== '')
      .map((v) => ({ addr: v, backup: false, weight: 1 }));
    const source: Record<string, any> = { sourceType: 'advanced', advancedSources };
    if (originHost) source.sourceHost = originHost;
    return (await this.call('PUT', `/domain/${domain}/source`, null, source)) !== false;
  }

  async setCacheRules(domain: string, rules: any[]) {
    const cacheControls = rules
      .map((r) => {
        const parsed = parsePathRule(r?.path);
        const { time, timeunit } = toCacheTime(r?.ttl);
        let type = 'all';
        let rule = '*';
        if (parsed.type === 'file_extension') {
          type = 'filetype';
          const exts = fileExtensions(parsed.value).map((e) => '.' + e);
          if (!exts.length) return null;
          rule = exts.join(',');
        } else if (parsed.type === 'catalog') {
          type = 'path';
          rule = catalogPath(parsed.value) + '/*';
        } else if (parsed.type === 'full_path') {
          type = 'path';
          rule = normalizeValue(parsed.value);
        }
        return { time, timeunit, type, rule };
      })
      .filter(Boolean);
    return (await this.call('PUT', `/domain/${domain}/cache`, null, { cacheControls, ignoreParam: false })) !== false;
  }

  async setHttps(domain: string, enabled: boolean, forceRedirect: boolean) {
    if (!enabled) {
      return (await this.call('PUT', `/domain/${domain}/unsslize`, null, {})) !== false;
    }
    const info = await this.call('GET', `/domain/${domain}`);
    const https = info?.https || {};
    if (https.certId) {
      return (
        (await this.call('PUT', `/domain/${domain}/httpsconf`, null, {
          certid: https.certId,
          forceHttps: !!forceRedirect,
          http2Enable: https.http2Enable === true,
        })) !== false
      );
    }
    return true;
  }

  async purge(urls: string[], type: 'url' | 'dir'): Promise<string | false> {
    const body = type === 'dir' ? { dirs: urls } : { urls };
    const data = await this.call('POST', '/cache/refresh', null, body);
    if (data === false) return false;
    return (data && data.requestId) ? String(data.requestId) : 'ok';
  }

  async preheat(urls: string[]): Promise<string | false> {
    const data = await this.call('POST', '/cache/prefetch', null, { urls });
    if (data === false) return false;
    return (data && data.requestId) ? String(data.requestId) : 'ok';
  }

  async getAccess(domain: string): Promise<Record<string, any> | false> {
    const out: Record<string, any> = { referer_mode: 'off', referer_list: [], ip_mode: 'off', ip_list: [], ua_list: [] };
    const data = await this.call('GET', `/domain/${domain}`);
    if (!data) return false;
    const referer = data.referer;
    if (referer) {
      out.referer_mode = referer.refererType === 'white' ? 'whitelist' : referer.refererType === 'black' ? 'blacklist' : 'off';
      out.referer_list = referer.refererValues || [];
    }
    const ipacl = data.ipacl || data.ipACL;
    if (ipacl) {
      out.ip_mode = ipacl.ipACLType === 'white' ? 'whitelist' : ipacl.ipACLType === 'black' ? 'blacklist' : 'off';
      out.ip_list = ipacl.ipACLValues || [];
    }
    return out;
  }

  async setAccess(domain: string, config: Record<string, any>): Promise<boolean> {
    const refererMode = config.referer_mode || 'off';
    const refererType = refererMode === 'whitelist' ? 'white' : refererMode === 'blacklist' ? 'black' : 'off';
    if ((await this.call('PUT', `/domain/${domain}/referer`, null, { refererType, refererValues: config.referer_list || [], nullReferer: false })) === false)
      return false;

    const ipMode = config.ip_mode || 'off';
    const ipACLType = ipMode === 'whitelist' ? 'white' : ipMode === 'blacklist' ? 'black' : 'off';
    return (
      (await this.call('PUT', `/domain/${domain}/ipacl`, null, { ipACLType, ipACLValues: config.ip_list || [] })) !== false
    );
  }
}