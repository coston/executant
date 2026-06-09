import { homedir } from "node:os";
import { join } from "node:path";

export const MODELS_DIR = join(homedir(), "llms");
export const PIDS_DIR = join(homedir(), ".executant", "pids");

export interface ModelConfig {
  name: string;
  key: string;
  file: string;
  port: number;
  url: string;
  size: string;
}

export const MODELS: readonly ModelConfig[] = [
  {
    name: "Qwen2.5-Coder 7B",
    key: "qwen7b",
    file: "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf",
    port: 8080,
    url: "https://huggingface.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf",
    size: "~4.7 GB",
  },
  {
    name: "Qwen2.5-Coder 14B",
    key: "qwen14b",
    file: "Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf",
    port: 8081,
    url: "https://huggingface.co/bartowski/Qwen2.5-Coder-14B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf",
    size: "~9 GB",
  },
  {
    name: "Llama 3.1 8B",
    key: "llama8b",
    file: "Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf",
    port: 8082,
    url: "https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF/resolve/main/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf",
    size: "~4.7 GB",
  },
] as const;
