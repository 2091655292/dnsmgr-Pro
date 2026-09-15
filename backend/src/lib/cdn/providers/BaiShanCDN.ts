import { BaiShan } from '../../clients/BaiShan.js';
import type { CdnProvider, CdnDomainItem } from '../types.js';
import { catalogPath, fileExtensions, normalizeValue, parsePathRule } from '../pathRule.js';

const areaMap: Record<string, string> = {
  mainland_china: 'mainland_china',
  overseas: 'outside_mainland_china',
  global: 'global',
};

function ttlToUnit(seconds: number): { expire: number; expire_unit: string } {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (s <= 0) return { expire: 0, expire_unit: 's' };
  if (s % 86400 === 0) return { expire: s / 86400, expire_unit: 'D' };
  if (s % 3600 === 0) return { expire: s / 3600, expire_unit: 'h' };
  if (s % 60 === 0) return { expire: s / 60, expire_unit: 'i' };
  return { expire: s, expire_unit: 's' };
}

export class BaiShanCDN implements CdnProvider {
  private client: BaiShan;
  private error = '';

  constructor(config: Record<string, any>) {
    this.client = new BaiShan(config.Token, 'cdn.api.baishan.com');
  }

  getError() {
    return this.error;
  }

  private async call(method: string, path: string, query?: Record<string, any> | null, body?: Record<string, any> | null): Promise<any> {
    try {
      return await this.client.request(method, path, query, body);
    } catch (e: any) {
      this.error = e.message || String(e);
      return false;
    }
  }

  async check() {
    return (await this.call('GET', '/v2/domain')) !== false;
  }

  private async query(domain: string): Promise<any | false> {
    const data = await this.call('GET', '/v2/domain', { domains: domain });
    if (!data || !Array.isArray(data) || !data.length) return false;
    return data[0];
  }

  private async listAll(): Promise<any[] | false> {
    const data = await this.call('GET', '/v2/domain');
    if (!data) return false;
    if (Array.isArray(data)) return data;
    return [];
  }

  async createDomain(domain: string, origin: string, originType: string, serviceArea: string): Promise<string | false> {
    const body = {
      domain,
      area: areaMap[serviceArea] ?? 'mainland_china',
      type: 'page',
      config: {
        origin: { default_master: origin.replace(/;/g, ','), origin_mode: 'default' },
        origin_host: { host: domain },
      },
    };
    if (!(await this.call('POST', '/v2/domain', null, body))) return false;
    for (let i = 0; i < 10; i++) {
      const cname = await this.getDomainCname(domain);
      if (cname) return cname;
      await new Promise((r) => setTimeout(r, 1000));
    }
    this.error = '未获取到 CNAME，请稍后在列表刷新重试';
    return false;
  }

  async getDomainCname(domain: string): Promise<string | false> {
    const info = await this.query(domain);
    if (!info) return false;
    return info.cname ? String(info.cname) : false;
  }

  private mapDomain(info: any): CdnDomainItem {
    const config = info.config || {};
    const origin = config.origin || {};
    const master = String(origin.default_master || '').replace(/,/g, ';');
    const masterType = master
      .split(';')
      .filter(Boolean)
      .every((h) => /^[\d.]+$/.test(h) || h.includes(':'))
      ? 'ipaddr'
      : 'domain';
    const https = config.https || {};
    return {
      domain: info.domain || '',
      cname: info.cname || '',
      status: String(info.status || '').toLowerCase() === 'off' ? 'offline' : 'online',
      area: areaMap[String(info.area || '')] || '',
      origin: master,
      origin_type: masterType,
      origin_host: config.origin_host?.host || '',
      origin_protocol: origin.origin_mode === 'custom' ? (origin.ori_https === 'yes' ? 'https' : 'http') : 'follow',
      http_port: origin.port || 80,
      https_port: 443,
      https_enabled: !!https.cert_id,
      force_redirect: ['301', '302'].includes(String(https.force_https || '')),
    };
  }

  async listDomains(): Promise<CdnDomainItem[] | false> {
    const data = await this.listAll();
    if (data === false) return false;
    return data.map((info) => this.mapDomain(info));
  }

  async deleteDomain(domain: string) {
    return (await this.call('DELETE', '/v2/domain', { domains: domain })) !== false;
  }

  async setDomainStatus(domain: string, status: string) {
    const path = status === 'offline' ? '/v2/domain/disable' : '/v2/domain/enable';
    return (await this.call('GET', path, { domains: domain })) !== false;
  }

  async updateOrigin(domain: string, origin: string, originType: string, originHost: string, originProtocol: string, httpPort: number, httpsPort: number) {
    const originCfg: Record<string, any> = { default_master: origin.replace(/;/g, ',') };
    if (originProtocol === 'http' || originProtocol === 'https') {
      originCfg.origin_mode = 'custom';
      originCfg.ori_https = originProtocol === 'https' ? 'yes' : 'no';
      originCfg.port = originProtocol === 'https' ? httpsPort : httpPort;
    } else {
      originCfg.origin_mode = 'default';
    }
    const config: Record<string, any> = { origin: originCfg };
    if (originHost) config.origin_host = { host: originHost };
    return (await this.call('POST', '/v2/domain/config', null, { domains: domain, config })) !== false;
  }

  async setCacheRules(domain: string, rules: any[]) {
    const cache_rule_list = rules
      .map((r, idx) => {
        const parsed = parsePathRule(r?.path);
        const { expire, expire_unit } = ttlToUnit(r?.ttl);
        let match_method = 'all';
        let pattern = '.*';
        if (parsed.type === 'file_extension') {
          const exts = fileExtensions(parsed.value);
          if (!exts.length) return null;
          match_method = 'ext';
          pattern = exts.join(',');
        } else if (parsed.type === 'catalog') {
          match_method = 'dir';
          pattern = catalogPath(parsed.value) + '/';
        } else if (parsed.type === 'full_path') {
          match_method = 'route';
          pattern = normalizeValue(parsed.value);
        }
        return { match_method, pattern, expire, expire_unit, priority: idx + 1, case_ignore: 'no' };
      })
      .filter(Boolean);
    return (await this.call('POST', '/v2/domain/config', null, { domains: domain, config: { cache_rule_list } })) !== false;
  }

  async setHttps(domain: string, enabled: boolean, forceRedirect: boolean) {
    const info = await this.query(domain);
    const certId = info?.config?.https?.cert_id || 0;
    const https: Record<string, any> = {
      cert_id: enabled ? certId : 0,
      http2: 'off',
      force_https: forceRedirect ? '301' : '0',
    };
    return (await this.call('POST', '/v2/domain/config', null, { domains: domain, config: { https } })) !== false;
  }

  async purge(urls: string[], type: 'url' | 'dir'): Promise<string | false> {
    const data = await this.call('POST', '/v2/cache/refresh', null, { urls, type: type === 'dir' ? 'dir' : 'url' });
    if (data === false) return false;
    return data && data.task_id ? String(data.task_id) : 'ok';
  }

  async preheat(urls: string[]): Promise<string | false> {
    const data = await this.call('POST', '/v2/cache/prefetch', null, { urls });
    if (data === false) return false;
    return data && data.task_id ? String(data.task_id) : 'ok';
  }

  async getAccess(domain: string): Promise<Record<string, any> | false> {
    const info = await this.query(domain);
    if (!info) return false;
    const config = info.config || {};
    const out: Record<string, any> = { referer_mode: 'off', referer_list: [], ip_mode: 'off', ip_list: [], ua_list: [] };
    const referer = config.referer;
    if (referer) {
      const t = Number(referer.type || 0);
      out.referer_mode = t === 1 ? 'blacklist' : t === 2 ? 'whitelist' : 'off';
      out.referer_list = referer.list || [];
    }
    if (config.ip_black_list) {
      out.ip_mode = 'blacklist';
      out.ip_list = config.ip_black_list.list || [];
    } else if (config.ip_white_list) {
      out.ip_mode = 'whitelist';
      out.ip_list = config.ip_white_list.list || [];
    }
    return out;
  }

  async setAccess(domain: string, config: Record<string, any>): Promise<boolean> {
    const refererMode = config.referer_mode || 'off';
    const refererType = refererMode === 'blacklist' ? 1 : refererMode === 'whitelist' ? 2 : 0;
    const cfg: Record<string, any> = {};
    if (refererType === 0) {
      if ((await this.call('DELETE', '/v2/domain/config', null, { domains: domain, config: ['referer'] })) === false) return false;
    } else {
      cfg.referer = { type: refererType, list: config.referer_list || [], allow_empty: (config.referer_list || []).length === 0 };
    }
    const ipMode = config.ip_mode || 'off';
    if (ipMode === 'off') {
      if ((await this.call('DELETE', '/v2/domain/config', null, { domains: domain, config: ['ip_black_list', 'ip_white_list'] })) === false) return false;
    } else if (ipMode === 'blacklist') {
      cfg.ip_black_list = { list: config.ip_list || [], mode: 'cover' };
    } else if (ipMode === 'whitelist') {
      cfg.ip_white_list = { list: config.ip_list || [], mode: 'cover' };
    }
    if (!Object.keys(cfg).length) return true;
    return (await this.call('POST', '/v2/domain/config', null, { domains: domain, config: cfg })) !== false;
  }
}