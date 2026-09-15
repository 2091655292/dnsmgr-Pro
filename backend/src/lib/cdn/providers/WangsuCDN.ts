import { CdnetworksCDN } from './CdnetworksCDN.js';

// 网宿（ChinaNetCenter）与 CDNetworks 使用同一套 OpenAPI，
// 仅 endpoint / 合约号 / ItemId 不同（参见 Java 端 WangsuCdn extends CdnetworksCdn）。
export class WangsuCDN extends CdnetworksCDN {
  constructor(config: Record<string, any>) {
    super({
      Endpoint: 'open.chinanetcenter.com',
      ContractId: '40017058',
      ItemId: '20',
      ...config,
    });
  }
}