import { Kingsoft } from '../../clients/Kingsoft.js';
import type { CdnProvider, CdnDomainItem } from '../types.js';
import { catalogPath, fileExtensions, normalizeValue, parsePathRule } from '../pathRule.js';

const areaMap: Record<string, string> = { mainland_china: 'CN', overseas: 'OverSea', global: 'Global' };
const statusMap: Record<string, string> = {
  online: 'online',
  offline: 'offline',
  configuring: 'online',
  icp_checking: 'online',
  configure_failed: 'offline',
  icp_check_failed: 'offline',
  locked: 'offline',
};

function pick(obj: any, ...keys: string[]): any {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

export class KingsoftCDN implements CdnProvider {
  private client: Kingsoft;
  private error = '';

  constructor(config: Record<string, any>) {
    this.client = new Kingsoft(config.AccessKey, config.SecretKey, config.Region || 'cn-beijing-6', 'cdn.api.ksyun.com');
  }

  getError() {
    return this.error;
  }

  private async get(action: string, version: string, path: string, params: Record<string, any> = {}): Promise<any> {
    try {
      return await this.client.get(action, version, path, params);
    } catch (e: any) {
      this.error = e.message || String(e);
      return false;
    }
  }

  private async post(action: string, version: string, path: string, body: Record<string, any> | null, useJson: boolean): Promise<any> {
    try {
      return await this.client.post(action, version, path, body, useJson);
    } catch (e: any) {
      this.error = e.message || String(e);
      return false;
    }
  }

  async check() {
    return (await this.get('GetCdnDomains', '2019-06-01', '/2019-06-01/domain/GetCdnDomains', { PageSize: '1', PageNumber: '1' })) !== false;
  }

  private async resolveDomainId(domain: string): Promise<string | null> {
    const data = await this.get('GetCdnDomains', '2019-06-01', '/2019-06-01/domain/GetCdnDomains', {
      DomainName: domain,
      FuzzyMatch: 'off',
      PageSize: '1',
    });
    if (!data) return null;
    const domains = pick(data, 'Domains', 'domains') || [];
    return domains[0] ? String(pick(domains[0], 'DomainId', 'domainId') || '') : null;
  }

  private async basicInfo(domainId: string): Promise<any | false> {
    return this.get('GetCdnDomainBasicInfo', '2016-09-01', '/2016-09-01/domain/GetCdnDomainBasicInfo', { DomainId: domainId });
  }

  async createDomain(domain: string, origin: string, originType: string, serviceArea: string): Promise<string | false> {
    const body = {
      DomainName: domain,
      CdnType: 'page',
      OriginType: originType === 'domain' ? 'domain' : 'ipaddr',
      CdnProtocol: 'http',
      OriginProtocol: 'http',
      Origin: origin,
      Regions: areaMap[serviceArea] ?? 'CN',
    };
    const result = await this.post('AddCdnDomain', 'V3', '/V3/AddCdnDomain', body, false);
    if (result === false || !result) return false;
    const domainId = pick(result, 'DomainId', 'domainId');
    if (!domainId) {
      this.error = '金山云未返回域名ID';
      return false;
    }
    for (let i = 0; i < 10; i++) {
      const info = await this.basicInfo(String(domainId));
      if (info && pick(info, 'Cname', 'cname')) return String(pick(info, 'Cname', 'cname'));
      await new Promise((r) => setTimeout(r, 1000));
    }
    return domain + '.download.ks-cdn.com';
  }

  async getDomainCname(domain: string): Promise<string | false> {
    const id = await this.resolveDomainId(domain);
    if (!id) return false;
    const info = await this.basicInfo(id);
    if (!info) return false;
    const cname = pick(info, 'Cname', 'cname');
    return cname ? String(cname) : false;
  }

  async listDomains(): Promise<CdnDomainItem[] | false> {
    const data = await this.get('GetCdnDomains', '2019-06-01', '/2019-06-01/domain/GetCdnDomains', { PageSize: '100', PageNumber: '1' });
    if (!data) return false;
    const domains = pick(data, 'Domains', 'domains') || [];
    const list: CdnDomainItem[] = [];
    for (const d of domains) {
      const name = pick(d, 'DomainName', 'domainName') || '';
      const id = pick(d, 'DomainId', 'domainId') || '';
      if (!name) continue;
      const info = id ? await this.basicInfo(String(id)) : false;
      const origin = info ? String(pick(info, 'Origin', 'origin') || '') : '';
      const originType = info && String(pick(info, 'OriginType', 'originType') || '') === 'domain' ? 'domain' : 'ipaddr';
      const protocol = info ? String(pick(info, 'OriginProtocol', 'originProtocol') || 'follow') : 'follow';
      const httpPort = info ? Number(pick(info, 'OriginHttpPort', 'originHttpPort') || 80) : 80;
      const httpsPort = info ? Number(pick(info, 'OriginHttpsPort', 'originHttpsPort') || 443) : 443;
      const rawStatus = String(pick(d, 'DomainStatus', 'domainStatus') || '').toLowerCase();
      list.push({
        domain: name,
        cname: String(pick(d, 'Cname', 'cname') || ''),
        status: statusMap[rawStatus] || 'online',
        area: 'mainland_china',
        origin,
        origin_type: originType,
        origin_host: '',
        origin_protocol: protocol,
        http_port: httpPort,
        https_port: httpsPort,
        https_enabled: false,
        force_redirect: false,
      });
    }
    return list;
  }

  async deleteDomain(domain: string) {
    const id = await this.resolveDomainId(domain);
    if (!id) {
      this.error = '未找到域名ID';
      return false;
    }
    return (await this.get('DeleteCdnDomain', '2016-09-01', '/2016-09-01/domain/DeleteCdnDomain', { DomainId: id })) !== false;
  }

  async setDomainStatus(domain: string, status: string) {
    const id = await this.resolveDomainId(domain);
    if (!id) {
      this.error = '未找到域名ID';
      return false;
    }
    return (
      (await this.get('StartStopCdnDomain', '2016-09-01', '/2016-09-01/domain/StartStopCdnDomain', {
        DomainId: id,
        ActionType: status === 'offline' ? 'stop' : 'start',
      })) !== false
    );
  }

  async updateOrigin(domain: string, origin: string, originType: string, originHost: string, originProtocol: string, httpPort: number, httpsPort: number) {
    const id = await this.resolveDomainId(domain);
    if (!id) {
      this.error = '未找到域名ID';
      return false;
    }
    const params: Record<string, any> = { DomainId: id, Origin: origin, OriginType: originType === 'domain' ? 'domain' : 'ipaddr' };
    if (originHost) params.BackOriginHost = originHost;
    const hp = httpPort || 80;
    let hs = httpsPort || 443;
    if (originProtocol === 'https') {
      params.OriginProtocol = 'https';
      params.OriginPort = String(hs);
    } else if (originProtocol === 'http') {
      params.OriginProtocol = 'http';
      params.OriginPort = String(hp);
    } else {
      params.OriginProtocol = 'follow';
      if (hp === hs) hs = hp === 443 ? 8443 : 443;
      params.OriginPort = hp + ',' + hs;
    }
    return (await this.get('ModifyCdnDomainBasicInfo', '2016-09-01', '/2016-09-01/domain/ModifyCdnDomainBasicInfo', params)) !== false;
  }

  async setCacheRules(domain: string, rules: any[]) {
    const id = await this.resolveDomainId(domain);
    if (!id) {
      this.error = '未找到域名ID';
      return false;
    }
    const CacheRules = rules
      .map((r) => {
        const parsed = parsePathRule(r?.path);
        if (parsed.type === 'global') return null;
        const ttl = Math.max(0, Number(r?.ttl) || 0);
        let CacheRuleType = 'exact';
        let Value = normalizeValue(parsed.value);
        if (parsed.type === 'file_extension') {
          CacheRuleType = 'file_suffix';
          const exts = fileExtensions(parsed.value);
          if (!exts.length) return null;
          Value = exts.join(',');
        } else if (parsed.type === 'catalog') {
          CacheRuleType = 'directory';
          Value = catalogPath(parsed.value) + '/';
        }
        return { CacheRuleType, Value, CacheEnable: 'on', CacheTime: ttl };
      })
      .filter(Boolean);
    return (await this.post('SetCacheRuleConfig', '2016-09-01', '/2016-09-01/domain/SetCacheRuleConfig', { DomainId: id, CacheRules }, true)) !== false;
  }

  async setHttps(domain: string, enabled: boolean, forceRedirect: boolean) {
    const id = await this.resolveDomainId(domain);
    if (!id) {
      this.error = '未找到域名ID';
      return false;
    }
    if (!enabled) {
      const off = await this.post('ConfigCertificate', '2016-09-01', '/2016-09-01/cert/ConfigCertificate', { DomainId: id, Enable: 'off' }, true);
      if (off === false) return false;
    }
    const redirect: Record<string, any> = { DomainId: id, RedirectType: enabled && forceRedirect ? 'https' : 'off' };
    if (enabled && forceRedirect) redirect.RedirectCode = '301';
    return (await this.post('SetForceRedirectConfig', '2016-09-01', '/2016-09-01/domain/SetForceRedirectConfig', redirect, true)) !== false;
  }

  async purge(urls: string[], type: 'url' | 'dir'): Promise<string | false> {
    const list = urls.map((url) => ({ Url: url }));
    const body = type === 'dir' ? { Dirs: list } : { Files: list };
    const data = await this.post('RefreshCaches', '2016-09-01', '/2016-09-01/content/RefreshCaches', body, true);
    if (data === false) return false;
    const taskId = pick(data, 'RefreshTaskId', 'refreshTaskId');
    return taskId ? String(taskId) : 'ok';
  }

  async preheat(urls: string[]): Promise<string | false> {
    const data = await this.post('PreloadCaches', '2016-09-01', '/2016-09-01/content/PreloadCaches', { Urls: urls.map((url) => ({ Url: url })) }, true);
    if (data === false) return false;
    const taskId = pick(data, 'PreloadTaskId', 'preloadTaskId');
    return taskId ? String(taskId) : 'ok';
  }

  async getAccess(domain: string): Promise<Record<string, any> | false> {
    const id = await this.resolveDomainId(domain);
    if (!id) return false;
    const data = await this.get('GetDomainConfigs', '2016-09-01', '/2016-09-01/domain/GetDomainConfigs', { DomainId: id });
    if (!data) return false;
    const out: Record<string, any> = { referer_mode: 'off', referer_list: [], ip_mode: 'off', ip_list: [], ua_list: [] };
    const ipConfig = pick(data, 'ipProtectionConfig', 'IpProtectionConfig');
    if (ipConfig && String(pick(ipConfig, 'Enable', 'enable') || '').toLowerCase() === 'on') {
      out.ip_mode = pick(ipConfig, 'IpType', 'ipType') === 'allow' ? 'whitelist' : 'blacklist';
      out.ip_list = String(pick(ipConfig, 'IpList', 'ipList') || '')
        .split(',')
        .filter(Boolean);
    }
    const refererConfig = pick(data, 'referProtectionConfig', 'ReferProtectionConfig');
    if (refererConfig && String(pick(refererConfig, 'Enable', 'enable') || '').toLowerCase() === 'on') {
      out.referer_mode = pick(refererConfig, 'ReferType', 'referType') === 'allow' ? 'whitelist' : 'blacklist';
      out.referer_list = String(pick(refererConfig, 'ReferList', 'referList') || '')
        .split(',')
        .filter(Boolean);
    }
    return out;
  }

  async setAccess(domain: string, config: Record<string, any>): Promise<boolean> {
    const id = await this.resolveDomainId(domain);
    if (!id) {
      this.error = '未找到域名ID';
      return false;
    }
    const refererMode = config.referer_mode || 'off';
    const refererBody: Record<string, any> = { DomainId: id };
    if (refererMode === 'off') {
      refererBody.Enable = 'off';
    } else {
      refererBody.Enable = 'on';
      refererBody.ReferType = refererMode === 'whitelist' ? 'allow' : 'block';
      refererBody.ReferList = (config.referer_list || []).join(',');
      refererBody.AllowEmpty = (config.referer_list || []).length === 0 ? 'on' : 'off';
    }
    if ((await this.post('SetReferProtectionConfig', '2016-09-01', '/2016-09-01/domain/SetReferProtectionConfig', refererBody, false)) === false) return false;

    const ipMode = config.ip_mode || 'off';
    const ipBody: Record<string, any> = { DomainId: id };
    if (ipMode === 'off') {
      ipBody.Enable = 'off';
    } else {
      ipBody.Enable = 'on';
      ipBody.IpType = ipMode === 'whitelist' ? 'allow' : 'block';
      ipBody.IpList = (config.ip_list || []).join(',');
    }
    return (await this.post('SetIpProtectionConfig', '2016-09-01', '/2016-09-01/domain/SetIpProtectionConfig', ipBody, false)) !== false;
  }
}