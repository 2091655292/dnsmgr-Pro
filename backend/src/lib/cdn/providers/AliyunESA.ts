import { Aliyun } from '../../clients/Aliyun.js';
import type { CdnProvider, CdnDomainItem } from '../types.js';
import { catalogPath, fileExtensions, normalizeValue, parsePathRule, wildcardToRegex } from '../pathRule.js';
import type { PathRuleType } from '../pathRule.js';

export class AliyunESA implements CdnProvider {
  private client: Aliyun;
  private error = '';
  private siteId: string | null = null;

  constructor(config: Record<string, any>) {
    this.client = new Aliyun(config.AccessKeyId, config.AccessKeySecret, 'esa.aliyuncs.com', '2024-09-10');
  }

  getError() {
    return this.error;
  }

  setSiteId(siteId: string) {
    this.siteId = siteId;
  }

  private async call(param: Record<string, any>): Promise<any> {
    try {
      const resp = await this.client.request(param);
      if (resp.Code && resp.Code !== 'Success') throw new Error(resp.Message || resp.Code);
      return resp;
    } catch (e: any) {
      this.error = e.message || String(e);
      return false;
    }
  }

  async getZones() {
    const list: any[] = [];
    let page = 1;
    const size = 100;
    while (page < 50) {
      const data = await this.call({ Action: 'ListSites', PageNumber: page, PageSize: size });
      if (!data) break;
      for (const s of data.Sites || []) {
        list.push({ zoneId: String(s.SiteId || ''), zoneName: s.SiteName || '', status: s.Status || '', area: s.Coverage || '' });
      }
      const total = Number(data.TotalCount || 0);
      if ((data.Sites || []).length < size || list.length >= total) break;
      page++;
    }
    return list;
  }

  async check() {
    return (await this.call({ Action: 'ListSites', PageNumber: 1, PageSize: 1 })) !== false;
  }

  private getRootDomain(domain: string): string {
    const parts = domain.split('.');
    return parts.length <= 2 ? domain : parts.slice(-2).join('.');
  }

  private async findSite(domain: string): Promise<string | false> {
    if (this.siteId) return this.siteId;
    let page = 1;
    const size = 100;
    let best: any = null;
    while (page < 50) {
      const data = await this.call({ Action: 'ListSites', PageNumber: page, PageSize: size });
      if (!data) break;
      for (const s of data.Sites || []) {
        const siteName = s.SiteName || '';
        if (!siteName) continue;
        if (domain === siteName) return String(s.SiteId);
        if (domain.endsWith('.' + siteName)) {
          if (!best || siteName.length > (best.SiteName || '').length) best = s;
        }
      }
      const total = Number(data.TotalCount || 0);
      if ((data.Sites || []).length < size || page * size >= total) break;
      page++;
    }
    return best ? String(best.SiteId) : false;
  }

  private async getSiteName(siteId: string): Promise<string> {
    const data = await this.call({ Action: 'GetSite', SiteId: siteId });
    return data?.SiteModel?.SiteName || '';
  }

  private calcRecordName(domain: string, siteName: string): string {
    if (domain === siteName) return '@';
    return domain.slice(0, domain.length - siteName.length - 1);
  }

  private async findRecord(domain: string): Promise<{ siteId: string; siteName: string; record: any } | false> {
    const siteId = await this.findSite(domain);
    if (!siteId) return false;
    const siteName = (await this.getSiteName(siteId)) || this.getRootDomain(domain);
    const recordName = this.calcRecordName(domain, siteName);
    const data = await this.call({ Action: 'ListRecords', SiteId: siteId, PageNumber: 1, PageSize: 100, RecordName: recordName });
    if (!data) return false;
    for (const r of data.Records || []) {
      if (r.RecordName === recordName) return { siteId, siteName, record: r };
    }
    return false;
  }

  async createDomain(domain: string, origin: string, originType: string, serviceArea: string, zoneId?: string | null): Promise<string | false> {
    if (zoneId) this.siteId = zoneId;
    const siteId = await this.findSite(domain);
    if (!siteId) {
      this.error = '未找到该域名的 ESA 站点，请先在阿里云 ESA 控制台创建站点后再接入';
      return false;
    }
    const siteName = await this.getSiteName(siteId);
    const recordName = this.calcRecordName(domain, siteName);
    const originVal = origin.split(';')[0].trim();
    const type = originType === 'ipaddr' ? 'A' : 'CNAME';
    const param: Record<string, any> = {
      Action: 'CreateRecord',
      SiteId: siteId,
      RecordName: recordName,
      Type: type,
      Data: JSON.stringify({ value: originVal }),
      Proxied: true,
    };
    if (originType === 'domain') param.SourceType = 'domain';
    if (!(await this.call(param))) return false;
    for (let i = 0; i < 10; i++) {
      const cname = await this.getDomainCname(domain);
      if (cname) return cname;
      await new Promise((r) => setTimeout(r, 1000));
    }
    this.error = '未获取到 CNAME，请稍后在列表刷新重试';
    return false;
  }

  async getDomainCname(domain: string): Promise<string | false> {
    const found = await this.findRecord(domain);
    if (!found) return false;
    return found.record.RecordCname || false;
  }

  async listDomains(): Promise<CdnDomainItem[] | false> {
    const list: CdnDomainItem[] = [];
    let page = 1;
    const size = 100;
    while (page < 50) {
      const data = await this.call({ Action: 'ListSites', PageNumber: page, PageSize: size });
      if (!data) return false;
      for (const s of data.Sites || []) {
        const siteId = String(s.SiteId || '');
        const siteName = s.SiteName || '';
        if (!siteId || !siteName) continue;
        let rp = 1;
        while (rp < 50) {
          const rr = await this.call({ Action: 'ListRecords', SiteId: siteId, PageNumber: rp, PageSize: size });
          if (!rr) break;
          const records = rr.Records || [];
          for (const r of records) {
            if (!r.Proxied) continue;
            if (!['A', 'AAAA', 'CNAME'].includes(r.RecordType || '')) continue;
            const recordName = r.RecordName || '';
            const domain = recordName === '@' ? siteName : recordName + '.' + siteName;
            const dataObj = r.Data && typeof r.Data === 'object' ? r.Data : {};
            const origin = dataObj.value ? String(dataObj.value) : '';
            const originType = (r.RecordType === 'A' || r.RecordType === 'AAAA') ? 'ipaddr' : 'domain';
            list.push({
              domain,
              cname: r.RecordCname || '',
              status: 'online',
              zoneId: siteId,
              origin,
              origin_type: originType,
              origin_host: r.HostPolicy || '',
              origin_protocol: 'follow',
              http_port: 80,
              https_port: 443,
              https_enabled: false,
              force_redirect: false,
            });
          }
          const rtotal = Number(rr.TotalCount || 0);
          if (records.length < size || rp * size >= rtotal) break;
          rp++;
        }
      }
      const stotal = Number(data.TotalCount || 0);
      if ((data.Sites || []).length < size || page * size >= stotal) break;
      page++;
    }
    return list;
  }

  async deleteDomain(domain: string) {
    const found = await this.findRecord(domain);
    if (!found) {
      this.error = '未找到该域名的 ESA 记录';
      return false;
    }
    return (await this.call({ Action: 'DeleteRecord', RecordId: found.record.RecordId })) !== false;
  }

  async setDomainStatus(domain: string, status: string) {
    const found = await this.findRecord(domain);
    if (!found) {
      this.error = '未找到该域名的 ESA 记录';
      return false;
    }
    const proxied = status !== 'offline';
    return (await this.call({ Action: 'UpdateRecord', RecordId: found.record.RecordId, Proxied: proxied })) !== false;
  }

  async updateOrigin(domain: string, origin: string, originType: string, originHost: string, originProtocol: string, httpPort: number, httpsPort: number) {
    const found = await this.findRecord(domain);
    if (!found) {
      this.error = '未找到该域名的 ESA 记录';
      return false;
    }
    const originVal = origin.split(';')[0].trim();
    const type = originType === 'ipaddr' ? 'A' : 'CNAME';
    const param: Record<string, any> = {
      Action: 'UpdateRecord',
      RecordId: found.record.RecordId,
      Type: type,
      Data: JSON.stringify({ value: originVal }),
      HttpPorts: String(httpPort),
      HttpsPorts: String(httpsPort),
    };
    if (originType === 'domain') param.SourceType = 'domain';
    if (originHost) param.HostPolicy = originHost;
    return (await this.call(param)) !== false;
  }

  // ===== ESA 缓存规则 / HTTPS 规则（规则引擎式，参照 multi-cloud-cdn EdgeOne 规则引擎移植思路）=====

  private esaRuleName(domain: string, suffix = ''): string {
    return 'dnsmgr_cache_' + normalizeValue(domain).replace(/[^A-Za-z0-9_-]/g, '_') + suffix;
  }

  private esaHostCondition(domain: string): string {
    return '(http.host eq "' + normalizeValue(domain).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }

  // dnsmgr 的 path 规则 → ESA 规则表达式的补充条件（不含 host 前缀，返回闭括号结尾的片段）
  private esaPathCondition(parsed: { type: PathRuleType; value: string }): string {
    if (parsed.type === 'file_extension') {
      const exts = fileExtensions(parsed.value);
      if (!exts.length) throw new Error('文件后缀缓存规则内容不能为空');
      return ' and http.request.uri.path matches "\\.(' + exts.join('|') + ')$")';
    }
    if (parsed.type === 'catalog') {
      const path = catalogPath(parsed.value);
      return ' and starts_with(http.request.uri.path, "' + path + '"))';
    }
    // full_path
    const v = normalizeValue(parsed.value);
    if (v.includes('*') || v.includes('?')) {
      return ' and http.request.uri.path matches "' + wildcardToRegex(v) + '"))';
    }
    return ' and http.request.uri.path eq "' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"))';
  }

  private async findEsaRule(action: string, siteId: number, ruleName: string): Promise<any | null> {
    const data = await this.call({ Action: action, SiteId: siteId, RuleName: ruleName, PageNumber: 1, PageSize: 100 });
    if (!data) return undefined;
    for (const c of data.Configs || []) {
      if (c.RuleName === ruleName) return c;
    }
    return null;
  }

  // 缓存规则：每条 dnsmgr 规则对应一条 ESA CacheRule（CacheRule 一条只能承载一个缓存行为）
  async setCacheRules(domain: string, rules: any[]) {
    const siteId = await this.findSite(domain);
    if (!siteId) {
      this.error = '未找到该域名的 ESA 站点';
      return false;
    }
    const sid = Number(siteId);
    const list = Array.isArray(rules) ? rules : [];
    // 全量同步：目标集合 = 全局规则（*）+ 逐条具体规则
    const targets: { ruleName: string; condition: string; mode: string; ttl: number }[] = [];
    const globalRule = list.find((r) => parsePathRule(r?.path).type === 'global');
    if (globalRule) {
      targets.push({
        ruleName: this.esaRuleName(domain),
        condition: this.esaHostCondition(domain) + ')',
        mode: Number(globalRule.ttl) > 0 ? 'override_origin' : 'no_cache',
        ttl: Math.max(0, Number(globalRule.ttl) || 0),
      });
    }
    let idx = 0;
    for (const r of list) {
      if (parsePathRule(r?.path).type === 'global') continue;
      idx++;
      targets.push({
        ruleName: this.esaRuleName(domain, '_' + idx),
        condition: this.esaHostCondition(domain) + this.esaPathCondition(parsePathRule(r?.path)),
        mode: Number(r?.ttl) > 0 ? 'override_origin' : 'no_cache',
        ttl: Math.max(0, Number(r?.ttl) || 0),
      });
    }
    try {
      // 同步目标规则（创建或更新）
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        const existing = await this.findEsaRule('ListCacheRules', sid, t.ruleName);
        if (existing === undefined) return false;
        const base: Record<string, any> = {
          RuleName: t.ruleName,
          Rule: t.condition,
          RuleEnable: 'on',
          Sequence: i + 1,
          EdgeCacheMode: t.mode,
        };
        if (t.mode === 'override_origin') base.EdgeCacheTtl = String(t.ttl);
        if (existing?.ConfigId) {
          if (!(await this.call({ Action: 'UpdateCacheRule', SiteId: sid, ConfigId: existing.ConfigId, ...base }))) return false;
        } else {
          if (!(await this.call({ Action: 'CreateCacheRule', SiteId: sid, ...base }))) return false;
        }
      }
      // 清理多余的旧规则（_N+1 起，直到查不到）
      let extra = idx + 1;
      for (let guard = 0; guard < 100; guard++, extra++) {
        const name = this.esaRuleName(domain, '_' + extra);
        const existing = await this.findEsaRule('ListCacheRules', sid, name);
        if (existing === undefined) return false;
        if (!existing) break;
        if (!(await this.call({ Action: 'DeleteCacheRule', SiteId: sid, ConfigId: existing.ConfigId }))) return false;
      }
      return true;
    } catch (e: any) {
      this.error = '修改阿里云 ESA 缓存规则失败：' + (e.message || String(e));
      return false;
    }
  }

  // HTTPS：开关走 HttpsBasicConfiguration，强制跳转走 HttpsApplicationConfiguration（均规则式、按域名）
  async setHttps(domain: string, enabled: boolean, forceRedirect: boolean) {
    const siteId = await this.findSite(domain);
    if (!siteId) {
      this.error = '未找到该域名的 ESA 站点';
      return false;
    }
    const sid = Number(siteId);
    const host = this.esaHostCondition(domain) + ')';
    try {
      // 基础 HTTPS 开关
      const basicName = 'dnsmgr_https_' + normalizeValue(domain).replace(/[^A-Za-z0-9_-]/g, '_');
      const basic = { RuleName: basicName, Rule: host, RuleEnable: 'on', Sequence: 1, Https: enabled ? 'on' : 'off' };
      const existBasic = await this.findEsaRule('ListHttpsBasicConfigurations', sid, basicName);
      if (existBasic === undefined) return false;
      if (existBasic?.ConfigId) {
        if (!(await this.call({ Action: 'UpdateHttpsBasicConfiguration', SiteId: sid, ConfigId: existBasic.ConfigId, ...basic }))) return false;
      } else {
        if (!(await this.call({ Action: 'CreateHttpsBasicConfiguration', SiteId: sid, ...basic }))) return false;
      }
      // 强制 HTTPS 跳转
      const forceName = 'dnsmgr_httpsforce_' + normalizeValue(domain).replace(/[^A-Za-z0-9_-]/g, '_');
      const force = { RuleName: forceName, Rule: host, RuleEnable: 'on', Sequence: 1, HttpsForce: forceRedirect ? 'on' : 'off', HttpsForceCode: '302' };
      const existForce = await this.findEsaRule('ListHttpsApplicationConfigurations', sid, forceName);
      if (existForce === undefined) return false;
      if (existForce?.ConfigId) {
        if (!(await this.call({ Action: 'UpdateHttpsApplicationConfiguration', SiteId: sid, ConfigId: existForce.ConfigId, ...force }))) return false;
      } else {
        if (!(await this.call({ Action: 'CreateHttpsApplicationConfiguration', SiteId: sid, ...force }))) return false;
      }
      return true;
    } catch (e: any) {
      this.error = '修改阿里云 ESA HTTPS 配置失败：' + (e.message || String(e));
      return false;
    }
  }

  async getZoneSetting(_zoneId: string): Promise<false> {
    this.error = 'ESA 站点配置暂未支持';
    return false;
  }

  async updateZoneSetting(_zoneId: string, _zoneConfig: Record<string, any>): Promise<boolean> {
    this.error = 'ESA 站点配置暂未支持';
    return false;
  }

  async purge(urls: string[], type: 'url' | 'dir'): Promise<string | false> {
    if (!this.siteId) {
      this.error = '缺少站点 SiteId';
      return false;
    }
    const data = await this.call({
      Action: 'PurgeCaches',
      SiteId: this.siteId,
      Type: type === 'dir' ? 'directory' : 'file',
      Content: urls.join('\n'),
    });
    if (!data) return false;
    return 'ok';
  }

  async preheat(urls: string[]): Promise<string | false> {
    if (!this.siteId) {
      this.error = '缺少站点 SiteId';
      return false;
    }
    const data = await this.call({ Action: 'PreloadCaches', SiteId: this.siteId, Content: urls.join('\n') });
    if (!data) return false;
    return 'ok';
  }
}