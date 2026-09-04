import type { RuntimeCommandHandler } from '../../core/messaging/runtime-command-registry';
import {
  createChatRuntimeHandlers,
  type ChatRuntimeHandlerDependencies,
} from './chat-handlers';
import {
  createConversationExportRuntimeHandlers,
  type ConversationExportRuntimeHandlerDependencies,
} from './conversation-export-handlers';
import {
  createDeepSeekAuthRuntimeHandlers,
  type DeepSeekAuthRuntimeHandlerDependencies,
} from './deepseek-auth-handlers';
import {
  createMultimodalRuntimeHandlers,
  type MultimodalRuntimeHandlerDependencies,
} from './multimodal-handlers';
import {
  createHarnessBridgeRuntimeHandlers,
  type HarnessBridgeRuntimeHandlerDependencies,
} from './harness-bridge-handlers';

export interface DeepSeekRuntimeHandlerDependencies {
  auth: DeepSeekAuthRuntimeHandlerDependencies;
  multimodal: MultimodalRuntimeHandlerDependencies;
  chat: ChatRuntimeHandlerDependencies;
  conversationExport: ConversationExportRuntimeHandlerDependencies;
  harnessBridge: HarnessBridgeRuntimeHandlerDependencies;
}

export function createDeepSeekRuntimeHandlers(
  dependencies: DeepSeekRuntimeHandlerDependencies,
): readonly RuntimeCommandHandler[] {
  return Object.freeze([
    ...createDeepSeekAuthRuntimeHandlers(dependencies.auth),
    ...createMultimodalRuntimeHandlers(dependencies.multimodal),
    ...createChatRuntimeHandlers(dependencies.chat),
    ...createConversationExportRuntimeHandlers(dependencies.conversationExport),
    ...createHarnessBridgeRuntimeHandlers(dependencies.harnessBridge),
  ]);
}
