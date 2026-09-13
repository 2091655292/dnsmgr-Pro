<template>
  <div>
    <n-card :bordered="false" size="small">
      <div class="info-row">
        <n-button quaternary circle size="small" @click="$router.back()"><template #icon><n-icon :component="ArrowBackOutline" /></template></n-button>
        <span class="domain-name">{{ info?.name }}</span>
        <n-space>
          <n-tag size="small">{{ info?.routename || info?.route }}</n-tag>
          <n-tag size="small" :type="info?.status === 'offline' ? 'default' : 'success'">状态：{{ info?.status }}</n-tag>
        </n-space>
      </div>
      <div class="info-row" style="margin-top:6px">
        <span class="cname">CNAME：{{ info?.cname || '暂无' }}</span>
      </div>
    </n-card>

    <n-space vertical :size="12" style="margin-top:12px">
      <n-card title="域名状态" size="small" :bordered="false">
        <n-space>
          <n-button type="success" size="small" @click="setStatus('online')">启用</n-button>
          <n-button type="warning" size="small" @click="setStatus('offline')">停用</n-button>
        </n-space>
      </n-card>

      <n-card title="回源配置" size="small" :bordered="false">
        <n-form label-placement="left" label-width="90">
          <n-form-item label="源站地址">
            <n-input v-model:value="originForm.origin" placeholder="IP 或域名，多个用分号间隔" />
          </n-form-item>
          <n-form-item label="源站类型">
            <n-radio-group v-model:value="originForm.origin_type">
              <n-radio value="ipaddr">IP 源站</n-radio>
              <n-radio value="domain">域名源站</n-radio>
            </n-radio-group>
          </n-form-item>
          <n-form-item label="回源 Host">
            <n-input v-model:value="originForm.origin_host" placeholder="可留空" />
          </n-form-item>
          <n-form-item label="回源协议">
            <n-select v-model:value="originForm.origin_protocol" :options="protoOptions" style="width:200px" />
          </n-form-item>
          <n-form-item label="回源端口">
            <n-space>
              <n-input-number v-model:value="originForm.http_port" :min="1" style="width:120px" placeholder="HTTP" />
              <n-input-number v-model:value="originForm.https_port" :min="1" style="width:120px" placeholder="HTTPS" />
            </n-space>
          </n-form-item>
          <n-button type="primary" size="small" @click="saveOrigin">保存回源配置</n-button>
        </n-form>
      </n-card>

      <n-card title="缓存规则" size="small" :bordered="false">
        <n-space vertical size="small">
          <div v-for="(rule, idx) in cacheForm.rules" :key="idx" class="rule-row">
            <n-input v-model:value="rule.path" placeholder="* 全部 / .jpg 后缀 / /dir/ 目录 / /a.png 路径" />
            <n-input-number v-model:value="rule.ttl" :min="0" style="width:140px" placeholder="TTL 秒" />
            <n-button size="small" @click="removeRule(idx)">删除</n-button>
          </div>
          <n-space>
            <n-button size="small" dashed @click="addRule">添加规则</n-button>
            <n-button type="primary" size="small" :loading="savingCache" @click="saveCache">保存缓存规则</n-button>
          </n-space>
          <n-text depth="3" style="font-size: 12px">TTL 单位为秒；0 表示不缓存；「*」表示全部文件。部分服务商规则生效约需数分钟。</n-text>
        </n-space>
      </n-card>

      <n-card title="HTTPS 配置" size="small" :bordered="false">
        <n-space vertical size="small">
          <n-space align="center">
            <span style="width:120px">开启 HTTPS</span>
            <n-switch v-model:value="httpsForm.https_enabled" />
          </n-space>
          <n-space align="center">
            <span style="width:120px">强制跳转 HTTPS</span>
            <n-switch v-model:value="httpsForm.force_redirect" :disabled="!httpsForm.https_enabled" />
          </n-space>
          <n-button type="primary" size="small" :loading="savingHttps" @click="saveHttps">保存 HTTPS 配置</n-button>
          <n-text depth="3" style="font-size: 12px">关闭 HTTPS 将停止强制跳转；HTTPS 证书由服务商分配/在云端配置。</n-text>
        </n-space>
      </n-card>

      <n-card title="访问控制" size="small" :bordered="false">
        <n-form label-placement="left" label-width="110">
          <n-form-item label="防盗链 Referer">
            <n-radio-group v-model:value="accessForm.referer_mode">
              <n-radio value="off">关闭</n-radio>
              <n-radio value="whitelist">白名单</n-radio>
              <n-radio value="blacklist">黑名单</n-radio>
            </n-radio-group>
            <n-dynamic-tags
              v-if="accessForm.referer_mode !== 'off'"
              v-model:value="accessForm.referer_list"
              style="margin-top:8px"
            />
            <n-text v-if="accessForm.referer_mode !== 'off'" depth="3" style="font-size:12px">输入域名或空值允许，如 *.example.com（回车确认）</n-text>
          </n-form-item>
          <n-form-item label="IP 黑白名单">
            <n-radio-group v-model:value="accessForm.ip_mode">
              <n-radio value="off">关闭</n-radio>
              <n-radio value="whitelist">白名单</n-radio>
              <n-radio value="blacklist">黑名单</n-radio>
            </n-radio-group>
            <n-dynamic-input
              v-if="accessForm.ip_mode !== 'off'"
              v-model:value="accessForm.ip_list"
              placeholder="1.2.3.4 或 1.2.3.0/24"
              style="margin-top:8px"
              type="input"
            />
          </n-form-item>
          <n-form-item label="UA 黑名单">
            <n-dynamic-tags v-model:value="accessForm.ua_list" style="margin-top:8px" />
            <n-text depth="3" style="font-size:12px">命中这些 User-Agent 的请求将被拦截（留空则关闭）</n-text>
          </n-form-item>
          <n-button type="primary" size="small" :loading="savingAccess" @click="saveAccess">保存访问控制</n-button>
        </n-form>
      </n-card>
    </n-space>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useMessage } from 'naive-ui';
import { ArrowBackOutline } from '@vicons/ionicons5';
import { api } from '../api';

const route = useRoute();
const message = useMessage();
const domainId = Number(route.params.id);

const info = ref<any>(null);
const cacheRules = ref<any[]>([]);
const savingCache = ref(false);
const savingHttps = ref(false);
const savingAccess = ref(false);

const protoOptions = [
  { label: '跟随', value: 'follow' },
  { label: 'HTTP', value: 'http' },
  { label: 'HTTPS', value: 'https' },
];

const originForm = reactive<any>({ origin: '', origin_type: 'ipaddr', origin_host: '', origin_protocol: 'follow', http_port: 80, https_port: 443 });
const httpsForm = reactive<any>({ https_enabled: false, force_redirect: false });
const cacheForm = reactive<{ rules: { path: string; ttl: number }[] }>({ rules: [] });
const accessForm = reactive<any>({
  referer_mode: 'off',
  referer_list: [],
  ip_mode: 'off',
  ip_list: [],
  ua_list: [],
});

async function load() {
  const res = await api<any>('GET', `/cdn/domains/${domainId}`);
  if (res.code !== 0) {
    message.error(res.msg);
    return;
  }
  const { info: _info, cacheRules: _rules } = res.data;
  info.value = _info;
  cacheRules.value = _rules || [];
  Object.assign(originForm, {
    origin: _info.origin || '',
    origin_type: _info.origin_type || 'ipaddr',
    origin_host: _info.origin_host || '',
    origin_protocol: _info.origin_protocol || 'follow',
    http_port: _info.http_port || 80,
    https_port: _info.https_port || 443,
  });
  httpsForm.https_enabled = !!_info.https_enabled;
  httpsForm.force_redirect = !!_info.force_redirect;
  cacheForm.rules = (_rules || []).map((r: any) => ({ path: r.path, ttl: Number(r.ttl || 0) }));
  loadAccess();
}

async function loadAccess() {
  const res = await api<any>('GET', `/cdn/domains/${domainId}/access`).catch(() => ({ code: -1, data: null }));
  if (res.code === 0 && res.data) {
    Object.assign(accessForm, res.data);
  }
}

function addRule() {
  cacheForm.rules.push({ path: '', ttl: 0 });
}
function removeRule(idx: number) {
  cacheForm.rules.splice(idx, 1);
}

async function saveCache() {
  savingCache.value = true;
  try {
    const rules = cacheForm.rules.filter((r) => (r.path || '').trim() !== '');
    const res = await api('POST', `/cdn/domains/${domainId}/cache`, { rules });
    if (res.code === 0) {
      message.success(res.msg);
      load();
    } else message.error(res.msg);
  } finally {
    savingCache.value = false;
  }
}

async function saveHttps() {
  savingHttps.value = true;
  try {
    const res = await api('POST', `/cdn/domains/${domainId}/https`, {
      https_enabled: httpsForm.https_enabled,
      force_redirect: httpsForm.force_redirect,
    });
    if (res.code === 0) {
      message.success(res.msg);
      load();
    } else message.error(res.msg);
  } finally {
    savingHttps.value = false;
  }
}

async function saveAccess() {
  savingAccess.value = true;
  try {
    const res = await api('POST', `/cdn/domains/${domainId}/access`, accessForm);
    if (res.code === 0) {
      message.success(res.msg);
      loadAccess();
    } else message.error(res.msg);
  } finally {
    savingAccess.value = false;
  }
}

async function setStatus(status: string) {
  const res = await api('POST', `/cdn/domains/${domainId}/status`, { status });
  if (res.code === 0) {
    message.success(res.msg);
    load();
  } else message.error(res.msg);
}

async function saveOrigin() {
  if (!originForm.origin) return message.warning('源站不能为空');
  const res = await api('POST', `/cdn/domains/${domainId}/origin`, originForm);
  if (res.code === 0) {
    message.success(res.msg);
    load();
  } else message.error(res.msg);
}

onMounted(load);
</script>

<style scoped>
.info-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.domain-name {
  font-weight: 600;
  font-size: 16px;
}
.cname {
  color: #999;
  font-size: 13px;
}
.rule-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rule-row .n-input {
  flex: 1;
}
</style>