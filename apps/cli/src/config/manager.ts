import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface CliConfig {
  apiBaseUrl: string;
  defaultModel: string | null;
  defaultSessionId: string | null;
  theme: string;
}

const DEFAULT_CONFIG: CliConfig = {
  apiBaseUrl: 'http://localhost:3001',
  defaultModel: null,
  defaultSessionId: null,
  theme: 'default'
};

const CONFIG_DIR = path.join(os.homedir(), '.ara');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export function loadConfig(): CliConfig {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    
    if (!fs.existsSync(CONFIG_FILE)) {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
      return { ...DEFAULT_CONFIG };
    }

    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    
    return {
      apiBaseUrl: parsed.apiBaseUrl || DEFAULT_CONFIG.apiBaseUrl,
      defaultModel: parsed.defaultModel !== undefined ? parsed.defaultModel : DEFAULT_CONFIG.defaultModel,
      defaultSessionId: parsed.defaultSessionId !== undefined ? parsed.defaultSessionId : DEFAULT_CONFIG.defaultSessionId,
      theme: parsed.theme || DEFAULT_CONFIG.theme
    };
  } catch (e) {
    console.error('Warning: Failed to load CLI config, using defaults.', e);
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: CliConfig): void {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  } catch (e) {
    console.error('Error: Failed to save CLI config.', e);
  }
}

export function getApiBaseUrl(): string {
  return loadConfig().apiBaseUrl;
}

export function setApiBaseUrl(url: string): void {
  const config = loadConfig();
  config.apiBaseUrl = url;
  saveConfig(config);
}
