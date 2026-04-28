// ─── ai.js — AI service wrapper with conversation history ────────────────
export class AIService {
  constructor() {
    this.conversationHistory = [];
    this.maxHistory = 10;
  }

  addToHistory(question, answer) {
    this.conversationHistory.push(
      { role: 'user', content: question },
      { role: 'assistant', content: answer }
    );
    while (this.conversationHistory.length > this.maxHistory * 2) {
      this.conversationHistory.shift();
      this.conversationHistory.shift();
    }
  }

  buildMessages(question, systemPrompt) {
    return [
      { role: 'system', content: systemPrompt },
      ...this.conversationHistory,
      { role: 'user', content: question },
    ];
  }

  clearHistory() {
    this.conversationHistory = [];
  }

  async ask(question, systemPrompt, apiKey, model = 'gpt-4o') {
    const messages = this.buildMessages(question, systemPrompt);
    return window.electronAPI.aiComplete({ messages, apiKey, model });
  }

  stream(question, systemPrompt, apiKey, model = 'gpt-4o') {
    const messages = this.buildMessages(question, systemPrompt);
    return window.electronAPI.aiStream({ messages, apiKey, model });
  }
}
