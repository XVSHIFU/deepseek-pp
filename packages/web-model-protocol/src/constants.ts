export const PROTOCOL_VERSION = 1 as const;
export const JSON_RPC_VERSION = "2.0" as const;

export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_STRUCTURE_DEPTH = 32;
export const MAX_STRUCTURE_NODES = 65_536;
export const MAX_OBJECT_PROPERTIES = 256;
export const MAX_ARRAY_LENGTH = 256;

export const MAX_ID_LENGTH = 128;
export const MAX_NAME_LENGTH = 128;
export const MAX_VERSION_LENGTH = 128;
export const MAX_MODEL_ID_LENGTH = 256;
export const MAX_REASON_LENGTH = 4_096;
export const MAX_DESCRIPTION_LENGTH = 16_384;
export const MAX_TEXT_LENGTH = 262_144;
export const MAX_ERROR_MESSAGE_LENGTH = 4_096;
export const MAX_MESSAGES = 128;
export const MAX_CONTENT_BLOCKS = 128;
export const MAX_TOOLS = 128;
export const MAX_TIMEOUT_MS = 30 * 60 * 1_000;
