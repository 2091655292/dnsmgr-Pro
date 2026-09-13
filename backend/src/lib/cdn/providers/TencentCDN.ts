import { TencentCloud } from '../../clients/TencentCloud.js';
import type { CdnProvider, CdnDomainItem } from '../types.js';
import { catalogPath, fileExtensions, normalizeValue, parsePathRule } from '../pathRule.js';

const areaMap: Record<string, string> = { mainland_china: 'mainland', overseas: 'overseas', global: 'global' };
const protoMap: Record<string, string> = { http: 'http', https: 'https', follow: 'follow' };

export class TencentCDN implements CdnProvider {
  private client: TencentCloud;
  private error = '';

  constructor(config: Record<string, any>) {
    this.client = new TencentCloud(config.SecretId, config.SecretKey, 'cdn.tencentcloudapi.com', 'cdn', '2018-06-06');
  }

  getError() {
    return this.error;
  }

  private async send(action: string, param: Record<string, any>): Promise<any> {
    try {
      return await this.client.request(action, param);
    } catch (e: any) {
      this.error = e.message || String(e);
      return false;
    }
  }

  async check() {
    return (await this.send('DescribeDomains', { Limit: 1 })) !== false;
  }

  async createDomain(domain: string, origin: string, originType: string, serviceArea: string): Promise<string | false> {
    const origins = origin
      .split(';')
      .map((v) => v.trim())
      .filter((v) => v !== '')
      .map((v) => (v.includes(':') ? v : v + ':80'));
    const param = {
      Domain: domain,
      ServiceType: 'web',
      Area: areaMap[serviceArea] ?? 'mainland',
      Origin: { Origins: origins, OriginType: originType === 'domain' ? 'domain' : 'ipaddr', OriginPullProtocol: 'follow' },
    };
    if (!(await this.send('AddCdnDomain', param))) return false;
    for (let i = 0; i < 10; i++) {
      const cname = await this.getDomainCname(domain);
      if (cname) return cname;
      await new Promise((r) => setTimeout(r, 1000));
    }
    this.error = '未获取到 CNAME，请稍后在列表刷新重试';
    return false;
  }

  async getDomainCname(domain: string): Promise<string | false> {
    const data = await this.send('DescribeDomains', { Filters: [{ Name: 'domain', Value: [domain] }] });
    if (!data) return false;
    for (const d of data.Domains || []) {
      if (d.Domain === domain && d.Cname) return d.Cname;
    }
    return false;
  }

  async listDomains(): Promise<CdnDomainItem[] | false> {
    const list: CdnDomainItem[] = [];
    let offset = 0;
    const limit = 100;
    while (offset < 2000) {
      const data = await this.send('DescribeDomains', { Offset: offset, Limit: limit });
      if (!data) return false;
      const domains = data.Domains || [];
      for (const d of domains) {
        const Origin = d.Origin || {};
        const origins: string[] = [];
        let port = 0;
        for (const o of Origin.Origins || []) {
          const parts = String(o).split(':');
          origins.push(parts[0] + (parts[1] ? ':' + parts[1] : ''));
          if (!port && parts[1]) port = Number(parts[1]);
        }
        const Https = d.Https || {};
        const fr = Https.ForceRedirect || {};
        list.push({
          domain: d.Domain,
          cname: d.Cname || '',
          status: d.Status === 'offline' ? 'offline' : 'online',
          area: d.Area || '',
          origin: origins.join(';'),
          origin_type: ['ipaddr', 'domain'].includes(Origin.OriginType) ? Origin.OriginType : '',
          origin_host: Origin.ServerName || '',
          origin_protocol: protoMap[Origin.OriginPullProtocol] ?? 'follow',
          http_port: port || 80,
          https_port: 443,
          https_enabled: Https.Switch === 'on',
          force_redirect: fr.Switch === 'on' && fr.RedirectType === 'https',
        });
      }
      if (domains.length < limit) break;
      offset += limit;
    }
    return list;
  }

  async deleteDomain(domain: string) {
    return (await this.send('DeleteCdnDomain', { Domain: domain })) !== false;
  }

  async setDomainStatus(domain: string, status: string) {
    const action = status === 'offline' ? 'StopCdnDomain' : 'StartCdnDomain';
    return (await this.send(action, { Domain: domain })) !== false;
  }

  async updateOrigin(domain: string, origin: string, originType: string, originHost: string, originProtocol: string, httpPort: number, httpsPort: number) {
    const port = originProtocol === 'https' ? httpsPort : httpPort;
    const origins = origin
      .split(';')
      .map((v) => v.trim())
      .filter((v) => v !== '')
      .map((v) => (v.includes(':') ? v : v + ':' + port));
    const Origin: Record<string, any> = { Origins: origins, OriginType: originType === 'domain' ? 'domain' : 'ipaddr', OriginPullProtocol: originProtocol || 'follow' };
    if (originHost) Origin.ServerName = originHost;
    return (await this.send('UpdateDomainConfig', { Domain: domain, Origin })) !== false;
  }

  // 移植自 multi-cloud-cdn TencentDomainServiceImpl.saveCacheRules：
  // 规则类型 all/file/directory/path + NoCache 支持，且腾讯 CDN 规则优先级从下到上，需要反转
  async setCacheRules(domain: string, rules: any[]) {
    const ruleCache = rules
      .map((r) => {
        const parsed = parsePathRule(r?.path);
        const ttl = Math.max(0, Number(r?.ttl) || 0);
        let ruleType = 'all';
        let rulePaths = ['*'];
        if (parsed.type === 'file_extension') {
          ruleType = 'file';
          rulePaths = fileExtensions(parsed.value);
          if (!rulePaths.length) return null;
        } else if (parsed.type === 'catalog') {
          ruleType = 'directory';
          rulePaths = [catalogPath(parsed.value)];
        } else if (parsed.type === 'full_path') {
          ruleType = 'path';
          rulePaths = [normalizeValue(parsed.value)];
        }
        const CacheConfig = ttl
          ? { Cache: { CacheConfigSwitch: 'on', CacheTime: ttl, CompareMaxAge: 'off', IgnoreCacheControl: 'off' }, NoCache: { Switch: 'off' } }
          : { NoCache: { Switch: 'on', Revalidate: 'off' } };
        return { RuleType: ruleType, RulePaths: rulePaths, CacheConfig };
      })
      .filter(Boolean)
      .reverse();
    return (await this.send('UpdateDomainConfig', { Domain: domain, Cache: { RuleCache: ruleCache } })) !== false;
  }

  async setHttps(domain: string, enabled: boolean, forceRedirect: boolean) {
    const https: Record<string, any> = { Switch: enabled ? 'on' : 'off' };
    if (forceRedirect) https.ForceRedirect = { Switch: 'on', RedirectType: 'https' };
    return (await this.send('UpdateDomainConfig', { Domain: domain, Https: https })) !== false;
  }

  async purge(urls: string[], type: 'url' | 'dir'): Promise<string | false> {
    const data =
      type === 'dir'
        ? await this.send('PurgePathCache', { Paths: urls, FlushType: 'flush' })
        : await this.send('PurgeUrlsCache', { Urls: urls });
    if (!data) return false;
    return data.TaskId || 'ok';
  }

  async preheat(urls: string[]): Promise<string | false> {
    const data = await this.send('PushUrlsCache', { Urls: urls });
    if (!data) return false;
    return data.TaskId || 'ok';
  }

  async setAccess(domain: string, config: Record<string, any>): Promise<boolean> {
    const updates: Record<string, any> = this.buildAccessConfig(config);
    return (await this.send('UpdateDomainConfig', { Domain: domain, ...updates })) !== false;
  }

  private buildAccessConfig(config: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = {};
    const refererMode = config.referer_mode || 'off';
    if (refererMode === 'off') {
      out.Referer = { Switch: 'off' };
    } else {
      out.Referer = {
        Switch: 'on',
        RefererRules: [{ RuleType: 'all', RulePaths: ['*'], RefererType: refererMode, AllowEmpty: true, Rules: config.referer_list || [] }],
      };
    }
    const ipMode = config.ip_mode || 'off';
    if (ipMode === 'off') {
      out.IpFilter = { Switch: 'off' };
    } else {
      out.IpFilter = { Switch: 'on', FilterType: ipMode, Filters: config.ip_list || [] };
    }
    const uaList = config.ua_list || [];
    out.UserAgentFilter = uaList.length
      ? { Switch: 'on', FilterRules: [{ RuleType: 'all', RulePaths: ['*'], Value: uaList }] }
      : { Switch: 'off' };
    return out;
  }
}