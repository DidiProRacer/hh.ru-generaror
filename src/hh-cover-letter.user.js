// ==UserScript==
// @name         Covora AI — HH Cover Letter Tool (Tampermonkey)
// @namespace    madtrip.covora.ai
// @version      1.6.7
// @description  Генератор сопроводительных писем прямо на страницах вакансий hh.ru
// @author       Madtrip
// @match        https://hh.ru/*
// @match        https://*.hh.ru/*
// @run-at       document-end
// @grant        none
// @license      MIT
// ==/UserScript==

(function() {
  'use strict';
  if (window.top !== window.self) return;

  /** -------------------------------------------------
   * Helpers
   * -------------------------------------------------*/
  const $ = (sel, root = document) => /** @type {HTMLElement} */ (root.querySelector(sel));
  const storageGet = (key, def) => { try { const v = localStorage.getItem(key); return v ?? def; } catch { return def; } };
  const storageSet = (key, val) => { try { localStorage.setItem(key, String(val)); } catch {} };

  const fetchWithTimeout = async (url, init = {}, timeoutMs = 30000) => {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: abortController.signal });
    } finally {
      clearTimeout(timeout);
    }
  };

  const parseJSON = async (response) => {
    try {
      return await response.json();
    } catch {
      return {};
    }
  };

  const fetchStream = async (url, init = {}, onChunk = () => {}, onDone = () => {}, onError = () => {}) => {
    try {
      const response = await fetchWithTimeout(url, { ...init, headers: { ...(init.headers || {}), 'Accept': 'text/event-stream' } });
      if (!response.ok || !response.body) {
        onError(new Error(`HTTP ${response.status}`));
        return;
      }
      const decoder = new TextDecoder('utf-8');
      const reader = response.body.getReader();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || '';
        for (const part of parts) {
          const lines = part.split("\n").filter(Boolean);
          let payload = '';
          for (const line of lines) {
            if (line.startsWith('data:')) payload += line.slice(5).trim();
          }
          if (!payload) continue;
          if (payload === '[DONE]') {
            onDone();
            return;
          }
          try {
            const data = JSON.parse(payload);
            const delta = data?.choices?.[0]?.delta?.content ?? data?.choices?.[0]?.message?.content ?? '';
            if (delta) onChunk(delta);
          } catch {
            /* ignore parse issues */
          }
        }
      }
      onDone();
    } catch (e) {
      onError(e);
    }
  };

  /** -------------------------------------------------
   * Constants & Configuration
   * -------------------------------------------------*/
  const CONFIG = {
    IO_BASE: 'https://api.intelligence.io.solutions/api/v1',
    RECOMMENDED_MODELS: [
      'Qwen/Qwen3-Next-80B-A3B-Instruct',
      'meta-llama/Llama-3.3-70B-Instruct',
      'mistralai/Mistral-Large-Instruct-2411',
      'Qwen/Qwen3-235B-A22B-Thinking-2507',
      'deepseek-ai/DeepSeek-R1-0528'
    ],
    CACHE_TTL: 86_400_000, // 24h
    MORPH_OPEN_DURATION: 460,
    MORPH_CLOSE_DURATION: 120,
    BASE_FRAME_WIDTH: 420,
    BASE_FRAME_HEIGHT: 600
  };

  const DEFAULTS = {
    MODEL: CONFIG.RECOMMENDED_MODELS[1],
    IO_API_KEY: '',
    TONE: 0.35,
    MAXTOK: 650,
    LIQUID: false,
    BASE: `Здравствуйте!

Меня заинтересовала ваша вакансия. Меня зовут Дмитрий. У меня есть опыт работы более полутора лет, в течение которых я занимался проведением проектов (ивенты), управлением коллективом (4–8 человек), руководил разработкой и продвижением образовательного проекта (сайт, дизайн продукта, маркетинг), координировал дизайн и разработку (мерч, визуал, сайт, баннеры, материалы). Владею Jira и Bitrix24, отлично знаю MS Office и документооборот (включая ЭДО).

Высшее экономическое образование (финансы и управление бизнесом).

Ожидаемый уровень — 90–130 тыс. руб. (в зависимости от обязанностей).

Буду рад обсудить детали и ответить на вопросы.`
  };

  const settings = {
    init() {
        this.MODEL = storageGet('MODEL', DEFAULTS.MODEL);
        this.IO_API_KEY = storageGet('IO_API_KEY', DEFAULTS.IO_API_KEY);
        this.TONE = Number(storageGet('TONE', DEFAULTS.TONE));
        this.MAXTOK = Number(storageGet('MAXTOK', DEFAULTS.MAXTOK));
        this.LIQUID = storageGet('LIQUID', String(DEFAULTS.LIQUID)) === 'true';
        this.BASE = storageGet('BASE', DEFAULTS.BASE);
    },
    set(key, value) {
      this[key] = value;
      storageSet(key, String(value));
    }
  };

  settings.init();

  const SYSTEM_PROMPT = `Ты карьерный консультант и рекрутер для рынка СНГ.
Твоя цель — подготовить сопроводительное письмо к вакансии hh.ru строго по описанию.
Базовое письмо кандидата используй только как источник фактов.
Если в описании есть явные просьбы/вопросы — ответь на них в начале.
После приветствия всегда фраза: «Меня заинтересовала ваша вакансия».
Финал: «Буду рад возможности обсудить детали и ответить на ваши вопросы. Жду вашей обратной связи!».
Структура 120–180 слов.`;

  let modelsCache = { ts: 0, list: [] };

  /** -------------------------------------------------
   * UI & State Management
   * -------------------------------------------------*/
  const uiState = {
    isFrameOpen: false,
    isAnimating: false,
    toastTimer: null,
    starEmitterTimer: null,
    isEmitterActive: false,
  };

  const getElement = id => document.getElementById(id);

  function showToast(message) {
    const el = getElement('hhq-toast');
    if (!el) return;
    el.textContent = String(message || '');
    el.classList.add('show');
    clearTimeout(uiState.toastTimer);
    uiState.toastTimer = setTimeout(() => el.classList.remove('show'), 2000);
  }

  function adjustFrameHeight() {
    const frame = getElement('hhq-frame');
    const activePage = $('.hhq-page.active');
    if (!frame || !activePage) return;

    let contentHeight = activePage.scrollHeight;

    // For the main and settings pages, also consider padding and margins
    if (activePage.id === 'hhq-main' || activePage.id === 'hhq-settings') {
      const pagePadding = 16 * 2; // top + bottom padding
      const topbarHeight = getElement('hhq-topbar').offsetHeight;
      contentHeight = activePage.scrollHeight + topbarHeight + pagePadding;
    }

    const minHeight = CONFIG.BASE_FRAME_HEIGHT;
    const newHeight = Math.max(minHeight, Math.min(contentHeight + 24, window.innerHeight - 48)); // +24 to add a little margin
    frame.style.height = `${newHeight}px`;
  }

  function shrinkFrame() {
    const frame = getElement('hhq-frame');
    if (frame) {
      frame.style.height = `${CONFIG.BASE_FRAME_HEIGHT}px`;
    }
  }

  function togglePage(page) {
    const frame = getElement('hhq-frame');
    const heroPage = getElement('hhq-hero-container');
    const mainPage = getElement('hhq-main');
    const settingsPage = getElement('hhq-settings');
    const gearBtn = getElement('hhq-gear');
    const backBtn = getElement('hhq-back');
    const title = getElement('hhq-topbar-title');

    if (!frame || !heroPage || !mainPage || !gearBtn || !backBtn || !title) return;

    // Check if we are coming from settings to hero and apply shrink animation
    if (settingsPage && settingsPage.classList.contains('active') && page === 'hero') {
      shrinkFrame();
      // Hide settings UI immediately
      backBtn.classList.remove('shown');
      title.classList.remove('shown');
      // Wait for the shrink animation to finish, then show hero UI
      setTimeout(() => {
        heroPage.classList.remove('slide-left');
        mainPage.classList.remove('slide-left');
        settingsPage.classList.remove('active');
        heroPage.classList.add('active');
        gearBtn.classList.add('shown'); // Show the gear button back
        startStarEmitter();
      }, 300); // Duration matches CSS transition
    } else {
      heroPage.classList.remove('active', 'slide-left');
      mainPage.classList.remove('active', 'slide-left');
      if (settingsPage) settingsPage.classList.remove('active');

      if (page === 'settings') {
        if (!settingsPage) return;
        heroPage.classList.add('slide-left');
        mainPage.classList.add('slide-left');
        settingsPage.classList.add('active');
        backBtn.classList.add('shown');
        gearBtn.classList.remove('shown');
        title.classList.add('shown');
        stopStarEmitter();
      } else {
        heroPage.classList.remove('slide-left');
        mainPage.classList.remove('slide-left');
        backBtn.classList.remove('shown');
        gearBtn.classList.add('shown');
        title.classList.remove('shown');
        if (page === 'hero') {
          heroPage.classList.add('active');
          startStarEmitter();
        } else if (page === 'main') {
          mainPage.classList.add('active');
          stopStarEmitter();
        }
      }
      setTimeout(adjustFrameHeight, 300); // Give time for transition
    }
  }

  function openModal() {
    const overlay = getElement('hhq-overlay');
    const modal = getElement('hhq-modal');
    if (overlay && modal) {
      overlay.classList.add('shown');
      modal.classList.add('shown');
    }
  }

  function closeModal() {
    const overlay = getElement('hhq-overlay');
    const modal = getElement('hhq-modal');
    if (overlay && modal) {
      overlay.classList.remove('shown');
      modal.classList.remove('shown');
    }
  }

  /** -------------------------------------------------
   * UI Animations
   * -------------------------------------------------*/
  function openFrame() {
    if (uiState.isFrameOpen || uiState.isAnimating) return;
    uiState.isAnimating = true;
    uiState.isFrameOpen = true;

    const launcher = getElement('hhq-launcher');
    const frame = getElement('hhq-frame');
    if (!launcher || !frame) return;

    const targetWidth = CONFIG.BASE_FRAME_WIDTH;
    const targetHeight = CONFIG.BASE_FRAME_HEIGHT;
    const targetLeft = Math.max(0, window.innerWidth - 24 - targetWidth);
    const targetTop = 24;
    const launcherRect = launcher.getBoundingClientRect();

    launcher.style.opacity = '0';
    launcher.style.pointerEvents = 'none';

    const morph = document.createElement('div');
    morph.id = 'hhq-morph';
    Object.assign(morph.style, {
      left: `${launcherRect.left}px`,
      top: `${launcherRect.top}px`,
      width: `${launcherRect.width}px`,
      height: `${launcherRect.height}px`,
      borderRadius: '9999px',
    });
    document.body.appendChild(morph);

    if (morph.animate) {
      const morphDuration = CONFIG.MORPH_OPEN_DURATION;
      const easing = 'cubic-bezier(.4, 0, .2, 1)';
      const animation = morph.animate([
        { left: `${launcherRect.left}px`, top: `${launcherRect.top}px`, width: `${launcherRect.width}px`, height: `${launcherRect.height}px`, borderRadius: '9999px', background: 'linear-gradient(135deg,#3A8DFF 0%,#80C8FF 100%)' },
        { left: `${targetLeft}px`, top: `${targetTop}px`, width: `${targetWidth}px`, height: `${targetHeight}px`, borderRadius: '22px', background: '#ffffff' }
      ], { duration: morphDuration + 100, easing: easing, fill: 'forwards' });

      animation.onfinish = () => {
        frame.classList.add('shown');
        morph.remove();
        if (!settings.IO_API_KEY.trim()) {
          openModal();
        } else {
          togglePage('hero');
        }
        uiState.isAnimating = false;
      };
    } else {
      frame.classList.add('shown');
      morph.remove();
      if (!settings.IO_API_KEY.trim()) {
        openModal();
      } else {
        togglePage('hero');
      }
      uiState.isAnimating = false;
    }
  }

  function closeFrame() {
    if (!uiState.isFrameOpen || uiState.isAnimating) return;
    uiState.isAnimating = true;
    uiState.isFrameOpen = false;

    const launcher = getElement('hhq-launcher');
    const frame = getElement('hhq-frame');
    if (!launcher || !frame) return;

    const launcherRect = launcher.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();

    stopStarEmitter();
    frame.classList.remove('shown', 'wide');

    const morph = document.createElement('div');
    morph.id = 'hhq-morph';
    Object.assign(morph.style, {
      left: `${frameRect.left}px`,
      top: `${frameRect.top}px`,
      width: `${frameRect.width}px`,
      height: `${frameRect.height}px`,
      borderRadius: '22px'
    });
    document.body.appendChild(morph);

    if (morph.animate) {
      const morphDuration = CONFIG.MORPH_CLOSE_DURATION;
      const easing = 'cubic-bezier(.4, 0, .2, 1)';
      const animation = morph.animate([
        { left: `${frameRect.left}px`, top: `${frameRect.top}px`, width: `${frameRect.width}px`, height: `${frameRect.height}px`, borderRadius: '22px', background: '#ffffff' },
        { left: `${launcherRect.left}px`, top: `${launcherRect.top}px`, width: `${launcherRect.width}px`, height: `${launcherRect.height}px`, borderRadius: '9999px', background: 'linear-gradient(135deg,#3A8DFF 0%,#80C8FF 100%)' }
      ], { duration: morphDuration + 50, easing: easing, fill: 'forwards' });

      animation.onfinish = () => {
        launcher.style.opacity = '1';
        launcher.style.pointerEvents = 'auto';
        morph.remove();
        uiState.isAnimating = false;
      };
    } else {
      launcher.style.opacity = '1';
      launcher.style.pointerEvents = 'auto';
      morph.remove();
      uiState.isAnimating = false;
    }
  }

  function createParticles(container, count = 20) {
    const genBtn = getElement('hhq-hero-gen');
    if (!genBtn) return;
    const btnRect = genBtn.getBoundingClientRect();
    const originX = btnRect.left + btnRect.width / 2;
    const originY = btnRect.top + btnRect.height / 2;

    for (let i = 0; i < count; i++) {
      const particle = document.createElement('div');
      particle.className = 'particle';
      container.appendChild(particle);

      const size = Math.random() * 6 + 2;
      const angle = Math.random() * Math.PI * 2;
      const distance = Math.random() * 50 + 20;
      const translateX = Math.cos(angle) * distance;
      const translateY = Math.sin(angle) * distance;
      const duration = Math.random() * 600 + 800;
      const hue = Math.floor(Math.random() * 30 + 200);

      Object.assign(particle.style, {
        width: `${size}px`,
        height: `${size}px`,
        left: `${originX}px`,
        top: `${originY}px`,
        background: `hsl(${hue}, 100%, 98%)`,
        boxShadow: `0 0 16px hsla(${hue}, 100%, 98%, .5)`,
        opacity: '0',
        transform: 'scale(0)'
      });

      setTimeout(() => {
        Object.assign(particle.style, {
          opacity: '.5',
          transform: `scale(1) translate(${translateX}px, ${translateY}px)`,
          transition: `opacity ${duration / 2}ms, transform ${duration}ms cubic-bezier(.17,.67,.83,.67)`
        });
        setTimeout(() => particle.remove(), duration + 20);
      }, 5);
    }
  }

  function startStarEmitter() {
    const container = getElement('hhq-particle-host');
    if (!container || uiState.isEmitterActive) return;
    uiState.isEmitterActive = true;

    const spawnParticleRecursive = () => {
      if (!uiState.isEmitterActive) return;
      createParticles(container, Math.floor(Math.random() * 2) + 1);
      const delay = Math.random() * 40 + 10;
      uiState.starEmitterTimer = setTimeout(spawnParticleRecursive, delay);
    };

    uiState.starEmitterTimer = setTimeout(spawnParticleRecursive, 10);
  }

  function stopStarEmitter() {
    uiState.isEmitterActive = false;
    if (uiState.starEmitterTimer) {
      clearTimeout(uiState.starEmitterTimer);
      uiState.starEmitterTimer = null;
    }
  }

  /** -------------------------------------------------
   * Business Logic
   * -------------------------------------------------*/
  function extractHints(rawDescription) {
    const desc = (rawDescription || '').toLowerCase();
    const asks = [];
    const askKeywords = ['указать', 'напишите', 'сообщить', 'ответить', 'опишите'];
    const introIndex = desc.indexOf('сопроводитель');
    if (introIndex !== -1) {
      const tail = desc.slice(introIndex, introIndex + 300).split('\n')[0];
      for (const keyword of askKeywords) {
        if (tail.includes(keyword)) {
          asks.push(tail.slice(0, 240));
          break;
        }
      }
    }
    const skillsDict = ['стрессоустойчив', 'обучаем', 'инициатив', 'ответствен', 'внимательн', 'коммуникаб', 'клиентоориент', 'самоорганиз', 'исполнительн', 'аналитич', 'проактив', 'командн'];
    const skills = skillsDict.filter(keyword => desc.includes(keyword));
    return { asks, skills };
  }

  function buildUserPrompt(base, job, variantNo) {
    const hints = extractHints(job.description);
    const hintsText = [
      hints.asks.length ? (`ЯВНЫЕ ВОПРОСЫ/ПРОСЬБЫ:\n- ${hints.asks.slice(0, 3).join('\n- ')}`) : '',
      hints.skills.length ? (`ЗАПРОШЕННЫЕ КАЧЕСТВА: ${hints.skills.join(', ')}`) : ''
    ].filter(Boolean).join('\n\n');
    return `БАЗОВОЕ ПИСЬМО (только факты):
${base}

ВАКАНСИЯ: ${job.title}
URL: ${job.url}

Описание:
${String(job.description || '').slice(0, 9000)}

${hintsText}

ЗАДАЧА: 120–180 слов. Ответь на явные вопросы в начале. Вариант №${variantNo}.`;
  }

  function extractJobInfo() {
    const titleEl = $('h1[data-qa="vacancy-title"]');
    const descEl = $('div[data-qa="vacancy-description"]');
    if (!titleEl || !descEl) return null;
    return {
      title: titleEl.textContent?.trim() || 'Без названия',
      url: window.location.href,
      description: descEl.textContent?.trim() || ''
    };
  }

  async function fetchIOModels(apiKey) {
    if (modelsCache.list.length && Date.now() - modelsCache.ts < CONFIG.CACHE_TTL) {
      return modelsCache.list;
    }
    const headers = apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {};
    const response = await fetchWithTimeout(`${CONFIG.IO_BASE}/models`, { method: 'GET', headers }, 20000);
    if (!response.ok) {
      return CONFIG.RECOMMENDED_MODELS.map(id => ({ id, name: id }));
    }
    const data = await parseJSON(response);
    const list = Array.isArray(data.data) ? data.data : (Array.isArray(data.models) ? data.models : []);
    const models = list.map(m => ({ id: m.id || m.name || m.model, name: m.id || m.name || m.model }))
                   .filter(x => x.id)
                   .slice(0, 60);
    modelsCache = { ts: Date.now(), list: models };
    return models;
  }

  async function generateCoverLetter() {
    const jobInfo = extractJobInfo();
    if (!jobInfo) {
      showToast('Не могу найти описание вакансии.');
      togglePage('settings');
      return;
    }
    const apiKey = (settings.IO_API_KEY || '').trim();
    if (!apiKey) {
      showToast('Введите API Key в настройках!');
      togglePage('settings');
      return;
    }

    const mainSection = getElement('hhq-main');
    const loading = getElement('hhq-loading');
    const bar = getElement('hhq-bar');
    const out = getElement('hhq-out');

    // Switch to main view
    togglePage('main');

    mainSection?.classList.add('is-loading');
    loading.style.display = 'flex';
    bar.style.display = 'none';
    out.textContent = '';
    out.classList.remove('success');
    out.contentEditable = 'false';
    adjustFrameHeight(); // initial adjustment

    const payload = {
      model: settings.MODEL,
      temperature: settings.TONE,
      max_tokens: settings.MAXTOK,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(settings.BASE, jobInfo, Math.floor(Math.random() * 99999)) }
      ]
    };

    const generatedText = [];

    const finalizeUI = () => {
      mainSection?.classList.remove('is-loading');
      loading.style.display = 'none';
      bar.style.display = 'grid';
      out.contentEditable = 'true';
      adjustFrameHeight();
    };

    await fetchStream(
      `${CONFIG.IO_BASE}/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ ...payload, stream: true })
      },
      (chunk) => { // onChunk
        generatedText.push(chunk);
        out.textContent += chunk;
        adjustFrameHeight();
      },
      () => { // onDone
        const finalContent = generatedText.join('');
        if (finalContent) {
          out.textContent = finalContent;
          out.classList.add('success');
          showToast('Готово!');
        } else {
          showToast('Пустой ответ от модели.');
        }
        finalizeUI();
      },
      (err) => { // onError
        showToast(`Ошибка: ${err.message}`);
        console.error('Stream error:', err);
        finalizeUI();
      }
    );
  }

  /** -------------------------------------------------
   * Event Bindings & Initialization
   * -------------------------------------------------*/
  function bindSettingsActions() {
    const maxtok = getElement('hhq-maxtok');
    const liquid = getElement('hhq-liquid-toggle');
    const base = getElement('hhq-base');
    const key = getElement('hhq-key');
    const tone = getElement('hhq-tone');
    const modelSel = getElement('hhq-model');
    if (!maxtok || !liquid || !base || !key || !tone || !modelSel) return;

    maxtok.value = String(settings.MAXTOK);
    base.value = settings.BASE;
    key.value = settings.IO_API_KEY;
    liquid.checked = settings.LIQUID;

    if (settings.LIQUID) {
      getElement('hhq-frame')?.classList.add('glass');
      document.documentElement.style.setProperty('--out-bg', 'transparent');
    }

    const tempToSlider = (t) => Math.round(((Math.max(0.2, Math.min(0.5, +t || 0.35)) - 0.2) / 0.3) * 100);
    const sliderToTemp = (pct) => 0.2 + ((+pct || 0) / 100) * 0.3;
    const setThumbColor = (pct) => {
      const t = pct / 100;
      const r = Math.round(255 + (150 - 255) * t);
      const g = Math.round(150 + (150 - 150) * t);
      const b = Math.round(150 + (255 - 150) * t);
      document.documentElement.style.setProperty('--tone-thumb', `rgb(${r},${g},${b})`);
    };

    tone.value = String(tempToSlider(settings.TONE));
    setThumbColor(+tone.value);

    key.addEventListener('input', () => { settings.set('IO_API_KEY', key.value); refreshModels(); });
    modelSel.addEventListener('change', () => settings.set('MODEL', modelSel.value));
    tone.addEventListener('input', () => { const temp = sliderToTemp(+tone.value); settings.set('TONE', temp); setThumbColor(+tone.value); });
    maxtok.addEventListener('input', () => settings.set('MAXTOK', +maxtok.value));
    liquid.addEventListener('change', () => {
      settings.set('LIQUID', liquid.checked);
      const frame = getElement('hhq-frame');
      if (frame) {
        frame.classList.toggle('glass', liquid.checked);
      }
      document.documentElement.style.setProperty('--out-bg', liquid.checked ? 'transparent' : '#fff');
    });
    base.addEventListener('input', () => {
      settings.set('BASE', base.value);
      adjustFrameHeight();
    });
  }

  async function refreshModels() {
    const modelSel = /** @type {HTMLSelectElement} */ (getElement('hhq-model'));
    if (!modelSel) return;
    try {
      const list = await fetchIOModels((settings.IO_API_KEY || '').trim());
      modelSel.innerHTML = '';
      const seen = new Set();
      const addModelOption = (id) => {
        const value = String(id || '').trim();
        if (!value || seen.has(value)) return;
        seen.add(value);
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        modelSel.appendChild(option);
      };
      CONFIG.RECOMMENDED_MODELS.forEach(addModelOption);
      (list || []).forEach(m => addModelOption(m.id || m.name));
      modelSel.value = settings.MODEL || modelSel.options[0]?.value || '';
      if (modelSel.value) settings.set('MODEL', modelSel.value);
    } catch (e) {
      console.error('Failed to refresh models:', e);
    }
  }

  function createSettingsPage() {
    let settingsPage = getElement('hhq-settings');
    if (settingsPage) return; // Already exists

    const pagesContainer = getElement('hhq-pages');
    if (!pagesContainer) return;

    settingsPage = document.createElement('section');
    settingsPage.id = 'hhq-settings';
    settingsPage.classList.add('hhq-page');
    settingsPage.innerHTML = `
      <div class="card">
        <h4>Конфигурация API</h4>
        <label class="l" for="hhq-key">API Key</label>
        <input id="hhq-key" class="c" type="password" placeholder="io-v2-..." autocomplete="off">
        <label class="l" for="hhq-model" style="margin-top:10px;">Модель</label>
        <select id="hhq-model" class="c"></select>
        <div class="form-row">
          <div>
            <label class="l" for="hhq-tone" style="margin-top:0;">Тон общения</label>
            <input id="hhq-tone" type="range" min="0" max="100">
          </div>
          <div>
            <label class="l" for="hhq-maxtok">max_tokens</label>
            <input id="hhq-maxtok" class="c" type="number" min="100" max="4000">
          </div>
        </div>
      </div>
      <div class="card">
        <h4>Интерфейс</h4>
        <label class="l" for="hhq-liquid-toggle" style="display:flex;align-items:center;gap:10px;">
          <input id="hhq-liquid-toggle" type="checkbox"> Включить фон «Liquid Glass»
        </label>
      </div>
      <div class="card expand">
        <h4>Твой опыт и скиллы (будут адаптированы):</h4>
        <textarea id="hhq-base" class="c" rows="5"></textarea>
      </div>
    `;
    pagesContainer.appendChild(settingsPage);
    bindSettingsActions(); // Bind events to the newly created elements
  }

  function bindActions() {
    const openBtn = getElement('hhq-launcher');
    const closeBtn = getElement('hhq-close');
    const gearBtn = getElement('hhq-gear');
    const backBtn = getElement('hhq-back');
    const genBtn = getElement('hhq-hero-gen');
    const regenBtn = getElement('hhq-regen');
    const copyBtn = getElement('hhq-copy');
    const out = getElement('hhq-out');
    const modalKey = getElement('hhq-modal-key');
    const modalBase = getElement('hhq-modal-base');
    const modalSave = getElement('hhq-modal-save');
    const particleContainer = getElement('hhq-particle-host');

    if (!openBtn || !closeBtn || !gearBtn || !backBtn || !genBtn || !regenBtn || !copyBtn || !out || !modalKey || !modalBase || !modalSave || !particleContainer) return;

    const updateModalSaveState = () => {
      const keyFilled = modalKey.value.trim().length > 0;
      const baseFilled = modalBase.value.trim().length > 0;
      if (keyFilled && baseFilled) {
        modalSave.disabled = false;
        modalSave.classList.remove('disabled');
      } else {
        modalSave.disabled = true;
        modalSave.classList.add('disabled');
      }
    };

    openBtn.addEventListener('click', openFrame);
    closeBtn.addEventListener('click', closeFrame);
    gearBtn.addEventListener('click', () => {
      createSettingsPage();
      togglePage('settings');
      refreshModels(); // Refresh models list when opening settings
    });
    backBtn.addEventListener('click', () => {
      togglePage('hero');
    });

    modalKey.addEventListener('input', updateModalSaveState);
    modalBase.addEventListener('input', updateModalSaveState);
    modalSave.addEventListener('click', () => {
      const key = modalKey.value.trim();
      const base = modalBase.value.trim();
      if (!key) {
        showToast('API-ключ обязателен!');
        return;
      }
      settings.set('IO_API_KEY', key);
      settings.set('BASE', base);
      closeModal();
      createSettingsPage(); // Ensure settings page is available after modal close
      togglePage('hero');
    });

    genBtn.addEventListener('click', () => {
      createParticles(particleContainer, 24);
      generateCoverLetter();
    });
    regenBtn.addEventListener('click', generateCoverLetter);

    copyBtn.addEventListener('click', async () => {
      try {
        if (out.textContent) {
          await navigator.clipboard.writeText(out.textContent);
          showToast('Скопировано');
        }
      } catch {
        showToast('Ошибка при копировании');
      }
    });
  }

  /** -------------------------------------------------
   * Bootstrap
   * -------------------------------------------------*/
  function main() {
    injectStyles();
    injectDOM();
    bindActions();
    if (!settings.IO_API_KEY.trim()) {
      openModal();
    }
  }

  function injectStyles() {
    const css = `@import url('https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;700;800&display=swap');
:root{--hhq-blue:#0A84FF;--hhq-blue2:#54AEFF;--ink:#0b1220;--muted:#6b7280;--g50:#F9FAFB;--g100:#F3F4F6;--g200:#E5E7EB;--g300:#D1D5DB;--ease:cubic-bezier(.4,0,.2,1);--ease-s:cubic-bezier(.8,0,.2,1);--tone-thumb:#ff0000;--out-bg:#fff;--morph-open:.46s;--morph-close:.12s;--morph-ease:cubic-bezier(.42, 0, .58, 1)}
#hhq-container, #hhq-container * { font-family:'Inter Tight',Arial,sans-serif; box-sizing:border-box; }
#hhq-launcher { position:fixed; top:24px; right:24px; z-index:2147483646; display:flex; align-items:center; justify-content:center; padding:12px 18px; min-width:260px; height:50px; border-radius:9999px; background:linear-gradient(135deg,#3A8DFF 0%,#80C8FF 100%); color:#fff; font-size:14px; cursor:pointer; user-select:none; box-shadow:0 16px 36px rgba(0,0,0,.25); opacity:1; transform:translateY(0); transition:opacity .3s var(--ease),transform .3s var(--ease); overflow:hidden; isolation:isolate; }
#hhq-launcher::before { content:""; position:absolute; inset:-30%; border-radius:inherit; z-index:0; background:conic-gradient(from 0deg,#3A8DFF,#6D5AEF,#FF6FB0,#33D4FF,#80C8FF,#3A8DFF); filter:blur(12px) saturate(115%) brightness(.98); opacity:.45; animation:hhq-spin 12s linear infinite; }
#hhq-cap-text { font-weight:800; color:#fff; }
#hhq-frame { position:fixed; top:24px; right:24px; width:420px; max-width:420px; height:600px; min-height:600px; max-height:calc(100vh - 48px); background:#fff; border-radius:22px; box-shadow:0 24px 56px rgba(0,0,0,.18); z-index:2147483647; overflow:hidden; display:none; opacity:0; transform:translateY(-8px) scale(.99); visibility:hidden; transition:opacity .22s var(--ease-s),transform .22s var(--ease-s),height .3s var(--ease); }
#hhq-frame.shown { display:block; opacity:1!important; transform:translateY(0) scale(1)!important; visibility:visible!important; }
#hhq-frame.glass { background:rgba(255,255,255,.55); backdrop-filter:blur(12px) saturate(140%) brightness(1.04) contrast(1.02); -webkit-backdrop-filter:blur(12px) saturate(140%) brightness(1.04) contrast(1.02); }
#hhq-morph { position:fixed; z-index:2147483648; border-radius:9999px; box-shadow:0 16px 36px rgba(0,0,0,.25); pointer-events:none; transition:left var(--morph-open) var(--morph-ease),top var(--morph-open) var(--morph-ease),width var(--morph-open) var(--morph-ease),height var(--morph-open) var(--morph-ease),border-radius var(--morph-open) var(--morph-ease),background-color var(--morph-open) var(--morph-ease),opacity .24s var(--morph-ease); }
#hhq-morph.closing { transition:left var(--morph-close) var(--morph-ease),top var(--morph-close) var(--morph-ease),width var(--morph-close) var(--morph-ease),height var(--morph-close) var(--morph-ease),border-radius var(--morph-close) var(--morph-ease),background-color var(--morph-close) var(--morph-ease),opacity .12s var(--morph-ease); }
#hhq-topbar { display:flex; align-items:center; justify-content:space-between; padding:12px; position:relative; }
#hhq-topbar-title { font-size:16px; font-weight:700; opacity:0; transform:translateX(10px); transition:opacity .2s ease,transform .2s ease; }
#hhq-topbar-title.shown { opacity:1; transform:translateX(0); }
#hhq-right { display:flex; align-items:center; gap:8px; }
#hhq-back { display:flex; align-items:center; justify-content:center; gap:4px; padding:0 12px; height:32px; border:1px solid var(--g200); background:#fff; border-radius:9999px; font-weight:400; cursor:pointer; font-size:13px; opacity:0; transform:translateX(-16px); transition:opacity .2s ease,transform .2s ease; }
#hhq-back.shown { opacity:1; transform:translateX(0); }
.circle-btn { width:32px; height:32px; border-radius:9999px; border:1px solid var(--g200); background:#fff; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; transition:transform .2s ease; }
#hhq-gear.shown { transform:translateY(0); opacity:1; }
#hhq-gear.hidden-up { transform:translateY(-100%); opacity:0; }
#hhq-pages { position:relative; width:100%; height:100%; overflow-x:hidden; }
.hhq-page { position:absolute; top:0; left:0; width:100%; height:100%; padding:16px 16px 24px; overflow-y:auto; transition:transform .3s var(--ease-s),opacity .3s var(--ease-s); }
#hhq-hero-container { display:flex; flex-direction:column; align-items:center; text-align:center; gap:48px; transform:translateX(0); opacity:1; z-index:2; }
#hhq-main { flex-direction:column; gap:12px; transform:translateX(0); opacity:0; display:none; z-index:2; }
#hhq-settings { display:flex; flex-direction:column; transform:translateX(100%); opacity:0; z-index:3; }
#hhq-hero-container.active { display:flex; }
#hhq-main.active { display:flex; opacity:1; }
#hhq-settings.active { transform:translateX(0); opacity:1; }
#hhq-hero-container.slide-left, #hhq-main.slide-left { transform:translateX(-100%); }
#hhq-settings { -ms-overflow-style:none; scrollbar-width:none; gap:16px; }
#hhq-settings::-webkit-scrollbar { display:none; }
#hhq-hero-title { font-size:32px; font-weight:800; margin-bottom:24px; background:linear-gradient(135deg,#3A8DFF 0%,#80C8FF 100%); -webkit-background-clip:text; -webkit-text-fill-color:transparent; color:transparent; }
#hhq-hero-gen { width:180px; height:180px; border-radius:9999px; border:0; color:#fff; font-weight:800; cursor:pointer; position:relative; overflow:hidden; isolation:isolate; background:linear-gradient(135deg,#3A8DFF 0%,#80C8FF 100%); display:flex; flex-direction:column; gap:12px; align-items:center; justify-content:center; box-shadow:0 14px 28px rgba(10,132,255,.20); transition:transform .18s var(--ease-s),box-shadow .18s var(--ease-s); }
#hhq-hero-gen::before { content:""; position:absolute; inset:-25%; border-radius:inherit; z-index:0; background:conic-gradient(from 0deg,#3A8DFF,#6D5AEF,#FF6FB0,#33D4FF,#80C8FF,#3A8DFF); filter:blur(14px) saturate(115%) brightness(.98); opacity:.7; border-radius:50%; z-index:0; animation:hhq-spin 9s cubic-bezier(.65,.05,.36,1) infinite; }
#hhq-hero-gen > * { position:relative; z-index:1; }
#hhq-hero-gen:hover { transform:translateY(-1px); box-shadow:0 18px 34px rgba(10,132,255,.3); }
#hhq-hero-gen:active { transform:translateY(0); box-shadow:0 10px 20px rgba(10,132,255,.22); }
.particle-host { position:absolute; width:180px; height:180px; z-index:4; pointer-events:none; overflow:visible; }
.particle { position:absolute; border-radius:50%; pointer-events:none; opacity:0; transform:scale(0) translate(0); transition:opacity .5s,transform .5s cubic-bezier(.17,.67,.83,.67); }
#hhq-hero-hint { color:var(--muted); font-size:13px; margin:0; max-width:360px; line-height:1.45; }
#hhq-out { white-space:pre-wrap; border:1px solid var(--g200); border-radius:14px; padding:14px; min-height:120px; background:var(--out-bg); color:var(--ink); outline:none; user-select:text; cursor:text; width:100%; max-width:100%; transition:height .3s var(--ease); }
#hhq-out.success { border-color:#bbf7d0; }
#hhq-bar { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:24px; width:100%; align-items:stretch; }
.hhq-btn { width:100%; padding:12px 14px; border-radius:12px; border:1px solid var(--g200); background:#fff; cursor:pointer; font-weight:700; }
#hhq-copy.hhq-btn { color:#fff!important; background:linear-gradient(135deg,#3A8DFF 0%,#80C8FF 100%); border:none; }
#hhq-loading { display:none; flex-direction:column; align-items:center; justify-content:center; gap:18px; color:var(--muted); font-size:13px; min-height:120px; }
.hhq-dots { display:inline-flex; gap:6px; }
.hhq-dot { width:8px; height:8px; background:#0A84FF; border-radius:50%; animation:hhq-bounce .9s ease-in-out infinite; }
.hhq-dot:nth-child(2) { animation-delay:.15s; }.hhq-dot:nth-child(3) { animation-delay:.3s; }
.card { border:1px solid var(--g200); border-radius:14px; padding:12px; background:#fff; }
.card h4 { margin:4px 0 10px; font-size:14px; }
.l { font-size:12px; color:var(--muted); margin:6px 0; display:block; }
.c { width:100%; padding:10px 12px; border-radius:10px; border:1px solid var(--g200); background:#fff; font-size:14px; max-width:100%; }
.form-row { display:grid; grid-template-columns:1fr 1fr; gap:12px; align-items:center; }
input[type=range] { -webkit-appearance:none; appearance:none; width:100%; height:4px; background:var(--g200); border-radius:9999px; outline:none; }
input[type=range]::-webkit-slider-thumb { -webkit-appearance:none; appearance:none; width:18px; height:18px; border-radius:50%; background:var(--tone-thumb); border:2px solid #fff; box-shadow:0 1px 2px rgba(0,0,0,.15); cursor:pointer; }
input[type=range]::-moz-range-track { height:4px; background:var(--g200); border:none; border-radius:9999px; }
input[type=range]::-moz-range-thumb { width:18px; height:18px; border-radius:50%; background:var(--tone-thumb); border:2px solid #fff; box-shadow:0 1px 2px (0,0,0,.15); cursor:pointer; }
#hhq-toast { position:absolute; right:12px; top:56px; z-index:9; max-width:260px; padding:8px 10px; border-radius:10px; background:#0b1220; color:#fff; font-size:13px; opacity:0; transform:translateY(0) scale(.92); transition:opacity .24s var(--ease-s),transform .24s var(--ease-s); pointer-events:none; }
#hhq-toast.show { opacity:1; transform:translateY(-8px) scale(1); }
@keyframes hhq-bounce { 0%,100% { transform:translateY(0); } 50% { transform:translateY(-8px); } }
@keyframes hhq-spin { 0% { transform:rotate(0) scale(1.04); } 50% { transform:rotate(180deg) scale(1.08); } 100% { transform:rotate(360deg) scale(1.04); } }
#hhq-overlay { position:fixed; inset:0; background:rgba(0,0,0,.5); z-index:2147483646; display:none; opacity:0; transition:opacity .2s ease; pointer-events:auto; }
#hhq-modal { position:fixed; top:24px; right:24px; width:420px; height:600px; max-height:calc(100vh - 48px); z-index:2147483647; opacity:0; transition:opacity .2s ease; visibility:hidden; }
#hhq-modal.shown { opacity:1; visibility:visible; }
#hhq-modal-content { width:100%; height:100%; background:#fff; padding:24px; border-radius:16px; box-shadow:0 12px 24px rgba(0,0,0,.12); overflow-y:auto; display:flex; flex-direction:column; gap:16px; }
#hhq-modal-content h3 { font-size:24px; margin:0; font-weight:800; background:linear-gradient(135deg,#3A8DFF 0%,#80C8FF 100%); -webkit-background-clip:text; -webkit-text-fill-color:transparent; }
#hhq-modal-content p { margin:0; color:var(--muted); font-size:14px; line-height:1.45; }
#hhq-modal-content a { color:var(--hhq-blue); font-weight:700; }
.form-group { display:flex; flex-direction:column; gap:8px; }
.form-group input, .form-group textarea { border:1px solid var(--g200); border-radius:8px; padding:10px; font-size:14px; width:100%; max-width:100%; }
.form-group textarea { resize:vertical; min-height:120px; }
#hhq-modal-save { padding:12px; border:none; border-radius:10px; background:linear-gradient(135deg,#3A8DFF 0%,#80C8FF 100%); color:#fff; font-weight:700; cursor:pointer; margin-top:16px; }
#hhq-modal-save:hover:not(.disabled) { opacity:0.9; }
#hhq-modal-save.disabled { background-color:var(--g300); background:var(--g300); cursor:not-allowed; }
.card.expand { flex-grow:1; display:flex; flex-direction:column; }
#hhq-settings { display:flex; flex-direction:column; height:100%; }
#hhq-base { flex-grow:1; height:auto; resize:vertical; max-width:100%; }
`;
    const st = document.createElement('style');
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }

  function injectDOM() {
    const root = document.createElement('div');
    root.id = 'hhq-container';
    root.setAttribute('aria-live', 'polite');
    root.innerHTML = `
      <button id="hhq-launcher" type="button" aria-haspopup="dialog" aria-controls="hhq-frame"><span id="hhq-cap-text">Сгенерировать сопроводительное</span></button>
      <section id="hhq-frame" role="dialog" aria-modal="true" aria-labelledby="hhq-topbar-title">
        <div id="hhq-topbar">
          <button id="hhq-back" type="button" title="Назад" aria-label="Назад">
            <svg viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
            Назад
          </button>
          <div id="hhq-topbar-title">Настройки</div>
          <div id="hhq-right">
            <button id="hhq-gear" class="circle-btn" type="button" title="Настройки" aria-label="Настройки">⚙</button>
            <button id="hhq-close" class="circle-btn" type="button" title="Закрыть" aria-label="Закрыть">✕</button>
          </div>
        </div>
        <div id="hhq-toast" role="status"></div>
        <div id="hhq-pages">
          <section id="hhq-hero-container" class="hhq-page">
            <h3 id="hhq-hero-title">Covora AI</h3>
            <button id="hhq-hero-gen" type="button" aria-label="Сгенерировать">
              <svg viewBox="0 0 64 64" width="51" height="51" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <line x1="12" y1="52" x2="36" y2="28" stroke="currentColor"/>
                <g transform="translate(-16,-13)">
                  <path d="M42 18 L45 23 L51 24 L46 28 L47 34 L42 31 L37 34 L38 28 L33 24 L39 23 Z" fill="white" stroke="currentColor" transform="translate(9,8) scale(1.12) rotate(-25 42 28)"/>
                </g>
              </svg>
              <div>Сгенерировать</div>
            </button>
            <div id="hhq-particle-host" class="particle-host"></div>
            <p id="hhq-hero-hint">Нажмите кнопку, чтобы создать персональное сопроводительное письмо для текущей вакансии</p>
          </section>
          <section id="hhq-main" class="hhq-page">
            <div id="hhq-out" contenteditable="true" spellcheck="false" tabindex="0" aria-label="Результат"></div>
            <div id="hhq-bar">
              <button id="hhq-copy" class="hhq-btn" type="button">Скопировать</button>
              <button id="hhq-regen" class="hhq-btn" type="button">Перегенерировать</button>
            </div>
            <div id="hhq-loading" aria-hidden="true">
              <span class="hhq-dots"><span class="hhq-dot"></span><span class="hhq-dot"></span><span class="hhq-dot"></span></span>
              <span>Генерирую письмо…</span>
            </div>
          </section>
        </div>
      </section>
      <div id="hhq-overlay"></div>
      <div id="hhq-modal" role="dialog" aria-modal="true" aria-labelledby="hhq-modal-title">
        <div id="hhq-modal-content">
          <div style="font-size: 22px; font-weight: 800; text-align: center; line-height: 1.25; background: linear-gradient(135deg,#3A8DFF 0%,#80C8FF 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;">Добро пожаловать в Covora AI!</div>
          <p style="text-align:center; font-size:14px; margin-top:-8px; margin-bottom:16px;">Осталась пара шагов до первого письма</p>
          <h4><b>1. Получите API-ключ</b></h4>
          <p>Создайте свой API-ключ на этом сайте.<a href="https://intelligence.io.solutions/auth/api-tokens" target="_blank" style="margin-left: 4px;">Получить ключ</a></p>
          <div class="form-group">
            <input type="text" id="hhq-modal-key" placeholder="io-v2-..." class="c" autocomplete="off">
          </div>
          <h4><b>2. Расскажите о ваших навыках и опыте</b></h4>
          <p>Опишите детально свой опыт и навыки — это поможет ИИ адаптировать письма под вас.</p>
          <div class="form-group">
            <textarea id="hhq-modal-base" class="c" rows="5"></textarea>
          </div>
          <p style="font-size:12px; color:var(--muted); margin-top: -8px;">*Вы в любой момент сможете поменять эту информацию в настройках</p>
          <button id="hhq-modal-save" class="disabled" disabled>Сохранить</button>
        </div>
      </div>
    `;
    (document.body || document.documentElement).appendChild(root);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();