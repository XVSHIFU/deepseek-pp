import type { HarnessBridgeCoordinator } from '../../core/harness-bridge/coordinator';
import { decodeDeepSeekRuntimePayload } from '../../core/messaging/deepseek-runtime-request-codec';
import {
  definePayloadlessRuntimeCommandHandler,
  defineRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from '../../core/messaging/runtime-command-registry';

export interface HarnessBridgeRuntimeHandlerDependencies {
  readonly coordinator: Pick<HarnessBridgeCoordinator, 'getStatus' | 'updateSettings'>;
}

export function createHarnessBridgeRuntimeHandlers(
  dependencies: HarnessBridgeRuntimeHandlerDependencies,
): readonly RuntimeCommandHandler[] {
  return Object.freeze([
    definePayloadlessRuntimeCommandHandler('GET_HARNESS_BRIDGE_STATUS', (context) => {
      if (context.surface !== 'extension_context') return extensionContextRequired();
      return dependencies.coordinator.getStatus();
    }),
    defineRuntimeCommandHandler({
      type: 'UPDATE_HARNESS_BRIDGE_SETTINGS',
      decode: (message) => decodeDeepSeekRuntimePayload(
        'UPDATE_HARNESS_BRIDGE_SETTINGS',
        message.payload,
      ),
      handle: (patch, context) => {
        if (context.surface !== 'extension_context') return extensionContextRequired();
        return dependencies.coordinator.updateSettings(patch);
      },
    }),
  ]);
}

function extensionContextRequired() {
  return Object.freeze({
    ok: false as const,
    error: 'harness_bridge_extension_context_required',
  });
}
