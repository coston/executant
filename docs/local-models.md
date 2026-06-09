# Local Models with Metal GPU

Executant supports running local LLMs via [llama.cpp](https://github.com/ggml-org/llama.cpp) with Apple Silicon Metal GPU acceleration. The architecture keeps LLM inference fast and native while the coding agent (opencode/claude) runs sandboxed in Docker.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  macOS host (Apple Silicon Metal GPU)            │
│                                                  │
│  llama-server :8080  Qwen2.5-Coder 7B           │
│  llama-server :8081  Qwen2.5-Coder 14B          │
│  llama-server :8082  Llama 3.1 8B               │
│    ↑ native binaries, Metal-accelerated ~80 t/s  │
└──────────────────────┬──────────────────────────┘
                       │ HTTP via host-gateway
┌──────────────────────▼──────────────────────────┐
│  Docker container (coding agent)                 │
│                                                  │
│  opencode / claude-code                         │
│    can only see /workspace mount                 │
│    no SSH keys, no ~/.config, no secrets         │
└─────────────────────────────────────────────────┘
```

**Security model:** The agent that executes code and touches your files is sandboxed in Docker — it can only see what you mount into `/workspace`. The LLM inference server is just matrix multiplication over an HTTP API; it has no file system access and no security concern running natively.

**Performance:** Docker on macOS has no Metal GPU passthrough (Linux VM layer). Running llama-server natively bypasses this, giving full Apple Silicon Metal throughput (~80 tokens/sec on M-series chips vs ~11 tokens/sec CPU-only in Docker).

## Setup

### 1. Install llama.cpp

```bash
brew install llama.cpp
```

This installs `llama-server` to `/opt/homebrew/bin/llama-server`. No daemon, no background service, no hidden data directories — just a binary.

### 2. Download model files

```bash
npm run models:download
```

Downloads Q4\_K\_M quantized GGUF files to `~/.executant/models/`:

| Model | Size | Port |
|---|---|---|
| Qwen2.5-Coder 7B | ~4.7 GB | 8080 |
| Qwen2.5-Coder 14B | ~9 GB | 8081 |
| Llama 3.1 8B | ~4.7 GB | 8082 |

Downloads are idempotent — already-present files are skipped.

### 3. Start inference servers

```bash
npm run models:start
```

Starts all three llama-server processes in the background. Each loads its model into Metal GPU memory and begins accepting requests on its port. Give them ~30 seconds to warm up.

```bash
npm run models:status   # check which are running
npm run models:stop     # stop all servers
```

### 4. Verify connectivity

```bash
curl http://localhost:8080/health   # should return {"status":"ok"}
npm run setup                       # full dependency check
```

### 5. Run with opencode

```bash
# Single step
executant --provider opencode --model llama-qwen7b/qwen2.5-coder-7b workflow.yaml

# Or set env vars for the session
export EXECUTANT_PROVIDER=opencode
export EXECUTANT_MODEL=llama-qwen7b/qwen2.5-coder-7b
executant workflow.yaml
```

## How opencode.json works

`opencode.json` registers the three llama.cpp providers with URLs like `http://localhost:8080/v1`. These resolve correctly in both contexts:

- **macOS host**: `localhost` is the loopback → hits native llama-server directly
- **Docker dev container**: `extra_hosts: localhost:host-gateway` maps `localhost` to the Docker host bridge IP → routes to the native llama-server on the macOS host

No configuration changes needed when switching between host and container contexts.

## Startup on boot (optional)

To start model servers automatically on login:

```bash
# Create a launchd agent (adjust paths as needed)
cat > ~/Library/LaunchAgents/com.executant.models.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.executant.models</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/path/to/executant/src/model-server.ts</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
EOF
launchctl load ~/Library/LaunchAgents/com.executant.models.plist
```

Or just run `npm run models:start` manually before each session.

## Removing local models

To free disk space:

```bash
npm run models:stop
rm -rf ~/.executant/models      # removes ~18 GB of GGUF files
rmdir ~/.executant/pids 2>/dev/null || true
brew uninstall llama.cpp        # optional — removes the binary
```

The `~/.executant/models` directory is the only thing on your host Mac besides the Homebrew binary.

## Eval comparison

With all three servers running, compare local models against Claude:

```bash
npm run eval:compare
```

Results are written to `results/*.csv`. Use `npm run eval:compare:merge` to combine into a single CSV.
