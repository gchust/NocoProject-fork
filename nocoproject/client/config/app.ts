import { defineAppConfig, type AppConfigFactory } from '@nocobase/app-client';

const app: AppConfigFactory<{ title: string }> = defineAppConfig(
  (_runtime) => ({
    title: 'NocoProject',
  }),
);
export default app;
