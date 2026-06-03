const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { pathToFileURL } = require('url');
const { spawnSync } = require('child_process');

const PLUGIN_ID = 'savetavern';
const BASE_DIR = path.join(process.cwd(), 'extensions', 'savetavern');
const REPO_DIR = path.join(BASE_DIR, 'repo');
const IMPORT_DIR = path.join(BASE_DIR, 'imported');
const ARCHIVE_DIR = path.join(IMPORT_DIR, 'archive');
const MESSAGE_DIR = path.join(IMPORT_DIR, 'messages');
const ATTACHMENT_DIR = path.join(IMPORT_DIR, 'attachments');
const SCENE_DIR = path.join(IMPORT_DIR, 'scenes');
const PRESET_ENTRY_DIR = path.join(IMPORT_DIR, 'preset_entries');
const CONFIG_PATH = path.join(BASE_DIR, 'server-config.json');
const IMPORT_ROOT = path.join(process.cwd(), 'data', 'default-user');
const MAX_LOG_LINES = 200;
const GIT_TIMEOUT_MS = 90 * 1000;
const TEXT_RESOURCE_FORMAT = 'savetavern_text_resource_v1';

const CATEGORY_TARGET_MAP = {
    characters: path.join(IMPORT_ROOT, 'characters'),
    worlds: path.join(IMPORT_ROOT, 'worlds'),
    presets: path.join(IMPORT_ROOT, 'presets'),
    themes: path.join(IMPORT_ROOT, 'themes'),
    attachments: ATTACHMENT_DIR,
    scenes: SCENE_DIR,
    preset_entries: PRESET_ENTRY_DIR,
};

const CATEGORY_ARCHIVE_MAP = {
    characters: path.join(ARCHIVE_DIR, 'characters'),
    worlds: path.join(ARCHIVE_DIR, 'worlds'),
    presets: path.join(ARCHIVE_DIR, 'presets'),
    themes: path.join(ARCHIVE_DIR, 'themes'),
    scenes: path.join(ARCHIVE_DIR, 'scenes'),
    preset_entries: path.join(ARCHIVE_DIR, 'preset_entries'),
};

let logs = [];
let lastResult = null;
let lastSyncAt = null;
let isSyncing = false;
let parserModulePromise = null;
let defaultAvatarBufferPromise = null;

function pushLog(level, message, extra = null) {
    const line = `[${new Date().toISOString()}] [${level}] ${message}`;
    logs.push(extra ? `${line} ${extra}` : line);
    logs = logs.slice(-MAX_LOG_LINES);

    const logger = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
    logger(`[SaveTavern] ${message}`, extra || '');
}

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

function sanitizeFileStem(name) {
    const sanitized = String(name || 'character')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
        .trim();

    return sanitized || 'character';
}

function isCharacterCardObject(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return false;
    }

    const spec = String(data.spec || '').toLowerCase();
    if (spec.startsWith('chara_card')) {
        return true;
    }

    const nested = data.data;
    if (nested && typeof nested === 'object' && !Array.isArray(nested) && nested.name) {
        const nestedKeys = ['description', 'personality', 'scenario', 'first_mes', 'mes_example'];
        if (nestedKeys.some(key => Object.hasOwn(nested, key))) {
            return true;
        }
    }

    if (data.name) {
        const rootKeys = ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creatorcomment', 'creator_notes'];
        if (rootKeys.some(key => Object.hasOwn(data, key))) {
            return true;
        }
    }

    return false;
}

function isSceneResourceObject(data) {
    return isTypedTextResourceObject(data, 'scene');
}

function isPresetEntryResourceObject(data) {
    return isTypedTextResourceObject(data, 'preset_entry');
}

function isTypedTextResourceObject(data, resourceType) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return false;
    }

    if (data.format !== TEXT_RESOURCE_FORMAT) {
        return false;
    }

    if (data.type !== resourceType) {
        return false;
    }

    if (!String(data.name || '').trim()) {
        return false;
    }

    return typeof data.content === 'string';
}

function normalizeSceneResource(data) {
    return normalizeTypedTextResource(data, 'scene');
}

function normalizePresetEntryResource(data) {
    return normalizeTypedTextResource(data, 'preset_entry');
}

function normalizeTypedTextResource(data, resourceType) {
    return {
        format: TEXT_RESOURCE_FORMAT,
        type: resourceType,
        name: String(data.name || '').trim(),
        content: String(data.content || ''),
        saved_at: String(data.saved_at || new Date().toISOString()),
    };
}

function sanitizeSceneFileStem(name) {
    return String(name || 'scene')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
        .replace(/\s+/g, ' ')
        .trim() || 'scene';
}

function buildSceneFilePath(sourceFile, sceneName) {
    if (sourceFile) {
        const normalized = String(sourceFile).replace(/\\/g, '/').replace(/^\/+/, '');
        if (normalized.toLowerCase().endsWith('.json')) {
            return path.join(SCENE_DIR, normalized);
        }
    }

    const safeStem = sanitizeSceneFileStem(sceneName);
    return path.join(SCENE_DIR, `${safeStem}.json`);
}

function buildPresetEntryFilePath(sourceFile, entryName) {
    if (sourceFile) {
        const normalized = String(sourceFile).replace(/\\/g, '/').replace(/^\/+/, '');
        if (normalized.toLowerCase().endsWith('.json')) {
            return path.join(PRESET_ENTRY_DIR, normalized);
        }
    }

    const safeStem = sanitizeSceneFileStem(entryName);
    return path.join(PRESET_ENTRY_DIR, `${safeStem}.json`);
}

async function getCharacterCardParser() {
    if (!parserModulePromise) {
        const moduleUrl = pathToFileURL(path.join(process.cwd(), 'src', 'character-card-parser.js')).href;
        parserModulePromise = import(moduleUrl);
    }

    return parserModulePromise;
}

async function getDefaultAvatarBuffer() {
    if (!defaultAvatarBufferPromise) {
        const avatarPath = path.join(process.cwd(), 'public', 'img', 'ai4.png');
        defaultAvatarBufferPromise = fs.promises.readFile(avatarPath);
    }

    return defaultAvatarBufferPromise;
}

function buffersEqual(sourceBuffer, destPath) {
    if (!fs.existsSync(destPath)) {
        return false;
    }

    const destBuffer = fs.readFileSync(destPath);
    return sourceBuffer.equals(destBuffer);
}

function loadConfig() {
    if (!fs.existsSync(CONFIG_PATH)) {
        return {
            remote: '',
            token: '',
            branch: 'main',
            backup_enabled: true,
        };
    }

    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);

    return {
        remote: parsed.remote || '',
        token: parsed.token || '',
        branch: parsed.branch || 'main',
        backup_enabled: parsed.backup_enabled !== false,
    };
}

function saveConfig(config) {
    ensureDir(BASE_DIR);
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

function getPublicState() {
    const config = loadConfig();
    const sceneCount = listSceneResources().length;
    const presetEntryCount = listPresetEntryResources().length;

    return {
        pluginLoaded: true,
        repoDir: REPO_DIR,
        importRoot: IMPORT_ROOT,
        sceneDir: SCENE_DIR,
        presetEntryDir: PRESET_ENTRY_DIR,
        sceneCount,
        presetEntryCount,
        hasToken: Boolean(config.token),
        config: {
            remote: config.remote,
            branch: config.branch,
            backup_enabled: config.backup_enabled !== false,
        },
        lastResult,
        lastSyncAt,
        logs,
        isSyncing,
    };
}

function sanitizeGitArg(arg) {
    if (typeof arg !== 'string') {
        return arg;
    }

    try {
        const url = new URL(arg);
        if (url.password) {
            url.password = '***';
        }
        return url.toString();
    } catch {
        return arg;
    }
}

function runGit(args, options = {}) {
    pushLog('INFO', `执行 git ${args.map(sanitizeGitArg).join(' ')}`);

    const result = spawnSync('git', args, {
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0',
            GCM_INTERACTIVE: 'Never',
            GH_PROMPT_DISABLED: '1',
        },
        ...options,
    });

    if (result.stdout?.trim()) {
        pushLog('INFO', 'git stdout', result.stdout.trim());
    }

    if (result.stderr?.trim()) {
        pushLog('WARN', 'git stderr', result.stderr.trim());
    }

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        throw new Error(result.stderr?.trim() || result.stdout?.trim() || `git 命令失败: ${args.join(' ')}`);
    }
}

function buildAuthenticatedRemote(remote, token) {
    if (!remote.startsWith('https://') || !token) {
        return remote;
    }

    const url = new URL(remote);
    url.username = 'x-access-token';
    url.password = token;
    return url.toString();
}

function syncRepo(config) {
    const authRemote = buildAuthenticatedRemote(config.remote, config.token);

    ensureDir(BASE_DIR);

    if (!fs.existsSync(path.join(REPO_DIR, '.git'))) {
        pushLog('INFO', '本地仓库不存在，准备 clone');
        runGit(['clone', '-b', config.branch, authRemote, REPO_DIR]);
        return;
    }

    pushLog('INFO', '本地仓库已存在，准备更新远程与分支');
    runGit(['-C', REPO_DIR, 'remote', 'set-url', 'origin', authRemote]);
    runGit(['-C', REPO_DIR, 'fetch', 'origin']);

    const hasLocalBranch = spawnSync('git', ['-C', REPO_DIR, 'rev-parse', '--verify', config.branch], {
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0',
            GCM_INTERACTIVE: 'Never',
            GH_PROMPT_DISABLED: '1',
        },
    }).status === 0;

    if (hasLocalBranch) {
        runGit(['-C', REPO_DIR, 'checkout', config.branch]);
    } else {
        runGit(['-C', REPO_DIR, 'checkout', '-b', config.branch, `origin/${config.branch}`]);
    }

    runGit(['-C', REPO_DIR, 'pull', 'origin', config.branch]);
}

function filesEqual(src, dest) {
    if (!fs.existsSync(dest)) {
        return false;
    }

    const srcStat = fs.statSync(src);
    const destStat = fs.statSync(dest);

    if (srcStat.size !== destStat.size) {
        return false;
    }

    return fs.readFileSync(src).equals(fs.readFileSync(dest));
}

function copyFileWithStats(src, dest, stats) {
    ensureDir(path.dirname(dest));

    if (!fs.existsSync(dest)) {
        fs.copyFileSync(src, dest);
        stats.created += 1;
        return;
    }

    if (filesEqual(src, dest)) {
        stats.skipped += 1;
        return;
    }

    fs.copyFileSync(src, dest);
    stats.updated += 1;
}

function copyBufferWithStats(buffer, dest, stats) {
    ensureDir(path.dirname(dest));

    if (!fs.existsSync(dest)) {
        fs.writeFileSync(dest, buffer);
        stats.created += 1;
        return;
    }

    if (buffersEqual(buffer, dest)) {
        stats.skipped += 1;
        return;
    }

    fs.writeFileSync(dest, buffer);
    stats.updated += 1;
}

function copyFileWithMode(src, dest, mode = 'preserve') {
    ensureDir(path.dirname(dest));

    if (!fs.existsSync(dest)) {
        fs.copyFileSync(src, dest);
        return 'created';
    }

    if (filesEqual(src, dest)) {
        return 'skipped';
    }

    if (mode === 'preserve') {
        return 'skipped';
    }

    fs.copyFileSync(src, dest);
    return 'updated';
}

function copyBufferWithMode(buffer, dest, mode = 'preserve') {
    ensureDir(path.dirname(dest));

    if (!fs.existsSync(dest)) {
        fs.writeFileSync(dest, buffer);
        return 'created';
    }

    if (buffersEqual(buffer, dest)) {
        return 'skipped';
    }

    if (mode === 'preserve') {
        return 'skipped';
    }

    fs.writeFileSync(dest, buffer);
    return 'updated';
}

function applyStatus(stats, status) {
    if (!stats || !status) {
        return;
    }

    stats[status] = Number(stats[status] || 0) + 1;
}

function copyDirectoryRecursive(srcDir, destDir, stats) {
    ensureDir(destDir);

    const entries = fs.readdirSync(srcDir, { withFileTypes: true });

    for (const entry of entries) {
        const srcPath = path.join(srcDir, entry.name);
        const destPath = path.join(destDir, entry.name);

        if (entry.isDirectory()) {
            copyDirectoryRecursive(srcPath, destPath, stats);
            continue;
        }

        copyFileWithStats(srcPath, destPath, stats);
    }
}

function getCharacterJsonTargetPath(srcPath, sourceDir, targetDir) {
    const originalBaseName = path.parse(srcPath).name;
    const safeBaseName = sanitizeFileStem(originalBaseName);
    const siblingPngPath = path.join(sourceDir, `${originalBaseName}.png`);
    const plainTargetPath = path.join(targetDir, `${safeBaseName}.png`);
    const jsonTargetPath = path.join(targetDir, `${safeBaseName}-json.png`);

    if (fs.existsSync(jsonTargetPath)) {
        return jsonTargetPath;
    }

    if (fs.existsSync(siblingPngPath) || fs.existsSync(plainTargetPath)) {
        return jsonTargetPath;
    }

    return plainTargetPath;
}

function getRelativeRepoPath(sourceDir, srcPath) {
    return path.relative(sourceDir, srcPath);
}

function archiveSourceFile(srcPath, archiveBaseDir, relativePath) {
    if (!archiveBaseDir) {
        return;
    }

    const archiveTarget = path.join(archiveBaseDir, relativePath);
    copyFileWithMode(srcPath, archiveTarget, 'overwrite');
}

async function processCharacterFile(srcPath, sourceDir, targetDir, archiveBaseDir, keepBackup, stats, consumedFiles) {
    const entryName = path.basename(srcPath);
    const ext = path.extname(entryName).toLowerCase();
    const relativePath = getRelativeRepoPath(sourceDir, srcPath);

    if (ext !== '.json') {
        const targetPath = path.join(targetDir, relativePath);
        const status = copyFileWithMode(srcPath, targetPath, 'overwrite');
        if (keepBackup) {
            archiveSourceFile(srcPath, archiveBaseDir, relativePath);
        }
        applyStatus(stats, status);
        consumedFiles.push(srcPath);
        return;
    }

    const rawJson = fs.readFileSync(srcPath, 'utf8');
    const parsed = JSON.parse(rawJson);

    if (!isCharacterCardObject(parsed)) {
        pushLog('WARN', `characters 目录中的 JSON 不是角色卡，已跳过: ${entryName}`);
        stats.skipped += 1;
        return;
    }

    const { write } = await getCharacterCardParser();
    const defaultAvatarBuffer = await getDefaultAvatarBuffer();
    const targetPath = getCharacterJsonTargetPath(srcPath, sourceDir, targetDir);
    const pngBuffer = Buffer.from(write(defaultAvatarBuffer, rawJson));
    const status = copyBufferWithMode(pngBuffer, targetPath, 'overwrite');

    if (keepBackup) {
        archiveSourceFile(srcPath, archiveBaseDir, relativePath);
    }

    applyStatus(stats, status);
    consumedFiles.push(srcPath);
}

async function processCharactersRecursive(sourceDir, currentDir, targetDir, archiveBaseDir, keepBackup, stats, consumedFiles) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
        const srcPath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
            await processCharactersRecursive(sourceDir, srcPath, targetDir, archiveBaseDir, keepBackup, stats, consumedFiles);
            continue;
        }

        try {
            await processCharacterFile(srcPath, sourceDir, targetDir, archiveBaseDir, keepBackup, stats, consumedFiles);
        } catch (error) {
            pushLog('ERROR', `角色资源处理失败: ${entry.name}`, error.message);
            stats.skipped += 1;
        }
    }
}

async function importCharactersCategory(sourceDir, targetDir, archiveBaseDir, keepBackup) {
    const stats = { created: 0, updated: 0, skipped: 0 };
    const consumedFiles = [];
    ensureDir(targetDir);
    if (keepBackup && archiveBaseDir) {
        ensureDir(archiveBaseDir);
    }

    await processCharactersRecursive(sourceDir, sourceDir, targetDir, archiveBaseDir, keepBackup, stats, consumedFiles);
    return { stats, consumedFiles };
}

function processTypedTextResourceFile(
    srcPath,
    sourceDir,
    targetDir,
    archiveBaseDir,
    keepBackup,
    stats,
    consumedFiles,
    options = {},
) {
    const entryName = path.basename(srcPath);
    const relativePath = getRelativeRepoPath(sourceDir, srcPath);
    const {
        categoryName = 'text resource',
        isResourceObject = () => false,
        normalizeResource = (value) => value,
    } = options;

    if (path.extname(entryName).toLowerCase() !== '.json') {
        pushLog('WARN', `${categoryName} 目录中出现非 JSON 文件，已跳过: ${entryName}`);
        stats.skipped += 1;
        return;
    }

    const rawJson = fs.readFileSync(srcPath, 'utf8');
    const parsed = JSON.parse(rawJson);
    if (!isResourceObject(parsed)) {
        pushLog('WARN', `${categoryName} 目录中的 JSON 不是合法资源，已跳过: ${entryName}`);
        stats.skipped += 1;
        return;
    }

    const normalizedBuffer = Buffer.from(
        JSON.stringify(normalizeResource(parsed), null, 2),
        'utf8',
    );
    const targetPath = path.join(targetDir, relativePath);
    const status = copyBufferWithMode(normalizedBuffer, targetPath, 'overwrite');

    if (keepBackup) {
        archiveSourceFile(srcPath, archiveBaseDir, relativePath);
    }

    applyStatus(stats, status);
    consumedFiles.push(srcPath);
}

function processSceneFile(srcPath, sourceDir, targetDir, archiveBaseDir, keepBackup, stats, consumedFiles) {
    return processTypedTextResourceFile(
        srcPath,
        sourceDir,
        targetDir,
        archiveBaseDir,
        keepBackup,
        stats,
        consumedFiles,
        {
            categoryName: 'scenes',
            isResourceObject: isSceneResourceObject,
            normalizeResource: normalizeSceneResource,
        },
    );
}

function processPresetEntryFile(srcPath, sourceDir, targetDir, archiveBaseDir, keepBackup, stats, consumedFiles) {
    return processTypedTextResourceFile(
        srcPath,
        sourceDir,
        targetDir,
        archiveBaseDir,
        keepBackup,
        stats,
        consumedFiles,
        {
            categoryName: 'preset_entries',
            isResourceObject: isPresetEntryResourceObject,
            normalizeResource: normalizePresetEntryResource,
        },
    );
}

function processTypedTextResourcesRecursive(
    sourceDir,
    currentDir,
    targetDir,
    archiveBaseDir,
    keepBackup,
    stats,
    consumedFiles,
    options = {},
) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    const { processResourceFile = () => {}, resourceLabel = '资源' } = options;

    for (const entry of entries) {
        const srcPath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
            processTypedTextResourcesRecursive(
                sourceDir,
                srcPath,
                targetDir,
                archiveBaseDir,
                keepBackup,
                stats,
                consumedFiles,
                options,
            );
            continue;
        }

        try {
            processResourceFile(srcPath, sourceDir, targetDir, archiveBaseDir, keepBackup, stats, consumedFiles);
        } catch (error) {
            pushLog('ERROR', `${resourceLabel}处理失败: ${entry.name}`, error.message);
            stats.skipped += 1;
        }
    }
}

function processScenesRecursive(sourceDir, currentDir, targetDir, archiveBaseDir, keepBackup, stats, consumedFiles) {
    processTypedTextResourcesRecursive(
        sourceDir,
        currentDir,
        targetDir,
        archiveBaseDir,
        keepBackup,
        stats,
        consumedFiles,
        {
            processResourceFile: processSceneFile,
            resourceLabel: '小剧场资源',
        },
    );
}

function processPresetEntriesRecursive(sourceDir, currentDir, targetDir, archiveBaseDir, keepBackup, stats, consumedFiles) {
    processTypedTextResourcesRecursive(
        sourceDir,
        currentDir,
        targetDir,
        archiveBaseDir,
        keepBackup,
        stats,
        consumedFiles,
        {
            processResourceFile: processPresetEntryFile,
            resourceLabel: '预设条目资源',
        },
    );
}

function importScenesCategory(sourceDir, targetDir, archiveBaseDir, keepBackup) {
    const stats = { created: 0, updated: 0, skipped: 0 };
    const consumedFiles = [];

    ensureDir(targetDir);
    if (keepBackup && archiveBaseDir) {
        ensureDir(archiveBaseDir);
    }

    processScenesRecursive(sourceDir, sourceDir, targetDir, archiveBaseDir, keepBackup, stats, consumedFiles);
    return { stats, consumedFiles };
}

function importPresetEntriesCategory(sourceDir, targetDir, archiveBaseDir, keepBackup) {
    const stats = { created: 0, updated: 0, skipped: 0 };
    const consumedFiles = [];

    ensureDir(targetDir);
    if (keepBackup && archiveBaseDir) {
        ensureDir(archiveBaseDir);
    }

    processPresetEntriesRecursive(sourceDir, sourceDir, targetDir, archiveBaseDir, keepBackup, stats, consumedFiles);
    return { stats, consumedFiles };
}

function processGenericRecursive(sourceDir, currentDir, targetDir, archiveBaseDir, keepBackup, stats, consumedFiles) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
        const srcPath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
            processGenericRecursive(sourceDir, srcPath, targetDir, archiveBaseDir, keepBackup, stats, consumedFiles);
            continue;
        }

        const relativePath = getRelativeRepoPath(sourceDir, srcPath);
        const targetPath = path.join(targetDir, relativePath);
        const status = copyFileWithMode(srcPath, targetPath, 'overwrite');

        if (keepBackup) {
            archiveSourceFile(srcPath, archiveBaseDir, relativePath);
        }

        applyStatus(stats, status);
        consumedFiles.push(srcPath);
    }
}

function importGenericCategory(sourceDir, targetDir, archiveBaseDir, keepBackup) {
    const stats = { created: 0, updated: 0, skipped: 0 };
    const consumedFiles = [];

    ensureDir(targetDir);
    if (keepBackup && archiveBaseDir) {
        ensureDir(archiveBaseDir);
    }

    processGenericRecursive(sourceDir, sourceDir, targetDir, archiveBaseDir, keepBackup, stats, consumedFiles);
    return { stats, consumedFiles };
}

function importRootTextFiles() {
    const stats = { created: 0, updated: 0, skipped: 0 };
    const consumedFiles = [];
    ensureDir(MESSAGE_DIR);

    const entries = fs.readdirSync(REPO_DIR, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.txt') {
            continue;
        }

        const src = path.join(REPO_DIR, entry.name);
        const dest = path.join(MESSAGE_DIR, entry.name);
        const status = copyFileWithMode(src, dest, 'overwrite');
        applyStatus(stats, status);
        consumedFiles.push(src);
    }

    return { stats, consumedFiles };
}

function collectFilesRecursive(baseDir, currentDir, collector) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
        const entryPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
            collectFilesRecursive(baseDir, entryPath, collector);
            continue;
        }

        collector.push({
            fullPath: entryPath,
            relativePath: path.relative(baseDir, entryPath).replace(/\\/g, '/'),
        });
    }
}

function listSceneResources() {
    return listTypedTextResources(SCENE_DIR, {
        isResourceObject: isSceneResourceObject,
        normalizeResource: normalizeSceneResource,
        resourceLabel: '小剧场资源',
    });
}

function listPresetEntryResources() {
    return listTypedTextResources(PRESET_ENTRY_DIR, {
        isResourceObject: isPresetEntryResourceObject,
        normalizeResource: normalizePresetEntryResource,
        resourceLabel: '预设条目资源',
    });
}

function listTypedTextResources(baseDir, options = {}) {
    const {
        isResourceObject = () => false,
        normalizeResource = (value) => value,
        resourceLabel = '资源',
    } = options;

    if (!fs.existsSync(baseDir) || !fs.statSync(baseDir).isDirectory()) {
        return [];
    }

    const files = [];
    collectFilesRecursive(baseDir, baseDir, files);

    const items = [];
    for (const file of files) {
        if (path.extname(file.fullPath).toLowerCase() !== '.json') {
            continue;
        }

        try {
            const rawJson = fs.readFileSync(file.fullPath, 'utf8');
            const parsed = JSON.parse(rawJson);
            if (!isResourceObject(parsed)) {
                continue;
            }

            const normalized = normalizeResource(parsed);
            items.push({
                name: normalized.name,
                content: normalized.content,
                saved_at: normalized.saved_at,
                source_file: file.relativePath,
            });
        } catch (error) {
            pushLog('WARN', `读取${resourceLabel}失败，已跳过: ${file.relativePath}`, error.message);
        }
    }

    items.sort((left, right) => {
        const timeCompare = String(right.saved_at || '').localeCompare(String(left.saved_at || ''));
        if (timeCompare !== 0) {
            return timeCompare;
        }
        return String(left.name || '').localeCompare(String(right.name || ''), 'zh-Hans-CN');
    });

    return items;
}

function saveSceneResource(payload = {}) {
    const normalized = normalizeSceneResource(payload);
    if (!normalized.name) {
        throw new Error('小剧场标题不能为空');
    }

    ensureDir(SCENE_DIR);
    const targetPath = buildSceneFilePath(payload.source_file, normalized.name);
    ensureDir(path.dirname(targetPath));

    const existingPath = payload.source_file
        ? path.join(SCENE_DIR, String(payload.source_file).replace(/\\/g, '/'))
        : null;

    if (existingPath && existingPath !== targetPath && fs.existsSync(existingPath)) {
        fs.unlinkSync(existingPath);
    }

    fs.writeFileSync(targetPath, JSON.stringify(normalized, null, 2), 'utf8');

    return {
        name: normalized.name,
        content: normalized.content,
        saved_at: normalized.saved_at,
        source_file: path.relative(SCENE_DIR, targetPath).replace(/\\/g, '/'),
    };
}

function savePresetEntryResource(payload = {}) {
    const normalized = normalizePresetEntryResource(payload);
    if (!normalized.name) {
        throw new Error('预设条目标题不能为空');
    }

    ensureDir(PRESET_ENTRY_DIR);
    const targetPath = buildPresetEntryFilePath(payload.source_file, normalized.name);
    ensureDir(path.dirname(targetPath));

    const existingPath = payload.source_file
        ? path.join(PRESET_ENTRY_DIR, String(payload.source_file).replace(/\\/g, '/'))
        : null;

    if (existingPath && existingPath !== targetPath && fs.existsSync(existingPath)) {
        fs.unlinkSync(existingPath);
    }

    fs.writeFileSync(targetPath, JSON.stringify(normalized, null, 2), 'utf8');

    return {
        name: normalized.name,
        content: normalized.content,
        saved_at: normalized.saved_at,
        source_file: path.relative(PRESET_ENTRY_DIR, targetPath).replace(/\\/g, '/'),
    };
}

function removeConsumedFiles(consumedFiles) {
    for (const filePath of consumedFiles) {
        if (!fs.existsSync(filePath)) {
            continue;
        }

        fs.unlinkSync(filePath);
    }
}

function removeEmptyDirectories(currentDir) {
    if (!fs.existsSync(currentDir)) {
        return;
    }

    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }

        const childDir = path.join(currentDir, entry.name);
        if (entry.name === '.git') {
            continue;
        }

        removeEmptyDirectories(childDir);
    }

    const remaining = fs.readdirSync(currentDir);
    if (remaining.length === 0 && currentDir !== REPO_DIR) {
        fs.rmdirSync(currentDir);
    }
}

function consumeRepoFiles(consumedFiles) {
    if (!Array.isArray(consumedFiles) || consumedFiles.length === 0) {
        return 0;
    }

    removeConsumedFiles(consumedFiles);
    removeEmptyDirectories(REPO_DIR);
    runGit(['-C', REPO_DIR, 'add', '-A']);

    const statusCheck = spawnSync('git', ['-C', REPO_DIR, 'status', '--porcelain'], {
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0',
            GCM_INTERACTIVE: 'Never',
            GH_PROMPT_DISABLED: '1',
        },
    });

    if (statusCheck.error) {
        throw statusCheck.error;
    }

    if (!statusCheck.stdout?.trim()) {
        pushLog('INFO', '仓库中没有需要提交的清理变更');
        return consumedFiles.length;
    }

    runGit(['-C', REPO_DIR, 'commit', '-m', `Consume imported files ${new Date().toISOString()}`]);
    runGit(['-C', REPO_DIR, 'push', 'origin', loadConfig().branch]);
    return consumedFiles.length;
}

async function importFromRepo(config) {
    const summary = {
        categories: {},
        messages: { created: 0, updated: 0, skipped: 0 },
        consumed: 0,
        backup_enabled: config.backup_enabled !== false,
    };
    const consumedFiles = [];
    const keepBackup = config.backup_enabled !== false;

    ensureDir(IMPORT_ROOT);
    ensureDir(IMPORT_DIR);
    ensureDir(ATTACHMENT_DIR);
    ensureDir(SCENE_DIR);
    ensureDir(PRESET_ENTRY_DIR);
    if (keepBackup) {
        ensureDir(ARCHIVE_DIR);
    }

    for (const [category, targetDir] of Object.entries(CATEGORY_TARGET_MAP)) {
        const sourceDir = path.join(REPO_DIR, category);
        if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
            continue;
        }

        const archiveBaseDir = CATEGORY_ARCHIVE_MAP[category] || null;
        let result;
        if (category === 'characters') {
            result = await importCharactersCategory(sourceDir, targetDir, archiveBaseDir, keepBackup);
        } else if (category === 'scenes') {
            result = importScenesCategory(sourceDir, targetDir, archiveBaseDir, keepBackup);
        } else if (category === 'preset_entries') {
            result = importPresetEntriesCategory(sourceDir, targetDir, archiveBaseDir, keepBackup);
        } else {
            result = importGenericCategory(sourceDir, targetDir, archiveBaseDir, keepBackup);
        }

        summary.categories[category] = result.stats;
        consumedFiles.push(...result.consumedFiles);
    }

    const rootTextResult = importRootTextFiles();
    summary.messages = rootTextResult.stats;
    consumedFiles.push(...rootTextResult.consumedFiles);

    summary.consumed = consumeRepoFiles(consumedFiles);

    return summary;
}

function buildSyncMessage(summary) {
    const parts = ['同步完成'];

    const categoryLines = Object.entries(summary.categories)
        .map(([category, stats]) => {
            return `${category}: 新增 ${stats.created} / 更新 ${stats.updated} / 跳过 ${stats.skipped}`;
        });

    if (categoryLines.length > 0) {
        parts.push(categoryLines.join(' | '));
    }

    const messageStats = summary.messages;
    if (messageStats.created || messageStats.updated || messageStats.skipped) {
        parts.push(`messages: 新增 ${messageStats.created} / 更新 ${messageStats.updated} / 跳过 ${messageStats.skipped}`);
    }

    if (typeof summary.consumed === 'number') {
        parts.push(`仓库清理: 已移除 ${summary.consumed} 个已同步文件`);
    }

    parts.push(`本地备份: ${summary.backup_enabled !== false ? '已开启' : '已关闭'}`);

    return parts.join('\n');
}

async function init(router) {
    pushLog('INFO', 'server plugin 已启动');

    router.get('/state', async (_req, res) => {
        res.json(getPublicState());
    });

    router.get('/scenes', async (_req, res) => {
        res.json({
            items: listSceneResources(),
        });
    });

    router.get('/preset-entries', async (_req, res) => {
        res.json({
            items: listPresetEntryResources(),
        });
    });

    router.post('/scenes/save', async (req, res) => {
        try {
            const savedItem = saveSceneResource(req.body || {});
            pushLog('INFO', `小剧场资源已保存: ${savedItem.source_file}`);
            res.json({
                ok: true,
                item: savedItem,
            });
        } catch (error) {
            pushLog('ERROR', '保存小剧场资源失败', error.message);
            res.status(400).json({ error: error.message || '保存小剧场资源失败' });
        }
    });

    router.post('/preset-entries/save', async (req, res) => {
        try {
            const savedItem = savePresetEntryResource(req.body || {});
            pushLog('INFO', `预设条目资源已保存: ${savedItem.source_file}`);
            res.json({
                ok: true,
                item: savedItem,
            });
        } catch (error) {
            pushLog('ERROR', '保存预设条目资源失败', error.message);
            res.status(400).json({ error: error.message || '保存预设条目资源失败' });
        }
    });

    router.post('/config', async (req, res) => {
        try {
            const current = loadConfig();
            const remote = String(req.body?.remote || '').trim();
            const branch = String(req.body?.branch || '').trim() || 'main';
            const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
            const backupEnabled = req.body?.backup_enabled !== false;

            if (!remote) {
                return res.status(400).json({ error: '缺少 Git 仓库地址' });
            }

            const nextConfig = {
                remote,
                branch,
                token: token || current.token,
                backup_enabled: backupEnabled,
            };

            saveConfig(nextConfig);
            pushLog('INFO', `配置已保存，branch=${branch}，backup=${backupEnabled ? 'on' : 'off'}`);
            res.json({
                ok: true,
                hasToken: Boolean(nextConfig.token),
                backup_enabled: nextConfig.backup_enabled,
            });
        } catch (error) {
            pushLog('ERROR', '保存配置失败', error.message);
            res.status(500).json({ error: error.message || '保存配置失败' });
        }
    });

    router.post('/sync', async (_req, res) => {
        if (isSyncing) {
            return res.status(409).json({ error: '已有同步任务正在进行中' });
        }

        const config = loadConfig();
        if (!config.remote || !config.token) {
            return res.status(400).json({ error: '请先保存远程仓库和 token' });
        }

        isSyncing = true;

        try {
            syncRepo(config);
            const importResult = await importFromRepo(config);
            const message = buildSyncMessage(importResult);

            lastSyncAt = new Date().toISOString();
            lastResult = {
                ok: true,
                message,
                importResult,
            };

            pushLog('INFO', message.replace(/\n/g, ' | '));
            res.json(lastResult);
        } catch (error) {
            lastSyncAt = new Date().toISOString();
            lastResult = {
                ok: false,
                message: error.message || '同步失败',
            };

            pushLog('ERROR', '同步失败', error.message);
            res.status(500).json({ error: error.message || '同步失败' });
        } finally {
            isSyncing = false;
        }
    });
}

async function exit() {
    pushLog('INFO', 'server plugin 已退出');
}

module.exports = {
    init,
    exit,
    info: {
        id: PLUGIN_ID,
        name: 'SaveTavern Sync',
        description: 'Sync Git resources into fixed SaveTavern import directories.',
    },
};
