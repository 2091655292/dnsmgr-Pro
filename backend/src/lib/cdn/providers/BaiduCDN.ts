import { BaiduCloud } from '../../clients/BaiduCloud.js';
import type { CdnProvider, CdnDomainItem } from '../types.js';
import { catalogPath, fileExtensions, normalizeValue, parsePathRule } from '../pathRule.js';

function parsePeer(peer: string): { host: string; port: number } | null {
  const m = String(peer).match(/^https?:\/\/(\[[^\]]+\]|[^/:]+)(?::(\d+))?/);
  if (!m) return null;
  return { host: m[1], port: m[2] ? Number(m[2]) : 80 };
}

function isIp(host: string): boolean {
  return /^[\d.]+$/.test(host) || host.includes(':');
}

export class BaiduCDN implements CdnProvider {
  private client: BaiduCloud;
  private error = '';

  constructor(config: Record<string, any>) {
    this.client = new BaiduCloud(config.AccessKeyId, config.SecretAccessKey, 'cdn.baidubce.com');
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
    return (await this.call('GET', '/v2/domain')) !== false;
  }

  private buildPeers(origin: string, scheme: 'http' | 'https', port: number, weight: number): any[] {
    return origin
      .split(';')
      .map((v) => v.trim())
      .filter((v) => v !== '')
      .map((v) => {
        const host = v.replace(/^https?:\/\//, '').split(':')[0];
        const p = v.includes(':') ? v.split(':').pop() : String(port);
        return { peer: `${scheme}://${host}:${p}`, backup: false, weight };
      });
  }

  async createDomain(domain: string, origin: string, originType: string, serviceArea: string): Promise<string | false> {
    const origins = origin
      .split(';')
      .map((v) => v.trim())
      .filter((v) => v !== '')
      .flatMap((v) => {
        const host = v.replace(/^https?:\/\//, '').split(':')[0];
        return [
          { peer: `http://${host}:80`, backup: false, weight: 1 },
          { peer: `https://${host}:443`, backup: false, weight: 1 },
        ];
      });
    const body = { form: 'default', origin: origins, defaultHost: domain, follow302: false };
    if (!(await this.call('PUT', `/v2/domain/${domain}`, null, body))) return false;
    for (let i = 0; i < 10; i++) {
      const cname = await this.getDomainCname(domain);
      if (cname) return cname;
      await new Promise((r) => setTimeout(r, 1000));
    }
    this.error = '未获取到 CNAME，请稍后在列表刷新重试';
    return false;
  }

  async getDomainCname(domain: string): Promise<string | false> {
    const data = await this.call('GET', `/v2/domain/${domain}`);
    if (!data) return false;
    return data && data.cname ? String(data.cname) : false;
  }

  private async getDomainDetail(domain: string): Promise<any | false> {
    return this.call('GET', `/v2/domain/${domain}`);
  }

  async listDomains(): Promise<CdnDomainItem[] | false> {
    const data = await this.call('GET', '/v2/domain');
    if (!data) return false;
    const domains = data.domains || [];
    const list: CdnDomainItem[] = [];
    for (const d of domains) {
      const name = d.domain || d.Domain || '';
      if (!name) continue;
      const detail = await this.getDomainDetail(name);
      if (!detail) continue;
      const origins: string[] = [];
      let httpPort = 80;
      let httpsPort = 443;
      let originType = '';
      for (const o of detail.origin || []) {
        const p = parsePeer(o.peer || '');
        if (!p) continue;
        if ((o.peer || '').startsWith('https:')) httpsPort = p.port;
        else httpPort = p.port;
        if (!origins.includes(p.host)) origins.push(p.host);
        originType = isIp(p.host) ? 'ipaddr' : 'domain';
      }
      const https = detail.https || {};
      list.push({
        domain: name,
        cname: detail.cname || '',
        status: String(detail.status || '').toUpperCase() === 'STOPPED' ? 'offline' : 'online',
        area: 'mainland_china',
        origin: origins.join(';'),
        origin_type: originType,
        origin_host: detail.defaultHost || detail.domain || '',
        origin_protocol: 'follow',
        http_port: httpPort,
        https_port: httpsPort,
        https_enabled: https.enabled === true,
        force_redirect: https.httpRedirect === true,
      });
    }
    return list;
  }

  async deleteDomain(domain: string) {
    return (await this.call('DELETE', `/v2/domain/${domain}`)) !== false;
  }

  async setDomainStatus(domain: string, status: string) {
    const q = status === 'offline' ? 'disable' : 'enable';
    return (await this.call('POST', `/v2/domain/${domain}?${q}`)) !== false;
  }

  async updateOrigin(domain: string, origin: string, originType: string, originHost: string, originProtocol: string, httpPort: number, httpsPort: number) {
    const originList = origin
      .split(';')
      .map((v) => v.trim())
      .filter((v) => v !== '')
      .flatMap((v) => {
        const host = v.replace(/^https?:\/\//, '').split(':')[0];
        return [
          { peer: `http://${host}:${httpPort || 80}`, backup: false, weight: 100 },
          { peer: `https://${host}:${httpsPort || 443}`, backup: false, weight: 100 },
        ];
      });
    const body: Record<string, any> = { origin: originList };
    if (originHost) body.defaultHost = originHost;
    if ((await this.call('PUT', `/v2/domain/${domain}/config`, { origin: '' }, body)) === false) return false;

    const proto = originProtocol === 'https' ? 'https' : originProtocol === 'follow' ? '*' : 'http';
    return (await this.call('PUT', `/v2/domain/${domain}/config`, { originProtocol: '' }, { originProtocol: { value: proto } })) !== false;
  }

  async setCacheRules(domain: string, rules: any[]) {
    const cacheTTL = rules
      .map((r, idx) => {
        const parsed = parsePathRule(r?.path);
        const ttl = Math.max(0, Number(r?.ttl) || 0);
        let type = 'exactPath';
        let value = normalizeValue(parsed.value);
        if (parsed.type === 'global') {
          type = 'path';
          value = '/';
        } else if (parsed.type === 'file_extension') {
          type = 'suffix';
          const exts = fileExtensions(parsed.value).map((e) => '.' + e);
          if (!exts.length) return null;
          value = exts.join(',');
        } else if (parsed.type === 'catalog') {
          type = 'path';
          value = catalogPath(parsed.value) + '/';
        }
        return { type, value, ttl, weight: rules.length - idx };
      })
      .filter(Boolean);
    return (await this.call('PUT', `/v2/domain/${domain}/config`, { cacheTtl: '' }, { cacheTTL })) !== false;
  }

  async setHttps(domain: string, enabled: boolean, forceRedirect: boolean) {
    if (!enabled) {
      await this.call('DELETE', `/v2/domain/${domain}/certificates`);
      return true;
    }
    let certId = '';
    try {
      const cert = await this.call('GET', `/v2/domain/${domain}/certificates`);
      if (cert && cert !== false) certId = cert.certId || '';
    } catch {
      certId = '';
    }
    const https = { enabled: true, certId, httpRedirect: !!forceRedirect, httpRedirectCode: forceRedirect ? 301 : 0, httpsRedirect: false };
    return (await this.call('PUT', `/v2/domain/${domain}/config`, { https: '' }, { https })) !== false;
  }

  async purge(urls: string[], type: 'url' | 'dir'): Promise<string | false> {
    const tasks = type === 'dir' ? urls.map((u) => ({ directory: u })) : urls.map((u) => ({ url: u }));
    const data = await this.call('POST', '/v2/cache/purge', null, { tasks });
    if (data === false) return false;
    return (data && data.id) ? String(data.id) : 'ok';
  }

  async preheat(urls: string[]): Promise<string | false> {
    const data = await this.call('POST', '/v2/cache/prefetch', null, { tasks: urls.map((u) => ({ url: u })) });
    if (data === false) return false;
    return (data && data.id) ? String(data.id) : 'ok';
  }

  async getAccess(domain: string): Promise<Record<string, any> | false> {
    const out: Record<string, any> = { referer_mode: 'off', referer_list: [], ip_mode: 'off', ip_list: [], ua_list: [] };
    const referer = await this.call('GET', `/v2/domain/${domain}/config`, { refererACL: '' });
    if (referer && referer !== false) {
      const acl = referer.refererACL || {};
      if (acl.blackList?.length) {
        out.referer_mode = 'blacklist';
        out.referer_list = acl.blackList;
      } else if (acl.whiteList?.length) {
        out.referer_mode = 'whitelist';
        out.referer_list = acl.whiteList;
      }
    }
    const ipacl = await this.call('GET', `/v2/domain/${domain}/config`, { ipACL: '' });
    if (ipacl && ipacl !== false) {
      const acl = ipacl.ipACL || {};
      if (acl.blackList?.length) {
        out.ip_mode = 'blacklist';
        out.ip_list = acl.blackList;
      } else if (acl.whiteList?.length) {
        out.ip_mode = 'whitelist';
        out.ip_list = acl.whiteList;
      }
    }
    const uaacl = await this.call('GET', `/v2/domain/${domain}/config`, { uaAcl: '' });
    if (uaacl && uaacl !== false) {
      const acl = uaacl.uaAcl || {};
      out.ua_list = acl.blackList || [];
    }
    return out;
  }

  async setAccess(domain: string, config: Record<string, any>): Promise<boolean> {
    const refererMode = config.referer_mode || 'off';
    const refererACL: Record<string, any> = { allowEmpty: (config.referer_list || []).length === 0 };
    if (refererMode === 'blacklist') refererACL.blackList = config.referer_list || [];
    else if (refererMode === 'whitelist') refererACL.whiteList = config.referer_list || [];
    if ((await this.call('PUT', `/v2/domain/${domain}/config`, { refererACL: '' }, { refererACL })) === false) return false;

    const ipMode = config.ip_mode || 'off';
    const ipACL: Record<string, any> = {};
    if (ipMode === 'blacklist') ipACL.blackList = config.ip_list || [];
    else if (ipMode === 'whitelist') ipACL.whiteList = config.ip_list || [];
    if ((await this.call('PUT', `/v2/domain/${domain}/config`, { ipACL: '' }, { ipACL })) === false) return false;

    const uaList = config.ua_list || [];
    const uaAcl: Record<string, any> = { blackList: uaList };
    return (await this.call('PUT', `/v2/domain/${domain}/config`, { uaAcl: '' }, { uaAcl })) !== false;
  }
}