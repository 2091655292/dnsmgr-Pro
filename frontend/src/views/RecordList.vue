<template>
  <div>
    <n-card :bordered="false">
      <template #header>
        <div class="toolbar">
          <n-space align="center">
            <n-button quaternary circle @click="$router.back()">
              <template #icon><n-icon :component="ArrowBackOutline" /></template>
            </n-button>
            <span class="title">解析记录 · {{ domainName || '域名 #' + domainId }}</span>
          </n-space>
          <n-space>
            <n-button v-if="accountType === 'cloudflare' && isAdmin" size="small" type="info" @click="router.push(`/cloudflare/domains/${domainId}/hostnames`)">自定义主机名</n-button>
            <n-button type="primary" @click="openAdd">
              <template #icon><n-icon :component="AddOutline" /></template>
              添加记录
            </n-button>
          </n-space>
        </div>
      </template>
      <n-data-table :columns="columns" :data="records" :loading="loading" :pagination="pagination" :bordered="false" />
      <n-empty class="list-empty" v-if="!loading && !records.length" description="暂无解析记录" />
    </n-card>

    <n-modal v-model:show="showEdit" preset="card" :title="editingId ? '修改记录' : '添加记录'" style="max-width:640px" :mask-closable="false">
      <n-form label-placement="left" label-width="90">
        <n-form-item label="主机记录">
          <n-input v-model:value="form.name" placeholder="如 www、@（根域名）" />
        </n-form-item>
        <n-form-item label="记录类型">
          <n-select v-model:value="form.type" :options="typeOptions" />
        </n-form-item>
        <n-form-item label="记录值">
          <n-input v-model:value="form.value" placeholder="IP 或域名" />
        </n-form-item>
        <n-form-item label="线路">
          <n-select v-model:value="form.line" :options="lineOptions" filterable placeholder="默认线路" />
        </n-form-item>
        <n-form-item label="TTL">
          <n-input-number v-model:value="form.ttl" :min="1" style="width:100%" />
        </n-form-item>
        <n-form-item v-if="form.type === 'MX'" label="优先级">
          <n-input-number v-model:value="form.mx" :min="0" style="width:100%" />
        </n-form-item>
      </n-form>
      <template #footer>
        <n-space justify="end">
          <n-button @click="showEdit = false">取消</n-button>
          <n-button type="primary" :loading="saving" @click="saveRecord">保存</n-button>
        </n-space>
      </template>
    </n-modal>

    <n-modal v-model:show="showValue" preset="card" title="记录值" style="max-width:560px">
      <n-input type="textarea" :value="valueDetail" :autosize="{ minRows: 2, maxRows: 10 }" readonly />
      <template #footer>
        <n-space justify="end">
          <n-button @click="showValue = false">关闭</n-button>
          <n-button type="primary" @click="copyValue">复制</n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { computed, h, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NButton, NSpace, NTag, useMessage, useDialog } from 'naive-ui';
import { ArrowBackOutline, AddOutline } from '@vicons/ionicons5';
import { api, getUser } from '../api';

const route = useRoute();
const router = useRouter();
const message = useMessage();
const dialog = useDialog();
const domainId = Number(route.params.id);
const domainName = ref('');
const accountType = ref('');
const isAdmin = computed(() => (getUser()?.level || 0) >= 2);

const loading = ref(false);
const records = ref<any[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const lines = ref<Record<string, string>>({});

const showEdit = ref(false);
const editingId = ref<string | null>(null);
const saving = ref(false);
const form = reactive<any>({ name: '', type: 'A', value: '', line: 'default', ttl: 600, mx: 1 });

const showValue = ref(false);
const valueDetail = ref('');

const pagination = computed(() => ({
  page: page.value,
  pageSize: pageSize.value,
  itemCount: total.value,
  onChange: (p: number) => {
    page.value = p;
    loadRecords();
  },
}));

const typeOptions = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA', 'REDIRECT_URL', 'FORWARD_URL'].map((t) => ({ label: t, value: t }));

const lineOptions = computed(() =>
  Object.entries(lines.value).map(([name, code]) => ({ label: name, value: code })),
);

const columns = [
  { title: '主机记录', key: 'Name', width: 160 },
  { title: '类型', key: 'Type', width: 90 },
  {
    title: '记录值',
    key: 'Value',
    width: 90,
    render(row: any) {
      return h(NButton, { text: true, size: 'tiny', type: 'primary', onClick: () => openValue(row.Value) }, { default: () => '查看' });
    },
  },
  { title: '线路', key: 'Line', width: 90 },
  { title: 'TTL', key: 'TTL', width: 80 },
  {
    title: '状态',
    key: 'Status',
    width: 80,
    render(row: any) {
      return h(NTag, { type: row.Status === '1' ? 'success' : 'default', size: 'small' }, { default: () => (row.Status === '1' ? '启用' : '暂停') });
    },
  },
  {
    title: '操作',
    key: 'actions',
    width: 200,
    render(row: any) {
      return h(NSpace, null, {
        default: () => [
          h(NButton, { size: 'tiny', onClick: () => toggleStatus(row) }, { default: () => (row.Status === '1' ? '暂停' : '启用') }),
          h(NButton, { size: 'tiny', type: 'primary', onClick: () => openEdit(row) }, { default: () => '编辑' }),
          h(NButton, { size: 'tiny', type: 'error', onClick: () => delRecord(row) }, { default: () => '删除' }),
        ],
      });
    },
  },
];

async function loadRecords() {
  loading.value = true;
  const res = await api<any>('GET', `/domains/${domainId}/records`, { page: page.value, pagesize: pageSize.value });
  if (res.code === 0) {
    records.value = res.data.list;
    total.value = res.data.total;
    domainName.value = res.data.list?.[0]?.Domain || '';
  } else {
    message.error(res.msg);
  }
  loading.value = false;
}

async function loadLines() {
  const res = await api<any>('GET', `/domains/${domainId}/lines`);
  if (res.code === 0) lines.value = res.data;
}

async function loadDomainInfo() {
  const res = await api<any>('GET', '/domains');
  if (res.code === 0) {
    const d = res.data.find((x: any) => x.id === domainId);
    if (d) {
      domainName.value = d.name;
      accountType.value = d.account_type || '';
    }
  }
}

function openValue(value: any) {
  valueDetail.value = String(value ?? '');
  showValue.value = true;
}

async function copyValue() {
  try {
    await navigator.clipboard.writeText(valueDetail.value);
    message.success('已复制');
  } catch {
    message.error('复制失败，请手动复制');
  }
}

function openAdd() {
  editingId.value = null;
  Object.assign(form, { name: '', type: 'A', value: '', line: 'default', ttl: 600, mx: 1 });
  showEdit.value = true;
}

function openEdit(row: any) {
  editingId.value = row.RecordId;
  Object.assign(form, { name: row.Name, type: row.Type, value: row.Value, line: row.Line, ttl: row.TTL, mx: row.MX ?? 1 });
  showEdit.value = true;
}

async function saveRecord() {
  if (!form.name || !form.value) return message.warning('请填写主机记录和记录值');
  saving.value = true;
  const body = { ...form };
  const res = editingId.value
    ? await api('PUT', `/domains/${domainId}/records/${editingId.value}`, body)
    : await api('POST', `/domains/${domainId}/records`, body);
  saving.value = false;
  if (res.code === 0) {
    message.success(res.msg);
    showEdit.value = false;
    loadRecords();
  } else message.error(res.msg);
}

async function toggleStatus(row: any) {
  const target = row.Status === '1' ? '0' : '1';
  const res = await api('POST', `/domains/${domainId}/records/${row.RecordId}/status`, { status: target });
  if (res.code === 0) {
    message.success(res.msg);
    loadRecords();
  } else message.error(res.msg);
}

function delRecord(row: any) {
  dialog.warning({
    title: '删除记录',
    content: `确定删除记录 ${row.Name}.${domainName.value || ''} 吗？`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      const res = await api('DELETE', `/domains/${domainId}/records/${row.RecordId}`);
      if (res.code === 0) {
        message.success('删除成功');
        loadRecords();
      } else message.error(res.msg);
    },
  });
}

onMounted(() => {
  loadRecords();
  loadLines();
  loadDomainInfo();
});
</script>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.title {
  font-size: 16px;
  font-weight: 600;
}
</style>