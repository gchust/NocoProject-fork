import { defineCliPlugin, type AppCliPlugin } from '@nocobase/app-cli';

// Not a published plugin: build hooks can only be declared by a CLI plugin, so the application declares this one for
// its own build. It packs the daemon/CLI into dist/client/assets/cli/ after the client build, so every built
// application serves the installer the "connect a computer" page points at (scripts/pack-cli.sh).
const nocoprojectBuild: AppCliPlugin = defineCliPlugin({
  packageName: '@nocoproject/cli-installer',
  description: 'Packs the NocoProject CLI installer into the build.',
  buildHooks: {
    afterClientBuild: [
      {
        label: 'Pack nocoproject-cli',
        command: ['bash', 'scripts/pack-cli.sh'],
      },
    ],
  },
});

export default nocoprojectBuild;
