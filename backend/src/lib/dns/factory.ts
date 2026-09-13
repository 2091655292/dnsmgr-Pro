import { Dnspod } from './providers/dnspod.js';
import { AliyunDns } from './providers/aliyun.js';
import { CloudflareDns } from './providers/cloudflare.js';
import { HuaweiDns } from './providers/huawei.js';
import { BaiduDns } from './providers/baidu.js';
import { HuoshanDns } from './providers/huoshan.js';
import { JdcloudDns } from './providers/jdcloud.js';
import { WestDns } from './providers/west.js';
import { PowerDns } from './providers/powerdns.js';
import { AliyunEsaDns } from './providers/aliyunesa.js';
import { TencentEoDns } from './providers/tencenteo.js';
import { Dnsla } from './providers/dnsla.js';
import { QingcloudDns } from './providers/qingcloud.js';
import { BtDns } from './providers/bt.js';
import { NamesiloDns } from './providers/namesilo.js';
import { HenetDns } from './providers/henet.js';
import { SpaceshipDns } from './providers/spaceship.js';
import { DnsmgrDns } from './providers/dnsmgr.js';
import { GoEdgeDns } from './providers/goedge.js';
import { Dynv6Dns } from './providers/dynv6.js';
import { TechnitiumDns } from './providers/technitium.js';
import type { DnsProvider } from './types.js';

export interface FieldConfig {
  name: string;
  type: 'input' | 'radio' | 'select';
  placeholder?: string;
  options?: Record<string, string> | { value: string; label: string }[];
  value?: string;
  required?: boolean;
}

export interface DnsProviderMeta {
  name: string;
  icon: string;
  note?: string;
  config: Record<string, FieldConfig>;
  remark: number;
  status: boolean;
  redirect: boolean;
  log: boolean;
  weight: boolean;
  page: boolean;
  add: boolean;
  sort: boolean;
  implemented: boolean;
}

const proxyField: FieldConfig = {
  name: '使用代理服务器',
  type: 'radio',
  options: { '0': '否', '1': '是' },
  value: '0',
};

export const dnsProviders: Record<string, DnsProviderMeta> = {
  aliyun: {
    name: '阿里云',
    icon: 'aliyun.png',
    config: {
      AccessKeyId: { name: 'AccessKeyId', type: 'input', required: true },
      AccessKeySecret: { name: 'AccessKeySecret', type: 'input', required: true },
      proxy: proxyField,
    },
    remark: 1, status: true, redirect: true, log: true, weight: false, page: false, add: true, sort: true,
    implemented: true,
  },
  dnspod: {
    name: '腾讯云',
    icon: 'dnspod.ico',
    config: {
      SecretId: { name: 'SecretId', type: 'input', required: true },
      SecretKey: { name: 'SecretKey', type: 'input', required: true },
      proxy: proxyField,
    },
    remark: 1, status: true, redirect: true, log: true, weight: true, page: false, add: true, sort: true,
    implemented: true,
  },
  cloudflare: {
    name: 'Cloudflare',
    icon: 'cloudflare.ico',
    config: {
      email: { name: '邮箱地址', type: 'input', required: true },
      apikey: { name: 'API密钥/令牌', type: 'input', required: true },
      auth: {
        name: '认证方式',
        type: 'radio',
        options: { '0': 'API密钥', '1': 'API令牌' },
        value: '0',
      },
      proxy: proxyField,
    },
    remark: 2, status: true, redirect: false, log: false, weight: false, page: false, add: true, sort: true,
    implemented: true,
  },
  huawei: {
    name: '华为云',
    icon: 'huawei.ico',
    config: {
      AccessKeyId: { name: 'AccessKeyId', type: 'input', required: true },
      SecretAccessKey: { name: 'SecretAccessKey', type: 'input', required: true },
      proxy: proxyField,
    },
    remark: 2, status: true, redirect: false, log: false, weight: true, page: false, add: true, sort: true,
    implemented: true,
  },
  baidu: {
    name: '百度云',
    icon: 'baidu.ico',
    config: {
      accessKeyId: { name: 'AccessKeyId', type: 'input', required: true },
      secretAccessKey: { name: 'SecretAccessKey', type: 'input', required: true },
      proxy: proxyField,
    },
    remark: 2, status: false, redirect: false, log: false, weight: false, page: true, add: true, sort: false,
    implemented: true,
  },
  huoshan: {
    name: '火山引擎',
    icon: 'huoshan.ico',
    config: {
      AccessKeyId: { name: 'AccessKeyId', type: 'input', required: true },
      SecretAccessKey: { name: 'SecretAccessKey', type: 'input', required: true },
      proxy: proxyField,
    },
    remark: 2, status: true, redirect: false, log: false, weight: true, page: false, add: true, sort: false,
    implemented: true,
  },
  jdcloud: {
    name: '京东云',
    icon: 'jdcloud.ico',
    config: {
      AccessKeyId: { name: 'AccessKeyId', type: 'input', required: true },
      AccessKeySecret: { name: 'AccessKeySecret', type: 'input', required: true },
      proxy: proxyField,
    },
    remark: 0, status: true, redirect: true, log: false, weight: true, page: false, add: true, sort: false,
    implemented: true,
  },
  west: {
    name: '西部数码',
    icon: 'west.ico',
    config: {
      username: { name: '用户名', type: 'input', required: true },
      api_password: { name: 'API密码', type: 'input', required: true },
      proxy: proxyField,
    },
    remark: 0, status: true, redirect: false, log: false, weight: false, page: false, add: false, sort: false,
    implemented: true,
  },
  powerdns: {
    name: 'PowerDNS',
    icon: 'powerdns.ico',
    config: {
      ip: { name: 'IP地址', type: 'input', required: true },
      port: { name: '端口', type: 'input', required: true },
      apikey: { name: 'API KEY', type: 'input', required: true },
      proxy: proxyField,
    },
    remark: 2, status: true, redirect: false, log: false, weight: false, page: true, add: true, sort: false,
    implemented: true,
  },
  aliyunesa: {
    name: '阿里云 ESA',
    icon: 'aliyun.png',
    note: '仅支持以 NS 方式接入阿里云 ESA 的域名',
    config: {
      AccessKeyId: { name: 'AccessKeyId', type: 'input', required: true },
      AccessKeySecret: { name: 'AccessKeySecret', type: 'input', required: true },
      region: {
        name: 'API接入点',
        type: 'select',
        options: [
          { value: 'cn-hangzhou', label: '中国内地' },
          { value: 'ap-southeast-1', label: '非中国内地' },
        ],
        value: 'cn-hangzhou',
        required: true,
      },
      proxy: proxyField,
    },
    remark: 2, status: false, redirect: false, log: false, weight: false, page: false, add: false, sort: false,
    implemented: true,
  },
  tencenteo: {
    name: '腾讯云 EdgeOne',
    icon: 'tencent.png',
    note: '仅支持以 NS 方式接入腾讯云 EdgeOne 的域名',
    config: {
      SecretId: { name: 'SecretId', type: 'input', required: true },
      SecretKey: { name: 'SecretKey', type: 'input', required: true },
      site_type: {
        name: 'API接入点',
        type: 'select',
        options: [
          { value: 'cn', label: '中国内地' },
          { value: 'intl', label: '非中国内地' },
        ],
        value: 'cn',
        required: true,
      },
      proxy: proxyField,
    },
    remark: 0, status: true, redirect: false, log: false, weight: true, page: false, add: false, sort: true,
    implemented: true,
  },
  dnsla: {
    name: 'DNSLA',
    icon: 'dnsla.ico',
    config: {
      apiid: { name: 'APIID', type: 'input', required: true },
      apisecret: { name: 'API密钥', type: 'input', required: true },
      proxy: proxyField,
    },
    remark: 0, status: true, redirect: true, log: false, weight: true, page: false, add: true, sort: false,
    implemented: true,
  },
  qingcloud: {
    name: '青云',
    icon: 'qingcloud.ico',
    config: {
      access_key_id: { name: 'Access Key ID', type: 'input', required: true },
      secret_access_key: { name: 'Secret Access Key', type: 'input', required: true },
      proxy: proxyField,
    },
    remark: 0, status: true, redirect: false, log: false, weight: true, page: false, add: false, sort: false,
    implemented: true,
  },
  bt: {
    name: '宝塔域名',
    icon: 'bt.png',
    config: {
      AccessKey: { name: 'Access Key', type: 'input', required: true },
      SecretKey: { name: 'Secret Key', type: 'input', required: true },
      AccountID: { name: 'Account ID', type: 'input', required: true },
      proxy: proxyField,
    },
    remark: 2, status: true, redirect: false, log: false, weight: true, page: false, add: true, sort: false,
    implemented: true,
  },
  namesilo: {
    name: 'NameSilo',
    icon: 'namesilo.ico',
    config: {
      username: { name: '账户名', type: 'input', required: true },
      apikey: { name: 'API Key', type: 'input', required: true },
      proxy: proxyField,
    },
    remark: 0, status: false, redirect: false, log: false, weight: false, page: true, add: false, sort: false,
    implemented: true,
  },
  henet: {
    name: 'HE DNS',
    icon: 'he.ico',
    config: {
      username: { name: '用户名/邮箱', type: 'input', required: true },
      password: { name: '密码', type: 'input', required: true },
      proxy: proxyField,
    },
    remark: 0, status: false, redirect: false, log: false, weight: false, page: true, add: false, sort: false,
    implemented: true,
  },
  spaceship: {
    name: 'Spaceship',
    icon: 'spaceship.ico',
    config: {
      apikey: { name: 'API Key', type: 'input', required: true },
      apisecret: { name: 'API Secret', type: 'input', required: true },
      proxy: proxyField,
    },
    remark: 0, status: false, redirect: true, log: false, weight: false, page: false, add: false, sort: false,
    implemented: true,
  },
  dnsmgr: {
    name: '同系统对接',
    icon: 'logo.png',
    note: '对接其他聚合DNS管理系统站点',
    config: {
      base_url: { name: '站点地址', type: 'input', placeholder: '例如：https://dns.example.com', required: true },
      uid: { name: '用户 ID', type: 'input', placeholder: '数字用户 ID（非用户名），见目标站点用户管理', required: true },
      key: { name: 'API 密钥', type: 'input', placeholder: '目标站点该用户开启 API 权限后的密钥', required: true },
      proxy: proxyField,
    },
    remark: 2, status: true, redirect: true, log: false, weight: true, page: false, add: false, sort: false,
    implemented: true,
  },
  goedge: {
    name: 'GoEdge智能DNS',
    icon: 'logo.png',
    note: '需要填写GoEdge HTTP API节点地址，不是管理后台地址或gRPC地址',
    config: {
      base_url: { name: 'API节点地址', type: 'input', placeholder: '例如：https://api.example.com:8004', required: true },
      accessKeyId: { name: 'AccessKey ID', type: 'input', required: true },
      accessKey: { name: 'AccessKey', type: 'input', required: true },
      type: { name: 'AccessKey类型', type: 'radio', options: { admin: '管理员', user: '用户' }, value: 'admin' },
      nsClusterId: { name: 'DNS集群ID', type: 'input', placeholder: '例如：1', required: true },
      userId: { name: 'GoEdge用户ID（可选）', type: 'input', placeholder: '留空表示不指定用户' },
      proxy: proxyField,
    },
    remark: 2, status: true, redirect: false, log: false, weight: true, page: false, add: true, sort: false,
    implemented: true,
  },
  dynv6: {
    name: 'dynv6',
    icon: 'dynv6.ico',
    config: {
      token: { name: 'API Token', type: 'input', required: true },
      proxy: proxyField,
    },
    remark: 0, status: false, redirect: false, log: false, weight: false, page: false, add: false, sort: false,
    implemented: true,
  },
  technitium: {
    name: 'Technitium',
    icon: 'technitium.png',
    config: {
      url: { name: 'Server URL', type: 'input', placeholder: 'http://127.0.0.1:5380', required: true },
      token: { name: 'API Token', type: 'input', required: true },
      proxy: proxyField,
    },
    remark: 2, status: true, redirect: false, log: false, weight: false, page: true, add: true, sort: false,
    implemented: true,
  },
};

const providerMap: Record<string, new (config: Record<string, any>) => DnsProvider> = {
  aliyun: AliyunDns,
  dnspod: Dnspod,
  cloudflare: CloudflareDns,
  huawei: HuaweiDns,
  baidu: BaiduDns,
  huoshan: HuoshanDns,
  jdcloud: JdcloudDns,
  west: WestDns,
  powerdns: PowerDns,
  aliyunesa: AliyunEsaDns,
  tencenteo: TencentEoDns,
  dnsla: Dnsla,
  qingcloud: QingcloudDns,
  bt: BtDns,
  namesilo: NamesiloDns,
  henet: HenetDns,
  spaceship: SpaceshipDns,
  dnsmgr: DnsmgrDns,
  goedge: GoEdgeDns,
  dynv6: Dynv6Dns,
  technitium: TechnitiumDns,
};

export function getDnsProvider(
  type: string,
  config: Record<string, any>,
  domain: string,
  domainid: string | null,
): DnsProvider | false {
  const Ctor = providerMap[type];
  if (!Ctor) return false;
  const merged = { ...config, domain, domainid: domainid || '' };
  return new Ctor(merged);
}

export function getProviderList() {
  return dnsProviders;
}