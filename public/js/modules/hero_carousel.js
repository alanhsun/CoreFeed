/**
 * CoreFeed v3.0 — Top-3 焦点轮播控制、显式暂停按钮与移动端触摸滑动 (public/js/modules/hero_carousel.js)
 */

export const heroCarouselMethods = {
    startHeroCarousel() {
        this.stopHeroCarousel();
        this.initHeroTouchGestures();
        this.syncHeroPauseButtonUi();
        if (this.heroSlideCount <= 1 || this.heroCarouselUserPaused) return;
        if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            return;
        }
        this.heroCarouselTimer = setInterval(() => {
            if (!this.heroCarouselPaused && !this.heroCarouselUserPaused && this.activeTab === 'feed') {
                this.nextHeroSlide(false);
            }
        }, 6500);
    },

    stopHeroCarousel() {
        if (this.heroCarouselTimer) {
            clearInterval(this.heroCarouselTimer);
            this.heroCarouselTimer = null;
        }
    },

    pauseHeroCarousel() {
        this.heroCarouselPaused = true;
    },

    resumeHeroCarousel() {
        this.heroCarouselPaused = false;
    },

    toggleHeroCarouselPause() {
        this.heroCarouselUserPaused = !this.heroCarouselUserPaused;
        if (this.heroCarouselUserPaused) {
            this.stopHeroCarousel();
        } else {
            this.startHeroCarousel();
        }
        this.syncHeroPauseButtonUi();
    },

    syncHeroPauseButtonUi() {
        const paused = Boolean(this.heroCarouselUserPaused);
        const btns = document.querySelectorAll('#heroCarousel .hero-pause-btn');
        btns.forEach((btn) => {
            btn.setAttribute('aria-pressed', paused ? 'true' : 'false');
            btn.setAttribute('aria-label', paused ? '继续自动轮播' : '暂停自动轮播');
            btn.setAttribute('title', paused ? '继续自动轮播' : '暂停自动轮播');
            const icon = btn.querySelector('i');
            if (icon) {
                icon.className = paused ? 'fa-solid fa-play' : 'fa-solid fa-pause';
            }
        });
    },

    initHeroTouchGestures() {
        const carousel = document.getElementById('heroCarousel');
        if (!carousel || carousel.dataset.touchBound === '1') return;
        carousel.dataset.touchBound = '1';

        let startX = 0;
        let startY = 0;
        let tracking = false;

        carousel.addEventListener('touchstart', (e) => {
            if (!e.touches || e.touches.length !== 1) return;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            tracking = true;
        }, { passive: true });

        carousel.addEventListener('touchend', (e) => {
            if (!tracking || !e.changedTouches || e.changedTouches.length !== 1) return;
            tracking = false;
            const dx = e.changedTouches[0].clientX - startX;
            const dy = e.changedTouches[0].clientY - startY;
            if (Math.abs(dx) >= 40 && Math.abs(dx) > Math.abs(dy) * 1.2) {
                if (dx < 0) {
                    this.nextHeroSlide(true);
                } else {
                    this.prevHeroSlide(true);
                }
            }
        }, { passive: true });
    },

    goToHeroSlide(targetIdx, manual = true) {
        if (this.heroSlideCount <= 1) return;
        const normalized = ((targetIdx % this.heroSlideCount) + this.heroSlideCount) % this.heroSlideCount;
        this.heroSlideIndex = normalized;

        const carousel = document.getElementById('heroCarousel');
        if (!carousel) return;

        const slides = carousel.querySelectorAll('.hero-carousel-slide');
        slides.forEach((slide, idx) => {
            const active = idx === normalized;
            slide.classList.toggle('is-active', active);
            slide.setAttribute('aria-hidden', active ? 'false' : 'true');
        });

        const dockItems = carousel.querySelectorAll('.hero-dock-item');
        dockItems.forEach((btn, idx) => {
            const active = idx === normalized;
            btn.classList.toggle('is-active', active);
            btn.setAttribute('aria-selected', active ? 'true' : 'false');
        });

        if (manual && !this.heroCarouselUserPaused) {
            this.startHeroCarousel();
        }
    },

    nextHeroSlide(manual = true) {
        this.goToHeroSlide(this.heroSlideIndex + 1, manual);
    },

    prevHeroSlide(manual = true) {
        this.goToHeroSlide(this.heroSlideIndex - 1, manual);
    },

    renderHeroCarouselHtml(heroItems) {
        const totalHero = heroItems.length;
        const slidesHtml = heroItems.map((item, slideIdx) => this.renderHeroSlideHtml(item, slideIdx, totalHero)).join('');
        const dockHtml = totalHero > 1 ? `
            <div class="hero-carousel-dock" role="tablist" aria-label="切换前三位重点要闻">
                ${heroItems.map((hItem, hIdx) => {
                    const hNum = String(hIdx + 1).padStart(2, '0');
                    const hTitle = hItem.translatedTitle || hItem.title || '无标题';
                    const hSource = hItem.source?.name || 'Global Media';
                    const active = hIdx === 0;
                    return `
                        <button type="button"
                                role="tab"
                                aria-selected="${active ? 'true' : 'false'}"
                                data-dock-index="${hIdx}"
                                onclick="app.goToHeroSlide(${hIdx})"
                                class="hero-dock-item ${active ? 'is-active' : ''}">
                            <div class="hero-dock-meta">
                                <span class="hero-dock-num">${hNum}</span>
                                <span class="card-meta-sep">/</span>
                                <span class="hero-dock-source">${this.escapeHtml(hSource)}</span>
                            </div>
                            <div class="hero-dock-title line-clamp-1">${this.escapeHtml(hTitle)}</div>
                        </button>
                    `;
                }).join('')}
            </div>
        ` : '';

        return `
            <section id="heroCarousel"
                     class="news-card news-card--lead hero-carousel bento-span-12"
                     aria-roledescription="carousel"
                     aria-label="重点要闻轮播"
                     onmouseenter="app.pauseHeroCarousel()"
                     onmouseleave="app.resumeHeroCarousel()">
                <div class="hero-carousel-track">
                    ${slidesHtml}
                </div>
                ${dockHtml}
            </section>
        `;
    },

    renderHeroSlideHtml(item, slideIdx, totalHero) {
        const indexNum = String(slideIdx + 1).padStart(2, '0');
        const title = item.translatedTitle || item.title || '无标题';
        const originalTitle = item.translatedTitle && item.translatedTitle !== item.title ? item.title : '';
        const summary = item.summary || item.translatedDescription || item.description || '';
        const sourceName = item.source?.name || 'Global Media';
        const region = item.region || '国际';
        const category = item.category || '国际';
        const timeStr = item.publishedAt ? this.formatRelativeTime(item.publishedAt) : '';
        const rawImageUrl = item.urlToImage || '';
        const imageUrl = this.safeAssetUrl(rawImageUrl, '');

        const relatedSources = Array.isArray(item.relatedSources) ? item.relatedSources : [];
        const hasMultiSources = relatedSources.length > 0;
        const keyPoints = Array.isArray(item.keyPoints) ? item.keyPoints : [];
        const isCompiling = (this.collectionPhase === 'collected' || this.collectionPhase === 'compiling') && !item.aiCompiled;

        const relatedLinksHtml = relatedSources.map(r => {
            const safeRelUrl = this.safeHttpUrl(r.url, '');
            if (safeRelUrl) {
                return `<a href="${this.escapeHtml(safeRelUrl)}" target="_blank" rel="noopener noreferrer" class="hover:underline font-medium" title="${this.escapeHtml(r.title || r.name)}">${this.escapeHtml(r.name)}</a>`;
            }
            return `<span>${this.escapeHtml(r.name)}</span>`;
        }).join('、');

        const metaBadgeText = category && category !== region ? `${region} · ${category}` : region;
        const isRemoteHttp = /^https?:\/\//i.test(imageUrl);
        const displayImgSrc = isRemoteHttp ? `/api/image-proxy?url=${encodeURIComponent(imageUrl)}` : imageUrl;
        const safeItemUrl = this.safeHttpUrl(item.url, '#');
        const active = slideIdx === 0;
        const isUserPaused = Boolean(this.heroCarouselUserPaused);

        return `
            <article class="hero-carousel-slide ${active ? 'is-active' : ''}"
                     data-slide-index="${slideIdx}"
                     aria-hidden="${active ? 'false' : 'true'}">
                <div class="hero-slide-top">
                    <div class="card-meta-header">
                        <div class="card-meta-left">
                            <span class="card-index-num">${indexNum}</span>
                            <span class="card-meta-sep">/</span>
                            <span class="card-source-name" title="${this.escapeHtml(sourceName)}">${this.escapeHtml(sourceName)}</span>
                        </div>
                        <div class="hero-meta-right">
                            <span class="card-taxonomy-pill">${this.escapeHtml(metaBadgeText)}</span>
                            ${totalHero > 1 ? `
                                <div class="hero-step-controls" role="group" aria-label="切换重点要闻">
                                    <button type="button" class="hero-step-btn" onclick="app.prevHeroSlide()" aria-label="上一条要闻" title="上一条要闻">
                                        <i class="fa-solid fa-chevron-left" aria-hidden="true"></i>
                                    </button>
                                    <span class="hero-step-counter tabular-nums">${slideIdx + 1} / ${totalHero}</span>
                                    <button type="button" class="hero-step-btn" onclick="app.nextHeroSlide()" aria-label="下一条要闻" title="下一条要闻">
                                        <i class="fa-solid fa-chevron-right" aria-hidden="true"></i>
                                    </button>
                                    <button type="button" class="hero-step-btn hero-pause-btn" onclick="app.toggleHeroCarouselPause()" aria-pressed="${isUserPaused ? 'true' : 'false'}" aria-label="${isUserPaused ? '继续自动轮播' : '暂停自动轮播'}" title="${isUserPaused ? '继续自动轮播' : '暂停自动轮播'}">
                                        <i class="fa-solid ${isUserPaused ? 'fa-play' : 'fa-pause'}" aria-hidden="true"></i>
                                    </button>
                                </div>
                            ` : ''}
                        </div>
                    </div>

                    <div class="lead-bento-inner has-media card-body-trigger"
                         role="button"
                         tabindex="0"
                         title="点击查看原文全文中文翻译"
                         data-card-url="${this.escapeHtml(item.url || '')}">
                        <div class="card-cover block ${imageUrl ? '' : 'is-fallback'}" data-cat="${this.escapeHtml(category)}">
                            ${imageUrl ? `
                                <img src="${this.escapeHtml(displayImgSrc)}"
                                     data-raw-src="${this.escapeHtml(imageUrl)}"
                                     alt="${this.escapeHtml(title)}"
                                     loading="lazy"
                                     referrerpolicy="no-referrer"
                                     class="card-cover-img"
                                     onerror="if(!this.dataset.retried && this.dataset.rawSrc && this.src !== this.dataset.rawSrc){this.dataset.retried='1';this.src=this.dataset.rawSrc;}else{this.parentElement.classList.add('is-fallback');this.remove();}" />
                            ` : ''}
                            <div class="card-cover-fallback">
                                <div class="fallback-plate-top">
                                    <span>${this.escapeHtml(region)}</span>
                                    <span>${this.escapeHtml(category)}</span>
                                </div>
                                <div class="fallback-plate-watermark">CoreFeed</div>
                                <div class="fallback-plate-bottom">
                                    <span class="fallback-plate-source">${this.escapeHtml(sourceName)}</span>
                                    <span class="fallback-plate-cat">要闻简报</span>
                                </div>
                            </div>
                        </div>

                        <div class="card-body">
                            ${hasMultiSources ? `
                                <div class="kami-callout flex flex-col gap-0.5">
                                    <div class="kami-callout-title">${relatedSources.length + 1} 家权威外媒交叉印证</div>
                                    <div class="truncate text-xs" style="color: var(--text-body);">同题报道：${relatedLinksHtml}</div>
                                </div>
                            ` : ''}

                            ${isCompiling ? `
                                <div>
                                    <span class="kami-tag">后台深度精编中</span>
                                </div>
                            ` : ''}

                            <div>
                                <h3 class="card-title">
                                    <span class="card-title-link">${this.escapeHtml(title)}</span>
                                </h3>
                                ${originalTitle ? `<p class="card-subtitle-en line-clamp-2" title="${this.escapeHtml(originalTitle)}">${this.escapeHtml(originalTitle)}</p>` : ''}
                            </div>

                            <p class="card-summary">${this.escapeHtml(summary)}</p>

                            ${keyPoints.length > 0 ? `
                                <ul class="card-keypoints">
                                    ${keyPoints.map(kp => `<li class="card-keypoint-item">${this.escapeHtml(kp)}</li>`).join('')}
                                </ul>
                            ` : ''}
                        </div>
                    </div>
                </div>

                <div class="card-footer">
                    <div class="card-footer-meta">
                        <span class="card-timestamp">${this.escapeHtml(timeStr)}</span>
                        <span class="card-meta-sep">·</span>
                        <span class="card-translate-hint">点击卡片看全文翻译</span>
                    </div>
                    <a href="${this.escapeHtml(safeItemUrl)}" target="_blank" rel="noopener noreferrer"
                        class="btn-source-link">
                        <span>原文</span>
                        <span aria-hidden="true">↗</span>
                    </a>
                </div>
            </article>
        `;
    }
};
