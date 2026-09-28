import type { EchoParseState } from '../../src/daemon/adapters/echo.js';

export function newEchoState(): EchoParseState {
  return { errors: [], visible: 0, sawResult: false };
}
