<template>
  <n-layout has-sider position="absolute">
    <!-- 桌面端侧边栏 -->
    <n-layout-sider
      v-if="!isMobile"
      bordered
      collapse-mode="width"
      :collapsed-width="64"
      :width="220"
      :collapsed="collapsed"
      show-trigger
      @collapse="collapsed = true"
      @expand="collapsed = false"
    >
      <div class="logo" @click="$router.push('/dashboard')">
        <n-icon size="22" :component="GlobeOutline" color="#3b6df0" />
        <span v-if="!collapsed" class="logo-text">聚合 DNS</span>
      </div>
      <n-menu :value="activeKey" :collapsed="collapsed" :collapsed-width="64" :options="menuOptions" @update:value="onMenu" />
    </n-layout-sider>

    <!-- 移动端抽屉 -->
    <n-drawer v-if="isMobile" v-model:show="drawerShow" placement="left" :width="220">
      <n-drawer-content :native-scrollbar="false" body-content-style="padding:0">
        <div class="logo">
          <n-icon size="22" :component="GlobeOutline" color="#3b6df0" />
          <span class="logo-text">聚合 DNS</span>
        </div>
        <n-menu :value="activeKey" :options="menuOptions" @update:value="onMenu" />
      </n-drawer-content>
    </n-drawer>

    <n-layout class="main-layout">
      <n-layout-header bordered class="header">
        <div class="header-left">
          <n-button v-if="isMobile" quaternary circle @click="drawerShow = true">
            <template #icon><n-icon :component="MenuOutline" /></template>
          </n-button>
          <span class="page-title">{{ pageTitle }}</span>
        </div>
        <div class="header-right">
          <n-dropdown :options="userOptions" @select="onUserSelect">
            <n-button quaternary>
              <template #icon><n-icon :component="PersonOutline" /></template>
              {{ user?.username || '用户' }}
            </n-button>
          </n-dropdown>
        </div>
      </n-layout-header>
      <n-layout-content class="content" :native-scrollbar="false">
        <router-view />
      </n-layout-content>
    </n-layout>
  </n-layout>
</template>

<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NIcon } from 'naive-ui';
import { GlobeOutline, MenuOutline, PersonOutline, ServerOutline, CloudOutline, SpeedometerOutline, LinkOutline, ShieldCheckmarkOutline, RocketOutline, PulseOutline, SwapHorizontalOutline, FlashOutline, TimeOutline, SettingsOutline, PeopleOutline, DocumentTextOutline, BarChartOutline } from '@vicons/ionicons5';
import { useAuthStore } from '../stores/auth';
import { clearToken } from '../api';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const user = computed(() => auth.user);

const collapsed = ref(false);
const isMobile = ref(false);
const drawerShow = ref(false);

const menuOptions = [
  { label: '仪表盘', key: 'dashboard', icon: () => h(NIcon, null, { default: () => h(SpeedometerOutline) }) },
  { label: '域名管理', key: 'domains', icon: () => h(NIcon, null, { default: () => h(ServerOutline) }) },
  { label: 'DNS 账户', key: 'dns-accounts', icon: () => h(NIcon, null, { default: () => h(LinkOutline) }) },
  { label: 'CDN 账户', key: 'cdn-accounts', icon: () => h(NIcon, null, { default: () => h(CloudOutline) }) },
  { label: 'CDN 域名', key: 'cdn-domains', icon: () => h(NIcon, null, { default: () => h(GlobeOutline) }) },
  { label: '数据统计', key: 'statistics', icon: () => h(NIcon, null, { default: () => h(BarChartOutline) }) },
  { label: '证书账户', key: 'cert-accounts', icon: () => h(NIcon, null, { default: () => h(ShieldCheckmarkOutline) }) },
  { label: '证书订单', key: 'cert-orders', icon: () => h(NIcon, null, { default: () => h(ShieldCheckmarkOutline) }) },
  { label: '部署账户', key: 'deploy-accounts', icon: () => h(NIcon, null, { default: () => h(RocketOutline) }) },
  { label: '部署任务', key: 'deploy-tasks', icon: () => h(NIcon, null, { default: () => h(RocketOutline) }) },
  { label: '容灾监控', key: 'dm-overview', icon: () => h(NIcon, null, { default: () => h(PulseOutline) }) },
  { label: '切换策略', key: 'dm-tasks', icon: () => h(NIcon, null, { default: () => h(SwapHorizontalOutline) }) },
  { label: '优选IP任务', key: 'optimize-tasks', icon: () => h(NIcon, null, { default: () => h(FlashOutline) }) },
  { label: '定时切换策略', key: 'schedule-tasks', icon: () => h(NIcon, null, { default: () => h(TimeOutline) }) },
  { label: '系统设置', key: 'system-settings', icon: () => h(NIcon, null, { default: () => h(SettingsOutline) }) },
  { label: '用户管理', key: 'users', icon: () => h(NIcon, null, { default: () => h(PeopleOutline) }) },
  { label: '操作日志', key: 'logs', icon: () => h(NIcon, null, { default: () => h(DocumentTextOutline) }) },
];

const activeKey = computed(() => {
  if (route.path.startsWith('/domains')) return 'domains';
  if (route.path.startsWith('/dns-accounts')) return 'dns-accounts';
  if (route.path.startsWith('/cdn-accounts')) return 'cdn-accounts';
  if (route.path.startsWith('/cdn-domains')) return 'cdn-domains';
  if (route.path.startsWith('/statistics')) return 'statistics';
  if (route.path.startsWith('/cert-accounts')) return 'cert-accounts';
  if (route.path.startsWith('/cert-orders')) return 'cert-orders';
  if (route.path.startsWith('/deploy-accounts')) return 'deploy-accounts';
  if (route.path.startsWith('/deploy-tasks')) return 'deploy-tasks';
  if (route.path.startsWith('/dm-overview')) return 'dm-overview';
  if (route.path.startsWith('/dm-tasks')) return 'dm-tasks';
  if (route.path.startsWith('/optimize')) return 'optimize-tasks';
  if (route.path.startsWith('/schedule-tasks')) return 'schedule-tasks';
  if (route.path.startsWith('/system-settings')) return 'system-settings';
  if (route.path.startsWith('/users')) return 'users';
  if (route.path.startsWith('/logs')) return 'logs';
  return 'dashboard';
});

const pageTitle = computed(() => (route.meta.title as string) || '聚合 DNS');

const userOptions = [
  { label: '安全设置（TOTP）', key: 'totp' },
  { label: '退出登录', key: 'logout' },
];

function onMenu(key: string) {
  drawerShow.value = false;
  router.push('/' + key);
}
function onUserSelect(key: string) {
  if (key === 'totp') {
    router.push('/totp');
  } else if (key === 'logout') {
    clearToken();
    auth.logout();
    router.push('/login');
  }
}

function checkMobile() {
  isMobile.value = window.innerWidth < 768;
}
onMounted(() => {
  checkMobile();
  window.addEventListener('resize', checkMobile);
});
onBeforeUnmount(() => window.removeEventListener('resize', checkMobile));
</script>

<style scoped>
.logo {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px 20px;
  cursor: pointer;
  font-weight: 600;
  font-size: 16px;
}
.logo-text {
  white-space: nowrap;
}
.main-layout {
  min-height: 100vh;
}
.header {
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
}
.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}
.page-title {
  font-size: 16px;
  font-weight: 600;
}
.content {
  padding: 16px;
  height: calc(100vh - 56px);
}
</style>