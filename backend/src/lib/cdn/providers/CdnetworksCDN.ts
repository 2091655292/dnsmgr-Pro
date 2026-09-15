import { Cdnetworks } from '../../clients/Cdnetworks.js';
import type { CdnProvider, CdnDomainItem } from '../types.js';
import { catalogPath, fileExtensions, normalizeValue, parsePathRule } from '../pathRule.js';

function ttlString(seconds: number): string {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (s <= 0) return '0s';
  if (s % 86400 === 0) return s / 86400 + 'd';
  if (s % 3600 === 0) return s / 3600 + 'h';
  if (s % 60 === 0) return s / 60 + 'm';
  return s + 's';
}

export class CdnetworksCDN implements CdnProvider {
  private client: Cdnetworks;
  private contractId: string;
  private itemId: string;
  private error = '';

  constructor(config: Record<string, any>) {
    this.client = new Cdnetworks(config.AccessKey, config.SecretKey, config.Endpoint || 'api.cdnetworks.com');
    this.contractId = config.ContractId || '';
    this.itemId = config.ItemId || '10';
  }

  getError() {
    return this.error;
  }

  private parse(text: string): any {
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }

  private async call(method: string, path: string, body?: Record<string, any> | null): Promise<any> {
    try {
      const res = await this.client.request(method, path, body);
      const json = this.parse(res.body);
      if (res.status >= 200 && res.status < 300) return json ?? true;
      const msg = json?.errorMessages || json?.message || json?.Message || 'http_code=' + res.status;
      this.error = String(msg);
      return false;
    } catch (e: any) {
      this.error = e.message || String(e);
      return false;
    }
  }

  async check() {
    try {
      const res = await this.client.request('GET', '/cdnw/api/domain/example.com');
      return res.status !== 401 && res.status !== 403;
    } catch (e: any) {
      this.error = e.message || String(e);
      return false;
    }
  }

  async createDomain(domain: string, origin: string, originType: string, serviceArea: string): Promise<string | false> {
    const body = {
      version: '1.0.0',
      'contract-id': this.contractId,
      'item-id': this.itemId,
      'domain-name': domain,
      'origin-config': { 'origin-ips': origin, 'default-origin-host-header': domain, 'origin-port': '80' },
      'header-of-clientip': 'X-Forwarded-For',
      comment: domain,
      'accelerate-no-china': false,
    };
    try {
      const res = await this.client.request('POST', '/cdnw/api/domain', body);
      if (res.status !== 202 && !(res.status >= 200 && res.status < 300)) {
        const json = this.parse(res.body);
        this.error = String(json?.errorMessages || json?.message || 'http_code=' + res.status);
        return false;
      }
      const cname = res.headers['cname'];
      if (cname) return cname;
    } catch (e: any) {
      this.error = e.message || String(e);
      return false;
    }
    for (let i = 0; i < 10; i++) {
      const cname = await this.getDomainCname(domain);
      if (cname) return cname;
      await new Promise((r) => setTimeout(r, 1000));
    }
    this.error = '未获取到 CNAME，请稍后在列表刷新重试';
    return false;
  }

  async getDomainCname(domain: string): Promise<string | false> {
    const data = await this.call('GET', `/cdnw/api/domain/${domain}`);
    if (!data || data === true) return false;
    return data.cname ? String(data.cname) : false;
  }

  async listDomains(): Promise<CdnDomainItem[] | false> {
    this.error = 'CDNetworks 暂不支持域名列表同步，请在接入时手动填写';
    return false;
  }

  async deleteDomain(domain: string) {
    return (await this.call('DELETE', `/api/domain/${domain}`)) !== false;
  }

  async setDomainStatus(domain: string, status: string) {
    const action = status === 'offline' ? 'disable' : 'enable';
    return (await this.call('PUT', `/api/domain/${domain}/${action}`, {})) !== false;
  }

  async updateOrigin(domain: string, origin: string, originType: string, originHost: string, originProtocol: string, httpPort: number, httpsPort: number) {
    const ok = await this.call('PUT', `/api/domain/property/${domain}`, {
      'origin-config': { 'origin-ips': origin, 'origin-host': originHost || '', 'origin-port': String(httpPort || 80) },
    });
    if (ok === false) return false;
    const proto = originProtocol === 'https' ? 'https' : originProtocol === 'follow' ? 'follow' : 'http';
    return (await this.call('PUT', `/api/config/back2originrewrite/${domain}`, { backToOriginRewriteRule: { protocol: proto, port: String(httpPort || 80) } })) !== false;
  }

  async setCacheRules(domain: string, rules: any[]) {
    const behaviors = rules
      .map((r) => {
        const parsed = parsePathRule(r?.path);
        const behavior: Record<string, any> = {
          'cache-ttl': ttlString(r?.ttl),
          'ignore-cache-control': 'false',
          'is-respect-server': 'false',
          'ignore-letter-case': 'false',
          'reload-manage': 'if-modified-since',
          priority: '10',
          'ignore-authentication-header': 'false',
        };
        if (parsed.type === 'file_extension') {
          const exts = fileExtensions(parsed.value);
          if (!exts.length) return null;
          behavior['file-type'] = exts.join(';');
        } else if (parsed.type === 'catalog') {
          behavior.directory = catalogPath(parsed.value) + '/';
        } else if (parsed.type === 'full_path') {
          behavior['specify-url-pattern'] = normalizeValue(parsed.value);
        } else {
          behavior['custom-pattern'] = 'all';
        }
        return behavior;
      })
      .filter(Boolean)
      .reverse();
    return (await this.call('PUT', `/api/config/cachetime/${domain}`, { 'cache-time-behaviors': behaviors })) !== false;
  }

  async setHttps(domain: string, enabled: boolean, forceRedirect: boolean) {
    const rules: any[] = [];
    if (enabled && forceRedirect) {
      rules.push({
        'path-pattern': '.*',
        'ignore-letter-case': 'true',
        'publish-type': 'Cache',
        'before-value': '^http://([^/]+/.*)',
        'after-value': '301:https://$1',
        'rewrite-type': 'before',
        priority: '10',
      });
    }
    return (await this.call('PUT', `/api/config/InnerRedirect/${domain}`, { 'rewrite-rule-settings': rules })) !== false;
  }

  async purge(urls: string[], type: 'url' | 'dir'): Promise<string | false> {
    const body = type === 'dir' ? { dirs: urls, 'dir-action': 'delete' } : { urls, 'url-action': 'delete' };
    const data = await this.call('POST', '/ccm/purge/ItemIdReceiver', body);
    if (data === false) return false;
    return data && data.itemId ? String(data.itemId) : 'ok';
  }

  async preheat(urls: string[]): Promise<string | false> {
    const data = await this.call('POST', '/cdn/prefetches', { name: 'preheat_' + Date.now(), fileList: urls.map((url) => ({ url })) });
    if (data === false) return false;
    return data && data.itemId ? String(data.itemId) : 'ok';
  }

  async getAccess(domain: string): Promise<Record<string, any> | false> {
    const data = await this.call('GET', `/api/config/visitcontrol/${domain}`);
    if (!data || data === true) return false;
    const rules = data.visitControlRules || [];
    const out: Record<string, any> = { referer_mode: 'off', referer_list: [], ip_mode: 'off', ip_list: [], ua_list: [] };
    for (const r of rules) {
      if (r.refererControlRule) {
        const rc = r.refererControlRule;
        if (rc.validDomain) {
          out.referer_mode = 'whitelist';
          out.referer_list = String(rc.validDomain).split(';').filter(Boolean);
        } else if (rc.invalidDomain) {
          out.referer_mode = 'blacklist';
          out.referer_list = String(rc.invalidDomain).split(';').filter(Boolean);
        }
      }
      if (r.ipControlRule) {
        const ic = r.ipControlRule;
        if (ic.allowedIps) {
          out.ip_mode = 'whitelist';
          out.ip_list = String(ic.allowedIps).split(';').filter(Boolean);
        } else if (ic.forbiddenIps) {
          out.ip_mode = 'blacklist';
          out.ip_list = String(ic.forbiddenIps).split(';').filter(Boolean);
        }
      }
      if (r.uaControlRule) {
        const uc = r.uaControlRule;
        out.ua_list = String(uc.invalidUserAgents || uc.validUserAgents || '')
          .split(';')
          .filter(Boolean);
      }
    }
    return out;
  }

  async setAccess(domain: string, config: Record<string, any>): Promise<boolean> {
    const current = await this.call('GET', `/api/config/visitcontrol/${domain}`);
    const existing = current && current !== true ? current.visitControlRules || [] : [];
    const rules: any[] = existing
      .filter((r: any) => !r.ipControlRule && !r.uaControlRule && !r.refererControlRule)
      .map((r: any) => ({ ...r }));

    const refererMode = config.referer_mode || 'off';
    if (refererMode !== 'off') {
      const rc: Record<string, any> = { allowNullReferer: (config.referer_list || []).length === 0 ? 'true' : 'false' };
      if (refererMode === 'whitelist') rc.validDomain = (config.referer_list || []).join(';');
      else rc.invalidDomain = (config.referer_list || []).join(';');
      rules.push({ 'custom-pattern': 'all', 'control-action': '403', priority: '10', 'referer-control-rule': rc });
    }
    const ipMode = config.ip_mode || 'off';
    if (ipMode !== 'off') {
      const ic: Record<string, any> = {};
      if (ipMode === 'whitelist') ic.allowedIps = (config.ip_list || []).join(';');
      else ic.forbiddenIps = (config.ip_list || []).join(';');
      rules.push({ 'custom-pattern': 'all', 'control-action': '403', priority: '10', 'ip-control-rule': ic });
    }
    const uaList = config.ua_list || [];
    if (uaList.length) {
      rules.push({ 'custom-pattern': 'all', 'control-action': '403', priority: '10', 'ua-control-rule': { invalidUserAgents: uaList.join(';') } });
    }
    return (await this.call('PUT', `/api/config/visitcontrol/${domain}`, { 'visit-control-rules': rules })) !== false;
  }
}