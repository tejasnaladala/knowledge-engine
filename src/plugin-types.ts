/**
 * Local type declarations mirroring the OpenClaw plugin SDK types.
 *
 * These types are derived from the actual OpenClaw plugin SDK at:
 * /opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/plugins/types.d.ts
 *
 * We declare them locally so the plugin compiles standalone without
 * requiring the openclaw package as a build-time dependency.
 */

import type { TSchema, Static } from '@sinclair/typebox';

// ── Logger ───────────────────────────────────────────────────────────────

export type PluginLogger = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

// ── Tool types ───────────────────────────────────────────────────────────

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface AgentToolResult<T = unknown> {
  content: (TextContent | ImageContent)[];
  details?: T;
}

export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = unknown> {
  name: string;
  label: string;
  description: string;
  parameters: TParameters;
  ownerOnly?: boolean;
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
  ) => Promise<AgentToolResult<TDetails>>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAgentTool = AgentTool<any, unknown> & {
  ownerOnly?: boolean;
};

// ── Plugin config schema ─────────────────────────────────────────────────

export type OpenClawPluginConfigSchema = {
  safeParse?: (value: unknown) => {
    success: boolean;
    data?: unknown;
    error?: {
      issues?: Array<{
        path: Array<string | number>;
        message: string;
      }>;
    };
  };
  parse?: (value: unknown) => unknown;
  validate?: (value: unknown) => { ok: boolean; errors?: string[] };
  uiHints?: Record<string, unknown>;
  jsonSchema?: Record<string, unknown>;
};

// ── CLI context ──────────────────────────────────────────────────────────

/**
 * Minimal Commander-like Command interface.
 * The full type comes from the 'commander' package at runtime via OpenClaw.
 */
export interface CommandLike {
  command(nameAndArgs: string): CommandLike;
  description(str: string): CommandLike;
  argument(flags: string, description: string): CommandLike;
  option(flags: string, description: string, defaultValue?: string): CommandLike;
  action(fn: (...args: unknown[]) => void | Promise<void>): CommandLike;
}

export type OpenClawPluginCliContext = {
  program: CommandLike;
  config: Record<string, unknown>;
  workspaceDir?: string;
  logger: PluginLogger;
};

export type OpenClawPluginCliRegistrar = (
  ctx: OpenClawPluginCliContext,
) => void | Promise<void>;

// ── Service ──────────────────────────────────────────────────────────────

export type OpenClawPluginServiceContext = {
  config: Record<string, unknown>;
  workspaceDir?: string;
  stateDir: string;
  logger: PluginLogger;
};

export type OpenClawPluginService = {
  id: string;
  start: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
  stop?: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
};

// ── Tool registration options ────────────────────────────────────────────

export type OpenClawPluginToolOptions = {
  name?: string;
  names?: string[];
  optional?: boolean;
};

// ── Hook types ───────────────────────────────────────────────────────────

export type PluginHookName =
  | 'before_model_resolve'
  | 'before_prompt_build'
  | 'before_agent_start'
  | 'llm_input'
  | 'llm_output'
  | 'agent_end'
  | 'before_compaction'
  | 'after_compaction'
  | 'before_reset'
  | 'message_received'
  | 'message_sending'
  | 'message_sent'
  | 'before_tool_call'
  | 'after_tool_call'
  | 'tool_result_persist'
  | 'before_message_write'
  | 'session_start'
  | 'session_end'
  | 'subagent_spawning'
  | 'subagent_delivery_target'
  | 'subagent_spawned'
  | 'subagent_ended'
  | 'gateway_start'
  | 'gateway_stop';

export type PluginHookMessageReceivedEvent = {
  from: string;
  content: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
};

export type PluginHookMessageContext = {
  channelId: string;
  accountId?: string;
  conversationId?: string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type InternalHookHandler = (...args: any[]) => any;

export type OpenClawPluginHookOptions = {
  entry?: unknown;
  name?: string;
  description?: string;
  register?: boolean;
};

// ── Plugin API ───────────────────────────────────────────────────────────

export type OpenClawPluginApi = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  source: string;
  config: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
  runtime: unknown;
  logger: PluginLogger;
  registerTool: (
    tool: AnyAgentTool,
    opts?: OpenClawPluginToolOptions,
  ) => void;
  registerHook: (
    events: string | string[],
    handler: InternalHookHandler,
    opts?: OpenClawPluginHookOptions,
  ) => void;
  registerHttpHandler: (handler: unknown) => void;
  registerHttpRoute: (params: { path: string; handler: unknown }) => void;
  registerChannel: (registration: unknown) => void;
  registerGatewayMethod: (method: string, handler: unknown) => void;
  registerCli: (
    registrar: OpenClawPluginCliRegistrar,
    opts?: { commands?: string[] },
  ) => void;
  registerService: (service: OpenClawPluginService) => void;
  registerProvider: (provider: unknown) => void;
  registerCommand: (command: unknown) => void;
  resolvePath: (input: string) => string;
  on: <K extends PluginHookName>(
    hookName: K,
    handler: (...args: unknown[]) => unknown,
    opts?: { priority?: number },
  ) => void;
};

// ── Plugin definition ────────────────────────────────────────────────────

export type OpenClawPluginDefinition = {
  id?: string;
  name?: string;
  description?: string;
  version?: string;
  kind?: 'memory';
  configSchema?: OpenClawPluginConfigSchema;
  register?: (api: OpenClawPluginApi) => void | Promise<void>;
  activate?: (api: OpenClawPluginApi) => void | Promise<void>;
};
