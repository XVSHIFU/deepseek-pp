import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createTranslator,
  formatMessage,
  getLocaleArrayKeys,
  getLocaleStringKeys,
  normalizeLocalePreference,
  resolveLocalePreference,
  resolveMessage,
  translate,
  translateArray,
} from '../core/i18n';
import { getPetLines } from '../core/pet/lines';

describe('i18n resources', () => {
  it('distinguishes the Harness fork in browser and sidepanel names', () => {
    for (const [locale, directory] of [['en', 'en'], ['zh-CN', 'zh_CN']] as const) {
      const messages = JSON.parse(readFileSync(resolve(`public/_locales/${directory}/messages.json`), 'utf8'));
      expect(translate(locale, 'manifest.name')).toBe('DeepSeek++ Harness');
      expect(messages.extension_name.message).toBe(translate(locale, 'manifest.name'));
      expect(messages.extension_action_title.message).toBe(translate(locale, 'manifest.actionTitle'));
    }
    const about = readFileSync(resolve('entrypoints/sidepanel/components/settings/AboutSubPage.tsx'), 'utf8');
    expect(about).toContain("t('manifest.name')");
    const page = readFileSync(resolve('entrypoints/sidepanel/index.html'), 'utf8');
    expect(page).toContain('<title>DeepSeek++ Harness</title>');
  });

  it('keeps English and Chinese string keys in parity', () => {
    expect(getLocaleStringKeys('en').sort()).toEqual(getLocaleStringKeys('zh-CN').sort());
  });

  it('keeps English and Chinese array keys in parity', () => {
    expect(getLocaleArrayKeys('en').sort()).toEqual(getLocaleArrayKeys('zh-CN').sort());
  });
});

describe('i18n translation', () => {
  it('translates typed keys by locale', () => {
    expect(translate('en', 'app.tabs.chat')).toBe('Chat');
    expect(translate('zh-CN', 'app.tabs.chat')).toBe('对话');
  });

  it('translates sidepanel shared UI copy by locale', () => {
    expect(translate('en', 'sidepanel.memory.types.feedback')).toBe('Feedback');
    expect(translate('zh-CN', 'sidepanel.memory.types.feedback')).toBe('反馈');
    expect(translate('en', 'sidepanel.githubSkillImport.selectedSummary', {
      selected: 2,
      total: 5,
      bytes: '3 KB',
    })).toBe('Selected 2 / 5 · 3 KB');
  });

  it('translates runtime page status copy by locale without touching dynamic names', () => {
    expect(translate('en', 'sidepanel.mcpPage.summary', {
      servers: 2,
      enabled: 1,
      tools: 4,
    })).toBe('2 servers, 1 enabled, 4 auto tools');
    expect(translate('zh-CN', 'sidepanel.mcpPage.summary', {
      servers: 2,
      enabled: 1,
      tools: 4,
    })).toBe('2 个服务，1 个启用，4 个自动工具');
    expect(translate('en', 'sidepanel.mcpPage.messages.deleteConfirm', {
      name: 'Filesystem MCP',
    })).toBe('Delete MCP server "Filesystem MCP"?');
    expect(translate('zh-CN', 'sidepanel.mcpPage.messages.deleteConfirm', {
      name: 'Filesystem MCP',
    })).toBe('删除 MCP 服务「Filesystem MCP」？');
    expect(translate('en', 'sidepanel.automationPage.status.timeout')).toBe('Timed out');
    expect(translate('zh-CN', 'sidepanel.automationPage.status.timeout')).toBe('超时');
  });

  it('translates content/background injected surfaces and locale-backed pet lines', () => {
    expect(translate('en', 'background.contextMenus.sendToChat')).toBe('Send to chat');
    expect(translate('zh-CN', 'background.contextMenus.sendToChat')).toBe('发送到对话');
    expect(translate('en', 'content.export.buttonIdle')).toBe('Export current conversation');
    expect(translate('zh-CN', 'content.export.buttonIdle')).toBe('导出当前对话');
    expect(translate('en', 'content.permission.webFetch', {
      origin: 'https://example.com',
    })).toBe('DeepSeek++ needs permission to access https://example.com so it can fetch that page');
    expect(getPetLines('success', 'en')).toContain('Done');
    expect(getPetLines('success', 'zh-CN')).toContain('搞定！');
  });

  it('interpolates message parameters without swallowing missing placeholders', () => {
    expect(formatMessage('Hello {name}, count {count}, flag {flag}', {
      name: 'DeepSeek++',
      count: 3,
      flag: false,
    })).toBe('Hello DeepSeek++, count 3, flag false');

    expect(formatMessage('Hello {missing}')).toBe('Hello {missing}');
  });

  it('returns observable fallback metadata for unsupported locales', () => {
    const resolved = resolveMessage('fr-FR', 'app.tabs.chat');

    expect(resolved).toEqual({
      value: '对话',
      locale: 'zh-CN',
      fallback: true,
    });
  });

  it('reads localized string-array resources', () => {
    expect(translateArray('en', 'pet.lines.success')).toEqual(['Done', 'Handled', 'Finished']);
    expect(translateArray('zh-CN', 'pet.lines.success')).toEqual(['大功告成', '搞定！', '收工！']);
  });

  it('creates stable translators for repeated calls', () => {
    const translator = createTranslator('en');

    expect(translator.locale).toBe('en');
    expect(translator.fallback).toBe(false);
    expect(translator.t('app.version', { version: '0.6.4' })).toBe('v0.6.4');
    expect(translator.ta('pet.lines.error')).toEqual(['Stuck...', 'Something failed', 'Needs a retry']);
  });

  it('throws on missing keys instead of returning silent defaults', () => {
    expect(() => translate('en', 'missing.key' as never)).toThrow('Missing locale key "missing.key"');
  });
});

describe('i18n locale preference resolution', () => {
  it('normalizes invalid locale preferences to auto', () => {
    expect(normalizeLocalePreference('en')).toBe('en');
    expect(normalizeLocalePreference('zh-CN')).toBe('zh-CN');
    expect(normalizeLocalePreference('auto')).toBe('auto');
    expect(normalizeLocalePreference('fr-FR')).toBe('auto');
    expect(normalizeLocalePreference(null)).toBe('auto');
  });

  it('lets explicit locale preference override browser languages', () => {
    expect(resolveLocalePreference('en', ['zh-CN'])).toMatchObject({
      preference: 'en',
      locale: 'en',
      fallback: false,
    });

    expect(resolveLocalePreference('zh-CN', ['en-US'])).toMatchObject({
      preference: 'zh-CN',
      locale: 'zh-CN',
      fallback: false,
    });
  });

  it('resolves auto from browser language candidates', () => {
    expect(resolveLocalePreference('auto', ['fr-FR', 'en-US'])).toMatchObject({
      preference: 'auto',
      locale: 'en',
      fallback: false,
    });

    expect(resolveLocalePreference('auto', ['zh-Hans-CN', 'en-US'])).toMatchObject({
      preference: 'auto',
      locale: 'zh-CN',
      fallback: false,
    });
  });

  it('falls back to zh-CN when auto has no supported browser language', () => {
    expect(resolveLocalePreference('auto', ['fr-FR', 'ja-JP'])).toMatchObject({
      preference: 'auto',
      locale: 'zh-CN',
      fallback: true,
    });
  });
});
