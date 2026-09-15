import { HuaweiCloud } from '../../clients/HuaweiCloud.js';
import type { CdnProvider, CdnDomainItem } from '../types.js';
import { catalogPath, fileExtensions, normalizeValue, parsePathRule } from '../pathRule.js';

const serviceAreaMap: Record<string, string> = {
  mainland_china: 'mainland_china',
  overseas: 'outside_mainland_china',
  global: 'global',
};

function ttlToUnit(seconds: number): { ttl: number; ttl_unit: string } {
  const s = Math.max(0, Math.floor(seconds) || 0);
  if (s <= 0) return { ttl: 0, ttl_unit: 's' };
  if (s % 86400 === 0) return { ttl: s / 86400, ttl_unit: 'd' };
  if (s % 3600 === 0) return { ttl: s / 3600, ttl_unit: 'h' };
  if (s % 60 === 0) return { ttl: s / 60, ttl_unit: 'm' };
  return { ttl: s, ttl_unit: 's' };
}

export class HuaweiCDN implements CdnProvider {
  private client: HuaweiCloud;
  private error = '';

  constructor(config: Record<string, any>) {
    this.client = new HuaweiCloud(config.AccessKeyId, config.SecretAccessKey, 'cdn.myhuaweicloud.com');
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
    return (await this.call('GET', '/v1.0/cdn/domains', { page_size: 1, page_number: 1 })) !== false;
  }

  private async getDomainId(domain: string): Promise<string | null> {
    const data = await this.call('GET', '/v1.0/cdn/domains', { domain_name: domain, page_size: 10, page_number: 1 });
    if (!data) return null;
    for (const d of data.domains || []) {
      if ((d.domain_name || d.DomainName) === domain || d.id) {
        if (d.id) return String(d.id);
      }
    }
    const detail = await this.getDomainDetail(domain);
    return detail?.domain?.id ? String(detail.domain.id) : null;
  }

  private async getDomainDetail(domain: string): Promise<any> {
    return this.call('GET', `/v1.0/cdn/configuration/domains/${domain}`);
  }

  private async updateDomainConfigs(domain: string, configs: Record<string, any>): Promise<boolean> {
    return (await this.call('PUT', `/v1.1/cdn/configuration/domains/${domain}/configs`, null, { configs })) !== false;
  }

  async createDomain(domain: string, origin: string, originType: string, serviceArea: string): Promise<string | false> {
    const sources = origin
      .split(';')
      .map((v) => v.trim())
      .filter((v) => v !== '')
      .map((v) => ({ ip_or_domain: v, origin_type: originType === 'domain' ? 'domain' : 'ipaddr', active_standby: 1 }));
    const body = {
      domain: { domain_name: domain, business_type: 'web', service_area: serviceAreaMap[serviceArea] ?? 'mainland_china', sources },
    };
    if (!(await this.call('POST', '/v1.0/cdn/domains', null, body))) return false;
    // 华为创建后返回域名信息，含 cname；否则轮询详情
    for (let i = 0; i < 10; i++) {
      const cname = await this.getDomainCname(domain);
      if (cname) return cname;
      await new Promise((r) => setTimeout(r, 1000));
    }
    this.error = '未获取到 CNAME，请稍后在列表刷新重试';
    return false;
  }

  async getDomainCname(domain: string): Promise<string | false> {
    const data = await this.getDomainDetail(domain);
    if (!data) return false;
    const info = data.domain || data;
    return info && info.cname ? String(info.cname) : false;
  }

  async listDomains(): Promise<CdnDomainItem[] | false> {
    const list: CdnDomainItem[] = [];
    let page = 1;
    while (page < 100) {
      const data = await this.call('GET', '/v1.0/cdn/domains', { page_size: 100, page_number: page });
      if (!data) return false;
      const domains = data.domains || [];
      for (const d of domains) {
        const name = d.domain_name || d.DomainName || '';
        if (!name) continue;
        const detail = await this.getDomainDetail(name);
        const info = detail?.domain || {};
        const sources = info.sources || [];
        const origins: string[] = [];
        let originType = '';
        let originHost = '';
        let httpPort = 80;
        let httpsPort = 443;
        for (const s of sources) {
          if (String(s.priority) === '30') continue; // 备源
          if (s.origin_addr) origins.push(String(s.origin_addr));
          originType = ['ipaddr', 'domain'].includes(s.origin_type) ? s.origin_type : originType;
          if (s.host_name) originHost = String(s.host_name);
          if (s.http_port != null) httpPort = Number(s.http_port);
          if (s.https_port != null) httpsPort = Number(s.https_port);
        }
        list.push({
          domain: name,
          cname: info.cname || d.cname || '',
          status: String(info.domain_status || d.domain_status || '').toLowerCase() === 'offline' ? 'offline' : 'online',
          area: serviceAreaMap[String(info.service_area || d.service_area || '')] || '',
          origin: origins.join(';'),
          origin_type: originType,
          origin_host: originHost,
          origin_protocol: 'follow',
          http_port: httpPort,
          https_port: httpsPort,
          https_enabled: String(info.https_status || '').toLowerCase() === 'on',
        });
      }
      const total = Number(data.total || 0);
      if (domains.length < 100 || list.length >= total) break;
      page++;
    }
    return list;
  }

  async deleteDomain(domain: string) {
    const id = await this.getDomainId(domain);
    if (!id) {
      this.error = '未找到域名 ID';
      return false;
    }
    return (await this.call('DELETE', `/v1.0/cdn/domains/${id}`)) !== false;
  }

  async setDomainStatus(domain: string, status: string) {
    const id = await this.getDomainId(domain);
    if (!id) {
      this.error = '未找到域名 ID';
      return false;
    }
    const path = status === 'offline' ? `/v1.0/cdn/domains/${id}/disable` : `/v1.0/cdn/domains/${id}/enable`;
    return (await this.call('PUT', path)) !== false;
  }

  async updateOrigin(domain: string, origin: string, originType: string, originHost: string, originProtocol: string, httpPort: number, httpsPort: number) {
    const sources = origin
      .split(';')
      .map((v) => v.trim())
      .filter((v) => v !== '')
      .map((v) => ({
        origin_addr: v,
        origin_type: originType === 'domain' ? 'domain' : 'ipaddr',
        priority: 70,
        http_port: httpPort || 80,
        https_port: httpsPort || 443,
        host_name: originHost || '',
      }));
    const configs: Record<string, any> = { sources };
    if (originProtocol && ['http', 'https', 'follow'].includes(originProtocol)) configs.origin_protocol = originProtocol;
    return this.updateDomainConfigs(domain, configs);
  }

  async setCacheRules(domain: string, rules: any[]) {
    const cacheRules = rules
      .map((r, idx) => {
        const parsed = parsePathRule(r?.path);
        const ttl = Math.max(0, Number(r?.ttl) || 0);
        const { ttl: t, ttl_unit } = ttlToUnit(ttl);
        let match_type = 'all';
        let match_value = '';
        if (parsed.type === 'file_extension') {
          match_type = 'file_extension';
          const exts = fileExtensions(parsed.value);
          if (!exts.length) return null;
          match_value = exts.map((e) => '.' + e).join(',');
        } else if (parsed.type === 'catalog') {
          match_type = 'file_path';
          match_value = catalogPath(parsed.value) + '/';
        } else if (parsed.type === 'full_path') {
          match_type = 'file_path';
          match_value = normalizeValue(parsed.value);
        }
        return { match_type, match_value, ttl: t, ttl_unit, priority: rules.length - idx };
      })
      .filter(Boolean);
    return this.updateDomainConfigs(domain, { cache_rules: cacheRules });
  }

  async setHttps(domain: string, enabled: boolean, forceRedirect: boolean) {
    const configs: Record<string, any> = { https: { https_status: enabled ? 'on' : 'off' } };
    configs.force_redirect = forceRedirect ? { status: 'on', type: 'https', redirect_code: 301 } : { status: 'off', type: 'https', redirect_code: 301 };
    return this.updateDomainConfigs(domain, configs);
  }

  async purge(urls: string[], type: 'url' | 'dir'): Promise<string | false> {
    const data = await this.call('POST', '/v1.0/cdn/content/refresh-tasks', null, {
      refresh_task: { type: type === 'dir' ? 'directory' : 'file', urls },
    });
    if (data === false) return false;
    return 'ok';
  }

  async preheat(urls: string[]): Promise<string | false> {
    const data = await this.call('POST', '/v1.0/cdn/content/preheating-tasks', null, {
      preheating_task: { urls },
    });
    if (data === false) return false;
    return 'ok';
  }

  async getAccess(domain: string): Promise<Record<string, any> | false> {
    const id = await this.getDomainId(domain);
    const out: Record<string, any> = { referer_mode: 'off', referer_list: [], ip_mode: 'off', ip_list: [], ua_list: [] };
    if (id) {
      const referer = await this.call('GET', `/v1.0/cdn/domains/${id}/referer`);
      if (referer && referer !== false) {
        const r = referer.referer || referer;
        const t = Number(r.referer_type || 0);
        out.referer_mode = t === 1 ? 'blacklist' : t === 2 ? 'whitelist' : 'off';
        out.referer_list = String(r.referer_list || '').split(';').filter(Boolean);
      }
      const ipacl = await this.call('GET', `/v1.0/cdn/domains/${id}/ip-acl`);
      if (ipacl && ipacl !== false) {
        const t = Number(ipacl.type || 0);
        out.ip_mode = t === 1 ? 'blacklist' : t === 2 ? 'whitelist' : 'off';
        out.ip_list = Array.isArray(ipacl.ip_list) ? ipacl.ip_list : [];
      }
    }
    const configs = await this.call('GET', `/v1.1/cdn/configuration/domains/${domain}/configs`);
    if (configs && configs !== false) {
      const ua = configs.configs?.user_agent_black_and_white_list;
      if (ua) out.ua_list = Array.isArray(ua.ua_list) ? ua.ua_list : [];
    }
    return out;
  }

  async setAccess(domain: string, config: Record<string, any>): Promise<boolean> {
    const id = await this.getDomainId(domain);
    const refererMode = config.referer_mode || 'off';
    const refererType = refererMode === 'blacklist' ? 1 : refererMode === 'whitelist' ? 2 : 0;
    const refererList = config.referer_list || [];
    if (!id) {
      this.error = '未找到域名 ID';
      return false;
    }
    if ((await this.call('PUT', `/v1.0/cdn/domains/${id}/referer`, null, { referer: { referer_type: refererType, referer_list: refererList.join(';'), include_empty: refererList.length === 0 } })) === false)
      return false;

    const ipMode = config.ip_mode || 'off';
    const ipType = ipMode === 'blacklist' ? 1 : ipMode === 'whitelist' ? 2 : 0;
    if ((await this.call('PUT', `/v1.0/cdn/domains/${id}/ip-acl`, null, { type: ipType, ip_list: config.ip_list || [] })) === false) return false;

    const uaList = config.ua_list || [];
    const uaType = uaList.length ? 1 : 0;
    return this.updateDomainConfigs(domain, { user_agent_black_and_white_list: { type: uaType, ua_list: uaList } });
  }
}