/**
 * CoreFeed v3.0 — 双主播语音播报播放器控制模块 (public/js/modules/audio_player.js)
 */

export const audioPlayerMethods = {
    formatAudioClock(secInput) {
        const total = Math.max(0, Math.round(Number(secInput) || 0));
        const mins = Math.floor(total / 60);
        const secs = total % 60;
        return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    },

    formatAudioAriaTime(curSec, durSec) {
        const c = Math.max(0, Math.round(Number(curSec) || 0));
        const d = Math.max(0, Math.round(Number(durSec) || 0));
        const cm = Math.floor(c / 60);
        const cs = c % 60;
        const dm = Math.floor(d / 60);
        const ds = d % 60;
        return d > 0
            ? `已播放 ${cm} 分 ${cs} 秒，共 ${dm} 分 ${ds} 秒`
            : `已播放 ${cm} 分 ${cs} 秒`;
    },

    syncBroadcastSliderVars() {
        const slider = document.getElementById('broadcastSeekSlider');
        if (!slider) return;
        const minVal = parseFloat(slider.min || '0') || 0;
        const maxVal = Math.max(0.1, parseFloat(slider.max || '100') || 100);
        const curVal = Math.min(maxVal, Math.max(minVal, parseFloat(slider.value || '0') || 0));
        slider.style.setProperty('--attr-min', String(minVal));
        slider.style.setProperty('--attr-max', String(maxVal));
        slider.style.setProperty('--control-value', String(curVal));
        slider.setAttribute('aria-valuetext', this.formatAudioAriaTime(curVal, maxVal));
    },

    initBroadcastPlayer() {
        const audio = document.getElementById('broadcastAudioEl');
        const slider = document.getElementById('broadcastSeekSlider');
        const toolbar = document.getElementById('broadcastAuxToolbar');

        // Roving-tabindex fallback for role="toolbar" only when native focusgroup is unsupported
        if (toolbar && typeof HTMLElement !== 'undefined' && !('focusGroup' in HTMLElement.prototype)) {
            const getItems = () => Array.from(toolbar.querySelectorAll('button, a[href]'));
            const initItems = getItems();
            initItems.forEach((el, i) => {
                el.tabIndex = i === 0 ? 0 : -1;
            });
            toolbar.addEventListener('focusin', ({ target }) => {
                const items = getItems();
                if (items.includes(target)) {
                    items.forEach((el) => {
                        el.tabIndex = el === target ? 0 : -1;
                    });
                }
            });
            toolbar.addEventListener('keydown', (e) => {
                const rtl = getComputedStyle(toolbar).direction === 'rtl';
                const steps = {
                    ArrowRight: rtl ? -1 : 1,
                    ArrowLeft: rtl ? 1 : -1
                };
                const items = getItems();
                if (items.length === 0) return;
                const curIdx = Math.max(0, items.indexOf(document.activeElement));
                let nextIdx = -1;
                if (e.key in steps) {
                    nextIdx = (curIdx + steps[e.key] + items.length) % items.length;
                } else if (e.key === 'Home') {
                    nextIdx = 0;
                } else if (e.key === 'End') {
                    nextIdx = items.length - 1;
                }
                if (nextIdx >= 0) {
                    e.preventDefault();
                    items[nextIdx].focus();
                }
            });
        }

        if (slider) {
            this.syncBroadcastSliderVars();
            slider.addEventListener('input', () => {
                this.isScrubbingAudio = true;
                const curEl = document.getElementById('broadcastCurrentTime');
                if (curEl) curEl.textContent = this.formatAudioClock(slider.value);
                this.syncBroadcastSliderVars();
            });
            slider.addEventListener('change', () => {
                if (audio) {
                    const targetTime = parseFloat(slider.value || '0') || 0;
                    if (audio.readyState >= 1) {
                        audio.currentTime = targetTime;
                    } else {
                        this.pendingChapterStartSec = targetTime;
                    }
                }
                this.isScrubbingAudio = false;
                this.syncBroadcastSliderVars();
            });
        }

        if (!audio) return;
        audio.playbackRate = this.playbackSpeed;
        this.updateBroadcastSpeedUi();

        audio.addEventListener('loadedmetadata', () => {
            const dur = Number.isFinite(audio.duration) && audio.duration > 0
                ? audio.duration
                : (this.getActiveAudioTrackMeta()?.durationSec || 0);
            if (slider && dur > 0) {
                slider.max = String(dur);
            }
            const totEl = document.getElementById('broadcastTotalTime');
            if (totEl && dur > 0) {
                totEl.textContent = this.formatAudioClock(dur);
            }
            audio.playbackRate = this.playbackSpeed;
            if (this.pendingChapterStartSec !== null) {
                const jumpTo = this.pendingChapterStartSec;
                this.pendingChapterStartSec = null;
                audio.currentTime = Math.max(0, Math.min(dur || jumpTo, jumpTo));
            }
            this.syncBroadcastSliderVars();
        });

        audio.addEventListener('timeupdate', () => {
            if (this.isScrubbingAudio) return;
            const cur = audio.currentTime || 0;
            const dur = (Number.isFinite(audio.duration) && audio.duration > 0)
                ? audio.duration
                : (this.getActiveAudioTrackMeta()?.durationSec || 100);
            if (slider) {
                slider.max = String(dur);
                slider.value = String(cur);
                this.syncBroadcastSliderVars();
            }
            const curEl = document.getElementById('broadcastCurrentTime');
            if (curEl) curEl.textContent = this.formatAudioClock(cur);
            this.syncActiveChapterUi(cur);
        });

        audio.addEventListener('play', () => {
            this.syncPlayStateUi(true);
            this.updateMediaSessionMetadata();
        });

        audio.addEventListener('pause', () => {
            this.syncPlayStateUi(false);
        });

        audio.addEventListener('ended', () => {
            this.syncPlayStateUi(false);
            const curEl = document.getElementById('broadcastCurrentTime');
            if (curEl) curEl.textContent = '00:00';
            if (slider) {
                slider.value = '0';
                this.syncBroadcastSliderVars();
            }
            this.syncActiveChapterUi(0);
        });

        audio.addEventListener('volumechange', () => {
            const muteBtn = document.getElementById('btnBroadcastMute');
            const muteIcon = document.getElementById('iconBroadcastMute');
            const isMuted = Boolean(audio.muted || audio.volume === 0);
            if (muteBtn) muteBtn.setAttribute('aria-pressed', isMuted ? 'true' : 'false');
            if (muteIcon) muteIcon.className = isMuted ? 'fa-solid fa-volume-xmark' : 'fa-solid fa-volume-high';
        });

        if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
            try {
                navigator.mediaSession.setActionHandler('play', () => this.toggleBroadcastPlay(true));
                navigator.mediaSession.setActionHandler('pause', () => this.toggleBroadcastPlay(false));
                navigator.mediaSession.setActionHandler('seekbackward', (d) => this.seekBroadcastRelative(-(d?.seekOffset || 15)));
                navigator.mediaSession.setActionHandler('seekforward', (d) => this.seekBroadcastRelative(d?.seekOffset || 15));
                navigator.mediaSession.setActionHandler('seekto', (d) => {
                    if (typeof d?.seekTime === 'number' && audio) {
                        audio.currentTime = Math.max(0, d.seekTime);
                    }
                });
            } catch (_) {}
        }
    },

    getActiveAudioTrackMeta() {
        const tracks = this.audioBroadcast?.tracks || {};
        if (tracks[this.activeAudioTrack]) return tracks[this.activeAudioTrack];
        if (tracks.news) {
            this.activeAudioTrack = 'news';
            return tracks.news;
        }
        if (tracks.pulse) {
            this.activeAudioTrack = 'pulse';
            return tracks.pulse;
        }
        return null;
    },

    async fetchLatestAudio() {
        try {
            const res = await fetch('/api/audio');
            const data = await res.json();
            if (data && data.success && data.audioBroadcast) {
                this.audioBroadcast = data.audioBroadcast;
                this.renderBroadcastPlayer({ preservePlayback: true });
                this.renderSocialPulse();
            }
        } catch (_) {}
    },

    syncPlayStateUi(isPlaying) {
        const deck = document.getElementById('broadcastPlayerDeck');
        const btn = document.getElementById('btnBroadcastPlay');
        const icon = document.getElementById('iconBroadcastPlay');
        if (deck) deck.classList.toggle('is-playing', Boolean(isPlaying));
        if (btn) btn.setAttribute('aria-label', isPlaying ? '暂停语音播报' : '播放本期语音播报');
        if (icon) icon.className = isPlaying ? 'fa-solid fa-pause' : 'fa-solid fa-play';
        if (!isPlaying) {
            const speakerEl = document.getElementById('broadcastActiveSpeaker');
            if (speakerEl) speakerEl.textContent = '林远 & Serena · 双主播交替播报';
        }
    },

    syncActiveChapterUi(currentSec) {
        const track = this.getActiveAudioTrackMeta();
        const chapters = Array.isArray(track?.chapters) ? track.chapters : [];
        if (chapters.length === 0) return;

        let activeIdx = 0;
        for (let i = 0; i < chapters.length; i++) {
            if (currentSec + 0.15 >= (Number(chapters[i].startSec) || 0)) {
                activeIdx = i;
            }
        }

        const chips = document.querySelectorAll('#broadcastChaptersBar .broadcast-chapter-chip');
        chips.forEach((chip, idx) => {
            if (idx === activeIdx) {
                chip.setAttribute('aria-current', 'step');
            } else {
                chip.removeAttribute('aria-current');
            }
        });

        const audio = document.getElementById('broadcastAudioEl');
        const speakerEl = document.getElementById('broadcastActiveSpeaker');
        const activeCh = chapters[activeIdx];
        if (speakerEl && activeCh && audio && !audio.paused) {
            speakerEl.textContent = `正在播报 · ${activeCh.speakerLabel || activeCh.speaker} · ${activeCh.title}`;
        }
    },

    renderBroadcastPlayer(opts = {}) {
        const deck = document.getElementById('broadcastPlayerDeck');
        const summaryQuickBtn = document.getElementById('btnSummaryListenQuick');
        const tracks = this.audioBroadcast?.tracks || {};
        const trackMeta = this.getActiveAudioTrackMeta();

        if (summaryQuickBtn) {
            summaryQuickBtn.classList.toggle('hidden', !tracks.news);
        }

        if (!deck) return;
        if (!trackMeta) {
            deck.classList.add('hidden');
            return;
        }
        deck.classList.remove('hidden');

        ['news', 'pulse'].forEach((tk) => {
            const pill = document.getElementById(`btnTrack-${tk}`);
            const durSpan = document.getElementById(`trackDur-${tk}`);
            const meta = tracks[tk] || null;
            if (!pill) return;
            pill.classList.toggle('hidden', !meta);
            if (meta) {
                pill.removeAttribute('aria-disabled');
                pill.setAttribute('aria-pressed', this.activeAudioTrack === tk ? 'true' : 'false');
                if (durSpan) durSpan.textContent = this.formatAudioClock(meta.durationSec);
            } else {
                pill.setAttribute('aria-disabled', 'true');
                pill.setAttribute('aria-pressed', 'false');
            }
        });

        const titleEl = document.getElementById('broadcastTitle');
        const subEl = document.getElementById('broadcastSubtitle');
        const totEl = document.getElementById('broadcastTotalTime');
        const dlLink = document.getElementById('linkBroadcastDownload');
        const audio = document.getElementById('broadcastAudioEl');
        const slider = document.getElementById('broadcastSeekSlider');

        if (titleEl) titleEl.textContent = trackMeta.title || '聚核双主播语音播报';
        if (subEl) subEl.textContent = trackMeta.subtitle || '';
        if (totEl) totEl.textContent = this.formatAudioClock(trackMeta.durationSec);
        if (dlLink) {
            dlLink.href = this.safeAssetUrl(trackMeta.audioUrl, '#');
            dlLink.setAttribute('download', trackMeta.fileName || `briefing-${trackMeta.track}.mp3`);
        }

        if (audio) {
            const currentAttrSrc = audio.getAttribute('src') || '';
            const nextSrc = trackMeta.audioUrl || '';
            const isSameSrc = currentAttrSrc === nextSrc;
            if (!isSameSrc && (!opts.preservePlayback || audio.paused)) {
                audio.setAttribute('src', nextSrc);
                audio.load();
                const curEl = document.getElementById('broadcastCurrentTime');
                if (curEl) curEl.textContent = '00:00';
                if (slider) {
                    slider.max = String(trackMeta.durationSec || 100);
                    slider.value = '0';
                    this.syncBroadcastSliderVars();
                }
                this.syncPlayStateUi(false);
            } else if (slider && audio.paused && !isSameSrc) {
                slider.max = String(trackMeta.durationSec || 100);
                this.syncBroadcastSliderVars();
            } else if (slider && (!audio.duration || isNaN(audio.duration))) {
                slider.max = String(trackMeta.durationSec || 100);
                this.syncBroadcastSliderVars();
            }
        }

        const chapters = Array.isArray(trackMeta.chapters) ? trackMeta.chapters : [];
        const chaptersBar = document.getElementById('broadcastChaptersBar');
        if (chaptersBar) {
            if (chapters.length === 0) {
                chaptersBar.classList.add('hidden');
                chaptersBar.innerHTML = '';
            } else {
                chaptersBar.classList.remove('hidden');
                chaptersBar.innerHTML = chapters.map((ch, idx) => {
                    const num = String(ch.index || (idx + 1)).padStart(2, '0');
                    const hostShort = ch.speaker === 'Lin_Yuan' ? '林远' : (ch.speaker === 'Uncle_Fu' ? '傅老师' : 'Serena');
                    return `
                        <button type="button"
                                data-chapter-idx="${idx}"
                                onclick="app.seekBroadcastToChapter(${idx})"
                                class="broadcast-chapter-chip"
                                ${idx === 0 ? 'aria-current="step"' : ''}>
                            <span class="broadcast-chapter-num tabular-nums">${this.escapeHtml(num)}</span>
                            <span>${this.escapeHtml(ch.title || '')}</span>
                            <span class="broadcast-chapter-host">${this.escapeHtml(hostShort)}</span>
                            <span class="broadcast-chapter-time tabular-nums">${this.formatAudioClock(ch.startSec)}</span>
                        </button>
                    `;
                }).join('');
            }
        }

        const transcriptBody = document.getElementById('broadcastTranscriptBody');
        if (transcriptBody) {
            transcriptBody.innerHTML = chapters.map((ch, idx) => `
                <div class="broadcast-script-turn">
                    <div class="broadcast-script-head">
                        <button type="button" onclick="app.seekBroadcastToChapter(${idx})" class="broadcast-script-seek tabular-nums">
                            ${this.formatAudioClock(ch.startSec)}
                        </button>
                        <strong class="broadcast-script-speaker">${this.escapeHtml(ch.speakerLabel || ch.speaker || '')}</strong>
                        <span class="broadcast-script-ch-title">${this.escapeHtml(ch.title || '')}</span>
                    </div>
                    <p class="broadcast-script-text">${this.escapeHtml(ch.text || '')}</p>
                </div>
            `).join('');
        }
    },

    selectBroadcastTrack(trackKey, autoPlay = false) {
        const pill = document.getElementById(`btnTrack-${trackKey}`);
        if (pill && pill.getAttribute('aria-disabled') === 'true') {
            return;
        }
        const tracks = this.audioBroadcast?.tracks || {};
        if (!tracks[trackKey]) return;

        const audio = document.getElementById('broadcastAudioEl');
        const wasPlaying = Boolean(audio && !audio.paused);
        if (this.activeAudioTrack !== trackKey) {
            if (audio) audio.pause();
            this.activeAudioTrack = trackKey;
            this.renderBroadcastPlayer({ preservePlayback: false });
        }
        if (autoPlay || wasPlaying) {
            this.toggleBroadcastPlay(true);
        }
    },

    playBroadcastTrack(trackKey, chapterIndex = 0) {
        const tracks = this.audioBroadcast?.tracks || {};
        if (!tracks[trackKey]) {
            this.toast('当前频道播音尚未同步', 'warning');
            return;
        }
        if (this.activeAudioTrack !== trackKey) {
            const audio = document.getElementById('broadcastAudioEl');
            if (audio) audio.pause();
            this.activeAudioTrack = trackKey;
            this.renderBroadcastPlayer({ preservePlayback: false });
        }
        const deck = document.getElementById('broadcastPlayerDeck');
        if (deck && typeof deck.scrollIntoView === 'function') {
            deck.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        this.seekBroadcastToChapter(chapterIndex, true);
    },

    async toggleBroadcastPlay(forceState = null) {
        const audio = document.getElementById('broadcastAudioEl');
        const trackMeta = this.getActiveAudioTrackMeta();
        if (!audio || !trackMeta) return;

        const shouldPlay = forceState !== null ? Boolean(forceState) : audio.paused;
        if (!shouldPlay) {
            audio.pause();
            return;
        }

        if (!audio.getAttribute('src') && trackMeta.audioUrl) {
            audio.setAttribute('src', trackMeta.audioUrl);
            audio.load();
        }
        audio.playbackRate = this.playbackSpeed;
        try {
            await audio.play();
        } catch (err) {
            this.toast(`音频播放未能启动: ${err.message || '请检查网络连接'}`, 'error');
        }
    },

    seekBroadcastRelative(deltaSec) {
        const audio = document.getElementById('broadcastAudioEl');
        const trackMeta = this.getActiveAudioTrackMeta();
        if (!audio || !trackMeta) return;
        const maxDur = (Number.isFinite(audio.duration) && audio.duration > 0)
            ? audio.duration
            : (trackMeta.durationSec || 0);
        const nextTime = Math.max(0, Math.min(maxDur || Infinity, (audio.currentTime || 0) + Number(deltaSec || 0)));
        if (audio.readyState >= 1) {
            audio.currentTime = nextTime;
        } else {
            this.pendingChapterStartSec = nextTime;
        }
        const slider = document.getElementById('broadcastSeekSlider');
        if (slider) {
            slider.value = String(nextTime);
            this.syncBroadcastSliderVars();
        }
        const curEl = document.getElementById('broadcastCurrentTime');
        if (curEl) curEl.textContent = this.formatAudioClock(nextTime);
    },

    seekBroadcastToChapter(chapterIdx, autoPlay = true) {
        const trackMeta = this.getActiveAudioTrackMeta();
        const audio = document.getElementById('broadcastAudioEl');
        const chapters = Array.isArray(trackMeta?.chapters) ? trackMeta.chapters : [];
        const ch = chapters[chapterIdx];
        if (!audio || !trackMeta) return;

        const targetSec = ch ? Math.max(0, Number(ch.startSec) || 0) : 0;
        if (audio.readyState >= 1) {
            audio.currentTime = targetSec;
        } else {
            this.pendingChapterStartSec = targetSec;
        }
        const slider = document.getElementById('broadcastSeekSlider');
        if (slider) {
            slider.value = String(targetSec);
            this.syncBroadcastSliderVars();
        }
        const curEl = document.getElementById('broadcastCurrentTime');
        if (curEl) curEl.textContent = this.formatAudioClock(targetSec);
        this.syncActiveChapterUi(targetSec);

        if (autoPlay) {
            this.toggleBroadcastPlay(true);
        }
    },

    updateBroadcastSpeedUi() {
        const btn = document.getElementById('btnBroadcastSpeed');
        if (!btn) return;
        const label = Number.isInteger(this.playbackSpeed) ? `${this.playbackSpeed.toFixed(1)}×` : `${this.playbackSpeed}×`;
        btn.textContent = label;
        btn.setAttribute('aria-label', `切换播放倍速，当前 ${this.playbackSpeed} 倍速`);
    },

    cycleBroadcastSpeed() {
        const idx = this.playbackSpeeds.indexOf(this.playbackSpeed);
        const nextSpeed = this.playbackSpeeds[(idx + 1) % this.playbackSpeeds.length];
        this.playbackSpeed = nextSpeed;
        try {
            localStorage.setItem('corefeed_audio_speed', String(nextSpeed));
        } catch (_) {}

        const audio = document.getElementById('broadcastAudioEl');
        if (audio) {
            audio.playbackRate = nextSpeed;
        }
        this.updateBroadcastSpeedUi();
        const live = document.getElementById('broadcastLiveStatus');
        if (live) {
            live.textContent = `播放倍速已切换为 ${nextSpeed} 倍速`;
        }
    },

    toggleBroadcastMute() {
        const audio = document.getElementById('broadcastAudioEl');
        if (!audio) return;
        audio.muted = !audio.muted;
    },

    updateMediaSessionMetadata() {
        if (typeof navigator === 'undefined' || !('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') {
            return;
        }
        const trackMeta = this.getActiveAudioTrackMeta();
        if (!trackMeta) return;
        try {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: trackMeta.title || '聚核双主播播报',
                artist: '林远 & Serena · CoreFeed 聚核电台',
                album: trackMeta.label || 'CoreFeed 全球要闻深度聚合',
                artwork: [
                    { src: '/images/logo.png', sizes: '192x192', type: 'image/png' }
                ]
            });
        } catch (_) {}
    }
};
