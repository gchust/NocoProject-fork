import type { RuntimeTypeCopy } from '@/components/np-runtime-type-copy';

import { errorDetailList, runtimeTypeErrorOf } from '../api-runtime-types.js';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * The sentence for an agent save the server refused over its type (NP-219 §5 error codes), or null when the error is
 * not one of them. `copy` is the agent's type, for the names in the sentence.
 */
export function agentTypeErrorMessage(
  t: Translate,
  error: unknown,
  copy: RuntimeTypeCopy,
): string | null {
  const code = runtimeTypeErrorOf(error);
  switch (code) {
    case 'INVALID_RUNTIME_TYPE':
    case 'RUNTIME_TYPE_IMMUTABLE':
    case 'INVALID_MODEL':
    case 'BUILTIN_RUNTIME_UNAVAILABLE':
      return t(`np.agentType.errors.${code}`);
    case 'RUNTIME_TYPE_MISMATCH':
      return t('np.agentType.errors.RUNTIME_TYPE_MISMATCH', {
        runtimeName: copy.runtimeName,
      });
    case 'CAPABILITY_NOT_FOR_RUNTIME_TYPE':
      return t('np.agentType.errors.CAPABILITY_NOT_FOR_RUNTIME_TYPE', {
        name: copy.name,
        capabilities: errorDetailList(error, 'capabilities')
          .map((key) => t(`np.capabilities.${key.replaceAll('.', '_')}`))
          .join(', '),
      });
    default:
      return null;
  }
}
