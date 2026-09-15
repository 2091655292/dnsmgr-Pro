import { Volcengine } from '../../clients/Volcengine.js';
import type { CdnProvider, CdnDomainItem } from '../types.js';
import { catalogPath, fileExtensions, normalizeValue, parsePathRule } from '../pathRule.js';

const regionMap: Record<string, string> = {
  chinese_mainland: 'mainland_china',
  mainland: 'mainland_china',
  global: 'global',
  outside_chinese_mainland: 'overseas',
  overseas: 'overseas',
};
const instanceTypeMap: Record<string, string> = { ip: 'ipaddr', domain: 'domain' };

export class VolcengineCDN implements CdnProvider {
  private client: Volcengine;
  private error = '';

  constructor(config: Record<string, any>) {
    this.client = new Volcengine(config.AccessKeyId, config.SecretAccessKey, 'cdn.volcengineapi.com', 'CDN', '2021-03-01', 'cn-north-1');
  }

  getError() {
    return this.error;
  }

  private async send(action: string, param: Record<string, any>): Promise<any> {
    try {
      return await this.client.request('POST', action, param);
    } catch (e: any) {
      this.error = e.message || String(e);
      return false;
    }
  }

  async check() {
    return (await this.send('ListCdnDomains', { PageNum: 1, PageSize: 1 })) !== false;
  }

  private buildOriginLines(origin: string, originType: string, originHost: string, httpPort: number, httpsPort: number, project?: string): any[] {
    const instanceType = originType === 'domain' ? 'domain' : 'ip';
    return origin
      .split(';')
      .map((v) => v.trim())
      .filter((v) => v !== '')
      .map((v) => ({
        OriginType: 'primary',
        InstanceType: instanceType,
        Address: v,
        HttpPort: String(httpPort || 80),
        HttpsPort: String(httpsPort || 443),
        OriginHost: originHost || '',
        Weight: '100',
      }));
  }

  async createDomain(domain: string, origin: string, originType: string, serviceArea: string): Promise<string | false> {
    const param = {
      Domain: domain,
      ServiceType: 'web',
      Project: 'default',
      OriginProtocol: 'HTTP',
      Origin: [
        {
          OriginAction: {
            OriginLines: this.buildOriginLines(origin, originType, domain, 80, 443),
          },
        },
      ],
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
    const data = await this.send('DescribeCdnConfig', { Domain: domain });
    if (!data) return false;
    const cfg = data.DomainConfig || data;
    return cfg && cfg.Cname ? String(cfg.Cname) : false;
  }

  async listDomains(): Promise<CdnDomainItem[] | false> {
    const list: CdnDomainItem[] = [];
    let pageNum = 1;
    const pageSize = 100;
    while (pageNum < 50) {
      const data = await this.send('ListCdnDomains', { PageNum: pageNum, PageSize: pageSize });
      if (!data) return false;
      const items = data.Item || data.Domains || [];
      for (const d of items) {
        const cfg = d.DomainConfig || d;
        list.push(this.mapDomain(cfg));
      }
      const total = Number(data.Total || 0);
      if (items.length < pageSize || list.length >= total) break;
      pageNum++;
    }
    return list;
  }

  private mapDomain(cfg: any): CdnDomainItem {
    const origins: string[] = [];
    let port = 0;
    let originType = '';
    let originHost = '';
    const originRule = Array.isArray(cfg.Origin) ? cfg.Origin[0] : null;
    const originLines = originRule?.OriginAction?.OriginLines || [];
    for (const line of originLines) {
      if (line.OriginType === 'backup') continue;
      if (line.Address) origins.push(String(line.Address));
      if (!port && line.HttpPort) port = Number(line.HttpPort);
      originType = instanceTypeMap[String(line.InstanceType || '')] || originType;
      if (line.OriginHost) originHost = String(line.OriginHost);
    }
    const https = cfg.HTTPS || {};
    const fr = https.ForcedRedirect || {};
    return {
      domain: cfg.Domain || '',
      cname: cfg.Cname || '',
      status: String(cfg.Status || '').toLowerCase() === 'offline' ? 'offline' : 'online',
      area: regionMap[String(cfg.ServiceRegion || cfg.ServiceArea || '')] || '',
      origin: origins.join(';'),
      origin_type: originType,
      origin_host: originHost || cfg.OriginHost || '',
      origin_protocol: 'follow',
      http_port: port || 80,
      https_port: 443,
      https_enabled: https.Switch === true || https.Switch === 'true',
      force_redirect: fr.EnableForcedRedirect === true || fr.EnableForcedRedirect === 'true',
    };
  }

  async deleteDomain(domain: string) {
    return (await this.send('DeleteCdnDomain', { Domain: domain })) !== false;
  }

  async setDomainStatus(domain: string, status: string) {
    const action = status === 'offline' ? 'StopCdnDomain' : 'StartCdnDomain';
    return (await this.send(action, { Domain: domain })) !== false;
  }

  async getOriginLines(domain: string): Promise<any[] | null> {
    const data = await this.send('DescribeCdnConfig', { Domain: domain });
    if (!data) return null;
    const cfg = data.DomainConfig || data;
    return cfg.Origin?.[0]?.OriginAction?.OriginLines || [];
  }

  async updateOrigin(domain: string, origin: string, originType: string, originHost: string, originProtocol: string, httpPort: number, httpsPort: number) {
    const param: Record<string, any> = {
      Domain: domain,
      Origin: [
        {
          OriginAction: {
            OriginLines: this.buildOriginLines(origin, originType, originHost, httpPort, httpsPort),
          },
        },
      ],
    };
    const protoMap: Record<string, string> = { http: 'HTTP', https: 'HTTPS', follow: 'HTTP' };
    param.OriginProtocol = protoMap[originProtocol] ?? 'HTTP';
    return (await this.send('UpdateCdnConfig', param)) !== false;
  }

  async setCacheRules(domain: string, rules: any[]) {
    const caches = rules
      .map((r) => {
        const parsed = parsePathRule(r?.path);
        const ttl = Math.max(0, Number(r?.ttl) || 0);
        let object = 'directory';
        let value = '/';
        if (parsed.type === 'file_extension') {
          object = 'filetype';
          value = fileExtensions(parsed.value).join(',');
          if (!value) return null;
        } else if (parsed.type === 'catalog') {
          object = 'directory';
          value = catalogPath(parsed.value) + '/';
        } else if (parsed.type === 'full_path') {
          object = 'path';
          value = normalizeValue(parsed.value);
        }
        return {
          Condition: { ConditionRule: [{ Object: object, Type: 'url', Operator: 'match', Value: value }] },
          CacheAction: { Action: ttl ? 'cache' : 'no-cache', Ttl: ttl },
        };
      })
      .filter(Boolean)
      .reverse();
    return (await this.send('UpdateCdnConfig', { Domain: domain, Cache: caches })) !== false;
  }

  async setHttps(domain: string, enabled: boolean, forceRedirect: boolean) {
    const https: Record<string, any> = { Switch: enabled, ForcedRedirect: { EnableForcedRedirect: forceRedirect, StatusCode: '301' } };
    return (await this.send('UpdateCdnConfig', { Domain: domain, HTTPS: https })) !== false;
  }

  async purge(urls: string[], type: 'url' | 'dir'): Promise<string | false> {
    const data = await this.send('SubmitRefreshTask', { Type: type === 'dir' ? 'dir' : 'file', Urls: urls.join('\n') });
    if (!data) return false;
    return data.TaskID ? String(data.TaskID) : 'ok';
  }

  async preheat(urls: string[]): Promise<string | false> {
    const data = await this.send('SubmitPreloadTask', { Urls: urls.join('\n') });
    if (!data) return false;
    return data.TaskID ? String(data.TaskID) : 'ok';
  }

  async getAccess(domain: string): Promise<Record<string, any> | false> {
    const data = await this.send('DescribeCdnConfig', { Domain: domain });
    if (!data) return false;
    const cfg = data.DomainConfig || data;
    const out: Record<string, any> = { referer_mode: 'off', referer_list: [], ip_mode: 'off', ip_list: [], ua_list: [] };
    const referer = cfg.RefererAccessRule;
    if (referer) {
      if (referer.Switch) out.referer_mode = referer.RuleType === 'allow' ? 'whitelist' : 'blacklist';
      out.referer_list = referer.Referers || [];
    }
    const ip = cfg.IpAccessRule;
    if (ip) {
      if (ip.Switch) out.ip_mode = ip.RuleType === 'allow' ? 'whitelist' : 'blacklist';
      out.ip_list = ip.Ip || [];
    }
    const ua = cfg.UaAccessRule;
    if (ua) out.ua_list = ua.UserAgent || [];
    return out;
  }

  async setAccess(domain: string, config: Record<string, any>): Promise<boolean> {
    const updates: Record<string, any> = {};
    const refererMode = config.referer_mode || 'off';
    updates.RefererAccessRule =
      refererMode === 'off'
        ? { Switch: false, RuleType: 'deny', Referers: [], AllowEmpty: true }
        : {
            Switch: true,
            RuleType: refererMode === 'whitelist' ? 'allow' : 'deny',
            Referers: config.referer_list || [],
            AllowEmpty: false,
          };
    const ipMode = config.ip_mode || 'off';
    updates.IpAccessRule =
      ipMode === 'off'
        ? { Switch: false, RuleType: 'deny', Ip: [] }
        : { Switch: true, RuleType: ipMode === 'whitelist' ? 'allow' : 'deny', Ip: config.ip_list || [] };
    const uaList = config.ua_list || [];
    updates.UaAccessRule = uaList.length ? { Switch: true, RuleType: 'deny', UserAgent: uaList, AllowEmpty: false } : { Switch: false, RuleType: 'deny', UserAgent: [], AllowEmpty: false };
    return (await this.send('UpdateCdnConfig', { Domain: domain, ...updates })) !== false;
  }
}