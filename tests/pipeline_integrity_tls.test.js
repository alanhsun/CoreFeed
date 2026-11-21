/**
 * CoreFeed v2.0 — Phase 2 Editorial Pipeline Integrity & TLS Switch Test Suite
 *
 * 覆盖验证项：
 *  1. harvestId 批次绑定与 ag-harvest --inspect 防误爆（空列表拦截、--inspect all、--max-chars、missingIndices、批次/ID 漂移阻断）
 *  2. 聚合契约校验器（--validate 单次汇总全部错误且零落盘、--strict 升级篇数/字数/枚举/段落告警、duplicateGroups 索引偏移拦截）
 *  3. --force-with-lease 并发推送安全（过期 lease 抛 LEASE_CONFLICT、ag-sync-pulse 冲突自动拉取重合并重试、发布期多客户端冷却防覆盖）
 *  4. editionId 新闻-音频一致性绑定（Step 5.2/5.4 确定性相同 editionId、匹配音轨保留、过期 tracks.news 剔除且 tracks.pulse 保留 [Q2=A]）
 *  5. TTS 流水线加固（跨平台环境变量路径、editionId/scriptSha256、--max-total-chars、幂等复用跳过 Colab、Preflight 缺脚本报错、_verify_zero_billing）
 *  6. 全链路 TLS 校验开关 ALLOW_INSECURE_TLS（默认拒绝对自签证书 HTTPS 请求、开启后放行、全仓源码零硬编码 rejectUnauthorized: false 与 Windows 路径）
 */
process.env.NODE_ENV = 'test';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { execFileSync, spawnSync } = require('node:child_process');
const axios = require('axios');

const config = require('../config');
const stateManager = require('../services/state_manager');
const { AudioBroadcastService, computeBufferSha256 } = require('../services/audio_broadcast_service');
const { computeHarvestId, inspectCandidates } = require('../scripts/ag-harvest');
const { runPublish, computeNewsEditionId, resolveEditionMatchedAudio } = require('../scripts/ag-publish');
const { runSyncPulse } = require('../scripts/ag-sync-pulse');
const { resolveColabPython } = require('../scripts/ag-tts');
const {
    publishSnapshotToGitHub,
    resolveRemoteBranchSha,
    fetchRemoteSnapshotViaGit
} = require('../utils/github_sync');
const { getHttpsAgent, isInsecureTlsAllowed } = require('../utils/network_config');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = config.storage.dataDir;
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
const TRACKED_DATA_FILES = [
    'news.json',
    'summary.json',
    'state.json',
    'social_pulse.json',
    'audio_broadcast.json',
    path.join('audio', 'briefing-news.mp3'),
    path.join('audio', 'briefing-pulse.mp3')
];

function createFakeMp3Buffer(tag = 'PHASE2_') {
    const header = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const body = Buffer.from(tag.repeat(48), 'utf8');
    return Buffer.concat([header, body]);
}

function initGitRepoPair(rootDir) {
    const bareRemoteDir = path.join(rootDir, 'remote.git');
    const workRepoDir = path.join(rootDir, 'work');
    fs.mkdirSync(bareRemoteDir, { recursive: true });
    fs.mkdirSync(path.join(workRepoDir, 'data', 'audio'), { recursive: true });
    execFileSync('git', ['init', '--bare', bareRemoteDir], { stdio: 'ignore' });
    execFileSync('git', ['init', workRepoDir], { stdio: 'ignore' });
    execFileSync('git', ['-C', workRepoDir, 'config', 'user.name', 'Test Bot'], { stdio: 'ignore' });
    execFileSync('git', ['-C', workRepoDir, 'config', 'user.email', 'bot@example.com'], { stdio: 'ignore' });
    execFileSync('git', ['-C', workRepoDir, 'remote', 'add', 'origin', bareRemoteDir], { stdio: 'ignore' });
    fs.writeFileSync(path.join(workRepoDir, 'README.md'), '# Test Repo\n', 'utf8');
    execFileSync('git', ['-C', workRepoDir, 'add', 'README.md'], { stdio: 'ignore' });
    execFileSync('git', ['-C', workRepoDir, 'commit', '-m', 'init'], { stdio: 'ignore' });
    execFileSync('git', ['-C', workRepoDir, 'branch', '-M', 'main'], { stdio: 'ignore' });
    return { bareRemoteDir, workRepoDir };
}

function createSampleDigest(dateStr = '2026-11-20') {
    return {
        date: dateStr,
        mode: 'daily',
        key: `daily:${dateStr}`,
        generated_at: `${dateStr}T07:10:00+08:00`,
        headline: '美欧围绕 AI 算力监管与能源补贴展开激烈公共辩论',
        executive_summary: {
            overview: '过去 24 小时欧美社交平台密集讨论算力中心能耗与跨境科技税方案。'
        },
        transatlantic_comparisons: [
            {
                topic: 'AI 算力中心供电与电价影响',
                us_angle: '美国网友担忧数据中心推高居民电价',
                eu_angle: '欧洲社区更关注绿电配额与核电重启',
                verdict: '美欧在AI基础设施成本分摊上呈现不同焦点'
            }
        ],
        clusters: [
            {
                id: 'us-c1',
                region: 'US',
                countries: ['US'],
                category: '科技',
                heat_score: 94,
                title_zh: '美国多州就数据中心用电定价爆发公开听证争论',
                hook_one_liner: '科技巨头承诺自建电源，社区质疑短期电费转嫁。',
                featured_quotes: [{ quote_zh: '算力扩张不应让普通家庭承担电网升级账单。', platform: 'reddit' }]
            },
            {
                id: 'eu-c1',
                region: 'EU',
                countries: ['DE', 'FR'],
                category: '能源',
                heat_score: 88,
                title_zh: '德法社区热议跨境电网扩容与核电协作',
                hook_one_liner: '多国网友呼吁加快工业电价缓冲政策落地。',
                featured_quotes: [{ quote_zh: '欧洲制造业最急迫的是稳定且可预期的能源成本。', platform: 'x' }]
            }
        ]
    };
}

function createCandidatesFixture(count = 5) {
    const fullCandidates = Array.from({ length: count }, (_, idx) => {
        const n = idx + 1;
        return {
            index: n,
            id: `cand-${n}`,
            title: `Global Policy Update Story ${n}`,
            description: `Original English excerpt for global policy story ${n}.`,
            fullText: `Paragraph one of open international reporting story ${n}. `.repeat(20),
            url: `https://www.reuters.com/world/phase2-story-${n}`,
            urlToImage: `https://cdn.example.com/img-${n}.jpg`,
            publishedAt: '2026-11-20T08:00:00.000Z',
            source: {
                id: `src-${n}`,
                name: 'Reuters (路透社)',
                authority: 95,
                language: 'en',
                paywall: 'open'
            }
        };
    });
    return {
        harvestId: computeHarvestId(fullCandidates),
        harvestedAt: '2026-11-20T08:15:00.000Z',
        totalCandidates: fullCandidates.length,
        fullCandidates
    };
}

function createValidCompiledArticle(candidateIndex, overrides = {}) {
    return {
        candidateIndex,
        id: `cand-${candidateIndex}`,
        region: '国际',
        category: '政经',
        translatedTitle: `多国央行联合发布跨境即时支付互通路线图第${candidateIndex}号声明`,
        summary: '二十国集团主要央行与国际清算银行在巴塞尔联合发布跨境即时支付系统互联路线图，明确未来三年在清算接口标准化、流动性池共建与反洗钱合规核验方面的关键里程碑。',
        keyPoints: [
            '主要经济体央行宣布推进跨境即时支付接口互联标准统一',
            '国际清算银行将主导建立多币种实时清算测试沙盒机制',
            '新框架预计显著降低中小外贸企业跨境结算成本与时滞'
        ],
        originalParagraphs: [
            `Central banks unveiled a joint cross-border instant payment roadmap in Basel for item ${candidateIndex}.`,
            'The framework defines common messaging standards and liquidity safeguards across participating corridors.'
        ],
        translatedParagraphs: [
            `多家主要央行在巴塞尔联合公布了第${candidateIndex}项跨境即时支付互通路线图，提出分阶段对接零售与批发清算基础设施。`,
            '该框架明确了跨境报文标准、实时流动性安全垫与反洗钱联合核验机制，旨在提升国际贸易资金周转效率。'
        ],
        ...overrides
    };
}

describe('CoreFeed v2.0 — Phase 2 Editorial Pipeline Integrity & TLS Switch Suite', () => {
    const backups = new Map();
    let prevAllowInsecureTls;
    let prevNoProxy;
    let prevColabPy;
    let prevColabRoot;

    before(() => {
        prevAllowInsecureTls = process.env.ALLOW_INSECURE_TLS;
        prevNoProxy = process.env.NO_PROXY;
        prevColabPy = process.env.QWEN3_COLAB_PYTHON;
        prevColabRoot = process.env.QWEN3_COLAB_ROOT;
        process.env.NO_PROXY = '127.0.0.1,localhost';

        for (const rel of TRACKED_DATA_FILES) {
            const p = path.join(DATA_DIR, rel);
            if (fs.existsSync(p)) {
                backups.set(p, fs.readFileSync(p));
            }
        }
    });

    after(() => {
        if (prevAllowInsecureTls === undefined) delete process.env.ALLOW_INSECURE_TLS;
        else process.env.ALLOW_INSECURE_TLS = prevAllowInsecureTls;
        if (prevNoProxy === undefined) delete process.env.NO_PROXY;
        else process.env.NO_PROXY = prevNoProxy;
        if (prevColabPy === undefined) delete process.env.QWEN3_COLAB_PYTHON;
        else process.env.QWEN3_COLAB_PYTHON = prevColabPy;
        if (prevColabRoot === undefined) delete process.env.QWEN3_COLAB_ROOT;
        else process.env.QWEN3_COLAB_ROOT = prevColabRoot;

        for (const rel of TRACKED_DATA_FILES) {
            const p = path.join(DATA_DIR, rel);
            if (backups.has(p)) {
                fs.mkdirSync(path.dirname(p), { recursive: true });
                fs.writeFileSync(p, backups.get(p));
            } else if (fs.existsSync(p)) {
                fs.unlinkSync(p);
            }
        }
        stateManager.reset();
    });

    it('1. harvestId batch binding & --inspect safety prevent index drift and full-pool context dumps', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corefeed-p2-harvest-'));
        try {
            const candFixture = createCandidatesFixture(4);
            const candPath = path.join(tmpDir, 'ag_candidates.json');
            fs.writeFileSync(candPath, JSON.stringify(candFixture, null, 2), 'utf8');

            // 1a. Deterministic harvestId format & sensitivity to reorder
            assert.match(candFixture.harvestId, /^hv-[a-f0-9]{12}$/);
            const reordered = [...candFixture.fullCandidates].reverse().map((c, idx) => ({ ...c, index: idx + 1 }));
            assert.notEqual(computeHarvestId(reordered), candFixture.harvestId);

            // 1b. --inspect rejects empty or non-numeric strings instead of dumping all candidates
            await assert.rejects(
                () => inspectCandidates(candPath, ''),
                /无效的 --inspect 序号列表/
            );
            await assert.rejects(
                () => inspectCandidates(candPath, 'abc,foo'),
                /无效的 --inspect 序号列表/
            );

            // 1c. --inspect all explicitly returns all items with harvestId; --max-chars truncates rawText; missingIndices reported
            const allRes = await inspectCandidates(candPath, 'all', { maxChars: 40 });
            assert.equal(allRes.harvestId, candFixture.harvestId);
            assert.equal(allRes.inspectedCount, 4);
            assert.deepEqual(allRes.missingIndices, []);
            assert.ok(allRes.items.every(it => it.rawText.length <= 40));

            const partialRes = await inspectCandidates(candPath, '1,3,99');
            assert.equal(partialRes.inspectedCount, 2);
            assert.deepEqual(partialRes.missingIndices, [99]);

            // 1d. Mismatched harvestId in ag_compiled.json is rejected with HTTP 400 validation error
            const compiledPath = path.join(tmpDir, 'ag_compiled.json');
            const compiledDoc = {
                harvestId: 'hv-000000000000',
                articles: [createValidCompiledArticle(1)],
                summaryArticle: {
                    title: '2026年11月20日 全球要闻深度综述：跨境清算提速',
                    content: '### 全球宏观\n\n主要央行联合公布跨境即时支付路线图 [NEWS_1]。'
                }
            };
            fs.writeFileSync(compiledPath, JSON.stringify(compiledDoc, null, 2), 'utf8');

            await assert.rejects(
                () => runPublish({ candidates: candPath, compiled: compiledPath, localOnly: true, pushToGithub: false }),
                (err) => err.statusCode === 400 && /批次不匹配/.test(err.message)
            );

            // 1e. --ignore-harvest-id escape hatch allows override when explicitly requested
            const overrideRes = await runPublish({
                candidates: candPath,
                compiled: compiledPath,
                validateOnly: true,
                ignoreHarvestId: true
            });
            assert.equal(overrideRes.success, true);

            // 1f. Out-of-range candidateIndex & mismatched id vs candidateIndex are blocked
            const driftCompiledPath = path.join(tmpDir, 'ag_compiled_drift.json');
            fs.writeFileSync(driftCompiledPath, JSON.stringify({
                harvestId: candFixture.harvestId,
                articles: [
                    createValidCompiledArticle(1, { id: 'cand-2' }),
                    createValidCompiledArticle(99, { id: 'cand-99' })
                ],
                summaryArticle: {
                    title: '测试综述',
                    content: '### 板块\n\n综述正文测试 [NEWS_1] [NEWS_2]。'
                }
            }, null, 2), 'utf8');

            const driftRes = await runPublish({
                candidates: candPath,
                compiled: driftCompiledPath,
                validateOnly: true
            });
            assert.equal(driftRes.success, false);
            assert.ok(driftRes.validation.errors.some(e => e.includes('不匹配')));
            assert.ok(driftRes.validation.errors.some(e => e.includes('越界或不存在')));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('2. Aggregated validator (--validate / --strict) collects all errors in one pass without writing disk files', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corefeed-p2-validate-'));
        try {
            const candFixture = createCandidatesFixture(5);
            const candPath = path.join(tmpDir, 'ag_candidates.json');
            fs.writeFileSync(candPath, JSON.stringify(candFixture, null, 2), 'utf8');

            // Remove news.json temporarily to verify --validate performs zero disk writes
            const newsFile = config.storage.newsFile;
            const prevNewsBuf = fs.existsSync(newsFile) ? fs.readFileSync(newsFile) : null;
            if (fs.existsSync(newsFile)) fs.unlinkSync(newsFile);

            try {
                // 2a. Multi-error payload: duplicate primary index, primary index inside mergedIndices,
                // untranslated long English paragraph, unsafe URL, and [NEWS_99] out-of-range citation
                const brokenCompiledPath = path.join(tmpDir, 'broken.json');
                fs.writeFileSync(brokenCompiledPath, JSON.stringify({
                    harvestId: candFixture.harvestId,
                    articles: [
                        createValidCompiledArticle(1, {
                            mergedIndices: [2],
                            translatedParagraphs: [
                                '第一段中文精译内容完整准确，介绍国际政策进展。',
                                'This second paragraph was accidentally left completely untranslated in raw English text.'
                            ]
                        }),
                        createValidCompiledArticle(2, {
                            url: 'javascript:alert(1)'
                        }),
                        createValidCompiledArticle(1)
                    ],
                    summaryArticle: {
                        title: '综述测试',
                        content: '### 宏观政策\n\n全球金融协作迎来新阶段 [NEWS_1] 与越界引用 [NEWS_99]。'
                    }
                }, null, 2), 'utf8');

                const brokenRes = await runPublish({
                    candidates: candPath,
                    compiled: brokenCompiledPath,
                    validateOnly: true
                });
                assert.equal(brokenRes.validateOnly, true);
                assert.equal(brokenRes.success, false);
                assert.ok(brokenRes.validation.errors.length >= 5, `Expected >=5 aggregated errors, got ${brokenRes.validation.errors.length}`);
                assert.ok(brokenRes.validation.errors.some(e => e.includes('重复入选 candidateIndex=1')));
                assert.ok(brokenRes.validation.errors.some(e => e.includes('索引冲突')));
                assert.ok(brokenRes.validation.errors.some(e => e.includes('未翻译长外文生肉段落')));
                assert.ok(brokenRes.validation.errors.some(e => e.includes('越界引用角标 [NEWS_99]')));
                assert.ok(brokenRes.validation.errors.some(e => e.includes('缺少有效的 http(s) 原文链接')));
                assert.equal(fs.existsSync(newsFile), false, '--validate must not write data/news.json');

                // 2b. duplicateGroups skipping an article when summary has [NEWS_k] is blocked to prevent citation shift
                const dupGroupPath = path.join(tmpDir, 'dup_group.json');
                fs.writeFileSync(dupGroupPath, JSON.stringify({
                    harvestId: candFixture.harvestId,
                    duplicateGroups: [[1, 2]],
                    articles: [
                        createValidCompiledArticle(1),
                        createValidCompiledArticle(2)
                    ],
                    summaryArticle: {
                        title: '综述测试',
                        content: '### 宏观金融\n\n主要央行联合发布跨境即时支付互联路线图最新进展 [NEWS_1]。'
                    }
                }, null, 2), 'utf8');

                const dupRes = await runPublish({
                    candidates: candPath,
                    compiled: dupGroupPath,
                    validateOnly: true
                });
                assert.equal(dupRes.success, false);
                assert.ok(dupRes.validation.errors.some(e => e.includes('duplicateGroups') && e.includes('错位')));

                // 2c. Quality warnings pass in default mode (Q1=A) and become blocking errors under --strict
                const warnCompiledPath = path.join(tmpDir, 'warn_only.json');
                fs.writeFileSync(warnCompiledPath, JSON.stringify({
                    harvestId: candFixture.harvestId,
                    articles: [
                        createValidCompiledArticle(1, {
                            region: '亚太',
                            keyPoints: ['仅有两条看点之一', '仅有两条看点之二'],
                            originalParagraphs: ['Short open excerpt only.', 'Second para.', 'Third para.', 'Fourth para.'],
                            translatedParagraphs: ['单段精译内容，段数与原文差异大于一且提取覆盖率极低。']
                        })
                    ],
                    summaryArticle: {
                        title: '短综述',
                        content: '### 单一板块\n\n短综述正文内容仅覆盖一条要闻 [NEWS_1]。'
                    }
                }, null, 2), 'utf8');

                const relaxedRes = await runPublish({
                    candidates: candPath,
                    compiled: warnCompiledPath,
                    validateOnly: true,
                    strict: false
                });
                assert.equal(relaxedRes.success, true, 'Editorial quality bounds should be warnings by default (Q1=A)');
                assert.ok(relaxedRes.validation.warnings.length >= 6, `Expected >=6 warnings, got ${relaxedRes.validation.warnings.length}`);
                assert.ok(relaxedRes.validation.warnings.some(w => w.includes('精选文章篇数')));
                assert.ok(relaxedRes.validation.warnings.some(w => w.includes('region="亚太"')));
                assert.ok(relaxedRes.validation.warnings.some(w => w.includes('核心看点数量')));
                assert.ok(relaxedRes.validation.warnings.some(w => w.includes('段落数差异过大')));
                assert.ok(relaxedRes.validation.warnings.some(w => w.includes('开放全文提取覆盖率偏低')));

                const strictRes = await runPublish({
                    candidates: candPath,
                    compiled: warnCompiledPath,
                    validateOnly: true,
                    strict: true
                });
                assert.equal(strictRes.success, false, '--strict must promote editorial quality warnings to blocking errors');
                assert.equal(strictRes.validation.warnings.length, 0);
                assert.ok(strictRes.validation.errors.every(e => e.startsWith('[STRICT] ')));
                assert.equal(strictRes.validation.errors.length, relaxedRes.validation.warnings.length);
            } finally {
                if (prevNewsBuf !== null) fs.writeFileSync(newsFile, prevNewsBuf);
            }
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('3. --force-with-lease blocks stale pushes (LEASE_CONFLICT), ag-sync-pulse auto-retries on conflict, and publish cooldown guards cross-client overwrites', async () => {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'corefeed-p2-lease-'));
        try {
            const { bareRemoteDir, workRepoDir } = initGitRepoPair(tmpRoot);
            const extPulseWs = path.join(tmpRoot, 'ext-pulse');
            fs.mkdirSync(path.join(extPulseWs, 'data', 'digests'), { recursive: true });
            fs.writeFileSync(
                path.join(extPulseWs, 'data', 'digests', '2026-11-20.json'),
                JSON.stringify(createSampleDigest('2026-11-20'), null, 2),
                'utf8'
            );

            // 3a. Client A publishes v1 news snapshot
            const compiledV1Path = path.join(tmpRoot, 'compiled_v1.json');
            fs.writeFileSync(compiledV1Path, JSON.stringify({
                articles: [
                    createValidCompiledArticle(1, {
                        id: 'lease-v1',
                        url: 'https://www.reuters.com/world/lease-v1',
                        source: { name: 'Reuters (路透社)' }
                    })
                ],
                summaryArticle: {
                    title: '第一版深度综述',
                    content: '### 宏观金融\n\n第一版跨境支付互联协议 [NEWS_1]。'
                }
            }, null, 2), 'utf8');

            const pubV1 = await runPublish({
                candidates: path.join(tmpRoot, 'no_cand.json'),
                compiled: compiledV1Path,
                localOnly: true,
                pushToGithub: true,
                repoDir: workRepoDir,
                clientId: 'client-a'
            });
            const shaV1 = pubV1.githubSync.commitSha;
            assert.equal(resolveRemoteBranchSha(workRepoDir, 'origin', 'ag-snapshot'), shaV1);

            // 3b. Client A pushes v2 snapshot advancing remote HEAD to shaV2
            const compiledV2Path = path.join(tmpRoot, 'compiled_v2.json');
            fs.writeFileSync(compiledV2Path, JSON.stringify({
                articles: [
                    createValidCompiledArticle(2, {
                        id: 'lease-v2',
                        url: 'https://www.reuters.com/world/lease-v2',
                        source: { name: 'Reuters (路透社)' }
                    })
                ],
                summaryArticle: {
                    title: '第二版深度综述',
                    content: '### 宏观金融\n\n第二版更新的全球能源协定 [NEWS_1]。'
                }
            }, null, 2), 'utf8');

            const pubV2 = await runPublish({
                candidates: path.join(tmpRoot, 'no_cand.json'),
                compiled: compiledV2Path,
                localOnly: true,
                pushToGithub: true,
                repoDir: workRepoDir,
                clientId: 'client-a'
            });
            const shaV2 = pubV2.githubSync.commitSha;
            assert.notEqual(shaV2, shaV1);

            // 3c. Direct publishSnapshotToGitHub with stale expectedRemoteSha (shaV1) is rejected with LEASE_CONFLICT
            assert.throws(
                () => publishSnapshotToGitHub(
                    {
                        version: '2.0',
                        publishedAt: new Date().toISOString(),
                        news: [{ id: 'stale', translatedTitle: '过期推送', summary: '过期推送摘要', url: 'https://example.com/stale' }]
                    },
                    {
                        repoDir: workRepoDir,
                        remote: 'origin',
                        branch: 'ag-snapshot',
                        expectedRemoteSha: shaV1
                    }
                ),
                (err) => err.code === 'LEASE_CONFLICT'
            );
            // Remote must remain intact at shaV2
            assert.equal(resolveRemoteBranchSha(workRepoDir, 'origin', 'ag-snapshot'), shaV2);

            // 3d. ag-sync-pulse with stale initial lease automatically retries via fetchRemoteSnapshotViaGit and merges cleanly
            const pulseRes = await runSyncPulse({
                sourceDir: extPulseWs,
                localOnly: true,
                pushToGithub: true,
                repoDir: workRepoDir,
                clientId: 'pulse-worker',
                expectedRemoteSha: shaV1
            });
            assert.equal(pulseRes.githubSync.pushed, true);
            assert.ok(pulseRes.githubSync.retriedAfterLeaseConflict >= 1, 'runSyncPulse must retry after LEASE_CONFLICT');

            const remoteAfterPulse = fetchRemoteSnapshotViaGit({
                repoDir: workRepoDir,
                remote: 'origin',
                branch: 'ag-snapshot'
            });
            assert.equal(remoteAfterPulse.exists, true);
            assert.equal(remoteAfterPulse.snapshot.news[0].id, 'lease-v2', 'Pulse retry must preserve latest v2 news');
            assert.equal(remoteAfterPulse.snapshot.socialPulse.latestKey, 'daily:2026-11-20');

            // 3e. Publish-time multi-client cooldown blocks Client B from overwriting Client A's fresh snapshot (<30m)
            const compiledClientBPath = path.join(tmpRoot, 'compiled_client_b.json');
            fs.writeFileSync(compiledClientBPath, JSON.stringify({
                articles: [
                    createValidCompiledArticle(3, {
                        id: 'lease-client-b',
                        url: 'https://www.reuters.com/world/lease-b',
                        source: { name: 'Reuters (路透社)' }
                    })
                ],
                summaryArticle: {
                    title: '客户端 B 深度综述',
                    content: '### 宏观金融\n\n客户端 B 的另一版本 [NEWS_1]。'
                }
            }, null, 2), 'utf8');

            await assert.rejects(
                () => runPublish({
                    candidates: path.join(tmpRoot, 'no_cand.json'),
                    compiled: compiledClientBPath,
                    localOnly: true,
                    pushToGithub: true,
                    repoDir: workRepoDir,
                    clientId: 'client-b',
                    cooldownMinutes: 30
                }),
                (err) => err.code === 'COOLDOWN_CONFLICT' && err.statusCode === 409
            );

            // 3f. Passing force: true overrides multi-client cooldown guard
            const forcedRes = await runPublish({
                candidates: path.join(tmpRoot, 'no_cand.json'),
                compiled: compiledClientBPath,
                localOnly: true,
                pushToGithub: true,
                repoDir: workRepoDir,
                clientId: 'client-b',
                cooldownMinutes: 30,
                force: true
            });
            assert.equal(forcedRes.githubSync.pushed, true);
            const finalNews = JSON.parse(
                execFileSync('git', ['--git-dir', bareRemoteDir, 'show', 'ag-snapshot:news.json'], { encoding: 'utf8' })
            );
            const finalPulse = JSON.parse(
                execFileSync('git', ['--git-dir', bareRemoteDir, 'show', 'ag-snapshot:pulse.json'], { encoding: 'utf8' })
            );
            assert.equal(finalNews.news[0].id, 'lease-client-b');
            assert.equal(finalPulse.latestKey, 'daily:2026-11-20');
        } finally {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        }
    });

    it('4. editionId audio binding keeps matching news audio across Step 5.2->5.4 and drops stale news audio while keeping pulse (Q2=A)', async () => {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'corefeed-p2-edition-'));
        try {
            const { bareRemoteDir, workRepoDir } = initGitRepoPair(tmpRoot);

            const compiledEd1Path = path.join(tmpRoot, 'ed1.json');
            fs.writeFileSync(compiledEd1Path, JSON.stringify({
                articles: [
                    createValidCompiledArticle(1, {
                        id: 'ed1-art-1',
                        url: 'https://www.reuters.com/world/ed1-art-1',
                        source: { name: 'Reuters (路透社)' }
                    })
                ],
                summaryArticle: {
                    title: '2026年11月20日早间 全球要闻深度综述：跨境支付提速',
                    content: '### 宏观\n\n第一期深度综述正文 [NEWS_1]。'
                }
            }, null, 2), 'utf8');

            // Step 5.2: local-only pre-TTS publish generates deterministic editionId and persists to news.json / summary.json
            const step52 = await runPublish({
                candidates: path.join(tmpRoot, 'no_cand.json'),
                compiled: compiledEd1Path,
                localOnly: true,
                pushToGithub: false,
                clientId: 'ed-publisher'
            });
            assert.match(step52.editionId, /^ed-[a-f0-9]{12}$/);
            const savedNewsDoc = JSON.parse(fs.readFileSync(config.storage.newsFile, 'utf8'));
            const savedSummaryDoc = JSON.parse(fs.readFileSync(config.storage.summaryFile, 'utf8'));
            assert.equal(savedNewsDoc.editionId, step52.editionId);
            assert.equal(savedSummaryDoc.editionId, step52.editionId);

            // Simulate Step 5.3 TTS writing tracks.news (bound to step52.editionId) + tracks.pulse
            const newsMp3 = createFakeMp3Buffer('ED1_NEWS_MP3_');
            const pulseMp3 = createFakeMp3Buffer('ED1_PULSE_MP3_');
            fs.mkdirSync(AUDIO_DIR, { recursive: true });
            fs.writeFileSync(path.join(workRepoDir, 'data', 'audio', 'briefing-news.mp3'), newsMp3);
            fs.writeFileSync(path.join(workRepoDir, 'data', 'audio', 'briefing-pulse.mp3'), pulseMp3);

            const audioSvc = new AudioBroadcastService(null, stateManager);
            await audioSvc.mergeTrack('news', {
                title: '早间全球要闻双主播精播',
                editionId: step52.editionId,
                scriptSha256: 'a'.repeat(64),
                durationSec: 210,
                chapters: [{ index: 1, title: '开场', speaker: 'Serena', startSec: 0, durationSec: 12, text: '欢迎收听。' }]
            }, newsMp3, { emit: false });
            await audioSvc.mergeTrack('pulse', {
                title: '欧美社媒早班车',
                issueKey: 'daily:2026-11-20',
                durationSec: 190,
                chapters: [{ index: 1, title: '导播', speaker: 'Serena', startSec: 0, durationSec: 10, text: '早上好。' }]
            }, pulseMp3, { emit: false });

            // Step 5.4: full publish computes the EXACT SAME editionId and publishes both audio tracks
            const step54 = await runPublish({
                candidates: path.join(tmpRoot, 'no_cand.json'),
                compiled: compiledEd1Path,
                localOnly: true,
                pushToGithub: true,
                repoDir: workRepoDir,
                clientId: 'ed-publisher'
            });
            assert.equal(step54.editionId, step52.editionId);
            assert.equal(step54.droppedStaleNewsAudio, false);

            const manifestEd1 = JSON.parse(
                execFileSync('git', ['--git-dir', bareRemoteDir, 'show', 'ag-snapshot:manifest.json'], { encoding: 'utf8' })
            );
            const audioEd1 = JSON.parse(
                execFileSync('git', ['--git-dir', bareRemoteDir, 'show', 'ag-snapshot:audio.json'], { encoding: 'utf8' })
            );
            assert.equal(manifestEd1.editionId, step52.editionId);
            assert.equal(audioEd1.tracks.news.editionId, step52.editionId);
            assert.equal(audioEd1.tracks.news.scriptSha256, 'a'.repeat(64));
            assert.equal(audioEd1.tracks.pulse.issueKey, 'daily:2026-11-20');

            // Edition 2 published WITHOUT re-running TTS (local + remote still carry old editionId1 news audio)
            const compiledEd2Path = path.join(tmpRoot, 'ed2.json');
            fs.writeFileSync(compiledEd2Path, JSON.stringify({
                articles: [
                    createValidCompiledArticle(2, {
                        id: 'ed2-art-1',
                        translatedTitle: '欧洲能源部长达成冬季天然气联合储备扩容新协议',
                        url: 'https://www.reuters.com/world/ed2-art-1',
                        source: { name: 'Reuters (路透社)' }
                    })
                ],
                summaryArticle: {
                    title: '2026年11月20日晚间 全球要闻深度综述：欧洲能源储备扩容',
                    content: '### 能源安全\n\n第二期最新深度综述正文 [NEWS_1]。'
                }
            }, null, 2), 'utf8');

            const pubEd2 = await runPublish({
                candidates: path.join(tmpRoot, 'no_cand.json'),
                compiled: compiledEd2Path,
                localOnly: true,
                pushToGithub: true,
                repoDir: workRepoDir,
                clientId: 'ed-publisher',
                force: true
            });
            assert.notEqual(pubEd2.editionId, step52.editionId);
            assert.equal(pubEd2.droppedStaleNewsAudio, true, 'Q2=A must drop mismatched tracks.news');

            const manifestEd2 = JSON.parse(
                execFileSync('git', ['--git-dir', bareRemoteDir, 'show', 'ag-snapshot:manifest.json'], { encoding: 'utf8' })
            );
            const audioEd2 = JSON.parse(
                execFileSync('git', ['--git-dir', bareRemoteDir, 'show', 'ag-snapshot:audio.json'], { encoding: 'utf8' })
            );
            assert.equal(manifestEd2.editionId, pubEd2.editionId);
            assert.equal(audioEd2.tracks.news, undefined, 'Stale tracks.news must be excluded from snapshot');
            assert.equal(audioEd2.tracks.pulse.issueKey, 'daily:2026-11-20', 'Valid tracks.pulse must remain intact');

            // Direct unit check: remote old news audio is NOT inherited when localAudio is null
            const remoteDropCheck = resolveEditionMatchedAudio({
                localAudio: null,
                remoteSnap: { editionId: manifestEd1.editionId, audioBroadcast: audioEd1 },
                editionId: pubEd2.editionId
            });
            assert.equal(remoteDropCheck.droppedStaleNewsAudio, true);
            assert.equal(remoteDropCheck.effectiveAudio.tracks.news, undefined);
            assert.equal(remoteDropCheck.effectiveAudio.tracks.pulse.issueKey, 'daily:2026-11-20');
        } finally {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        }
    });

    it('5. TTS pipeline hardening: env-var cross-platform paths, editionId/scriptSha256, --max-total-chars, idempotent reuse, preflight & _verify_zero_billing', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corefeed-p2-tts-'));
        try {
            // 5a. resolveColabPython respects QWEN3_COLAB_ROOT venv and QWEN3_COLAB_PYTHON
            const fakeColabRoot = path.join(tmpDir, 'colab-root');
            const fakeVenvPy = process.platform === 'win32'
                ? path.join(fakeColabRoot, '.venv', 'Scripts', 'python.exe')
                : path.join(fakeColabRoot, '.venv', 'bin', 'python3');
            fs.mkdirSync(path.dirname(fakeVenvPy), { recursive: true });
            fs.writeFileSync(fakeVenvPy, '#!/bin/sh\n', 'utf8');

            delete process.env.QWEN3_COLAB_PYTHON;
            process.env.QWEN3_COLAB_ROOT = fakeColabRoot;
            assert.equal(resolveColabPython(), fakeVenvPy);

            const explicitPy = path.join(tmpDir, 'custom-python');
            fs.writeFileSync(explicitPy, '#!/bin/sh\n', 'utf8');
            process.env.QWEN3_COLAB_PYTHON = explicitPy;
            assert.equal(resolveColabPython(), explicitPy);

            delete process.env.QWEN3_COLAB_PYTHON;
            delete process.env.QWEN3_COLAB_ROOT;

            // 5b. ag-generate-tts.py --dry-run-script emits editionId, scriptSha256, and totalChars
            const ttsDataDir = path.join(tmpDir, 'data');
            fs.mkdirSync(path.join(ttsDataDir, 'audio'), { recursive: true });
            fs.writeFileSync(path.join(ttsDataDir, 'news.json'), JSON.stringify({
                editionId: 'ed-abc123456789',
                lastUpdated: '2026-11-20T09:00:00.000Z',
                news: [
                    {
                        id: 'tts-1',
                        translatedTitle: '多国央行推出跨境清算新标准',
                        summary: '国际清算银行发布最新跨境支付协同路线图。',
                        source: { name: 'Reuters (路透社)' }
                    }
                ]
            }, null, 2), 'utf8');
            fs.writeFileSync(path.join(ttsDataDir, 'summary.json'), JSON.stringify({
                editionId: 'ed-abc123456789',
                article: {
                    title: '2026年11月20日 全球要闻深度综述：跨境清算提速',
                    content: '### 宏观政策\n全球央行推进实时清算互联 [NEWS_1]。'
                }
            }, null, 2), 'utf8');

            const pyBin = process.platform === 'win32' ? 'python' : 'python3';
            const ttsScript = path.join(ROOT_DIR, 'scripts', 'ag-generate-tts.py');
            const dryOut = execFileSync(pyBin, [ttsScript, '--mode', 'news', '--data-dir', ttsDataDir, '--dry-run-script'], {
                encoding: 'utf8'
            });
            const dryJson = JSON.parse(dryOut);
            assert.equal(dryJson.ok, true);
            assert.equal(dryJson.plans[0].editionId, 'ed-abc123456789');
            assert.match(dryJson.plans[0].scriptSha256, /^[a-f0-9]{64}$/);
            assert.ok(dryJson.totalChars > 50);

            // 5c. --max-total-chars rejects oversized scripts before Colab launch
            const overCap = spawnSync(
                pyBin,
                [ttsScript, '--mode', 'news', '--data-dir', ttsDataDir, '--max-total-chars', '20', '--dry-run-script'],
                { encoding: 'utf8' }
            );
            assert.notEqual(overCap.status, 0);
            assert.match(overCap.stderr || '', /--max-total-chars/);

            // 5d. Idempotent reuse skips Colab when existing audio_broadcast.json & MP3 match editionId + scriptSha256
            const dummyMp3 = createFakeMp3Buffer('REUSE_MP3_');
            fs.writeFileSync(path.join(ttsDataDir, 'audio', 'briefing-news.mp3'), dummyMp3);
            fs.writeFileSync(path.join(ttsDataDir, 'audio_broadcast.json'), JSON.stringify({
                version: '1.0',
                tracks: {
                    news: {
                        track: 'news',
                        editionId: 'ed-abc123456789',
                        scriptSha256: dryJson.plans[0].scriptSha256,
                        sha256: computeBufferSha256(dummyMp3)
                    }
                }
            }, null, 2), 'utf8');

            const reuseRun = spawnSync(
                pyBin,
                [ttsScript, '--mode', 'news', '--data-dir', ttsDataDir],
                {
                    encoding: 'utf8',
                    env: {
                        ...process.env,
                        QWEN3_COLAB_ROOT: path.join(tmpDir, 'nonexistent-colab'),
                        QWEN3_JOB_RUNNER: path.join(tmpDir, 'nonexistent-runner.py')
                    }
                }
            );
            assert.equal(reuseRun.status, 0, `Idempotent reuse should exit 0 without Colab, stderr=${reuseRun.stderr}`);
            assert.match(reuseRun.stdout, /"skipped_colab": true/);
            assert.match(reuseRun.stdout, /"reused": \[\s*"news"\s*\]/);

            // 5e. --force bypasses reuse and hits preflight missing-script check cleanly
            const preflightFail = spawnSync(
                pyBin,
                [ttsScript, '--mode', 'news', '--data-dir', ttsDataDir, '--force'],
                {
                    encoding: 'utf8',
                    env: {
                        ...process.env,
                        QWEN3_COLAB_ROOT: path.join(tmpDir, 'nonexistent-colab'),
                        QWEN3_JOB_RUNNER: path.join(tmpDir, 'nonexistent-runner.py')
                    }
                }
            );
            assert.notEqual(preflightFail.status, 0);
            assert.match(preflightFail.stderr || '', /QWEN3_JOB_RUNNER/);

            // 5f. Python unit verification of env path resolution and _verify_zero_billing()
            const pyCheckCode = `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("ag_tts", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

assert str(mod.COLAB_REPO_ROOT) == os.environ["QWEN3_COLAB_ROOT"]
assert str(mod.SKILL_JOB_RUNNER) == os.environ["QWEN3_JOB_RUNNER"]
assert mod.RAW_SNAPSHOT_BASE == "https://example.com/custom-snap"

bad_cases = [
    {},
    None,
    {"active_assignments": 1, "cu_per_hour": 0.0},
    {"active_assignments": ["gpu-l4-1"]},
    {"active_assignments": 0, "cu_per_hour": 1.96},
    {"active_assignments": 0, "billing_rate": 0.5},
    {"error": "stop_timeout", "timed_out": True},
    {"ok": False, "active_assignments": 0},
    {"stopped": False, "active_assignments": 0},
]
for case in bad_cases:
    ok, reason = mod._verify_zero_billing(case)
    assert not ok, f"Expected bad billing receipt to fail: {case}"

good_cases = [
    {"ok": True, "active_assignments": 0, "cu_per_hour": 0.0},
    {"stopped": True, "active_assignments": [], "billing_rate": 0},
]
for case in good_cases:
    ok, reason = mod._verify_zero_billing(case)
    assert ok, f"Expected clean billing receipt to pass: {case} ({reason})"

print("PY_UNIT_OK")
`;
            const pyUnitOut = execFileSync(pyBin, ['-c', pyCheckCode, ttsScript], {
                encoding: 'utf8',
                env: {
                    ...process.env,
                    QWEN3_COLAB_ROOT: path.join(tmpDir, 'env-colab-root'),
                    QWEN3_JOB_RUNNER: path.join(tmpDir, 'env-runner.py'),
                    COREFEED_SNAPSHOT_RAW_BASE: 'https://example.com/custom-snap/'
                }
            });
            assert.match(pyUnitOut, /PY_UNIT_OK/);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('6. ALLOW_INSECURE_TLS defaults to strict verification, unlocks self-signed certs only when true, and zero hardcoded rejectUnauthorized: false or Windows paths remain', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corefeed-p2-tls-'));
        const keyPath = path.join(tmpDir, 'key.pem');
        const certPath = path.join(tmpDir, 'cert.pem');
        let httpsServer = null;

        try {
            execFileSync('openssl', [
                'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                '-keyout', keyPath,
                '-out', certPath,
                '-days', '1',
                '-subj', '/CN=127.0.0.1'
            ], { stdio: 'ignore' });

            httpsServer = https.createServer(
                { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
                (req, res) => {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                }
            );
            await new Promise((resolve, reject) => {
                httpsServer.listen(0, '127.0.0.1', (err) => (err ? reject(err) : resolve()));
            });
            const httpsUrl = `https://127.0.0.1:${httpsServer.address().port}/ping`;

            // 6a. Default (ALLOW_INSECURE_TLS unset / false) rejects self-signed certificate
            delete process.env.ALLOW_INSECURE_TLS;
            assert.equal(isInsecureTlsAllowed(), false);
            await assert.rejects(
                () => axios.get(httpsUrl, {
                    httpsAgent: getHttpsAgent({ keepAlive: false }),
                    proxy: false,
                    timeout: 5000
                }),
                (err) => /CERT|certificate|self[- ]signed|unable to verify/i.test(`${err.code || ''} ${err.message || ''}`)
            );

            // 6b. ALLOW_INSECURE_TLS=true permits self-signed certificate
            process.env.ALLOW_INSECURE_TLS = 'true';
            assert.equal(isInsecureTlsAllowed(), true);
            const okRes = await axios.get(httpsUrl, {
                httpsAgent: getHttpsAgent({ keepAlive: false }),
                proxy: false,
                timeout: 5000
            });
            assert.equal(okRes.status, 200);
            assert.equal(okRes.data.ok, true);

            // 6c. Static audit: zero hardcoded rejectUnauthorized: false outside utils/network_config.js and tests/
            const scanDirs = ['config', 'middleware', 'routes', 'scripts', 'services', 'utils'];
            const filesToScan = [path.join(ROOT_DIR, 'server.js')];
            const walk = (dir) => {
                if (!fs.existsSync(dir)) return;
                for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
                    const full = path.join(dir, ent.name);
                    if (ent.isDirectory()) walk(full);
                    else if (ent.name.endsWith('.js') || ent.name.endsWith('.py')) filesToScan.push(full);
                }
            };
            scanDirs.forEach(d => walk(path.join(ROOT_DIR, d)));

            const hardcodedTlsHits = [];
            const hardcodedWinPathHits = [];
            for (const fp of filesToScan) {
                const rel = path.relative(ROOT_DIR, fp).replace(/\\/g, '/');
                const src = fs.readFileSync(fp, 'utf8');
                if (rel !== 'utils/network_config.js' && /rejectUnauthorized\s*:\s*false/.test(src)) {
                    hardcodedTlsHits.push(rel);
                }
                if (/[cC]:\\Users\\alan/.test(src)) {
                    hardcodedWinPathHits.push(rel);
                }
            }
            const skillMd = fs.readFileSync(path.join(ROOT_DIR, '.agents', 'skills', 'corefeed-editor', 'SKILL.md'), 'utf8');
            if (/[cC]:\\Users\\alan/.test(skillMd)) {
                hardcodedWinPathHits.push('.agents/skills/corefeed-editor/SKILL.md');
            }

            assert.deepEqual(hardcodedTlsHits, [], `Found hardcoded rejectUnauthorized: false in: ${hardcodedTlsHits.join(', ')}`);
            assert.deepEqual(hardcodedWinPathHits, [], `Found hardcoded personal Windows path in: ${hardcodedWinPathHits.join(', ')}`);
        } finally {
            delete process.env.ALLOW_INSECURE_TLS;
            if (httpsServer) {
                await new Promise((resolve) => httpsServer.close(() => resolve()));
            }
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
