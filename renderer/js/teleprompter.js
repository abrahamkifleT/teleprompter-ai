// ─── teleprompter.js ──────────────────────────────────────────────────────
export class Teleprompter {
  constructor(container, textEl) {
    this.container   = container;
    this.textEl      = textEl;
    this.isScrolling = false;
    this.speed       = 1.0;
    this.fontSize    = 28;
    this.pixelsPerSec = 40;
    this._rafId      = null;
    this._lastTime   = null;
    this._accumulator = 0;
    this._answerCount = 0;
  }

  startScroll() {
    if (this.isScrolling) return;
    this.isScrolling = true;
    this._lastTime = performance.now();
    this._tick();
  }

  stopScroll() {
    this.isScrolling = false;
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
  }

  toggleScroll() {
    if (this.isScrolling) this.stopScroll(); else this.startScroll();
  }

  _tick() {
    if (!this.isScrolling) return;
    this._rafId = requestAnimationFrame((now) => {
      const dt = (now - this._lastTime) / 1000;
      this._lastTime = now;
      this._accumulator += this.pixelsPerSec * this.speed * dt;
      const px = Math.floor(this._accumulator);
      if (px >= 1) {
        this._accumulator -= px;
        this.container.scrollTop += px;
        const { scrollTop, scrollHeight, clientHeight } = this.container;
        if (scrollTop + clientHeight >= scrollHeight - 2) { this.stopScroll(); return; }
      }
      this._tick();
    });
  }

  scrollBy(px) { this.container.scrollTop += px; }

  resetScroll() {
    this.stopScroll();
    this.container.scrollTo({ top: 0, behavior: 'smooth' });
  }

  setSpeed(val) { this.speed = Math.min(5.0, Math.max(0.1, parseFloat(val))); }
  changeSpeed(delta) { this.setSpeed(this.speed + delta); }

  setFontSize(size) {
    this.fontSize = Math.min(72, Math.max(14, parseInt(size)));
    this.textEl.style.fontSize = this.fontSize + 'px';
  }
  changeFontSize(delta) { this.setFontSize(this.fontSize + delta); }

  // AI Answer injection into teleprompter for natural reading
  startStreamingAnswer(question) {
    this._answerCount++;
    const block = document.createElement('div');
    block.className = 'ai-injected-block';
    block.id = `ai-answer-${this._answerCount}`;

    const sep = document.createElement('div');
    sep.className = 'ai-injected-separator';
    sep.innerHTML = `<span class="ai-sep-icon">🤖</span><span class="ai-sep-label">AI Answer #${this._answerCount}</span><span class="ai-sep-line"></span>`;

    const qEl = document.createElement('div');
    qEl.className = 'ai-injected-question';
    qEl.textContent = `"${question}"`;

    const aEl = document.createElement('div');
    aEl.className = 'ai-injected-answer typing-cursor';
    aEl.textContent = '';

    block.appendChild(sep);
    block.appendChild(qEl);
    block.appendChild(aEl);
    this.textEl.appendChild(block);
    return aEl;
  }

  clearAIAnswers() {
    this.textEl.querySelectorAll('.ai-injected-block').forEach(b => b.remove());
    this._answerCount = 0;
  }

  updateLiveQuestion(text) {
    if (!this._liveQuestionBlock) {
      this._liveQuestionBlock = document.createElement('div');
      this._liveQuestionBlock.className = 'ai-injected-block live-question-block';
      this._liveQuestionBlock.innerHTML = `
        <div class="ai-injected-separator">
          <span class="ai-sep-icon">🎤</span><span class="ai-sep-label">You</span><span class="ai-sep-line"></span>
        </div>
        <div class="ai-injected-question" style="color: var(--accent-bright); font-style: normal; font-size: 1.1em;"></div>
      `;
      this.textEl.appendChild(this._liveQuestionBlock);
    }
    const qEl = this._liveQuestionBlock.querySelector('.ai-injected-question');
    qEl.textContent = text;
  }

  clearLiveQuestion() {
    if (this._liveQuestionBlock) {
      this._liveQuestionBlock.remove();
      this._liveQuestionBlock = null;
    }
  }
}
