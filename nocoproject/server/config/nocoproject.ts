import {
  defineAppConfig,
  envInteger,
  envString,
  type AppConfigFactory,
} from '@nocobase/app-server/config';

/**
 * NocoProject's own configuration section (docs/phase1/iteration-2-contract.md §B). `secretKey` encrypts stored
 * secrets (GitHub token, webhook secret, agent environment variables); see `server/modules/shared/crypto.ts`. Set it
 * with `NOCOPROJECT_SECRET_KEY` (64 hex characters or base64 of 32 bytes) or `nocoproject.secretKey` in config.yml.
 * Without it a development key is derived from `auth.secret` and a warning is logged.
 *
 * NP-78 issue attachments: `attachmentDisk` is the Drive disk new uploads go to (`server/config/drive.ts`; each file
 * row remembers its own disk, so switching to an S3-compatible OSS disk later keeps old files readable);
 * `attachmentMaxFileSize` (bytes) bounds one upload request (one file).
 */
export interface NocoProjectConfig {
  readonly secretKey?: string;
  readonly attachmentDisk?: string;
  readonly attachmentMaxFileSize?: number;
}

const nocoproject: AppConfigFactory<NocoProjectConfig> = defineAppConfig({
  env: {
    NOCOPROJECT_SECRET_KEY: envString('secretKey'),
    NOCOPROJECT_ATTACHMENT_DISK: envString('attachmentDisk'),
    NOCOPROJECT_ATTACHMENT_MAX_FILE_SIZE: envInteger('attachmentMaxFileSize'),
  },
  defaults: () => ({}),
});

export default nocoproject;
