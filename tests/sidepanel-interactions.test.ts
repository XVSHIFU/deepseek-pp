import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PROMPT_INJECTION_SETTINGS,
  type PromptInjectionSettings,
} from '../core/prompt/settings';
import PromptControlPanel from '../entrypoints/sidepanel/components/PromptControlPanel';
import LocalSkillImportPanel from '../entrypoints/sidepanel/components/LocalSkillImportPanel';
import ScenarioManager from '../entrypoints/sidepanel/components/ScenarioManager';
import ChatPage from '../entrypoints/sidepanel/pages/ChatPage';
import SavedPage from '../entrypoints/sidepanel/pages/SavedPage';
import ProjectFilesSubPage from '../entrypoints/sidepanel/components/settings/ProjectFilesSubPage';
import { HarnessBridgeSubPage } from '../entrypoints/sidepanel/pages/SettingsPage';
import { TRUSTED_DIRECTORY_STORAGE_KEY } from '../core/trusted-directory/store';
import {
  buildTrustedDirectorySession,
  setTrustedDirectorySession,
} from '../entrypoints/sidepanel/trusted-directory';

let container: HTMLDivElement;
let root: Root | null;
let runtimeListeners: Array<(message: unknown) => void>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = null;
  runtimeListeners = [];
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  container.remove();
  vi.unstubAllGlobals();
});

describe('sidepanel interactions', () => {
  it('sends a saved snippet payload when the save button is clicked', async () => {
    const sendMessage = vi.fn(async (message: { type: string; payload?: unknown }) => {
      if (message.type === 'GET_SAVED_ITEMS') return [];
      if (message.type === 'SAVE_SAVED_ITEM') {
        return {
          id: 'saved-1',
          syncId: 'sync-1',
          kind: 'snippet',
          title: 'Review prompt',
          content: 'Summarize this thread.',
          tags: ['prompt'],
          createdAt: 1,
          updatedAt: 1,
        };
      }
      return null;
    });
    stubChrome(sendMessage);

    await renderElement(React.createElement(SavedPage));
    await enterText('标题', 'Review prompt');
    await enterText('Prompt 片段、笔记或可复用文本', 'Summarize this thread.');
    await enterText('标签（逗号分隔）', 'prompt');
    await clickButton('保存');

    expect(sendMessage).toHaveBeenCalledWith({
      type: 'SAVE_SAVED_ITEM',
      payload: {
        kind: 'snippet',
        title: 'Review prompt',
        content: 'Summarize this thread.',
        tags: ['prompt'],
      },
    });
    expect(inputByPlaceholder('标题').value).toBe('');
  });

  it('requests insertion into the active DeepSeek chat when a saved item is clicked', async () => {
    const sendMessage = vi.fn(async (message: { type: string; payload?: unknown }) => {
      if (message.type === 'GET_SAVED_ITEMS') {
        return [{
          id: 'saved-1',
          syncId: 'sync-1',
          kind: 'snippet',
          title: 'Review prompt',
          content: 'Summarize this thread.',
          tags: ['prompt'],
          createdAt: 1,
          updatedAt: 1,
        }];
      }
      if (message.type === 'INSERT_SAVED_PROMPT_INTO_CHAT') return { ok: true };
      return null;
    });
    stubChrome(sendMessage);

    await renderElement(React.createElement(SavedPage));
    await flushPromises();
    await clickButton('插入到对话');

    expect(sendMessage).toHaveBeenCalledWith({
      type: 'INSERT_SAVED_PROMPT_INTO_CHAT',
      payload: { text: 'Summarize this thread.' },
    });
    expect(container.textContent).toContain('已插入当前 DeepSeek 对话');
  });

  it('shows insertion failures from the active DeepSeek chat route', async () => {
    const sendMessage = vi.fn(async (message: { type: string; payload?: unknown }) => {
      if (message.type === 'GET_SAVED_ITEMS') {
        return [{
          id: 'saved-1',
          syncId: 'sync-1',
          kind: 'snippet',
          title: 'Review prompt',
          content: 'Summarize this thread.',
          tags: [],
          createdAt: 1,
          updatedAt: 1,
        }];
      }
      if (message.type === 'INSERT_SAVED_PROMPT_INTO_CHAT') {
        return { ok: false, error: '请先在 chat.deepseek.com 登录，或刷新 DeepSeek 页面后重试。' };
      }
      return null;
    });
    stubChrome(sendMessage);

    await renderElement(React.createElement(SavedPage));
    await flushPromises();
    await clickButton('插入到对话');

    expect(container.textContent).toContain('插入到对话失败：请先在 chat.deepseek.com 登录，或刷新 DeepSeek 页面后重试。');
  });

  it('shows saved-item repository failures instead of rendering a fake empty state', async () => {
    const sendMessage = vi.fn(async (message: { type: string }) => {
      if (message.type === 'GET_SAVED_ITEMS') {
        return { ok: false, error: 'savedItems.schemaVersion is not supported' };
      }
      return null;
    });
    stubChrome(sendMessage);

    await renderElement(React.createElement(SavedPage));
    await flushPromises();

    expect(container.textContent)
      .toContain('保存项操作失败：savedItems.schemaVersion is not supported');
    expect(container.textContent).not.toContain('暂无保存项');
  });

  it('retains the last valid saved item when an update payload is corrupt', async () => {
    const item = {
      id: 'saved-1',
      syncId: 'sync-1',
      kind: 'snippet',
      title: 'Keep confirmed item',
      content: 'Last confirmed content.',
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    };
    const sendMessage = vi.fn(async (message: { type: string }) => (
      message.type === 'GET_SAVED_ITEMS' ? [item] : null
    ));
    stubChrome(sendMessage);

    await renderElement(React.createElement(SavedPage));
    await flushPromises();
    await act(async () => {
      runtimeListeners.forEach((listener) => listener({
        type: 'SAVED_ITEMS_UPDATED',
        savedItems: [{ id: 'corrupt' }],
      }));
    });

    expect(container.textContent).toContain('Keep confirmed item');
    expect(container.textContent).toContain('savedItemsUpdate[0]');
    expect(container.textContent).not.toContain('暂无保存项');
  });

  it('does not let an older saved-item read replace a newer update event', async () => {
    let resolveInitialRead!: (value: unknown) => void;
    const initialRead = new Promise<unknown>((resolve) => {
      resolveInitialRead = resolve;
    });
    const sendMessage = vi.fn((message: { type: string }) => (
      message.type === 'GET_SAVED_ITEMS' ? initialRead : Promise.resolve(null)
    ));
    stubChrome(sendMessage);
    await renderElement(React.createElement(SavedPage));

    await act(async () => {
      runtimeListeners.forEach((listener) => listener({
        type: 'SAVED_ITEMS_UPDATED',
        savedItems: [{
          id: 'saved-new',
          syncId: 'sync-new',
          kind: 'snippet',
          title: 'Newer saved item',
          content: 'Newer content.',
          tags: [],
          createdAt: 2,
          updatedAt: 2,
        }],
      }));
    });
    expect(container.textContent).toContain('Newer saved item');

    await act(async () => {
      resolveInitialRead([{
        id: 'saved-old',
        syncId: 'sync-old',
        kind: 'snippet',
        title: 'Older saved item',
        content: 'Older content.',
        tags: [],
        createdAt: 1,
        updatedAt: 1,
      }]);
      await initialRead;
    });
    expect(container.textContent).toContain('Newer saved item');
    expect(container.textContent).not.toContain('Older saved item');
  });

  it('keeps a saved item visible when repository deletion fails', async () => {
    const item = {
      id: 'saved-1',
      syncId: 'sync-1',
      kind: 'snippet',
      title: 'Keep me',
      content: 'Do not remove this item on failure.',
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    };
    const sendMessage = vi.fn(async (message: { type: string }) => {
      if (message.type === 'GET_SAVED_ITEMS') return [item];
      if (message.type === 'DELETE_SAVED_ITEM') {
        return { ok: false, error: 'delete blocked' };
      }
      return null;
    });
    stubChrome(sendMessage);

    await renderElement(React.createElement(SavedPage));
    await flushPromises();
    await clickButtonByLabel('删除');
    await clickButton('删除');
    await flushPromises();

    expect(container.textContent).toContain('保存项操作失败：delete blocked');
    expect(container.textContent).toContain('Keep me');
  });

  it('shows scenario repository failures instead of silently loading built-ins', async () => {
    const sendMessage = vi.fn(async () => ({
      ok: false,
      error: 'scenarios.schemaVersion is not supported',
    }));
    stubChrome(sendMessage);

    await renderElement(React.createElement(ScenarioManager));
    await flushPromises();

    expect(container.textContent)
      .toContain('场景操作失败：scenarios.schemaVersion is not supported');
    expect(sendMessage).toHaveBeenCalledWith({
      type: 'SCENARIOS_UPDATED',
      payload: { operation: 'get' },
    });
  });

  it('reports a committed Scenario separately when background menu refresh fails', async () => {
    let scenarios = [{
      id: 'summarize',
      label: '总结',
      template: '总结 {text}',
      builtIn: true,
      enabled: true,
    }];
    const sendMessage = vi.fn(async (message: {
      type: string;
      payload?: { operation?: string; scenario?: typeof scenarios[number] };
    }) => {
      if (message.payload?.operation === 'get') return { ok: true, scenarios };
      if (message.payload?.operation === 'save' && message.payload.scenario) {
        scenarios = [message.payload.scenario];
        return { ok: false, error: 'menu offline' };
      }
      return null;
    });
    stubChrome(sendMessage);

    await renderElement(React.createElement(ScenarioManager));
    await flushPromises();
    const firstToggle = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(firstToggle).toBeTruthy();
    await act(async () => firstToggle?.click());
    await flushPromises();

    expect(scenarios[0])
      .toMatchObject({ id: 'summarize', enabled: false });
    expect(sendMessage).toHaveBeenCalledWith({
      type: 'SCENARIOS_UPDATED',
      payload: {
        operation: 'save',
        scenario: expect.objectContaining({ id: 'summarize', enabled: false }),
      },
    });
    expect(container.textContent)
      .toContain('场景已保存，但后台右键菜单刷新失败：menu offline');
    expect(container.textContent).not.toContain('场景操作失败：menu offline');
  });

  it('persists prompt control select changes instead of reverting to defaults', async () => {
    const sendMessage = vi.fn(async (message: { type: string; payload?: PromptInjectionSettings }) => {
      if (message.type === 'GET_PROMPT_INJECTION_SETTINGS') return DEFAULT_PROMPT_INJECTION_SETTINGS;
      if (message.type === 'SAVE_PROMPT_INJECTION_SETTINGS') return message.payload;
      return null;
    });
    stubChrome(sendMessage);

    await renderElement(React.createElement(PromptControlPanel));
    const cadenceSelect = container.querySelector('select');
    expect(cadenceSelect).toBeInstanceOf(HTMLSelectElement);

    await act(async () => {
      setSelectValue(cadenceSelect as HTMLSelectElement, 'every_message');
      cadenceSelect?.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(sendMessage).toHaveBeenCalledWith({
      type: 'SAVE_PROMPT_INJECTION_SETTINGS',
      payload: {
        ...DEFAULT_PROMPT_INJECTION_SETTINGS,
        presetCadence: 'every_message',
      },
    });
    expect((cadenceSelect as HTMLSelectElement).value).toBe('every_message');
  });

  it('shows prompt control save failures and restores the previous confirmed state', async () => {
    const sendMessage = vi.fn(async (message: { type: string }) => {
      if (message.type === 'GET_PROMPT_INJECTION_SETTINGS') return DEFAULT_PROMPT_INJECTION_SETTINGS;
      if (message.type === 'SAVE_PROMPT_INJECTION_SETTINGS') {
        return { ok: false, error: 'tabs permission unavailable' };
      }
      return null;
    });
    stubChrome(sendMessage);

    await renderElement(React.createElement(PromptControlPanel));
    const memoryToggle = container.querySelector('button');
    expect(memoryToggle).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      memoryToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('保存提示词设置失败：tabs permission unavailable');
    expect((memoryToggle as HTMLButtonElement).getAttribute('style')).toContain('var(--ds-blue)');
  });

  it('explains that non-bundled local Skill resources remain available on demand', async () => {
    const legacyWarning = '13 local supporting file(s) were omitted.';
    const sendMessage = vi.fn(async (message: { type: string }) => {
      if (message.type !== 'PREVIEW_LOCAL_SKILL_SOURCE') return null;
      return {
        source: {
          id: 'local:demo',
          provider: 'local',
          rootPath: '/Users/me/.codex/skills/demo',
          displayName: 'demo',
          directoryName: 'demo',
          skillPaths: ['SKILL.md'],
          importedSkillNames: ['demo'],
          importedAt: 1,
          updatedAt: 1,
          warnings: [legacyWarning],
        },
        skills: [{
          path: 'SKILL.md',
          name: 'demo',
          importName: 'demo',
          description: 'Demo Skill',
          bytes: 64000,
          bodyBytes: 6000,
          includedFiles: Array.from({ length: 16 }, (_, index) => ({ path: `references/${index + 1}.md`, bytes: 100 })),
          omittedFiles: Array.from({ length: 13 }, (_, index) => ({ path: `references/${index + 17}.md`, bytes: 100 })),
          scriptFiles: [],
          warnings: [legacyWarning],
          nameChanged: false,
        }],
        warnings: [legacyWarning],
        truncated: false,
      };
    });
    stubChrome(sendMessage);

    await renderElement(React.createElement(LocalSkillImportPanel, {
      onImported: vi.fn(),
      onCancel: vi.fn(),
    }));
    await enterText('/Users/me/.codex/skills/my-skill', '/Users/me/.codex/skills/demo');
    await clickButton('预览');
    await flushPromises();

    expect(container.textContent).toContain('按需读取 13');
    expect(container.textContent).toContain('文件没有被删除');
    expect(container.textContent).not.toContain(legacyWarning);
  });

  it('keeps safe local Skills selectable when a sibling needs an unavailable reader', async () => {
    const source = {
      id: 'local:demo',
      provider: 'local' as const,
      rootPath: '/Users/me/.codex/skills/demo',
      displayName: 'demo',
      directoryName: 'demo',
      skillPaths: ['blocked/SKILL.md', 'safe/SKILL.md'],
      importedSkillNames: ['blocked', 'safe'],
      importedAt: 1,
      updatedAt: 1,
      warnings: [],
    };
    const sendMessage = vi.fn(async (message: { type: string; payload?: unknown }) => {
      if (message.type === 'PREVIEW_LOCAL_SKILL_SOURCE') {
        return {
          source,
          skills: [
            {
              path: 'blocked/SKILL.md',
              name: 'blocked',
              importName: 'blocked',
              description: 'Needs an on-demand reader',
              bytes: 64000,
              bodyBytes: 6000,
              includedFiles: Array.from({ length: 16 }, (_, index) => ({ path: `blocked/references/${index + 1}.md`, bytes: 100 })),
              omittedFiles: [{ path: 'blocked/references/17.md', bytes: 100 }],
              scriptFiles: [],
              warnings: [],
              importBlock: {
                code: 'shell_reader_unavailable',
              },
              nameChanged: false,
            },
            {
              path: 'safe/SKILL.md',
              name: 'safe',
              importName: 'safe',
              description: 'Safe to import',
              bytes: 1000,
              bodyBytes: 1000,
              includedFiles: [],
              omittedFiles: [],
              scriptFiles: [],
              warnings: [],
              nameChanged: false,
            },
          ],
          warnings: [],
          truncated: false,
        };
      }
      if (message.type === 'IMPORT_LOCAL_SKILL_SOURCE') {
        return {
          ok: true,
          source,
          imported: [],
          replaced: 0,
          renamed: 0,
          warnings: [],
        };
      }
      return null;
    });
    stubChrome(sendMessage);

    await renderElement(React.createElement(LocalSkillImportPanel, {
      onImported: vi.fn(),
      onCancel: vi.fn(),
    }));
    await enterText('/Users/me/.codex/skills/my-skill', '/Users/me/.codex/skills/demo');
    await clickButton('预览');
    await flushPromises();

    const checkboxes = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0]).toMatchObject({ checked: false, disabled: true });
    expect(checkboxes[1]).toMatchObject({ checked: true, disabled: false });
    expect(container.textContent).toContain('按需读取器不可用');
    expect(container.textContent).toContain('当前无法按需读取');
    expect(container.textContent).toContain('请将 Shell Local 执行模式设为“自动”');
    expect(container.textContent).not.toContain('Shell MCP on-demand file reading is not available to chat.');
    expect(container.textContent).toContain('未内嵌 1');
    expect(container.textContent).not.toContain('按需读取 1');

    await clickButton('导入选中 Skill');
    await flushPromises();

    expect(sendMessage).toHaveBeenCalledWith({
      type: 'IMPORT_LOCAL_SKILL_SOURCE',
      payload: {
        rootPath: '/Users/me/.codex/skills/demo',
        selectedPaths: ['safe/SKILL.md'],
        selectedImportNames: {
          'safe/SKILL.md': 'safe',
        },
      },
    });
  });

  it('localizes reader failures detected again at import time', async () => {
    const source = {
      id: 'local:demo',
      provider: 'local' as const,
      rootPath: '/Users/me/.codex/skills/demo',
      displayName: 'demo',
      directoryName: 'demo',
      skillPaths: ['SKILL.md'],
      importedSkillNames: ['demo'],
      importedAt: 1,
      updatedAt: 1,
      warnings: [],
    };
    const sendMessage = vi.fn(async (message: { type: string; payload?: unknown }) => {
      if (message.type === 'PREVIEW_LOCAL_SKILL_SOURCE') {
        return {
          source,
          skills: [{
            path: 'SKILL.md',
            name: 'demo',
            importName: 'demo',
            description: 'Reader was available during preview',
            bytes: 64000,
            bodyBytes: 6000,
            includedFiles: [],
            omittedFiles: [{ path: 'references/large.md', bytes: 58000 }],
            scriptFiles: [],
            warnings: [],
            nameChanged: false,
          }],
          warnings: [],
          truncated: false,
        };
      }
      if (message.type === 'IMPORT_LOCAL_SKILL_SOURCE') {
        return {
          ok: false,
          error: 'Shell MCP on-demand file reading is not available to chat.',
          importBlock: {
            code: 'shell_reader_unavailable',
          },
        };
      }
      return null;
    });
    const onImported = vi.fn();
    stubChrome(sendMessage);

    await renderElement(React.createElement(LocalSkillImportPanel, {
      onImported,
      onCancel: vi.fn(),
    }));
    await enterText('/Users/me/.codex/skills/my-skill', '/Users/me/.codex/skills/demo');
    await clickButton('预览');
    await flushPromises();
    await clickButton('导入选中 Skill');
    await flushPromises();

    expect(container.textContent).toContain('按需读取器不可用');
    expect(container.textContent).toContain('请将 Shell Local 执行模式设为“自动”');
    expect(container.textContent).not.toContain('Shell MCP on-demand file reading is not available to chat.');
    expect(onImported).not.toHaveBeenCalled();
  });

  it('persists web model mode from sidepanel chat controls', async () => {
    const sendMessage = vi.fn(async (message: { type: string; payload?: unknown }) => {
      if (message.type === 'GET_AUTH_STATUS') return { available: true, provider: 'deepseek-web' };
      if (message.type === 'GET_OFFICIAL_API_CHAT_CONFIG') return {};
      if (message.type === 'GET_MODEL_TYPE') return null;
      if (message.type === 'GET_VOICE_SETTINGS') return {};
      if (message.type === 'SET_MODEL_TYPE') return { ok: true };
      return null;
    });
    stubChrome(sendMessage);

    await renderElement(React.createElement(ChatPage));
    await flushPromises();
    expect(buttonByText('默认').className).toContain('ds-chat-segment-active');

    await clickButton('识图');

    expect(sendMessage).toHaveBeenCalledWith({ type: 'SET_MODEL_TYPE', payload: 'vision' });
    expect(buttonByText('识图').className).toContain('ds-chat-segment-active');
  });

  it('scrolls to the updated message height after the lazy rich renderer commits', async () => {
    const sendMessage = vi.fn(async (message: { type: string }) => {
      if (message.type === 'GET_AUTH_STATUS') return { available: true, provider: 'deepseek-web' };
      if (message.type === 'GET_OFFICIAL_API_CHAT_CONFIG') return {};
      if (message.type === 'GET_MODEL_TYPE') return null;
      if (message.type === 'GET_VOICE_SETTINGS') return {};
      return null;
    });
    stubChrome(sendMessage);

    await renderElement(React.createElement(ChatPage));
    await flushPromises();

    const messageList = container.querySelector('.ds-chat-messages') as HTMLDivElement;
    const scrollAssignments: number[] = [];
    let scrollTop = 0;
    Object.defineProperties(messageList, {
      scrollHeight: {
        configurable: true,
        get: () => messageList.querySelector('strong') ? 480 : 240,
      },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
          scrollAssignments.push(value);
        },
      },
    });

    await act(async () => {
      runtimeListeners.forEach((listener) => listener({
        type: 'CHAT_STREAM_CHUNK',
        text: 'Hello **world**',
      }));
    });

    await vi.waitFor(() => {
      expect(messageList.querySelector('strong')?.textContent).toBe('world');
    });
    expect(scrollAssignments).toContain(480);
    expect(scrollTop).toBe(480);
  });

  it('uploads a vision image attachment and submits its file reference', async () => {
    const sendMessage = vi.fn(async (message: { type: string; payload?: unknown }) => {
      if (message.type === 'GET_AUTH_STATUS') return { available: true, provider: 'deepseek-web' };
      if (message.type === 'GET_OFFICIAL_API_CHAT_CONFIG') return {};
      if (message.type === 'GET_MODEL_TYPE') return 'vision';
      if (message.type === 'GET_VOICE_SETTINGS') return {};
      if (message.type === 'UPLOAD_DEEPSEEK_IMAGE') {
        return {
          ok: true,
          file: {
            id: 'file-image-1',
            fileName: 'shot.png',
            status: 'SUCCESS',
          },
        };
      }
      if (message.type === 'CHAT_SUBMIT_PROMPT') return { ok: true };
      return null;
    });
    stubChrome(sendMessage);
    stubObjectUrl();
    stubFileReader('data:image/png;base64,YWJj');

    await renderElement(React.createElement(ChatPage));
    await flushPromises();

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(fileInput).toBeTruthy();
    const image = new File(['abc'], 'shot.png', { type: 'image/png' });
    Object.defineProperty(fileInput, 'files', { value: [image], configurable: true });

    await act(async () => {
      fileInput?.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flushPromises();

    expect(sendMessage).toHaveBeenCalledWith({
      type: 'UPLOAD_DEEPSEEK_IMAGE',
      payload: {
        dataUrl: 'data:image/png;base64,YWJj',
        name: 'shot.png',
        mimeType: 'image/png',
        sizeBytes: 3,
      },
    });
    expect(container.textContent).toContain('已添加');

    await enterText('给 DeepSeek++ 发送消息', '描述这张图片');
    await clickButtonByLabel('发送');

    expect(sendMessage).toHaveBeenCalledWith({
      type: 'CHAT_SUBMIT_PROMPT',
      payload: {
        text: '描述这张图片',
        refFileIds: ['file-image-1'],
      },
    });
  });

  it('waits for new-session acknowledgement before clearing pending chat UI', async () => {
    let resolveReset!: (value: { ok: true }) => void;
    const resetAck = new Promise<{ ok: true }>((resolve) => {
      resolveReset = resolve;
    });
    const sendMessage = vi.fn(async (message: { type: string; payload?: unknown }) => {
      if (message.type === 'GET_AUTH_STATUS') return { available: true, provider: 'deepseek-web' };
      if (message.type === 'GET_OFFICIAL_API_CHAT_CONFIG') return {};
      if (message.type === 'GET_MODEL_TYPE') return 'vision';
      if (message.type === 'GET_VOICE_SETTINGS') return {};
      if (message.type === 'UPLOAD_DEEPSEEK_IMAGE') {
        return { ok: true, file: { id: 'file-image-1', fileName: 'shot.png', status: 'SUCCESS' } };
      }
      if (message.type === 'CHAT_NEW_SESSION') return resetAck;
      return null;
    });
    stubChrome(sendMessage);
    stubObjectUrl();
    stubFileReader('data:image/png;base64,YWJj');
    await renderElement(React.createElement(ChatPage));
    await flushPromises();

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const image = new File(['abc'], 'shot.png', { type: 'image/png' });
    Object.defineProperty(fileInput, 'files', { value: [image], configurable: true });
    await act(async () => fileInput.dispatchEvent(new Event('change', { bubbles: true })));
    await flushPromises();
    expect(container.textContent).toContain('已添加');

    await clickButtonByLabel('新建会话');
    expect(container.textContent).toContain('已添加');
    resolveReset({ ok: true });
    await flushPromises();
    expect(container.textContent).not.toContain('已添加');
  });
});

function withRelativePath(file: File, relativePath: string): File {
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath, configurable: true });
  return file;
}

describe('trusted-directory @ file references', () => {
  beforeEach(() => {
    setTrustedDirectorySession(null);
  });

  function installSession() {
    const session = buildTrustedDirectorySession([
      withRelativePath(new File(['abc'], 'shot.png', { type: 'image/png' }), 'proj/assets/shot.png'),
      withRelativePath(new File(['readme'], 'README.md', { type: 'text/markdown' }), 'proj/README.md'),
    ]);
    expect(session).not.toBeNull();
    setTrustedDirectorySession(session);
  }

  function stubWebChat() {
    const sendMessage = vi.fn(async (message: { type: string; payload?: unknown }) => {
      if (message.type === 'GET_AUTH_STATUS') return { available: true, provider: 'deepseek-web' };
      if (message.type === 'GET_OFFICIAL_API_CHAT_CONFIG') return {};
      if (message.type === 'GET_MODEL_TYPE') return 'vision';
      if (message.type === 'GET_VOICE_SETTINGS') return {};
      if (message.type === 'UPLOAD_DEEPSEEK_IMAGE') {
        return { ok: true, file: { id: 'file-image-1', fileName: 'shot.png', status: 'SUCCESS' } };
      }
      if (message.type === 'CHAT_SUBMIT_PROMPT') return { ok: true };
      return null;
    });
    stubChrome(sendMessage);
    return sendMessage;
  }

  it('opens the @ panel, uploads a selected image, and includes its file id on send', async () => {
    const sendMessage = stubWebChat();
    stubObjectUrl();
    stubFileReader('data:image/png;base64,YWJj');
    installSession();

    await renderElement(React.createElement(ChatPage));
    await flushPromises();

    const textarea = inputByPlaceholder('给 DeepSeek++ 发送消息') as HTMLTextAreaElement;
    await act(async () => {
      setTextControlValue(textarea, '看下 @');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const rows = Array.from(container.querySelectorAll('.ds-chat-at-row')) as HTMLButtonElement[];
    expect(rows).toHaveLength(2);

    const imageRow = rows.find((row) => row.textContent?.includes('shot.png'));
    const textRow = rows.find((row) => row.textContent?.includes('README.md'));
    expect(imageRow).toBeTruthy();
    expect(textRow?.disabled).toBe(true);
    expect(textRow?.title).toBe('文本文件引用将在后续版本支持');

    await act(async () => {
      imageRow?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushPromises();

    expect(sendMessage).toHaveBeenCalledWith({
      type: 'UPLOAD_DEEPSEEK_IMAGE',
      payload: {
        dataUrl: 'data:image/png;base64,YWJj',
        name: 'shot.png',
        mimeType: 'image/png',
        sizeBytes: 3,
      },
    });
    expect(container.textContent).toContain('已添加');

    await enterText('给 DeepSeek++ 发送消息', '描述这张图片');
    await clickButtonByLabel('发送');

    expect(sendMessage).toHaveBeenCalledWith({
      type: 'CHAT_SUBMIT_PROMPT',
      payload: {
        text: '描述这张图片',
        refFileIds: ['file-image-1'],
      },
    });
  });

  it('uploads an extension-classified image whose picker MIME type is empty', async () => {
    const sendMessage = stubWebChat();
    stubObjectUrl();
    stubFileReader('data:image/png;base64,YWJj');
    const session = buildTrustedDirectorySession([
      withRelativePath(new File(['abc'], 'shot.png'), 'proj/shot.png'),
    ]);
    expect(session).not.toBeNull();
    setTrustedDirectorySession(session);

    await renderElement(React.createElement(ChatPage));
    await flushPromises();

    const textarea = inputByPlaceholder('给 DeepSeek++ 发送消息') as HTMLTextAreaElement;
    await act(async () => {
      setTextControlValue(textarea, '看下 @');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const imageRow = Array.from(container.querySelectorAll('.ds-chat-at-row'))
      .find((row) => row.textContent?.includes('shot.png')) as HTMLButtonElement | undefined;
    expect(imageRow?.disabled).toBe(false);

    await act(async () => {
      imageRow?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushPromises();

    expect(sendMessage).toHaveBeenCalledWith({
      type: 'UPLOAD_DEEPSEEK_IMAGE',
      payload: {
        dataUrl: 'data:image/png;base64,YWJj',
        name: 'shot.png',
        mimeType: 'image/png',
        sizeBytes: 3,
      },
    });
    expect(container.textContent).toContain('已添加');
  });

  it('filters rows by the @ query and disables non-image rows', async () => {
    stubWebChat();
    installSession();

    await renderElement(React.createElement(ChatPage));
    await flushPromises();

    const textarea = inputByPlaceholder('给 DeepSeek++ 发送消息') as HTMLTextAreaElement;
    await act(async () => {
      setTextControlValue(textarea, '看下 @read');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const rows = Array.from(container.querySelectorAll('.ds-chat-at-row')) as HTMLButtonElement[];
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('README.md');
  });

  it('shows the no-directory hint and closes on Escape', async () => {
    stubWebChat();

    await renderElement(React.createElement(ChatPage));
    await flushPromises();

    const textarea = inputByPlaceholder('给 DeepSeek++ 发送消息') as HTMLTextAreaElement;
    await act(async () => {
      setTextControlValue(textarea, '参考 @src');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(container.textContent).toContain('尚未授权项目目录');
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(container.querySelector('.ds-chat-at-panel')).toBeNull();
  });
});

describe('trusted-directory settings subpage', () => {
  it('authorizes a picked directory and persists its summary', async () => {
    const sendMessage = vi.fn(async () => null);
    const storageValues: Record<string, unknown> = {};
    const chromeStub = {
      runtime: {
        sendMessage,
        onMessage: {
          addListener: vi.fn((listener: (message: unknown) => void) => {
            runtimeListeners.push(listener);
          }),
          removeListener: vi.fn((listener: (message: unknown) => void) => {
            runtimeListeners = runtimeListeners.filter((item) => item !== listener);
          }),
        },
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageValues[key] })),
          set: vi.fn(async (values: Record<string, unknown>) => {
            Object.assign(storageValues, values);
          }),
          remove: vi.fn(async (key: string) => {
            delete storageValues[key];
          }),
        },
      },
    };
    vi.stubGlobal('chrome', chromeStub);

    await renderElement(React.createElement(ProjectFilesSubPage));
    await flushPromises();
    expect(container.textContent).toContain('选择目录');

    const picker = container.querySelector('input[type="file"]') as HTMLInputElement;
    const image = withRelativePath(new File(['abc'], 'shot.png', { type: 'image/png' }), 'proj/shot.png');
    const readme = withRelativePath(new File(['readme'], 'README.md', { type: 'text/markdown' }), 'proj/README.md');
    Object.defineProperty(picker, 'files', { value: [image, readme], configurable: true });

    await act(async () => {
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flushPromises();

    expect(container.textContent).toContain('proj');
    expect(container.textContent).toContain('已授权');
    expect(container.textContent).toContain('2 个文件');
    expect(container.textContent).toContain('图片 1 个');
    expect(container.textContent).toContain('文本 1 个');
    expect(storageValues[TRUSTED_DIRECTORY_STORAGE_KEY]).toMatchObject({
      rootName: 'proj',
      fileCount: 2,
      skippedCount: 0,
    });
  });
});

describe('Harness bridge settings subpage', () => {
  it('loads only the safe status DTO and saves a fixed loopback port with a replacement token', async () => {
    const token = 'A'.repeat(43);
    const sendMessage = vi.fn(async (message: { type: string; payload?: unknown }) => {
      if (message.type === 'GET_HARNESS_BRIDGE_STATUS') return bridgeStatus(false, false, 'stopped');
      if (message.type === 'UPDATE_HARNESS_BRIDGE_SETTINGS') {
        const payload = message.payload as { enabled: boolean; port: number; pairingToken?: string };
        return bridgeStatus(payload.enabled, payload.pairingToken !== undefined, 'connecting', payload.port);
      }
      return null;
    });
    stubChrome(sendMessage);

    await renderElement(React.createElement(HarnessBridgeSubPage));
    await flushPromises();
    expect(container.textContent).toContain('连接状态: 已停止');
    expect(container.textContent).not.toContain(token);

    const toggle = container.querySelector<HTMLButtonElement>('button[aria-pressed="false"]')!;
    const port = labelledInput('回环端口');
    const tokenInput = labelledInput('配对令牌');
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      setTextControlValue(port, '44001');
      port.dispatchEvent(new Event('input', { bubbles: true }));
      setTextControlValue(tokenInput, token);
      tokenInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await clickButton('保存');
    await flushPromises();

    expect(sendMessage).toHaveBeenCalledWith({
      type: 'UPDATE_HARNESS_BRIDGE_SETTINGS',
      payload: { enabled: true, port: 44_001, pairingToken: token },
    });
    expect(tokenInput.value).toBe('');
    expect(container.textContent).toContain('连接状态: 正在连接');
    expect(container.textContent).not.toContain(token);
  });

  it('disconnects by an idempotent disabled update and accepts only secret-free status notifications', async () => {
    const sendMessage = vi.fn(async (message: { type: string; payload?: unknown }) => {
      if (message.type === 'GET_HARNESS_BRIDGE_STATUS') return bridgeStatus(true, true, 'ready');
      if (message.type === 'UPDATE_HARNESS_BRIDGE_SETTINGS') return bridgeStatus(false, true, 'stopped');
      return null;
    });
    stubChrome(sendMessage);
    await renderElement(React.createElement(HarnessBridgeSubPage));
    await flushPromises();

    expect(container.textContent).toContain('连接状态: 已连接');
    await act(async () => {
      runtimeListeners[0]?.({
        type: 'HARNESS_BRIDGE_STATUS_CHANGED',
        payload: { ...bridgeStatus(true, true, 'protocol_error'), pairingToken: 'must-not-cross' },
      });
    });
    expect(container.textContent).toContain('连接状态: 已连接');

    await clickButton('断开');
    await flushPromises();
    expect(sendMessage).toHaveBeenLastCalledWith({
      type: 'UPDATE_HARNESS_BRIDGE_SETTINGS',
      payload: { enabled: false, port: 43_123 },
    });
    expect(container.textContent).toContain('连接状态: 已停止');
  });

  it('rejects a non-canonical pairing token before sending an update', async () => {
    const sendMessage = vi.fn(async (message: { type: string }) => (
      message.type === 'GET_HARNESS_BRIDGE_STATUS'
        ? bridgeStatus(false, false, 'stopped')
        : bridgeStatus(true, true, 'connecting')
    ));
    stubChrome(sendMessage);
    await renderElement(React.createElement(HarnessBridgeSubPage));
    await flushPromises();

    const tokenInput = labelledInput('配对令牌');
    await act(async () => {
      setTextControlValue(tokenInput, ' not-a-canonical-token ');
      tokenInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await clickButton('保存');

    expect(container.textContent).toContain('完整 base64url 配对令牌');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-decimal port before sending an update', async () => {
    const sendMessage = vi.fn(async (message: { type: string }) => (
      message.type === 'GET_HARNESS_BRIDGE_STATUS'
        ? bridgeStatus(false, false, 'stopped')
        : bridgeStatus(true, true, 'connecting')
    ));
    stubChrome(sendMessage);
    await renderElement(React.createElement(HarnessBridgeSubPage));
    await flushPromises();

    const portInput = labelledInput('回环端口');
    await act(async () => {
      setTextControlValue(portInput, '1e2');
      portInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await clickButton('保存');

    expect(container.textContent).toContain('1 到 65535');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('fences a late initial GET behind a newer status notification', async () => {
    const initial = deferredSidepanelStatus();
    const sendMessage = vi.fn(async () => initial.promise);
    stubChrome(sendMessage);
    await renderElement(React.createElement(HarnessBridgeSubPage));
    await flushPromises();

    await act(async () => {
      runtimeListeners[0]?.({
        type: 'HARNESS_BRIDGE_STATUS_CHANGED',
        payload: bridgeStatus(true, true, 'ready', 44_001),
      });
    });
    initial.resolve(bridgeStatus(false, false, 'stopped', 43_123));
    await flushPromises();

    expect(container.textContent).toContain('连接状态: 已连接');
    expect(labelledInput('回环端口').value).toBe('44001');
  });

  it('shows corrupt/future configuration failures without rendering raw details', async () => {
    const sendMessage = vi.fn(async () => ({
      ok: false,
      error: 'harness_bridge_settings_future_version',
    }));
    stubChrome(sendMessage);
    await renderElement(React.createElement(HarnessBridgeSubPage));
    await flushPromises();

    expect(container.textContent).toContain('设置损坏或来自更高版本');
    expect(container.textContent).not.toContain('harness_bridge_settings_future_version');
    expect(labelledInput('回环端口').disabled).toBe(true);
    expect(labelledInput('配对令牌').disabled).toBe(true);
    expect(buttonByText('保存').disabled).toBe(true);
    expect(buttonByText('刷新').disabled).toBe(false);
  });
});

async function renderElement(element: React.ReactElement) {
  await act(async () => {
    root = createRoot(container);
    root.render(element);
  });
}

function stubChrome(sendMessage: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage,
      onMessage: {
        addListener: vi.fn((listener: (message: unknown) => void) => {
          runtimeListeners.push(listener);
        }),
        removeListener: vi.fn((listener: (message: unknown) => void) => {
          runtimeListeners = runtimeListeners.filter((item) => item !== listener);
        }),
      },
    },
  });
}

async function enterText(placeholder: string, value: string) {
  const field = inputByPlaceholder(placeholder);
  await act(async () => {
    setTextControlValue(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function clickButton(label: string) {
  const button = buttonByText(label);
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function clickButtonByLabel(label: string) {
  const button = container.querySelector(`button[aria-label="${label}"]`);
  expect(button).toBeTruthy();
  await act(async () => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
  });
}

function inputByPlaceholder(placeholder: string): HTMLInputElement | HTMLTextAreaElement {
  const input = container.querySelector(`input[placeholder="${placeholder}"], textarea[placeholder="${placeholder}"]`);
  expect(input).toBeTruthy();
  return input as HTMLInputElement | HTMLTextAreaElement;
}

function buttonByText(label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button'))
    .find((candidate) => candidate.textContent === label);
  expect(button).toBeTruthy();
  return button as HTMLButtonElement;
}

function labelledInput(label: string): HTMLInputElement {
  const wrapper = Array.from(container.querySelectorAll('label'))
    .find((candidate) => candidate.textContent?.includes(label));
  const input = wrapper?.querySelector('input');
  expect(input).toBeTruthy();
  return input as HTMLInputElement;
}

function bridgeStatus(
  enabled: boolean,
  pairingTokenConfigured: boolean,
  phase: 'stopped' | 'connecting' | 'ready' | 'protocol_error',
  port = 43_123,
) {
  return {
    ok: true as const,
    settings: { version: 1 as const, enabled, port, pairingTokenConfigured },
    state: { phase, attempt: phase === 'connecting' ? 1 : 0 },
  };
}

function deferredSidepanelStatus() {
  let resolve!: (value: ReturnType<typeof bridgeStatus>) => void;
  const promise = new Promise<ReturnType<typeof bridgeStatus>>((done) => { resolve = done; });
  return { promise, resolve };
}

function setTextControlValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = input instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  setter?.call(input, value);
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  setter?.call(select, value);
}

function stubObjectUrl() {
  vi.stubGlobal('URL', Object.assign(URL, {
    createObjectURL: vi.fn(() => 'blob:preview'),
    revokeObjectURL: vi.fn(),
  }));
}

function stubFileReader(dataUrl: string) {
  class MockFileReader {
    result: string | ArrayBuffer | null = null;
    error: DOMException | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;

    readAsDataURL() {
      this.result = dataUrl;
      this.onload?.();
    }
  }

  vi.stubGlobal('FileReader', MockFileReader);
}
