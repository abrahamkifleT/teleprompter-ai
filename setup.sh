#!/bin/bash
# ─── AI Teleprompter — Setup Script ──────────────────────────────────────────
set -e

echo ""
echo "🎬 AI Teleprompter — Setup"
echo "─────────────────────────────"

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "❌ Node.js is required. Install from https://nodejs.org (v18+)"
  exit 1
fi

NODE_VER=$(node -v | cut -c2- | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  echo "❌ Node.js v18+ required (you have $(node -v))"
  exit 1
fi

echo "✅ Node.js $(node -v) found"

# Install dependencies
echo ""
echo "📦 Installing dependencies..."
npm install

echo ""
echo "✅ Setup complete!"
echo ""
echo "▶  Start the app:"
echo "   npm start"
echo ""
echo "📋 First run checklist:"
echo "   1. Open Settings (⚙ button or Ctrl+,)"
echo "   2. Enter your OpenAI API key"
echo "   3. Paste your interview script into the teleprompter"
echo "   4. For gaze correction: install OBS Studio → start Virtual Camera"
echo "      then add Browser Source: http://localhost:8765"
echo ""
