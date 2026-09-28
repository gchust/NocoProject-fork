import { defineCliPlugins, type AppCliPlugins } from '@nocobase/app-cli';
import scheduler from '@nocobase/app-plugin-scheduler/cli';
import workflow from '@nocobase/app-plugin-workflow/cli';

import nocoprojectBuild from './nocoproject-build.js';

// Array order is command registration order. A plugin contributes its commands
// by appearing in this list; removing its entry and its import removes them.
// `nocoprojectBuild` is the application's own build hook (packs the CLI installer), not a package.
const cliPlugins: AppCliPlugins = defineCliPlugins([
  workflow,
  scheduler,
  nocoprojectBuild,
]);

export default cliPlugins;
