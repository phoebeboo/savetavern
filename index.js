import { getRequestHeaders } from '../../../../script.js';
import { registerSlashCommand } from '../../../../scripts/slash-commands.js';
import { getPresetManager } from '../../../../scripts/preset-manager.js';

const extensionName = 'savetavern';
const extensionFolder = 'third-party/savetavern';
const pluginBaseUrl = '/api/plugins/savetavern';
const postReloadNoticeKey = 'savetavern_post_reload_notice';
const autoReloadDelayMs = 2200;
const sceneThemeStorageKey = 'savetavern_scene_theme';
const quickReplySetName = 'SaveTavern';
const resourceLibrarySlashCommandName = 'st-library';
const legacySceneLibrarySlashCommandName = 'st-scenes';
const resourceLibraryCommand = `/${resourceLibrarySlashCommandName}`;
const legacySceneLibraryCommand = `/${legacySceneLibrarySlashCommandName}`;
const resourceLibraryQrLabel = '资源库';
const resourceLibraryQrTitle = '打开 SaveTavern 资源库';
const resourceLibraryTabs = Object.freeze({
    scenes: 'scenes',
    presetEntries: 'preset_entries',
});
const presetEntryApplyPanelState = Object.freeze({
    collapsed: 'collapsed',
    expanded: 'expanded',
});
const defaultSettings = Object.freeze({
    git_remote: '',
    git_branch: 'main',
    backup_enabled: true,
});

const {
    extensionSettings,
    saveSettingsDebounced,
    renderExtensionTemplateAsync,
    loader,
} = SillyTavern.getContext();

let pendingReloadTimer = null;
let currentScenes = [];
let currentPresetEntries = [];
let sceneLibraryElements = null;
let sceneLibraryInitialized = false;
let openingSceneLibrary = false;
let currentSceneTheme = 'light';
let currentLibraryTab = resourceLibraryTabs.scenes;
let currentPresetEntrySelection = new Set();
let currentCompletionPresetNames = [];
let currentPresetEntryApplyPanelState = presetEntryApplyPanelState.collapsed;

function ensureSettings() {
    extensionSettings[extensionName] = extensionSettings[extensionName] || {};

    for (const [key, value] of Object.entries(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[extensionName], key)) {
            extensionSettings[extensionName][key] = value;
        }
    }

    return extensionSettings[extensionName];
}

function getPluginMissingMessage() {
    return [
        'SaveTavern server plugin 未加载。',
        '前端扩展请通过 Git URL 安装，或放到 data/<user-handle>/extensions/third-party/savetavern。',
        '服务端插件请放到 plugins/savetavern/index.js。',
        '并确认 config.yaml 已启用 enableServerPlugins。',
    ].join(' ');
}

function getQuickReplyMissingMessage() {
    return '未检测到 Quick Reply 扩展，无法创建“SaveTavern 资源库”唯一入口按钮。';
}

async function requestJson(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: {
            ...getRequestHeaders(),
            ...(options.headers || {}),
        },
    });

    const text = await response.text();
    let data = {};

    if (text) {
        try {
            data = JSON.parse(text);
        } catch (error) {
            if (response.status === 404 && url.startsWith(pluginBaseUrl)) {
                throw new Error(getPluginMissingMessage());
            }
            throw new Error(`服务器返回了非 JSON 响应 (${response.status})`);
        }
    }

    if (!response.ok) {
        if (response.status === 404 && url.startsWith(pluginBaseUrl)) {
            throw new Error(getPluginMissingMessage());
        }
        throw new Error(data.error || `请求失败 (${response.status})`);
    }

    return data;
}

function getQuickReplyApi() {
    return globalThis.quickReplyApi || null;
}

function getSceneLibrarySyncSummary(result = {}) {
    const status = result.ready ? '已就绪' : '未就绪';
    const action = result.created ? '已创建' : result.updated ? '已更新' : '已检查';
    return `资源库入口：${status}（${action}）`;
}

function renderLogs(lines = []) {
    const logBox = $('#st-log-output');
    if (!logBox.length) {
        return;
    }

    if (!Array.isArray(lines) || lines.length === 0) {
        logBox.text('暂无日志');
        return;
    }

    logBox.text(lines.join('\n'));
    logBox.scrollTop(logBox[0].scrollHeight);
}

function formatStatsLine(label, stats = {}) {
    const created = Number(stats.created || 0);
    const updated = Number(stats.updated || 0);
    const skipped = Number(stats.skipped || 0);

    return `${label}：新增 ${created} / 更新 ${updated} / 跳过 ${skipped}`;
}

function formatImportSummary(lastResult = null) {
    if (!lastResult?.importResult) {
        return lastResult?.message || '暂无结果';
    }

    const lines = ['同步完成'];
    const categories = lastResult.importResult.categories || {};

    for (const [category, stats] of Object.entries(categories)) {
        lines.push(formatStatsLine(category, stats));
    }

    if (lastResult.importResult.messages) {
        lines.push(formatStatsLine('messages', lastResult.importResult.messages));
    }

    if (typeof lastResult.importResult.consumed === 'number') {
        lines.push(`仓库清理：已移除 ${lastResult.importResult.consumed} 个已同步文件`);
    }

    lines.push(`本地备份：${lastResult.importResult.backup_enabled !== false ? '已开启' : '已关闭'}`);

    return lines.join('\n');
}

function renderLastSummary(lastResult = null) {
    $('#st-last-summary').text(formatImportSummary(lastResult));
}

function renderRefreshHint(message = '同步完成后会自动刷新页面，以便立即看到导入结果。') {
    $('#st-refresh-hint').text(message);
}

function scheduleAutoReload(summaryText) {
    if (pendingReloadTimer) {
        clearTimeout(pendingReloadTimer);
    }

    sessionStorage.setItem(postReloadNoticeKey, summaryText);
    renderRefreshHint(`同步完成，将在 ${(autoReloadDelayMs / 1000).toFixed(1)} 秒后自动刷新页面，以显示新导入内容。`);

    pendingReloadTimer = window.setTimeout(() => {
        location.reload();
    }, autoReloadDelayMs);
}

function showPostReloadNotice() {
    const summaryText = sessionStorage.getItem(postReloadNoticeKey);
    if (!summaryText) {
        return;
    }

    sessionStorage.removeItem(postReloadNoticeKey);
    toastr.success(summaryText, 'SaveTavern 已自动刷新');
}

function formatSceneUpdatedAt(savedAt) {
    if (!savedAt) {
        return '未记录时间';
    }

    const parsed = new Date(savedAt);
    if (Number.isNaN(parsed.getTime())) {
        return String(savedAt);
    }

    return parsed.toLocaleString();
}

function getScenePreview(content) {
    const normalized = String(content || '').replace(/\s+/g, ' ').trim();
    if (!normalized) {
        return '内容为空';
    }
    return normalized.length > 96 ? `${normalized.slice(0, 96)}...` : normalized;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function normalizeSceneTheme(theme) {
    return theme === 'dark' ? 'dark' : 'light';
}

function normalizeLibraryTab(tab) {
    return tab === resourceLibraryTabs.presetEntries
        ? resourceLibraryTabs.presetEntries
        : resourceLibraryTabs.scenes;
}

function getCurrentLibraryItems() {
    return currentLibraryTab === resourceLibraryTabs.presetEntries
        ? currentPresetEntries
        : currentScenes;
}

function cloneData(value) {
    if (typeof structuredClone === 'function') {
        return structuredClone(value);
    }

    return JSON.parse(JSON.stringify(value));
}

function ensurePlainObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function getPresetEntrySelectionKey(item = {}) {
    return String(item.source_file || `${item.name || 'unnamed'}::${item.saved_at || ''}`);
}

function isPresetEntrySelected(item = {}) {
    return currentPresetEntrySelection.has(getPresetEntrySelectionKey(item));
}

function getSelectedPresetEntries() {
    return currentPresetEntries.filter((item) => isPresetEntrySelected(item));
}

function generateSaveTavernPromptIdentifier() {
    if (globalThis.crypto?.randomUUID) {
        return `savetavern_${globalThis.crypto.randomUUID()}`;
    }

    const randomPart = Math.random().toString(36).slice(2, 10);
    return `savetavern_${Date.now()}_${randomPart}`;
}

function createPresetEntryPrompt(item, identifier) {
    return {
        identifier,
        name: String(item.name || '未命名预设条目').trim() || '未命名预设条目',
        system_prompt: false,
        role: 'system',
        content: String(item.content || ''),
        marker: false,
        injection_position: 0,
        injection_depth: 4,
        injection_order: 100,
        injection_trigger: [],
        forbid_overrides: false,
        extension: false,
    };
}

function getOpenAiPresetManager() {
    const manager = getPresetManager('openai');
    if (!manager) {
        throw new Error('未找到 OpenAI/Chat Completion 预设管理器，请确认当前酒馆版本支持 preset-manager.js');
    }

    return manager;
}

function ensurePromptOrderEntries(preset) {
    if (Array.isArray(preset.prompt_order) && preset.prompt_order.length > 0) {
        return preset.prompt_order;
    }

    preset.prompt_order = [
        { character_id: 100000, order: [] },
        { character_id: 100001, order: [] },
    ];
    return preset.prompt_order;
}

function getPromptLabelMap(preset) {
    const prompts = Array.isArray(preset?.prompts) ? preset.prompts : [];
    const map = new Map();
    for (const prompt of prompts) {
        const identifier = String(prompt?.identifier || '').trim();
        if (!identifier) {
            continue;
        }
        map.set(identifier, String(prompt?.name || identifier));
    }
    return map;
}

function getPromptOrderAnchorOptions(preset) {
    const promptOrder = ensurePromptOrderEntries(preset);
    const primaryOrder = Array.isArray(promptOrder[0]?.order) ? promptOrder[0].order : [];
    const labelMap = getPromptLabelMap(preset);
    const items = [];
    const seen = new Set();

    for (const entry of primaryOrder) {
        const identifier = String(entry?.identifier || '').trim();
        if (!identifier || seen.has(identifier)) {
            continue;
        }
        seen.add(identifier);
        const label = labelMap.get(identifier) || identifier;
        items.push({
            value: identifier,
            label: `${label} (${identifier})`,
        });
    }

    return items;
}

function insertPromptIdentifierIntoOrder(order, promptIdentifier, anchorIdentifier, relation) {
    const nextOrder = Array.isArray(order) ? order.filter((entry) => String(entry?.identifier || '') !== promptIdentifier) : [];
    const promptEntry = { identifier: promptIdentifier, enabled: true };

    if (anchorIdentifier === '__top__') {
        nextOrder.unshift(promptEntry);
        return nextOrder;
    }

    if (anchorIdentifier === '__bottom__') {
        nextOrder.push(promptEntry);
        return nextOrder;
    }

    const anchorIndex = nextOrder.findIndex((entry) => String(entry?.identifier || '') === anchorIdentifier);
    if (anchorIndex === -1) {
        nextOrder.push(promptEntry);
        return nextOrder;
    }

    const insertIndex = relation === 'before' ? anchorIndex : anchorIndex + 1;
    nextOrder.splice(insertIndex, 0, promptEntry);
    return nextOrder;
}

async function refreshPresetTargetOptions(preferredPresetName = '') {
    const elements = buildSceneLibraryDom();
    if (!elements.targetPresetSelect) {
        return;
    }

    if (currentLibraryTab !== resourceLibraryTabs.presetEntries) {
        return;
    }

    const manager = getOpenAiPresetManager();
    const selectedPresetName = preferredPresetName || elements.targetPresetSelect.value || manager.getSelectedPresetName() || '';
    currentCompletionPresetNames = manager.getAllPresets().slice();

    elements.targetPresetSelect.innerHTML = '';
    for (const presetName of currentCompletionPresetNames) {
        const option = document.createElement('option');
        option.value = presetName;
        option.textContent = presetName;
        elements.targetPresetSelect.appendChild(option);
    }

    if (!currentCompletionPresetNames.length) {
        elements.targetPresetSelect.disabled = true;
        elements.positionPresetSelect.innerHTML = '';
        elements.positionPresetSelect.disabled = true;
        updatePresetEntryApplyControls();
        return;
    }

    const nextPresetName = currentCompletionPresetNames.includes(selectedPresetName)
        ? selectedPresetName
        : currentCompletionPresetNames[0];
    elements.targetPresetSelect.disabled = false;
    elements.targetPresetSelect.value = nextPresetName;
    await refreshPresetAnchorOptions(nextPresetName);
}

async function refreshPresetAnchorOptions(presetName = '') {
    const elements = buildSceneLibraryDom();
    if (!elements.positionPresetSelect) {
        return;
    }

    const manager = getOpenAiPresetManager();
    const targetPresetName = String(presetName || elements.targetPresetSelect.value || '').trim();
    const preset = manager.getCompletionPresetByName(targetPresetName);
    const options = preset ? getPromptOrderAnchorOptions(preset) : [];
    const previousValue = elements.positionPresetSelect.value;

    elements.positionPresetSelect.innerHTML = '';

    const topOption = document.createElement('option');
    topOption.value = '__top__';
    topOption.textContent = '顶部';
    elements.positionPresetSelect.appendChild(topOption);

    for (const item of options) {
        const option = document.createElement('option');
        option.value = item.value;
        option.textContent = item.label;
        elements.positionPresetSelect.appendChild(option);
    }

    const bottomOption = document.createElement('option');
    bottomOption.value = '__bottom__';
    bottomOption.textContent = '底部';
    elements.positionPresetSelect.appendChild(bottomOption);

    const allValues = Array.from(elements.positionPresetSelect.options).map((option) => option.value);
    elements.positionPresetSelect.value = allValues.includes(previousValue)
        ? previousValue
        : (options[0]?.value || '__bottom__');
    elements.positionPresetSelect.disabled = false;
    updatePresetEntryApplyControls();
}

function updatePresetEntryApplyControls() {
    const elements = buildSceneLibraryDom();
    if (!elements.presetEntryControls) {
        return;
    }

    const isPresetTab = currentLibraryTab === resourceLibraryTabs.presetEntries;
    const selectedItems = getSelectedPresetEntries();
    const selectedCount = selectedItems.length;
    const currentItems = getCurrentLibraryItems();
    const hasPresetOptions = elements.targetPresetSelect?.options?.length > 0;
    const canOpenApplyPanel = selectedCount > 0 && hasPresetOptions;
    const shouldExpandPanel = isPresetTab
        && canOpenApplyPanel
        && currentPresetEntryApplyPanelState === presetEntryApplyPanelState.expanded;

    elements.presetEntrySelectionSummary.textContent = `已选择 ${selectedCount} / ${currentItems.length} 条预设条目`;
    elements.presetEntryControls.hidden = !isPresetTab;
    elements.selectAllPresetEntriesButton.disabled = currentItems.length === 0;
    elements.clearPresetEntriesButton.disabled = selectedCount === 0;
    elements.openPresetEntryApplyPanelButton.hidden = selectedCount === 0;
    elements.openPresetEntryApplyPanelButton.disabled = !canOpenApplyPanel;
    elements.openPresetEntryApplyPanelButton.textContent = shouldExpandPanel ? '收起载入设置' : '载入到预设';
    elements.presetEntryApplyPanel.hidden = !shouldExpandPanel;
    elements.applyPresetEntriesButton.disabled = !canOpenApplyPanel;

    if (!canOpenApplyPanel) {
        currentPresetEntryApplyPanelState = presetEntryApplyPanelState.collapsed;
    }
}

function togglePresetEntrySelection(item, forceSelected = null) {
    const key = getPresetEntrySelectionKey(item);
    const shouldSelect = forceSelected === null ? !currentPresetEntrySelection.has(key) : Boolean(forceSelected);
    if (shouldSelect) {
        currentPresetEntrySelection.add(key);
    } else {
        currentPresetEntrySelection.delete(key);
    }

    if (!currentPresetEntrySelection.size) {
        currentPresetEntryApplyPanelState = presetEntryApplyPanelState.collapsed;
    }

    renderSceneCards();
}

function selectAllVisiblePresetEntries() {
    const visibleItems = getFilteredScenes();
    for (const item of visibleItems) {
        currentPresetEntrySelection.add(getPresetEntrySelectionKey(item));
    }

    renderSceneCards();
}

function clearSelectedPresetEntries() {
    currentPresetEntrySelection.clear();
    currentPresetEntryApplyPanelState = presetEntryApplyPanelState.collapsed;
    renderSceneCards();
}

function setPresetEntryApplyPanelExpanded(expanded) {
    currentPresetEntryApplyPanelState = expanded
        ? presetEntryApplyPanelState.expanded
        : presetEntryApplyPanelState.collapsed;
    updatePresetEntryApplyControls();
}

async function applySelectedPresetEntriesToPreset() {
    const elements = buildSceneLibraryDom();
    const selectedItems = getSelectedPresetEntries();
    if (!selectedItems.length) {
        throw new Error('请先选择至少一条预设条目');
    }

    const targetPresetName = String(elements.targetPresetSelect.value || '').trim();
    if (!targetPresetName) {
        throw new Error('请先选择目标预设');
    }

    const manager = getOpenAiPresetManager();
    const sourcePreset = manager.getCompletionPresetByName(targetPresetName);
    if (!sourcePreset) {
        throw new Error(`未找到目标预设：${targetPresetName}`);
    }

    const preset = cloneData(sourcePreset);
    preset.prompts = Array.isArray(preset.prompts) ? preset.prompts : [];
    const promptOrderLists = ensurePromptOrderEntries(preset);
    preset.extensions = ensurePlainObject(preset.extensions);
    preset.extensions.savetavern = ensurePlainObject(preset.extensions.savetavern);
    preset.extensions.savetavern.resources = ensurePlainObject(preset.extensions.savetavern.resources);

    const anchorIdentifier = String(elements.positionPresetSelect.value || '__bottom__');
    const relation = String(elements.positionRelationSelect.value || 'after') === 'before' ? 'before' : 'after';
    const promptLabelMap = getPromptLabelMap(preset);

    for (const item of selectedItems) {
        const resourceKey = getPresetEntrySelectionKey(item);
        const existingMeta = ensurePlainObject(preset.extensions.savetavern.resources[resourceKey]);
        const existingPromptIdentifier = String(existingMeta.identifier || '').trim();
        const existingPromptIndex = preset.prompts.findIndex((prompt) => String(prompt?.identifier || '') === existingPromptIdentifier);
        const promptIdentifier = existingPromptIndex >= 0 && existingPromptIdentifier
            ? existingPromptIdentifier
            : generateSaveTavernPromptIdentifier();

        const nextPrompt = createPresetEntryPrompt(item, promptIdentifier);
        if (existingPromptIndex >= 0) {
            preset.prompts[existingPromptIndex] = {
                ...preset.prompts[existingPromptIndex],
                ...nextPrompt,
            };
        } else {
            preset.prompts.push(nextPrompt);
        }

        for (const promptOrder of promptOrderLists) {
            promptOrder.order = insertPromptIdentifierIntoOrder(
                Array.isArray(promptOrder.order) ? promptOrder.order : [],
                promptIdentifier,
                anchorIdentifier,
                relation,
            );
        }

        preset.extensions.savetavern.resources[resourceKey] = {
            identifier: promptIdentifier,
            source_file: String(item.source_file || ''),
            name: String(item.name || ''),
            saved_at: String(item.saved_at || ''),
            applied_at: new Date().toISOString(),
            anchor_identifier: anchorIdentifier,
            anchor_label: anchorIdentifier === '__top__'
                ? '顶部'
                : anchorIdentifier === '__bottom__'
                    ? '底部'
                    : (promptLabelMap.get(anchorIdentifier) || anchorIdentifier),
            relation,
        };
    }

    await manager.savePreset(targetPresetName, preset);
    await refreshPresetTargetOptions(targetPresetName);
    currentPresetEntryApplyPanelState = presetEntryApplyPanelState.collapsed;
    updatePresetEntryApplyControls();

    toastr.success(`已将 ${selectedItems.length} 条预设条目写入预设「${targetPresetName}」`);
}

function getLibraryTabConfig(tab = currentLibraryTab) {
    const normalizedTab = normalizeLibraryTab(tab);
    if (normalizedTab === resourceLibraryTabs.presetEntries) {
        return {
            tab: normalizedTab,
            title: 'SaveTavern 资源库',
            subtitle: '统一查看和整理从 Discord 同步来的文本资源。',
            sectionTitle: '预设条目',
            note: '先勾选条目，再选择目标预设和插入位置，最后执行载入。',
            emptyText: '当前没有可用的预设条目资源。',
            editorTitle: '编辑预设条目',
            cancelText: '取消',
            readOnly: false,
        };
    }

    return {
        tab: resourceLibraryTabs.scenes,
        title: 'SaveTavern 资源库',
        subtitle: '统一查看和整理从 Discord 同步来的文本资源。',
        sectionTitle: '小剧场',
        note: '直接插入到输入框，或进入编辑面板修改内容。',
        emptyText: '当前没有可用的小剧场资源。',
        editorTitle: '编辑小剧场',
        cancelText: '取消',
        readOnly: false,
    };
}

function loadSceneTheme() {
    try {
        return normalizeSceneTheme(localStorage.getItem(sceneThemeStorageKey));
    } catch {
        return 'light';
    }
}

function saveSceneTheme(theme) {
    try {
        localStorage.setItem(sceneThemeStorageKey, normalizeSceneTheme(theme));
    } catch {
        // ignore storage failures
    }
}

function getSceneThemeIconSvg(theme) {
    if (theme === 'dark') {
        return `
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M12 4.75a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0V5.5a.75.75 0 0 1 .75-.75Zm0 11a3.75 3.75 0 1 0 0-7.5 3.75 3.75 0 0 0 0 7.5Zm7.25-4.5a.75.75 0 0 1 0 1.5h-1.5a.75.75 0 0 1 0-1.5h1.5ZM7 12a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 7 12Zm9.419-4.919a.75.75 0 0 1 1.06 0l1.061 1.06a.75.75 0 0 1-1.06 1.061l-1.061-1.06a.75.75 0 0 1 0-1.061Zm-9.898 9.9a.75.75 0 0 1 1.06 0l1.061 1.06a.75.75 0 1 1-1.06 1.061L6.52 18.04a.75.75 0 0 1 0-1.06Zm11.019 0a.75.75 0 0 1 0 1.06l-1.06 1.061a.75.75 0 1 1-1.061-1.06l1.06-1.061a.75.75 0 0 1 1.061 0ZM8.641 7.08a.75.75 0 0 1 0 1.061L7.58 9.202A.75.75 0 0 1 6.52 8.14l1.06-1.06a.75.75 0 0 1 1.061 0ZM12 17a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 12 17Z"/>
            </svg>
        `;
    }

    return `
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M14.96 3.79a.75.75 0 0 1 .83.96 7.251 7.251 0 0 0 8.46 9.46.75.75 0 0 1 .82.83A9.25 9.25 0 1 1 14.96 3.79Z"/>
        </svg>
    `;
}

function getSceneCloseIconSvg() {
    return `
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M6.53 5.47a.75.75 0 0 1 1.06 0L12 9.94l4.41-4.47a.75.75 0 1 1 1.08 1.04L13.06 11l4.43 4.49a.75.75 0 0 1-1.08 1.04L12 12.06l-4.41 4.47a.75.75 0 0 1-1.08-1.04L10.94 11 6.53 6.51a.75.75 0 0 1 0-1.04Z"/>
        </svg>
    `;
}

function applySceneTheme(theme) {
    currentSceneTheme = normalizeSceneTheme(theme);
    const elements = buildSceneLibraryDom();
    elements.overlay.dataset.theme = currentSceneTheme;
    elements.themeButton.innerHTML = getSceneThemeIconSvg(currentSceneTheme);
    elements.themeButton.setAttribute('aria-label', currentSceneTheme === 'dark' ? '切换到日间主题' : '切换到夜间主题');
    elements.themeButton.title = currentSceneTheme === 'dark' ? '切换到日间主题' : '切换到夜间主题';
    saveSceneTheme(currentSceneTheme);
}

function toggleSceneTheme() {
    applySceneTheme(currentSceneTheme === 'dark' ? 'light' : 'dark');
}

function insertSceneIntoInput(content) {
    const textarea = document.querySelector('#send_textarea');
    if (!(textarea instanceof HTMLTextAreaElement)) {
        throw new Error('未找到酒馆输入框 #send_textarea');
    }

    const text = String(content || '');
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    textarea.value = `${before}${text}${after}`;

    const cursor = before.length + text.length;
    textarea.selectionStart = cursor;
    textarea.selectionEnd = cursor;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    textarea.focus();
}

function formatPresetEntryTagWrapper(name, content) {
    const safeName = String(name || '').trim() || '未命名条目';
    const text = String(content || '');
    return `<${safeName}>\n${text}\n</${safeName}>`;
}

function formatPresetEntrySetVarWrapper(name, content) {
    const safeName = String(name || '').trim() || '未命名条目';
    const text = String(content || '');
    return `{{setvar::${safeName}::\n${text}\n}}`;
}

function wrapPresetEntryEditorContent(wrapperType) {
    const elements = buildSceneLibraryDom();
    if (elements.activeEditorKind !== resourceLibraryTabs.presetEntries) {
        throw new Error('当前仅支持在预设条目编辑窗口使用该包裹功能');
    }

    const name = String(elements.nameInput.value || '').trim();
    const content = String(elements.contentInput.value || '');
    elements.contentInput.value = wrapperType === 'setvar'
        ? formatPresetEntrySetVarWrapper(name, content)
        : formatPresetEntryTagWrapper(name, content);
    elements.contentInput.dispatchEvent(new Event('input', { bubbles: true }));
    elements.contentInput.dispatchEvent(new Event('change', { bubbles: true }));
    elements.contentInput.focus();
}

async function writeTextToClipboard(text) {
    const value = String(text ?? '');
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', 'readonly');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();

    const copied = document.execCommand('copy');
    document.body.removeChild(textarea);
    if (!copied) {
        throw new Error('当前环境不支持复制到剪贴板');
    }
}

function buildSceneLibraryDom() {
    if (sceneLibraryElements) {
        return sceneLibraryElements;
    }

    const overlay = document.createElement('div');
    overlay.className = 'savetavern-scene-overlay';
    overlay.hidden = true;

    const panel = document.createElement('section');
    panel.className = 'savetavern-scene-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'savetavern-scene-title');

    const header = document.createElement('header');
    header.className = 'savetavern-scene-header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'savetavern-scene-heading';

    const title = document.createElement('h2');
    title.id = 'savetavern-scene-title';
    title.textContent = 'SaveTavern 资源库';

    const eyebrow = document.createElement('div');
    eyebrow.className = 'savetavern-scene-eyebrow';
    eyebrow.textContent = 'SAVE . TAVERN . LIBRARY';

    const subtitle = document.createElement('p');
    subtitle.className = 'savetavern-scene-subtitle';
    subtitle.textContent = getLibraryTabConfig().subtitle;

    titleWrap.append(eyebrow, title, subtitle);

    const headerActions = document.createElement('div');
    headerActions.className = 'savetavern-scene-header-actions';

    const themeButton = document.createElement('button');
    themeButton.type = 'button';
    themeButton.className = 'savetavern-scene-button savetavern-scene-theme-button';

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'savetavern-scene-button savetavern-scene-close';
    closeButton.setAttribute('aria-label', '关闭 SaveTavern 资源库');
    closeButton.title = '关闭 SaveTavern 资源库';
    closeButton.innerHTML = getSceneCloseIconSvg();

    headerActions.append(themeButton, closeButton);
    header.append(titleWrap, headerActions);

    const toolbar = document.createElement('div');
    toolbar.className = 'savetavern-scene-toolbar';

    const tabBar = document.createElement('div');
    tabBar.className = 'savetavern-scene-tabs';

    const sceneTabButton = document.createElement('button');
    sceneTabButton.type = 'button';
    sceneTabButton.className = 'savetavern-scene-button savetavern-scene-tab-button';
    sceneTabButton.textContent = '小剧场';
    sceneTabButton.dataset.tab = resourceLibraryTabs.scenes;

    const presetEntryTabButton = document.createElement('button');
    presetEntryTabButton.type = 'button';
    presetEntryTabButton.className = 'savetavern-scene-button savetavern-scene-tab-button';
    presetEntryTabButton.textContent = '预设条目';
    presetEntryTabButton.dataset.tab = resourceLibraryTabs.presetEntries;

    tabBar.append(sceneTabButton, presetEntryTabButton);

    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'text_pole savetavern-scene-search savetavern-scene-input';
    searchInput.placeholder = '搜索标题或内容';

    const countBadge = document.createElement('div');
    countBadge.className = 'savetavern-scene-count';
    countBadge.textContent = '0 条';

    const refreshButton = document.createElement('button');
    refreshButton.type = 'button';
    refreshButton.className = 'savetavern-scene-button savetavern-scene-button-secondary';
    refreshButton.textContent = '更新';

    toolbar.append(tabBar, refreshButton, searchInput, countBadge);

    const body = document.createElement('div');
    body.className = 'savetavern-scene-body';

    const contentFrame = document.createElement('section');
    contentFrame.className = 'savetavern-library-content';

    const sectionHeader = document.createElement('div');
    sectionHeader.className = 'savetavern-library-section-header';

    const sectionTitle = document.createElement('h3');
    sectionTitle.className = 'savetavern-library-section-title';
    sectionTitle.textContent = getLibraryTabConfig().sectionTitle;

    const note = document.createElement('p');
    note.className = 'savetavern-scene-note';
    note.textContent = getLibraryTabConfig().note;

    sectionHeader.append(sectionTitle, note);

    const presetEntryControls = document.createElement('section');
    presetEntryControls.className = 'savetavern-preset-entry-controls';
    presetEntryControls.hidden = true;

    const presetEntrySelectionSummary = document.createElement('div');
    presetEntrySelectionSummary.className = 'savetavern-preset-entry-summary';
    presetEntrySelectionSummary.textContent = '已选择 0 / 0 条预设条目';

    const presetEntrySelectionActions = document.createElement('div');
    presetEntrySelectionActions.className = 'savetavern-preset-entry-actions';

    const selectAllPresetEntriesButton = document.createElement('button');
    selectAllPresetEntriesButton.type = 'button';
    selectAllPresetEntriesButton.className = 'savetavern-scene-button savetavern-scene-button-secondary';
    selectAllPresetEntriesButton.textContent = '全选当前结果';

    const clearPresetEntriesButton = document.createElement('button');
    clearPresetEntriesButton.type = 'button';
    clearPresetEntriesButton.className = 'savetavern-scene-button savetavern-scene-button-secondary';
    clearPresetEntriesButton.textContent = '清空选择';

    presetEntrySelectionActions.append(selectAllPresetEntriesButton, clearPresetEntriesButton);

    const presetEntryPanelToggleRow = document.createElement('div');
    presetEntryPanelToggleRow.className = 'savetavern-preset-entry-actions';

    const openPresetEntryApplyPanelButton = document.createElement('button');
    openPresetEntryApplyPanelButton.type = 'button';
    openPresetEntryApplyPanelButton.className = 'savetavern-scene-button savetavern-scene-button-primary';
    openPresetEntryApplyPanelButton.textContent = '载入到预设';

    presetEntryPanelToggleRow.append(openPresetEntryApplyPanelButton);

    const presetEntryApplyPanel = document.createElement('div');
    presetEntryApplyPanel.className = 'savetavern-preset-entry-config-panel';
    presetEntryApplyPanel.hidden = true;

    const presetEntryTargetGrid = document.createElement('div');
    presetEntryTargetGrid.className = 'savetavern-preset-entry-target-grid';

    const targetPresetLabel = document.createElement('label');
    targetPresetLabel.className = 'savetavern-field';
    const targetPresetText = document.createElement('span');
    targetPresetText.textContent = '目标预设';
    const targetPresetSelect = document.createElement('select');
    targetPresetSelect.className = 'text_pole savetavern-scene-input';
    targetPresetLabel.append(targetPresetText, targetPresetSelect);

    const positionRelationLabel = document.createElement('label');
    positionRelationLabel.className = 'savetavern-field';
    const positionRelationText = document.createElement('span');
    positionRelationText.textContent = '插入方向';
    const positionRelationSelect = document.createElement('select');
    positionRelationSelect.className = 'text_pole savetavern-scene-input';
    for (const relationOption of [
        { value: 'after', label: '放在后面' },
        { value: 'before', label: '放在前面' },
    ]) {
        const option = document.createElement('option');
        option.value = relationOption.value;
        option.textContent = relationOption.label;
        positionRelationSelect.appendChild(option);
    }
    positionRelationLabel.append(positionRelationText, positionRelationSelect);

    const positionPresetLabel = document.createElement('label');
    positionPresetLabel.className = 'savetavern-field';
    const positionPresetText = document.createElement('span');
    positionPresetText.textContent = '锚点条目';
    const positionPresetSelect = document.createElement('select');
    positionPresetSelect.className = 'text_pole savetavern-scene-input';
    positionPresetLabel.append(positionPresetText, positionPresetSelect);

    presetEntryTargetGrid.append(targetPresetLabel, positionRelationLabel, positionPresetLabel);

    const presetEntryApplyHint = document.createElement('div');
    presetEntryApplyHint.className = 'savetavern-preset-entry-hint';
    presetEntryApplyHint.textContent = '位置会同步写入该预设的所有 prompt_order 变体，应用后该预设会自动保存并切换到最新状态。';

    const presetEntryApplyActions = document.createElement('div');
    presetEntryApplyActions.className = 'savetavern-preset-entry-actions';

    const applyPresetEntriesButton = document.createElement('button');
    applyPresetEntriesButton.type = 'button';
    applyPresetEntriesButton.className = 'savetavern-scene-button savetavern-scene-button-primary';
    applyPresetEntriesButton.textContent = '确认载入';

    presetEntryApplyActions.append(applyPresetEntriesButton);
    presetEntryApplyPanel.append(
        presetEntryTargetGrid,
        presetEntryApplyHint,
        presetEntryApplyActions,
    );
    presetEntryControls.append(
        presetEntrySelectionSummary,
        presetEntrySelectionActions,
        presetEntryPanelToggleRow,
        presetEntryApplyPanel,
    );

    const listFrame = document.createElement('div');
    listFrame.className = 'savetavern-scene-list-frame';

    const listViewport = document.createElement('div');
    listViewport.className = 'savetavern-scene-list-viewport';

    const list = document.createElement('div');
    list.className = 'savetavern-scene-list';

    const emptyState = document.createElement('div');
    emptyState.className = 'savetavern-scene-empty';
    emptyState.textContent = '当前没有可用的小剧场资源。';
    emptyState.hidden = true;

    listViewport.append(list, emptyState);
    listFrame.append(sectionHeader, presetEntryControls, listViewport);
    contentFrame.appendChild(listFrame);
    body.appendChild(contentFrame);

    const editor = document.createElement('aside');
    editor.className = 'savetavern-scene-editor';
    editor.hidden = true;

    const editorBackdrop = document.createElement('div');
    editorBackdrop.className = 'savetavern-scene-editor-backdrop';

    const editorCard = document.createElement('div');
    editorCard.className = 'savetavern-scene-editor-card';

    const editorTitle = document.createElement('div');
    editorTitle.className = 'savetavern-scene-editor-title';
    editorTitle.textContent = getLibraryTabConfig().editorTitle;

    const nameLabel = document.createElement('label');
    nameLabel.className = 'savetavern-field';
    const nameText = document.createElement('span');
    nameText.textContent = '标题';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'text_pole savetavern-scene-input';
    nameLabel.append(nameText, nameInput);

    const contentLabel = document.createElement('label');
    contentLabel.className = 'savetavern-field';
    const contentText = document.createElement('span');
    contentText.textContent = '内容';
    const contentInput = document.createElement('textarea');
    contentInput.className = 'text_pole savetavern-scene-input savetavern-scene-editor-textarea';
    contentInput.rows = 11;
    contentLabel.append(contentText, contentInput);

    const editorMeta = document.createElement('div');
    editorMeta.className = 'savetavern-scene-editor-meta';

    const editorActions = document.createElement('div');
    editorActions.className = 'savetavern-scene-editor-actions';

    const editorUtilityActions = document.createElement('div');
    editorUtilityActions.className = 'savetavern-scene-editor-utility-actions';
    editorUtilityActions.hidden = true;

    const insertTagWrappedButton = document.createElement('button');
    insertTagWrappedButton.type = 'button';
    insertTagWrappedButton.className = 'savetavern-scene-button savetavern-scene-button-secondary';
    insertTagWrappedButton.textContent = '插入标签包裹';

    const insertSetVarWrappedButton = document.createElement('button');
    insertSetVarWrappedButton.type = 'button';
    insertSetVarWrappedButton.className = 'savetavern-scene-button savetavern-scene-button-secondary';
    insertSetVarWrappedButton.textContent = '插入变量包裹';

    editorUtilityActions.append(insertTagWrappedButton, insertSetVarWrappedButton);

    const cancelEditButton = document.createElement('button');
    cancelEditButton.type = 'button';
    cancelEditButton.className = 'savetavern-scene-button savetavern-scene-button-secondary';
    cancelEditButton.textContent = '取消';

    const saveEditButton = document.createElement('button');
    saveEditButton.type = 'button';
    saveEditButton.className = 'savetavern-scene-button savetavern-scene-button-primary';
    saveEditButton.textContent = '保存';

    editorActions.append(cancelEditButton, saveEditButton);
    editorCard.append(editorTitle, nameLabel, contentLabel, editorMeta, editorUtilityActions, editorActions);
    editor.append(editorBackdrop, editorCard);

    panel.append(header, toolbar, body, editor);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    sceneLibraryElements = {
        overlay,
        panel,
        title,
        subtitle,
        sectionTitle,
        note,
        presetEntryControls,
        presetEntrySelectionSummary,
        selectAllPresetEntriesButton,
        clearPresetEntriesButton,
        openPresetEntryApplyPanelButton,
        presetEntryApplyPanel,
        targetPresetSelect,
        positionRelationSelect,
        positionPresetSelect,
        applyPresetEntriesButton,
        sceneTabButton,
        presetEntryTabButton,
        searchInput,
        countBadge,
        refreshButton,
        themeButton,
        list,
        emptyState,
        editor,
        editorBackdrop,
        editorTitle,
        editorMeta,
        editorUtilityActions,
        insertTagWrappedButton,
        insertSetVarWrappedButton,
        nameInput,
        contentInput,
        closeButton,
        cancelEditButton,
        saveEditButton,
        activeSceneSourceFile: null,
        activeEditorKind: resourceLibraryTabs.scenes,
    };

    applySceneTheme(currentSceneTheme);

    return sceneLibraryElements;
}

function closeSceneLibrary() {
    const elements = buildSceneLibraryDom();
    setEditorState(null);
    elements.overlay.hidden = true;
    document.body.classList.remove('savetavern-scene-open');
}

function openSceneLibraryShell() {
    const elements = buildSceneLibraryDom();
    elements.overlay.hidden = false;
    document.body.classList.add('savetavern-scene-open');
    window.setTimeout(() => {
        elements.searchInput.focus();
    }, 0);
}

function updateLibraryChrome() {
    const elements = buildSceneLibraryDom();
    const config = getLibraryTabConfig();
    const totalCount = getCurrentLibraryItems().length;
    elements.title.textContent = config.title;
    elements.subtitle.textContent = config.subtitle;
    elements.sectionTitle.textContent = config.sectionTitle;
    elements.note.textContent = config.note;
    elements.emptyState.textContent = config.emptyText;
    elements.sceneTabButton.classList.toggle('is-active', currentLibraryTab === resourceLibraryTabs.scenes);
    elements.presetEntryTabButton.classList.toggle('is-active', currentLibraryTab === resourceLibraryTabs.presetEntries);
    elements.sceneTabButton.setAttribute('aria-pressed', String(currentLibraryTab === resourceLibraryTabs.scenes));
    elements.presetEntryTabButton.setAttribute('aria-pressed', String(currentLibraryTab === resourceLibraryTabs.presetEntries));
    if (!elements.searchInput.value.trim()) {
        elements.countBadge.textContent = `${totalCount} 条`;
    }

    updatePresetEntryApplyControls();
}

function setLibraryTab(tab) {
    currentLibraryTab = normalizeLibraryTab(tab);
    if (currentLibraryTab !== resourceLibraryTabs.presetEntries) {
        currentPresetEntryApplyPanelState = presetEntryApplyPanelState.collapsed;
    }
    setEditorState(null);
    renderSceneCards();
    if (currentLibraryTab === resourceLibraryTabs.presetEntries) {
        refreshPresetTargetOptions().catch((error) => {
            console.error('[SaveTavern] 刷新预设列表失败', error);
            toastr.error(error.message || '刷新预设列表失败');
        });
    }
}

function setEditorState(sceneItem = null, editorKind = resourceLibraryTabs.scenes) {
    const elements = buildSceneLibraryDom();
    const normalizedKind = normalizeLibraryTab(editorKind);
    if (!sceneItem) {
        elements.editor.hidden = true;
        elements.activeSceneSourceFile = null;
        elements.activeEditorKind = resourceLibraryTabs.scenes;
        elements.editorTitle.textContent = getLibraryTabConfig().editorTitle;
        elements.nameInput.value = '';
        elements.contentInput.value = '';
        elements.nameInput.readOnly = false;
        elements.contentInput.readOnly = false;
        elements.editorMeta.textContent = '';
        elements.editorUtilityActions.hidden = true;
        elements.cancelEditButton.textContent = '取消';
        elements.saveEditButton.hidden = false;
        return;
    }

    const config = getLibraryTabConfig(normalizedKind);
    elements.editor.hidden = false;
    elements.activeSceneSourceFile = normalizedKind === resourceLibraryTabs.scenes ? sceneItem.source_file || null : null;
    elements.activeEditorKind = normalizedKind;
    elements.editorTitle.textContent = config.editorTitle;
    elements.nameInput.value = sceneItem.name || '';
    elements.contentInput.value = sceneItem.content || '';
    elements.nameInput.readOnly = config.readOnly;
    elements.contentInput.readOnly = config.readOnly;
    elements.cancelEditButton.textContent = config.cancelText;
    elements.saveEditButton.hidden = config.readOnly;
    elements.editorUtilityActions.hidden = normalizedKind !== resourceLibraryTabs.presetEntries;
    elements.editorMeta.textContent = sceneItem.source_file
        ? `来源：${sceneItem.source_file} · 更新时间：${formatSceneUpdatedAt(sceneItem.saved_at)}`
        : `更新时间：${formatSceneUpdatedAt(sceneItem.saved_at)}`;
    window.setTimeout(() => {
        if (config.readOnly) {
            elements.contentInput.focus();
            return;
        }
        elements.nameInput.focus();
        elements.nameInput.select();
    }, 0);
}

function getFilteredScenes() {
    const elements = buildSceneLibraryDom();
    const keyword = String(elements.searchInput.value || '').trim().toLowerCase();
    const items = getCurrentLibraryItems();
    if (!keyword) {
        return items;
    }

    return items.filter((item) => {
        const name = String(item.name || '').toLowerCase();
        const content = String(item.content || '').toLowerCase();
        const sourceFile = String(item.source_file || '').toLowerCase();
        return name.includes(keyword) || content.includes(keyword) || sourceFile.includes(keyword);
    });
}

function renderSceneCards() {
    const elements = buildSceneLibraryDom();
    updateLibraryChrome();
    const filteredScenes = getFilteredScenes();
    const currentItems = getCurrentLibraryItems();
    elements.list.innerHTML = '';
    elements.countBadge.textContent = `${filteredScenes.length} / ${currentItems.length} 条`;
    elements.emptyState.hidden = filteredScenes.length !== 0;

    for (const item of filteredScenes) {
        const card = document.createElement('section');
        card.className = 'savetavern-scene-card';
        if (currentLibraryTab === resourceLibraryTabs.presetEntries && isPresetEntrySelected(item)) {
            card.classList.add('is-selected');
        }

        const top = document.createElement('div');
        top.className = 'savetavern-scene-card-top';

        const headingWrap = document.createElement('div');
        headingWrap.className = 'savetavern-scene-card-heading';

        const heading = document.createElement('h3');
        heading.className = 'savetavern-scene-card-title';
        heading.textContent = item.name || (currentLibraryTab === resourceLibraryTabs.presetEntries ? '未命名预设条目' : '未命名小剧场');

        const meta = document.createElement('div');
        meta.className = 'savetavern-scene-card-meta';
        meta.textContent = formatSceneUpdatedAt(item.saved_at);

        const preview = document.createElement('div');
        preview.className = 'savetavern-scene-card-preview';
        preview.innerHTML = escapeHtml(getScenePreview(item.content)).replaceAll('\n', '<br />');

        headingWrap.append(heading, meta, preview);

        const actions = document.createElement('div');
        actions.className = 'savetavern-scene-card-actions';

        if (currentLibraryTab === resourceLibraryTabs.presetEntries) {
            const previewButton = document.createElement('button');
            previewButton.type = 'button';
            previewButton.className = 'savetavern-scene-button savetavern-scene-button-secondary';
            previewButton.textContent = '查看';
            previewButton.addEventListener('click', () => {
                setEditorState(item, resourceLibraryTabs.presetEntries);
            });

            const copyButton = document.createElement('button');
            copyButton.type = 'button';
            copyButton.className = 'savetavern-scene-button savetavern-scene-button-secondary';
            copyButton.textContent = '复制';
            copyButton.addEventListener('click', async (event) => {
                event.stopPropagation();
                try {
                    await writeTextToClipboard(item.content || '');
                    toastr.success(`已复制：${item.name || '未命名预设条目'}`);
                } catch (error) {
                    console.error('[SaveTavern] 复制预设条目失败', error);
                    toastr.error(error.message || '复制失败');
                }
            });

            const toggleSelectButton = document.createElement('button');
            toggleSelectButton.type = 'button';
            toggleSelectButton.className = isPresetEntrySelected(item)
                ? 'savetavern-scene-button savetavern-scene-button-primary'
                : 'savetavern-scene-button savetavern-scene-button-secondary';
            toggleSelectButton.textContent = isPresetEntrySelected(item) ? '已选' : '选择';
            toggleSelectButton.addEventListener('click', (event) => {
                event.stopPropagation();
                togglePresetEntrySelection(item);
            });

            actions.append(previewButton, copyButton, toggleSelectButton);
        } else {
            const insertButton = document.createElement('button');
            insertButton.type = 'button';
            insertButton.className = 'savetavern-scene-button savetavern-scene-button-primary';
            insertButton.textContent = '插入';
            insertButton.addEventListener('click', () => {
                try {
                    insertSceneIntoInput(item.content || '');
                    closeSceneLibrary();
                    toastr.success(`已插入：${item.name || '未命名小剧场'}`);
                } catch (error) {
                    console.error('[SaveTavern] 插入小剧场失败', error);
                    toastr.error(error.message || '插入失败');
                }
            });

            const editButton = document.createElement('button');
            editButton.type = 'button';
            editButton.className = 'savetavern-scene-button savetavern-scene-button-secondary';
            editButton.textContent = '编辑';
            editButton.addEventListener('click', () => {
                setEditorState(item, resourceLibraryTabs.scenes);
            });

            actions.append(insertButton, editButton);
        }
        top.append(headingWrap, actions);

        card.appendChild(top);
        elements.list.appendChild(card);
    }
}

async function fetchScenes() {
    const response = await requestJson(`${pluginBaseUrl}/scenes`);
    currentScenes = Array.isArray(response.items) ? response.items : [];
    return currentScenes;
}

async function fetchPresetEntries() {
    const response = await requestJson(`${pluginBaseUrl}/preset-entries`);
    currentPresetEntries = Array.isArray(response.items) ? response.items : [];
    return currentPresetEntries;
}

async function refreshSceneLibrary(showToast = false) {
    await Promise.all([fetchScenes(), fetchPresetEntries()]);
    renderSceneCards();
    if (showToast) {
        toastr.success('SaveTavern 资源库已刷新');
    }
}

async function saveResourceFromEditor() {
    const elements = buildSceneLibraryDom();

    const name = String(elements.nameInput.value || '').trim();
    const content = String(elements.contentInput.value || '');

    if (!name) {
        throw new Error('标题不能为空');
    }

    let saveUrl = '';
    let successMessage = '';
    if (elements.activeEditorKind === resourceLibraryTabs.presetEntries) {
        saveUrl = `${pluginBaseUrl}/preset-entries/save`;
        successMessage = '预设条目已保存';
    } else {
        saveUrl = `${pluginBaseUrl}/scenes/save`;
        successMessage = '小剧场已保存';
    }

    const response = await requestJson(saveUrl, {
        method: 'POST',
        body: JSON.stringify({
            source_file: elements.activeSceneSourceFile,
            name,
            content,
        }),
    });

    await refreshSceneLibrary(false);

    const savedItem = response.item || null;
    if (savedItem?.source_file) {
        elements.activeSceneSourceFile = savedItem.source_file;
    } else {
        elements.activeSceneSourceFile = null;
    }

    setEditorState(null);
    toastr.success(successMessage);
}

function initializeSceneLibraryUi() {
    if (sceneLibraryInitialized) {
        return;
    }

    const elements = buildSceneLibraryDom();

    elements.overlay.addEventListener('click', (event) => {
        if (event.target === elements.overlay) {
            closeSceneLibrary();
        }
    });

    elements.closeButton.addEventListener('click', () => {
        closeSceneLibrary();
    });

    elements.themeButton.addEventListener('click', () => {
        toggleSceneTheme();
    });

    elements.sceneTabButton.addEventListener('click', () => {
        setLibraryTab(resourceLibraryTabs.scenes);
    });

    elements.presetEntryTabButton.addEventListener('click', () => {
        setLibraryTab(resourceLibraryTabs.presetEntries);
    });

    elements.editorBackdrop.addEventListener('click', () => {
        setEditorState(null);
    });

    elements.refreshButton.addEventListener('click', async () => {
        try {
            await refreshSceneLibrary(true);
        } catch (error) {
            console.error('[SaveTavern] 刷新资源库失败', error);
            toastr.error(error.message || '刷新资源库失败');
        }
    });

    elements.searchInput.addEventListener('input', () => {
        renderSceneCards();
    });

    elements.selectAllPresetEntriesButton.addEventListener('click', () => {
        selectAllVisiblePresetEntries();
    });

    elements.clearPresetEntriesButton.addEventListener('click', () => {
        clearSelectedPresetEntries();
    });

    elements.openPresetEntryApplyPanelButton.addEventListener('click', () => {
        if (!getSelectedPresetEntries().length) {
            return;
        }
        setPresetEntryApplyPanelExpanded(
            currentPresetEntryApplyPanelState !== presetEntryApplyPanelState.expanded
        );
    });

    elements.targetPresetSelect.addEventListener('change', async () => {
        try {
            await refreshPresetAnchorOptions(elements.targetPresetSelect.value);
        } catch (error) {
            console.error('[SaveTavern] 刷新预设锚点失败', error);
            toastr.error(error.message || '刷新预设锚点失败');
        }
    });

    elements.positionRelationSelect.addEventListener('change', () => {
        updatePresetEntryApplyControls();
    });

    elements.positionPresetSelect.addEventListener('change', () => {
        updatePresetEntryApplyControls();
    });

    elements.applyPresetEntriesButton.addEventListener('click', async () => {
        try {
            await applySelectedPresetEntriesToPreset();
        } catch (error) {
            console.error('[SaveTavern] 写入预设失败', error);
            toastr.error(error.message || '写入预设失败');
        }
    });

    elements.cancelEditButton.addEventListener('click', () => {
        setEditorState(null);
    });

    elements.insertTagWrappedButton.addEventListener('click', () => {
        try {
            wrapPresetEntryEditorContent('tag');
            toastr.success('已在编辑框内套用标签包裹');
        } catch (error) {
            console.error('[SaveTavern] 插入标签包裹失败', error);
            toastr.error(error.message || '插入失败');
        }
    });

    elements.insertSetVarWrappedButton.addEventListener('click', () => {
        try {
            wrapPresetEntryEditorContent('setvar');
            toastr.success('已在编辑框内套用变量包裹');
        } catch (error) {
            console.error('[SaveTavern] 插入变量包裹失败', error);
            toastr.error(error.message || '插入失败');
        }
    });

    elements.saveEditButton.addEventListener('click', async () => {
        try {
            await saveResourceFromEditor();
        } catch (error) {
            console.error('[SaveTavern] 保存资源失败', error);
            toastr.error(error.message || '保存资源失败');
        }
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !elements.overlay.hidden) {
            if (!elements.editor.hidden) {
                setEditorState(null);
                return;
            }
            closeSceneLibrary();
        }
    });

    sceneLibraryInitialized = true;
}

async function openSceneLibrary() {
    if (openingSceneLibrary) {
        return;
    }

    openingSceneLibrary = true;
    try {
        currentSceneTheme = loadSceneTheme();
        currentPresetEntryApplyPanelState = presetEntryApplyPanelState.collapsed;
        initializeSceneLibraryUi();
        applySceneTheme(currentSceneTheme);
        openSceneLibraryShell();
        setEditorState(null);
        updateLibraryChrome();
        await refreshSceneLibrary(false);
    } finally {
        openingSceneLibrary = false;
    }
}

async function registerSceneLibrarySlashCommand() {
    if (typeof registerSlashCommand !== 'function') {
        return false;
    }

    if (globalThis.__savetavernSceneCommandRegistered) {
        return true;
    }

    registerSlashCommand(
        resourceLibrarySlashCommandName,
        async () => {
            await openSceneLibrary();
            return '';
        },
        [],
        '打开 SaveTavern 资源库'
    );

    registerSlashCommand(
        legacySceneLibrarySlashCommandName,
        async () => {
            await openSceneLibrary();
            return '';
        },
        [],
        '打开 SaveTavern 小剧场库（兼容入口）'
    );

    globalThis.__savetavernSceneCommandRegistered = true;
    return true;
}

async function ensureSceneLibraryQuickReply() {
    const quickReplyApi = getQuickReplyApi();
    if (!quickReplyApi) {
        throw new Error(getQuickReplyMissingMessage());
    }

    const commandRegistered = await registerSceneLibrarySlashCommand();
    if (!commandRegistered) {
        throw new Error('未找到 Slash Command 注册入口，暂时无法为 Quick Reply 绑定资源库入口');
    }

    let set = quickReplyApi.getSetByName(quickReplySetName);
    if (!set) {
        set = await quickReplyApi.createSet(quickReplySetName, {
            disableSend: false,
            placeBeforeInput: false,
            injectInput: false,
        });
    } else {
        await quickReplyApi.updateSet(quickReplySetName, {
            disableSend: false,
            placeBeforeInput: false,
            injectInput: false,
        });
    }

    const activeSets = quickReplyApi.listGlobalSets();
    if (!activeSets.includes(quickReplySetName)) {
        quickReplyApi.addGlobalSet(quickReplySetName, true);
    }

    const hasLibraryQr = quickReplyApi.listQuickReplies(quickReplySetName).includes(resourceLibraryQrLabel);
    const payload = {
        message: resourceLibraryCommand,
        title: resourceLibraryQrTitle,
        isHidden: false,
    };

    let created = false;
    let updated = false;

    if (!hasLibraryQr) {
        quickReplyApi.createQuickReply(quickReplySetName, resourceLibraryQrLabel, payload);
        created = true;
    } else {
        quickReplyApi.updateQuickReply(quickReplySetName, resourceLibraryQrLabel, payload);
        updated = true;
    }

    const currentSet = quickReplyApi.getSetByName(quickReplySetName);
    const currentLabels = new Set(currentSet?.qrList?.map(item => item.label) || []);
    for (const label of currentLabels) {
        if (label === resourceLibraryQrLabel) {
            continue;
        }
        quickReplyApi.deleteQuickReply(quickReplySetName, label);
    }

    return {
        ready: true,
        created,
        updated,
    };
}

function renderStatus(state = {}) {
    const settings = ensureSettings();

    $('#st-git-remote').val(settings.git_remote || '');
    $('#st-git-branch').val(settings.git_branch || 'main');
    $('#st-git-token').val('');
    $('#st-backup-enabled').prop('checked', settings.backup_enabled !== false);
    $('#st-token-status').text(state.hasToken ? '服务器端已保存 token' : '服务器端未保存 token');

    const summary = [];
    summary.push(`插件状态：${state.pluginLoaded ? '已连接' : '未连接'}`);
    summary.push(`仓库目录：${state.repoDir || '-'}`);
    summary.push(`导入根目录：${state.importRoot || '-'}`);
    summary.push(`资源缓存：小剧场 ${Number(state.sceneCount || 0)} 条 / 预设条目 ${Number(state.presetEntryCount || 0)} 条`);
    summary.push(`同步后备份：${settings.backup_enabled !== false ? '开启（保存到 extensions/savetavern/imported/archive）' : '关闭（仅保留导入结果）'}`);
    summary.push(`资源库入口：${getQuickReplyApi() ? 'Quick Reply 唯一入口可用' : 'Quick Reply 扩展未就绪'}`);

    if (state.lastSyncAt) {
        summary.push(`上次同步：${state.lastSyncAt}`);
    }

    if (state.lastResult?.message) {
        summary.push(`上次结果：${state.lastResult.message}`);
    }

    $('#st-status-summary').text(summary.join('\n'));
    renderLastSummary(state.lastResult || null);
    renderLogs(state.logs || []);

    if (!state.isSyncing) {
        renderRefreshHint();
    }
}

async function refreshState(showToast = false) {
    const state = await requestJson(`${pluginBaseUrl}/state`);

    if (state.config) {
        const settings = ensureSettings();
        settings.git_remote = state.config.remote || '';
        settings.git_branch = state.config.branch || 'main';
        settings.backup_enabled = state.config.backup_enabled !== false;
        saveSettingsDebounced();
    }

    renderStatus(state);

    if (showToast) {
        toastr.success('状态已刷新');
    }
}

async function saveConfig() {
    const settings = ensureSettings();
    const remote = String($('#st-git-remote').val() || '').trim();
    const branch = String($('#st-git-branch').val() || '').trim() || 'main';
    const token = String($('#st-git-token').val() || '').trim();
    const backupEnabled = $('#st-backup-enabled').prop('checked');

    if (!remote) {
        toastr.error('请填写 Git 仓库地址');
        return;
    }

    settings.git_remote = remote;
    settings.git_branch = branch;
    settings.backup_enabled = backupEnabled;
    saveSettingsDebounced();

    await requestJson(`${pluginBaseUrl}/config`, {
        method: 'POST',
        body: JSON.stringify({
            remote,
            branch,
            token,
            backup_enabled: backupEnabled,
        }),
    });

    $('#st-git-token').val('');
    await refreshState(false);
    toastr.success('配置已保存到服务器端');
}

async function runSync() {
    const handle = loader.show({
        message: 'SaveTavern 正在同步仓库...',
        blocking: false,
    });

    try {
        const result = await requestJson(`${pluginBaseUrl}/sync`, {
            method: 'POST',
        });

        const summaryText = formatImportSummary(result);
        let sceneSyncMessage = '';

        try {
            const sceneSyncResult = await ensureSceneLibraryQuickReply();
            sceneSyncMessage = getSceneLibrarySyncSummary(sceneSyncResult);
        } catch (error) {
            sceneSyncMessage = error.message || '资源库入口同步失败';
            console.warn('[SaveTavern] 资源库入口同步失败', error);
            toastr.warning(sceneSyncMessage, 'SaveTavern 资源库');
        }

        await refreshState(false);
        const finalSummaryText = sceneSyncMessage
            ? `${summaryText}\n${sceneSyncMessage}`
            : summaryText;
        toastr.success(finalSummaryText, 'SaveTavern 同步完成');
        scheduleAutoReload(finalSummaryText);
    } finally {
        await handle.hide();
    }
}

function bindEvents() {
    $('#st-save-config').on('click', async () => {
        try {
            await saveConfig();
        } catch (error) {
            console.error('[SaveTavern] 保存配置失败', error);
            toastr.error(error.message || '保存配置失败');
        }
    });

    $('#st-sync-now').on('click', async () => {
        try {
            await runSync();
        } catch (error) {
            console.error('[SaveTavern] 同步失败', error);
            toastr.error(error.message || '同步失败');
        }
    });

    $('#st-refresh-state').on('click', async () => {
        try {
            await refreshState(true);
        } catch (error) {
            console.error('[SaveTavern] 刷新状态失败', error);
            toastr.error(error.message || '刷新状态失败');
        }
    });

}

jQuery(async () => {
    ensureSettings();
    showPostReloadNotice();
    initializeSceneLibraryUi();

    const settingsHtml = await renderExtensionTemplateAsync(extensionFolder, 'settings', {});
    $('#extensions_settings').append(settingsHtml);

    bindEvents();

    try {
        await registerSceneLibrarySlashCommand();
        try {
            await ensureSceneLibraryQuickReply();
        } catch (error) {
            console.warn('[SaveTavern] 初始化资源库 QR 入口失败', error);
        }
        await refreshState(false);
    } catch (error) {
        console.error('[SaveTavern] 初始化失败', error);
        renderStatus({
            pluginLoaded: false,
            repoDir: 'extensions/savetavern/repo',
            importRoot: 'data/default-user',
            logs: [
                `初始化失败: ${error.message || error}`,
                '当前扩展应通过 Git URL 安装，或放在 data/<user-handle>/extensions/third-party/savetavern',
                '当前服务端插件应安装在 plugins/savetavern/index.js',
            ],
        });
        toastr.warning('未连接到 SaveTavern server plugin');
    }
});
