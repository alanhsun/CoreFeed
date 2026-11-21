/**
 * 聚核 CoreFeed v2.0 — 大模型精编产物聚合契约校验器 (utils/compiled_validator.js)
 *
 * 设计原则：
 *   - 零外部依赖，一次性汇总所有错误 (errors) 与质量告警 (warnings)，避免遇错即抛导致大模型反复重试；
 *   - 分层校验（按 Q1=A）：
 *     1. 硬不变量 (Errors，一律阻断发布)：harvestId 批次绑定、candidateIndex/id 合法与唯一性、
 *        禁止跨篇重复或主条目被吞入 mergedIndices、duplicateGroups 导致的角标偏移、合法 http(s) URL、
 *        中文字段齐全、逐段防未译外文生肉、[NEWS_k] 引注不越界、综述含中文正文；
 *     2. 总编质量契约 (默认 Warnings，传入 strict: true 时升级为 Errors)：篇数 20~30、标题 10~36 字、
 *        导语 60~160 字、严格 3 条看点、region/category 严格命中枚举、原文/译文段落数一致、
 *        开放长文覆盖率 >= 50%、综述 600~1800 字与 3~5 个 ### 板块、综述漏引提醒。
 */
const { VALID_REGIONS, VALID_CATEGORIES, hasChineseText } = require('./editorial_formatter');
const { isSafeHttpUrl } = require('./helpers');

function countCjk(str = '') {
    const m = String(str || '').match(/[\u4e00-\u9fff]/g);
    return m ? m.length : 0;
}

/**
 * 扫描单篇精编文章的硬不变量（兼容旧版单篇校验测试 validateCompiledArticle）
 * @returns {{ errors: string[], warnings: string[] }}
 */
function inspectCompiledArticle(article, position, context = {}) {
    const errors = [];
    const warnings = [];
    const label = `第 ${position} 篇 (${article?.id || article?.url || 'unknown'})`;
    const rawComp = context.rawComp || article || {};
    const baseCand = context.baseCand || null;

    if (!article || typeof article !== 'object') {
        errors.push(`${label} 不是有效的文章对象`);
        return { errors, warnings };
    }

    // 1. 链接必须为合法 http(s) URL
    if (!isSafeHttpUrl(article.url)) {
        errors.push(`${label} 缺少有效的 http(s) 原文链接 (url="${article.url || ''}")`);
    }

    // 2. 基础中文字段硬不变量
    const zhTitle = String(article.translatedTitle || '').trim();
    if (!hasChineseText(zhTitle, 2)) {
        errors.push(`${label} 缺少由大模型精编的中文标题 (translatedTitle): "${zhTitle}"`);
    } else if (zhTitle.length < 10 || zhTitle.length > 36) {
        warnings.push(`${label} 中文标题字数 ${zhTitle.length} 偏离建议区间 14~32 字（容差 10~36）`);
    }

    const zhSummary = String(article.summary || '').trim();
    if (!hasChineseText(zhSummary, 6)) {
        errors.push(`${label} 缺少由大模型撰写的中文导语摘要 (summary)`);
    } else if (zhSummary.length < 60 || zhSummary.length > 160) {
        warnings.push(`${label} 导语字数 ${zhSummary.length} 偏离建议区间 80~130 字（容差 60~160）`);
    }

    const keyPoints = Array.isArray(article.keyPoints) ? article.keyPoints : [];
    if (keyPoints.length === 0 || !keyPoints.every(kp => hasChineseText(kp, 2))) {
        errors.push(`${label} 缺少由大模型提取的中文核心看点数组 (keyPoints)`);
    } else if (keyPoints.length !== 3) {
        warnings.push(`${label} 核心看点数量为 ${keyPoints.length} 条（契约要求严格 3 条）`);
    }

    // 3. 逐段译文防未翻译生肉
    const translatedParas = Array.isArray(article.translatedParagraphs) ? article.translatedParagraphs : [];
    if (translatedParas.length === 0 || !translatedParas.some(p => hasChineseText(p, 4))) {
        errors.push(`${label} 缺少由大模型翻译的全文中文段落数组 (translatedParagraphs)`);
    } else {
        const untranslatedIdx = [];
        translatedParas.forEach((p, pIdx) => {
            const text = String(p || '').trim();
            // 超过 30 字符且完全没有汉字的段落视为未翻译外文生肉（排除纯 URL/数字短行）
            if (text.length >= 30 && countCjk(text) === 0 && /[A-Za-zÀ-ÿ\u3040-\u30ff\uac00-\ud7af]{12,}/.test(text)) {
                untranslatedIdx.push(pIdx + 1);
            }
        });
        if (untranslatedIdx.length > 0) {
            errors.push(`${label} translatedParagraphs 含未翻译长外文生肉段落 (第 ${untranslatedIdx.join(', ')} 段)`);
        }
    }

    // 4. 地域/领域枚举漂移检查（检测静默兜底前大模型原始输入）
    if (rawComp.region !== undefined && rawComp.region !== null && String(rawComp.region).trim() !== '') {
        const rawRegion = String(rawComp.region).trim();
        if (!VALID_REGIONS.includes(rawRegion)) {
            warnings.push(`${label} region="${rawRegion}" 不在标准枚举 [${VALID_REGIONS.join('/')}] 内`);
        }
    }
    if (rawComp.category !== undefined && rawComp.category !== null && String(rawComp.category).trim() !== '') {
        const rawCat = String(rawComp.category).trim();
        if (!VALID_CATEGORIES.includes(rawCat)) {
            warnings.push(`${label} category="${rawCat}" 不在标准枚举 [${VALID_CATEGORIES.join('/')}] 内`);
        }
    }

    // 5. 原文与译文段落数对齐 & 长文提取覆盖率
    const origParas = Array.isArray(article.originalParagraphs) ? article.originalParagraphs : [];
    if (origParas.length >= 2 && translatedParas.length > 0 && Math.abs(origParas.length - translatedParas.length) > 1) {
        warnings.push(`${label} originalParagraphs(${origParas.length}段) 与 translatedParagraphs(${translatedParas.length}段) 段落数差异过大`);
    }

    const harvestedFullText = String(baseCand?.fullText || '').trim();
    const isHardPaywall = String(baseCand?.source?.paywall || '').toLowerCase() === 'hard';
    if (!isHardPaywall && harvestedFullText.length >= 800 && origParas.length > 0) {
        const extractedChars = origParas.join('').length;
        const ratio = extractedChars / harvestedFullText.length;
        if (ratio < 0.5) {
            warnings.push(
                `${label} 开放全文提取覆盖率偏低 (${Math.round(ratio * 100)}%，提取 ${extractedChars}/${harvestedFullText.length} 字)`
            );
        }
    }

    return { errors, warnings };
}

/**
 * 校验整份精编数据包（汇总所有硬不变量错误与质量契约告警）
 */
function validateCompiledBundle({
    compiledData,
    harvestData = null,
    rawEntries = [],
    preAssemblyErrors = [],
    curatedArticles = [],
    finalNews = [],
    articleContexts = [],
    summaryArticle = null,
    duplicateSkippedCount = 0,
    options = {}
}) {
    const errors = [...preAssemblyErrors];
    const warnings = [];
    const strict = Boolean(options.strict);
    const ignoreHarvestId = Boolean(options.ignoreHarvestId);

    // 1. harvestId 批次一致性校验
    const harvestId = String(harvestData?.harvestId || '').trim();
    const compiledHarvestId = String(compiledData?.harvestId || '').trim();
    const usesCandidateRefs = rawEntries.some(
        (comp) => comp && (typeof comp.candidateIndex === 'number' || typeof comp.index === 'number')
    );

    if (!ignoreHarvestId && harvestId) {
        if (compiledHarvestId && compiledHarvestId !== harvestId) {
            errors.push(
                `批次不匹配: ag_compiled.json 的 harvestId="${compiledHarvestId}" 与当前 ag_candidates.json 的 harvestId="${harvestId}" 不一致（期间可能触发了重新采集，请重新核对或重编）`
            );
        } else if (!compiledHarvestId && usesCandidateRefs) {
            errors.push(
                `缺少批次绑定字段 harvestId: 当前 ag_candidates.json 批次为 "${harvestId}"，请在 ag_compiled.json 顶层写入 "harvestId": "${harvestId}" 以防索引错配`
            );
        }
    }

    // 2. 跨条目唯一性与 mergedIndices 冲突检测
    const seenPrimaryIndices = new Map();
    const seenIds = new Map();
    const mergedIndexOwners = new Map();

    articleContexts.forEach((ctx, idx) => {
        const pos = idx + 1;
        if (ctx.resolvedOneBased) {
            if (seenPrimaryIndices.has(ctx.resolvedOneBased)) {
                errors.push(
                    `重复入选 candidateIndex=${ctx.resolvedOneBased}（同时出现在第 ${seenPrimaryIndices.get(ctx.resolvedOneBased)} 篇与第 ${pos} 篇）`
                );
            } else {
                seenPrimaryIndices.set(ctx.resolvedOneBased, pos);
            }
        }
        const artId = String(ctx.assembled?.id || '').trim();
        if (artId) {
            if (seenIds.has(artId)) {
                errors.push(`重复文章 ID "${artId}"（同时出现在第 ${seenIds.get(artId)} 篇与第 ${pos} 篇）`);
            } else {
                seenIds.set(artId, pos);
            }
        }
        for (const mIdx of ctx.explicitMergedIndices || []) {
            if (!mergedIndexOwners.has(mIdx)) mergedIndexOwners.set(mIdx, []);
            mergedIndexOwners.get(mIdx).push(pos);
        }
    });

    for (const [primaryIdx, ownerPos] of seenPrimaryIndices.entries()) {
        if (mergedIndexOwners.has(primaryIdx)) {
            const otherPositions = mergedIndexOwners.get(primaryIdx).filter(p => p !== ownerPos);
            if (otherPositions.length > 0) {
                errors.push(
                    `索引冲突: 第 ${ownerPos} 篇的主 candidateIndex=${primaryIdx} 同时出现在第 ${otherPositions.join(', ')} 篇的 mergedIndices 中`
                );
            }
        }
    }

    // 3. 逐篇内容校验
    if (finalNews.length === 0) {
        errors.push('未能从精编产物中解析出任何有效中文报道');
    } else {
        if (finalNews.length < 20 || finalNews.length > 30) {
            warnings.push(`精选文章篇数为 ${finalNews.length} 篇（SKILL 契约建议区间 20~30 篇）`);
        }
        if (curatedArticles.length > finalNews.length) {
            warnings.push(`精编条目 ${curatedArticles.length} 篇超过上限 ${finalNews.length}，尾部 ${curatedArticles.length - finalNews.length} 篇将被裁切`);
        }
        finalNews.forEach((art, idx) => {
            const ctx = articleContexts[idx] || {};
            const itemRes = inspectCompiledArticle(art, idx + 1, ctx);
            errors.push(...itemRes.errors);
            warnings.push(...itemRes.warnings);
        });
    }

    // 4. 综述正文、角标 [NEWS_k] 越界与板块结构校验
    const summaryContent = String(summaryArticle?.content || '').trim();
    if (!summaryArticle || !hasChineseText(summaryContent || summaryArticle.htmlContent || '', 10)) {
        errors.push('缺少由大模型撰写的中文《全球要闻深度综述》(summaryArticle / summaryMarkdown)');
    } else {
        const citationMatches = [...summaryContent.matchAll(/\[NEWS_(\d+)\]/g)];
        const citedSet = new Set();
        const outOfRange = [];
        for (const m of citationMatches) {
            const num = parseInt(m[1], 10);
            if (num < 1 || num > finalNews.length) {
                outOfRange.push(`[NEWS_${num}]`);
            } else {
                citedSet.add(num);
            }
        }
        if (outOfRange.length > 0) {
            errors.push(
                `综述包含越界引用角标 ${[...new Set(outOfRange)].join(', ')}（当前仅有 ${finalNews.length} 篇入选文章，允许范围 [NEWS_1]..[NEWS_${finalNews.length}]）`
            );
        }
        if (duplicateSkippedCount > 0 && citationMatches.length > 0) {
            errors.push(
                `duplicateGroups 导致 ${duplicateSkippedCount} 条重复文章在组装期被跳过，可能造成综述 [NEWS_k] 序号错位；请先在 articles 中去重后再定稿`
            );
        }

        const sectionHeaders = summaryContent
            .split('\n')
            .map(l => l.trim())
            .filter(l => /^#{2,4}\s+/.test(l) || /^【.+】$/.test(l));
        if (sectionHeaders.length < 3 || sectionHeaders.length > 5) {
            warnings.push(`综述专题板块数为 ${sectionHeaders.length} 个（SKILL 契约建议 3~5 个 ### 板块）`);
        }
        if (summaryContent.length < 600 || summaryContent.length > 1800) {
            warnings.push(`综述正文字数为 ${summaryContent.length} 字（SKILL 契约建议 800~1500 字，容差 600~1800）`);
        }

        const uncited = [];
        for (let i = 1; i <= finalNews.length; i++) {
            if (!citedSet.has(i)) uncited.push(i);
        }
        if (uncited.length > 0) {
            warnings.push(`综述未引用第 ${uncited.join(', ')} 篇要闻（共漏引 ${uncited.length}/${finalNews.length} 篇）`);
        }
    }

    const effectiveErrors = strict ? [...errors, ...warnings.map(w => `[STRICT] ${w}`)] : errors;
    return {
        valid: effectiveErrors.length === 0,
        strict,
        errors: effectiveErrors,
        warnings: strict ? [] : warnings,
        hardErrorCount: errors.length,
        warningCount: warnings.length,
        stats: {
            harvestId: harvestId || null,
            compiledHarvestId: compiledHarvestId || null,
            articleCount: finalNews.length,
            summaryChars: summaryContent.length
        }
    };
}

function formatValidationReport(report) {
    const lines = [];
    if (report.errors.length > 0) {
        lines.push(`精编产物校验失败（共 ${report.errors.length} 项阻断错误${report.warnings.length ? `，${report.warnings.length} 项质量告警` : ''}）：`);
        report.errors.forEach((msg, idx) => {
            lines.push(`  [ERROR ${idx + 1}] ${msg}`);
        });
    }
    if (report.warnings.length > 0) {
        lines.push(`精编产物质量告警（共 ${report.warnings.length} 项，加 --strict 可设为阻断）：`);
        report.warnings.forEach((msg, idx) => {
            lines.push(`  [WARN  ${idx + 1}] ${msg}`);
        });
    }
    return lines.join('\n');
}

module.exports = {
    inspectCompiledArticle,
    validateCompiledBundle,
    formatValidationReport
};
