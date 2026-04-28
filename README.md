# 🎬 AI Teleprompter

A desktop teleprompter that is **invisible to screen capture** (Zoom, Google Meet, Loom, OBS), powered by AI to answer live interview questions, and with **eye gaze correction** so you appear to look directly at your camera while reading.

---

## ✨ Features

| Feature | How it works |
|---|---|
| 🫥 **Screen-capture invisible** | `setContentProtection(true)` — uses OS-level exclusion (macOS `CGWindowSharingReadOnly`, Windows `WDA_EXCLUDEFROMCAPTURE`) |
| 🤖 **AI question answering** | Press `L` → speak the interviewer's question → AI answers instantly via streaming GPT-4o |
| 👁 **Eye gaze correction** | MediaPipe FaceMesh iris tracking + inverse-mapped warp shifts your gaze toward camera |
| 📹 **Virtual camera output** | Corrected video served via MJPEG at `http://localhost:8765` → OBS Virtual Camera |
| 📜 **Teleprompter** | Smooth auto-scroll with speed/font control, fully editable script |

---

## 🚀 Quick Start

### Prerequisites
- **Node.js 18+** — [nodejs.org](https://nodejs.org)
- **OpenAI API key** — [platform.openai.com](https://platform.openai.com)
- **OBS Studio** (optional, for virtual camera) — [obsproject.com](https://obsproject.com)

### Install & Run

```bash
cd teleprompter-ai
chmod +x setup.sh && ./setup.sh

npm start
```

### First-run setup
1. Click ⚙ (or press `Ctrl+,`) → enter your **OpenAI API key** → Save
2. Click ✏️ to edit the teleprompter script
3. Press `Space` to start auto-scrolling

---

## ⌨️ Keyboard Shortcuts

| Key | Action |
|---|---|
| `Space` | Start / pause auto-scroll |
| `↑` / `↓` | Manual scroll |
| `+` / `-` | Increase / decrease scroll speed |
| `[` / `]` | Decrease / increase font size |
| `L` | **Start listening** for interviewer question |
| `Esc` | Stop listening, clear AI answer |
| `Ctrl+G` | Toggle camera / gaze correction panel |
| `Ctrl+,` | Open settings |
| `?` | Show/hide hotkey help |

---

## 👁 Eye Gaze Correction

The gaze correction makes your eyes look **directly at the camera** even while reading text lower on your screen.

### How it works
1. Your webcam feed is processed frame-by-frame with **MediaPipe FaceMesh** (478 landmarks including iris tracking)
2. The iris positions are detected and compared to your eye socket centers
3. A **liquify-style inverse-mapped warp** smoothly shifts the iris pixels upward toward the camera angle
4. The corrected feed is encoded as JPEG and served via **MJPEG stream** at `http://localhost:8765`

### Setting up Virtual Camera (OBS)
1. Install [OBS Studio](https://obsproject.com) with Virtual Camera support
2. In OBS: **Sources → + → Browser Source**
   - URL: `http://localhost:8765`
   - Width: 640, Height: 480
3. In OBS: **Tools → Virtual Camera → Start Virtual Camera**
4. In Zoom/Meet: select **"OBS Virtual Camera"** as your camera

### Adjustment tips
- Open **Settings → Eye Gaze Correction** to tune correction strength
- **Camera Vertical Offset**: Make more negative if camera is far above your screen
- Start with ~50% correction strength and increase gradually

---

## 🤖 AI Question Answering

During an interview when the interviewer asks a question:

1. Press **`L`** (or click 🎤 LISTEN) — status shows **LISTENING**
2. The interviewer's question is transcribed live via Web Speech API
3. After 3 seconds of silence, the transcript is automatically sent to GPT-4o
4. The AI answer **streams live** onto the teleprompter
5. Read the answer naturally — gaze correction handles your eye direction
6. Press **`Esc`** to clear and reset

### Customizing AI behavior
In Settings → System Prompt, customize how the AI responds:
```
You are an expert software engineer answering interview questions.
Keep answers under 90 words. Use concrete examples. First person only.
```

---

## 🏗 Architecture

```
teleprompter-ai/
├── main.js              ← Electron main: window, content-protection, MJPEG server, IPC
├── preload.js           ← Secure IPC bridge
├── renderer/
│   ├── index.html       ← Main UI
│   ├── settings.html    ← Settings panel
│   ├── css/style.css    ← Dark glass UI theme
│   └── js/
│       ├── app.js       ← Coordinator: shortcuts, state, UI events
│       ├── teleprompter.js ← Auto-scroll engine
│       ├── gaze.js      ← MediaPipe + iris warp + MJPEG broadcast
│       ├── speech.js    ← Web Speech API wrapper
│       └── ai.js        ← OpenAI streaming via IPC
└── package.json
```

### Why screen-capture invisible works
- **macOS**: `BrowserWindow.setContentProtection(true)` sets `CGWindowSharingReadOnly` — the window is excluded from `CGWindowListCreateImage`, `AVCaptureScreenInput`, and all screenshot/recording APIs
- **Windows 10 2004+**: Maps to `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` — window appears black/empty in any screen capture
- **Result**: Zoom, Meet, Loom, OBS Window Capture all see a transparent/black region where the window is

---

## 🔧 Build for Distribution

```bash
# macOS
npm run build:mac

# Windows
npm run build:win

# Linux
npm run build:linux
```

Output in `dist/` folder.

---

## 🔐 Privacy & Security

- Your **OpenAI API key** is stored locally in `~/.config/ai-teleprompter/settings.json` (or macOS equivalent)
- API calls go directly from your machine to OpenAI — no proxy
- Camera feed is processed **entirely locally** — never leaves your machine
- The MJPEG server binds to `127.0.0.1` only (localhost, not accessible from network)

---

## 🐛 Troubleshooting

**"The window is visible in my screen recording"**
- Make sure you're running via `npm start` (Electron), not a browser
- Windows: requires Windows 10 version 2004 or later

**"Gaze correction isn't working"**
- The MediaPipe CDN scripts need internet access on first load
- Check the camera panel opened properly (Ctrl+G)
- Make sure "Correct" checkbox is ticked

**"AI isn't answering"**
- Verify your OpenAI API key in Settings (Ctrl+,)
- Check you have API credits at platform.openai.com

**"Speech recognition not starting"**
- Electron uses Chromium's Web Speech API — ensure microphone permissions are granted
- On macOS: System Preferences → Security & Privacy → Microphone → enable for Electron

---

## 📄 License
MIT — use freely for interviews, presentations, and live sessions.
