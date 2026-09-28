import pkg from '../package.json' with { type: 'json' };
import { PROTOCOL_VERSION } from './protocol.js';

export const CLI_VERSION: string = pkg.version;
export { PROTOCOL_VERSION };
