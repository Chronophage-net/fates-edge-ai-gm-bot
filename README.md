    # 🤖 Fate's Edge AI Game Master Bot

    An extensible, pluggable AI bot that connects to the Fate's Edge WebSocket server and acts as a fully automated Game Master. It drives the narrative, interprets player actions, rolls dice, manages the Deck of Consequences, and handles timers – all through a simple terminal or headless operation.

    ---

    ## ✨ Features

    - **Pluggable AI backends** – use OpenAI, Ollama, DeepSeek, or any custom LLM.
    - **Automatic GM takeover** – joins the room, requests the Game Master role, and manages GM approvals.
    - **Narrative generation** – interprets player chat and creates immersive, descriptive responses.
    - **Dice rolling** – uses Fate's Edge dice mechanics (d10 pool, successes, story beats).
    - **Deck of Consequences** – draws cards, performs Crown Spreads, and tracks deck state.
    - **Timer management** – creates and ticks scene timers on demand.
    - **Player management** – kick, ban, and unban players directly from the bot's terminal.
    - **Conversation memory** – maintains a sliding window of recent messages for coherent stories.
    - **MUD‑style terminal** – all events are logged in color, and you can manually override the AI by typing messages.
    - **One‑click setup wizard** – a configuration script (`configure-bot.js`) that scans available drivers, prompts for API keys, and writes a `.env` file.

    ---

    ## 🧱 Architecture

    ```
    players in VTT / terminal
            │
            ▼
    ┌─────────────────────────────┐
    │  Fate's Edge Socket Server  │
    │   (WebSocket + REST)        │
    └─────────────────────────────┘
            │
            ▼
    ┌─────────────────────────────┐
    │     AI GM Bot               │
    │  - ai-gm-bot.js (core)      │
    │  - drivers/                 │
    │    ├── ai-driver.js         │  ← abstract driver interface
    │    ├── openai-driver.js     │
    │    ├── ollama-driver.js     │
    │    └── deepseek-driver.js   │
    └─────────────────────────────┘
            │
            ▼
    ┌─────────────────────────────┐
    │   AI Backend (OpenAI, etc.) │
    └─────────────────────────────┘
    ```

    The core bot is completely decoupled from the AI backend. It communicates with the server via WebSocket and delegates all narrative generation to a **driver**. Drivers implement a simple interface and can be swapped in seconds.

    ---

    ## 📦 Prerequisites

    - **Node.js** ≥ 18 (includes built‑in `fetch`; no extra dependencies needed for most drivers)
    - **A Fate's Edge WebSocket server** (the modular socket server from this repo)
    - **An API key for your chosen AI service** (or a local LLM running via Ollama)

    ---

    ## 🚀 Installation

    ```bash
    git clone <your-repo-url>
    cd ai-gm-bot
    npm install
    ```

    The only required dependency is `ws` (WebSocket).  
    If you use the OpenAI driver, the `openai` package will be installed automatically.

    ---

    ## ⚙️ Configuration – The Easy Way

    Run the built‑in configuration wizard:

    ```bash
    node configure-bot.js
    ```

    It will:

    1. Scan the `/drivers` folder and display all available backends.
    2. Let you pick a driver.
    3. Ask for any required API keys (or a file path containing the key).
    4. Generate a `.env` file with all necessary settings.

    After the wizard finishes, you can start the bot immediately.

    ### Manual Configuration (optional)

    Create a `.env` file in the bot's root directory. Example for OpenAI:

    ```
    AI_DRIVER=./drivers/openai-driver
    OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx
    AI_MODEL=gpt-4o-mini
    WS_URL=ws://localhost:10000
    ROOM=ABC123
    BOT_NAME=AI_GM
    ```

    For Ollama (local or cloud):

    ```
    AI_DRIVER=./drivers/ollama-driver
    OLLAMA_BASE_URL=http://localhost:11434
    OLLAMA_MODEL=mistral
    WS_URL=ws://localhost:10000
    ROOM=ABC123
    ```

    For DeepSeek:

    ```
    AI_DRIVER=./drivers/deepseek-driver
    DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxx
    DEEPSEEK_MODEL=deepseek-chat
    WS_URL=ws://localhost:10000
    ROOM=ABC123
    ```

    ---

    ## 🧠 Driver System

    All drivers live in `/drivers` and extend `ai-driver.js`. A driver must implement:

    ```javascript
    class MyDriver extends AIDriver {
        async generateResponse(context) {
            // context.systemPrompt  – string
            // context.messages      – array of { role: 'user'|'assistant', content: string }
            // Return the AI's reply as a string
        }
    }
    ```

    ### Built‑in Drivers

    | Driver | File | Description |
    |--------|------|-------------|
    | **OpenAI** | `openai-driver.js` | Uses `gpt-4o-mini` (or custom model). Requires `OPENAI_API_KEY`. |
    | **Ollama** | `ollama-driver.js` | Connects to a local or remote Ollama instance. Supports API key. |
    | **DeepSeek** | `deepseek-driver.js` | Uses DeepSeek's chat API (`deepseek-chat`). Requires `DEEPSEEK_API_KEY`. |

    To add your own driver, create a file in `/drivers`, implement `generateResponse`, and export a `meta` object:

    ```javascript
    class MyDriver extends AIDriver { ... }
    MyDriver.meta = {
        name: 'My Custom LLM',
        description: 'Talks to my server',
        requiredEnv: ['MY_API_KEY']
    };
    module.exports = MyDriver;
    ```

    It will automatically appear in the configuration wizard.

    ---

    ## ▶️ Running the Bot

    ```bash
    npm start
    ```

    The bot connects to the WebSocket server, claims the Game Master role, and starts listening to chat.  
    Players will see a join message: *"The AI Game Master has joined."*

    ### Terminal Commands

    Inside the bot's terminal you can type:

    - **Any text** – sent as a GM chat message (manual override).
    - **`/admin players`** – list players in the room (requires `API_KEY`).
    - **`/admin kick <clientId> [reason]`** – kick a player.
    - **`/admin ban <clientId> [reason]`** – ban a player.
    - **`/admin unban <clientId>`** – remove a ban.

    For automated admin via the REST API, set the `API_KEY` environment variable to your server's API key.

    ---

    ## 🎮 Bot Behavior

    1. **Connects and handshakes** as a GM – if another GM is present, it requests the role and will auto‑approve any pending GM vote.
    2. **Narrates** each player message using the selected AI backend.
    3. **Processes special commands** found in the AI's output:
       - `[ROLL XdY+Z]` → performs a dice roll and posts the result.
       - `[DRAW count region]` → draws cards from the Deck of Consequences.
       - `[TIMER name segments]` → creates a new scene timer.
    4. **Maintains conversation context** (last 20 messages) for coherent storytelling.
    5. **Listens for all server events** (presence, player join/leave, deck updates) and logs them in the terminal.

    ---

    ## 🔗 Integration

    The bot expects the Fate's Edge WebSocket server to be running.  
    Any client (web VTT, terminal client, Discord bot) can join the same room and interact with the AI GM.

    If you want to run the bot **headless** (e.g., on a server), simply omit the terminal input by redirecting stdin or using `nohup`. The bot will continue running and responding to chat.

    ---

    ## 🛠️ Troubleshooting

    | Symptom | Solution |
    |---------|----------|
    | `Cannot find module '../ai-driver'` | Ensure `ai-gm-bot.js` requires `'./drivers/ai-driver'` (correct path). |
    | `MODULE_NOT_FOUND: node-fetch` | The bot uses built‑in `fetch`; remove any `require('node-fetch')` from driver files. |
    | `EADDRINUSE` on port 10000 | Another process is using the port; kill it or change the server port. |
    | Bot doesn't become GM | Check that the server supports GM election. The bot auto‑requests the GM role. |
    | AI responses are poor | Tune the system prompt inside `ai-gm-bot.js` (around line 170) or adjust the model's temperature. |
    | No response from AI | Verify the API key and model name; check server logs for errors. |

    ---

    ## 📜 License

    This bot is part of the Fate's Edge project.  
    The code is provided under the same license as the main repository.  
    See [LICENSE](../LICENSE) for details.

    ---

**Enjoy your fully automated tabletop RPG experience!**
