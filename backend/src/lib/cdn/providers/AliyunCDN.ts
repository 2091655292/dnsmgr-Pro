import { Aliyun } from '../../clients/Aliyun.js';
import type { CdnProvider, CdnDomainItem } from '../types.js';
import { fileExtensions, normalizeValue, parsePathRule } from '../pathRule.js';

const scopeMap: Record<string, string> = { mainland_china: 'domestic', overseas: 'overseas', global: 'global' };

export class AliyunCDN implements CdnProvider {
  private client: Aliyun;
  private error = '';

  constructor(config: Record<string, any>) {
    this.client = new Aliyun(config.AccessKeyId, config.AccessKeySecret, 'cdn.aliyuncs.com', '2018-05-10');
  }

  getError() {
    return this.error;
  }

  private async call(param: Record<string, any>): Promise<any> {
    try {
      const resp = await this.client.request(param);
      if (resp.Code) throw new Error(resp.Message || resp.Code);
      return resp;
    } catch (e: any) {
      this.error = e.message || String(e);
      return false;
    }
  }

  async check() {
    return (await this.call({ Action: 'DescribeUserDomains', PageSize: 1 })) !== false;
  }

  async createDomain(domain: string, origin: string, originType: string, serviceArea: string): Promise<string | false> {
    const sources = origin
      .split(';')
      .map((v) => v.trim())
      .filter((v) => v !== '')
      .map((v) => ({ type: originType === 'domain' ? 'domain' : 'ipaddr', content: v, priority: '20', weight: '10', port: 80 }));
    const param = {
      Action: 'AddCdnDomain',
      DomainName: domain,
      CdnType: 'web',
      Scope: scopeMap[serviceArea] ?? 'domestic',
      Sources: JSON.stringify(sources),
    };
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
    const data = await this.call({ Action: 'DescribeCdnDomainDetail', DomainName: domain });
    if (!data) return false;
    return data.GetDomainDetailModel?.Cname || false;
  }

  async listDomains(): Promise<CdnDomainItem[] | false> {
    const list: CdnDomainItem[] = [];
    let page = 1;
    const size = 50;
    while (page < 50) {
      const data = await this.call({ Action: 'DescribeUserDomains', PageSize: size, CurrentPage: page });
      if (!data) return false;
      const pageData = data.Domains?.PageData || [];
      for (const d of pageData) {
        let detail: any = {};
        const dr = await this.call({ Action: 'DescribeCdnDomainDetail', DomainName: d.DomainName });
        if (dr) detail = dr.GetDomainDetailModel || {};
        const origins: string[] = [];
        let port = 0;
        let srcs: any[] = [];
        try {
          srcs = JSON.parse(detail.Sources || '[]') || [];
        } catch {
          srcs = [];
        }
        for (const s of srcs) {
          if (s.content) origins.push(s.content);
          if (!port && s.port) port = Number(s.port);
        }
        let forceRedirect = false;
        const cfg = await this.call({ Action: 'DescribeCdnDomainConfigs', DomainName: d.DomainName, FunctionNames: 'https_force' });
        if (cfg) {
          for (const c of cfg.DomainConfigs?.DomainConfig || []) {
            if (c.FunctionName !== 'https_force') continue;
            for (const arg of c.FunctionArgs?.FunctionArg || []) {
              if (arg.argName === 'enable') forceRedirect = arg.argValue === 'on';
            }
          }
        }
        list.push({
          domain: d.DomainName,
          cname: d.Cname || detail.Cname || '',
          status: d.DomainStatus === 'offline' ? 'offline' : 'online',
          area: d.Area || '',
          origin: origins.join(';'),
          origin_type: ['ipaddr', 'domain'].includes(detail.SourceType) ? detail.SourceType : '',
          origin_host: detail.ServerName || '',
          origin_protocol: 'follow',
          http_port: port || Number(detail.SourcePort || 80),
          https_port: 443,
          https_enabled: forceRedirect,
          force_redirect: forceRedirect,
        });
      }
      const total = Number(data.TotalCount || 0);
      if (pageData.length < size || list.length >= total) break;
      page++;
    }
    return list;
  }

  async deleteDomain(domain: string) {
    return (await this.call({ Action: 'DeleteCdnDomain', DomainName: domain })) !== false;
  }

  async setDomainStatus(domain: string, status: string) {
    const action = status === 'offline' ? 'StopCdnDomain' : 'StartCdnDomain';
    return (await this.call({ Action: action, DomainName: domain })) !== false;
  }

  async updateOrigin(domain: string, origin: string, originType: string, originHost: string, originProtocol: string, httpPort: number, httpsPort: number) {
    const port = originProtocol === 'https' ? httpsPort : httpPort;
    const sources = origin
      .split(';')
      .map((v) => v.trim())
      .filter((v) => v !== '')
      .map((v) => ({ type: originType === 'domain' ? 'domain' : 'ipaddr', content: v, priority: '20', weight: '10', port }));
    if (!(await this.call({ Action: 'ModifyCdnDomain', DomainName: domain, Sources: JSON.stringify(sources) }))) return false;

    const functions: any[] = [];
    if (originHost) {
      functions.push({ functionName: 'set_req_host_header', functionArgs: [{ argName: 'domain', argValue: originHost }] });
    }
    const schemeOn = originProtocol === 'follow' ? 'off' : 'on';
    functions.push({
      functionName: 'forward_scheme',
      functionArgs: [
        { argName: 'scheme_origin', argValue: schemeOn },
        { argName: 'scheme_origin_port', argValue: 'on' },
      ],
    });
    return (
      (await this.call({ Action: 'BatchSetCdnDomainConfig', DomainNames: domain, Functions: JSON.stringify(functions) })) !== false
    );
  }

  // 删除旧的同名 function 配置（移植自 AliyunDomainServiceImpl.deleteBatchCdnDomainConfig，删除失败仅忽略）
  private async deleteDomainConfig(domain: string, functionNames: string) {
    await this.call({ Action: 'BatchDeleteCdnDomainConfig', DomainNames: domain, FunctionNames: functionNames });
  }

  // 移植自 multi-cloud-cdn AliyunDomainServiceImpl.saveCacheRules：
  // 先删除旧的 filetype_based_ttl_set/path_based_ttl_set 再按新规则下发；后缀规则用 filetype_based_ttl_set，weight 按条数递减表示优先级
  async setCacheRules(domain: string, rules: any[]) {
    await this.deleteDomainConfig(domain, 'filetype_based_ttl_set,path_based_ttl_set');
    const list = rules.filter((r) => {
      const p = normalizeValue(r?.path);
      return p !== '' && p !== '*';
    });
    const globalRule = rules.find((r) => {
      const p = normalizeValue(r?.path);
      return p === '*' || p === '';
    });
    const functions: any[] = [];
    let weight = list.length + (globalRule ? 1 : 0);
    const buildTtlFunction = (functionName: string, argName: string, argValue: string, ttl: number, w: number) => ({
      functionName,
      functionArgs: [
        { argName, argValue },
        { argName: 'ttl', argValue: String(ttl) },
        { argName: 'weight', argValue: String(w) },
        { argName: 'swift_origin_cache_high', argValue: 'off' },
      ],
    });
    if (globalRule) {
      const ttl = Math.max(0, Number(globalRule.ttl) || 0);
      // 全部文件规则等价于全站路径 '/'
      functions.push(buildTtlFunction('path_based_ttl_set', 'path', '/', ttl, weight--));
    }
    for (const r of list) {
      const parsed = parsePathRule(r?.path);
      const ttl = Math.max(0, Number(r?.ttl) || 0);
      if (parsed.type === 'file_extension') {
        const exts = fileExtensions(parsed.value);
        if (!exts.length) {
          weight--;
          continue;
        }
        functions.push(buildTtlFunction('filetype_based_ttl_set', 'file_type', exts.join(','), ttl, weight--));
      } else {
        functions.push(buildTtlFunction('path_based_ttl_set', 'path', normalizeValue(parsed.value), ttl, weight--));
      }
    }
    if (!functions.length) return true;
    return (
      (await this.call({ Action: 'BatchSetCdnDomainConfig', DomainNames: domain, Functions: JSON.stringify(functions) })) !== false
    );
  }

  // 移植自 multi-cloud-cdn AliyunDomainServiceImpl.httpsConfiguration / forcedToJump：
  // 关闭 HTTPS 走 SetCdnDomainSSLCertificate SSLProtocol=off（开启需要证书内容，请在控制台或证书接口配置）；
  // 强制跳转先删除旧的 http_force/https_force 再下发 https_force
  async setHttps(domain: string, enabled: boolean, forceRedirect: boolean) {
    if (!enabled) {
      if (!(await this.call({ Action: 'SetCdnDomainSSLCertificate', DomainName: domain, SSLProtocol: 'off' }))) return false;
    }
    await this.deleteDomainConfig(domain, 'http_force,https_force');
    if (forceRedirect) {
      const functions = [
        {
          functionName: 'https_force',
          functionArgs: [
            { argName: 'enable', argValue: 'on' },
            { argName: 'https_rewrite', argValue: '308' },
          ],
        },
      ];
      if (!(await this.call({ Action: 'BatchSetCdnDomainConfig', DomainNames: domain, Functions: JSON.stringify(functions) }))) return false;
    }
    return true;
  }

  async purge(urls: string[], type: 'url' | 'dir'): Promise<string | false> {
    const data = await this.call({
      Action: 'RefreshObjectCaches',
      ObjectPath: urls.join('\n'),
      ObjectType: type === 'dir' ? 'Directory' : 'File',
    });
    if (!data) return false;
    return data.RefreshTaskId || 'ok';
  }

  async preheat(urls: string[]): Promise<string | false> {
    const data = await this.call({ Action: 'PushObjectCache', ObjectPath: urls.join('\n') });
    if (!data) return false;
    return data.PushTaskId || 'ok';
  }

  async setAccess(domain: string, config: Record<string, any>): Promise<boolean> {
    const functions = this.buildAccessFunctions(config);
    const names = [
      'referer_white_list_set',
      'referer_black_list_set',
      'ip_allow_list_set',
      'ip_black_list_set',
      'ua_black_list_set',
      'ua_white_list_set',
    ].join(',');
    await this.deleteDomainConfig(domain, names);
    if (!functions.length) return true;
    return (await this.call({ Action: 'BatchSetCdnDomainConfig', DomainNames: domain, Functions: JSON.stringify(functions) })) !== false;
  }

  private buildAccessFunctions(config: Record<string, any>): any[] {
    const functions: any[] = [];
    const refererMode = config.referer_mode || 'off';
    if (refererMode === 'whitelist' || refererMode === 'blacklist') {
      const allowEmpty = config.referer_list?.length ? 'off' : 'on';
      const value = (config.referer_list || []).map((d: string) => d.replace(/^\*\./, '.').replace(/^\./, '')).join(',');
      functions.push({
        functionName: refererMode === 'whitelist' ? 'referer_white_list_set' : 'referer_black_list_set',
        functionArgs: [
          { argName: refererMode === 'whitelist' ? 'refer_domain_allow_list' : 'refer_domain_black_list', argValue: value },
          { argName: 'allow_empty', argValue: allowEmpty },
        ],
      });
    }
    const ipMode = config.ip_mode || 'off';
    if (ipMode === 'whitelist' || ipMode === 'blacklist') {
      functions.push({
        functionName: ipMode === 'whitelist' ? 'ip_allow_list_set' : 'ip_black_list_set',
        functionArgs: [{ argName: 'ip_list', argValue: (config.ip_list || []).join(',') }],
      });
    }
    if (config.ua_list?.length) {
      functions.push({
        functionName: 'ua_black_list_set',
        functionArgs: [{ argName: 'ua_list', argValue: (config.ua_list || []).join(';') }],
      });
    }
    return functions;
  }
}