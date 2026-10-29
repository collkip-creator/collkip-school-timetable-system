import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.collkip.teacher',
  appName: 'Collkip Teacher',
  webDir: 'dist-mobile',
  bundledWebRuntime: false,
  android: {
    allowMixedContent: false,
  },
};

export default config;
