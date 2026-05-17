import type { LLMProvider, ChatInput, ChatChunk, Message } from '@ara/shared';
import { z } from 'zod';

export class ModelRouter {
  private providers: Map<string, LLMProvider> = new Map();

  register(provider: LLMProvider) {
    this.providers.set(provider.name, provider);
  }

  get(name: string): LLMProvider | undefined {
    if (name.startsWith('Ollama:')) {
      const provider = this.providers.get('Ollama') as any;
      if (provider) {
        provider.model = name.substring(7);
      }
      return provider;
    }
    return this.providers.get(name);
  }

  list(): string[] {
    return Array.from(this.providers.keys());
  }
}

// -------------------------------------------------------------
// Gemini Provider (REST API Stream Implementation)
// -------------------------------------------------------------
export class GeminiProvider implements LLMProvider {
  name = 'Gemini';

  constructor(private apiKey?: string) {}

  async *streamChat(input: ChatInput): AsyncIterable<ChatChunk> {
    const key = this.apiKey || process.env.GEMINI_API_KEY || process.env.OPENROUTER_API_KEY; // Fallback
    
    if (!key) {
      yield* streamMockResponse(this.name, 'กรุณาตั้งค่า GEMINI_API_KEY ในไฟล์ .env เพื่อคุยกับผมแบบสดๆ!');
      return;
    }

    const modelName = 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:streamGenerateContent?key=${key}`;

    // Format messages for Gemini API
    const contents = input.messages.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }));

    const body: any = { contents };
    if (input.systemPrompt) {
      body.systemInstruction = {
        parts: [{ text: input.systemPrompt }]
      };
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Gemini API error: ${response.status} - ${errText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('Response body is not readable');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        
        // Gemini streamGenerateContent returns a JSON array where chunks are parts of it
        // We parse the buffer incrementally. Gemini streams valid JSON objects or array fragments.
        // A simple, robust way is to extract "text": "..." values from the text stream:
        const regex = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
        let match;
        while ((match = regex.exec(buffer)) !== null) {
          const rawText = match[1];
          if (rawText) {
            // Unescape JSON string
            try {
              const text = JSON.parse(`"${rawText}"`);
              yield { text, isFinished: false };
            } catch (e) {
              // Ignore parse errors on half-read tokens
            }
          }
        }
        // Clear matched part of the buffer
        buffer = buffer.substring(regex.lastIndex);
      }
      yield { text: '', isFinished: true };
    } catch (err: any) {
      yield { text: `\n[Error calling Gemini API: ${err.message}]`, isFinished: true };
    }
  }

  async generateText(input: ChatInput): Promise<string> {
    let result = '';
    for await (const chunk of this.streamChat(input)) {
      result += chunk.text;
    }
    return result;
  }

  async generateJSON<T>(input: ChatInput, schema: z.ZodSchema<T>): Promise<T> {
    const text = await this.generateText({
      ...input,
      systemPrompt: (input.systemPrompt || '') + '\nIMPORTANT: You must return ONLY raw valid JSON conforming to the requested schema. No markdown formatting.'
    });
    try {
      const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
      return schema.parse(parsed);
    } catch (e) {
      throw new Error(`Failed to parse JSON response from LLM: ${e}`);
    }
  }
}

// -------------------------------------------------------------
// OpenAI Provider (REST API Stream Implementation)
// -------------------------------------------------------------
export class OpenAIProvider implements LLMProvider {
  name = 'OpenAI';

  constructor(private apiKey?: string) {}

  async *streamChat(input: ChatInput): AsyncIterable<ChatChunk> {
    const key = this.apiKey || process.env.OPENAI_API_KEY;
    
    if (!key) {
      yield* streamMockResponse(this.name, 'กรุณาตั้งค่า OPENAI_API_KEY ในไฟล์ .env เพื่อคุยกับผมแบบสดๆ!');
      return;
    }

    const url = 'https://api.openai.com/v1/chat/completions';
    const messages = [];
    if (input.systemPrompt) {
      messages.push({ role: 'system', content: input.systemPrompt });
    }
    messages.push(...input.messages.map(msg => ({
      role: msg.role,
      content: msg.content
    })));

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages,
          stream: true
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`OpenAI API error: ${response.status} - ${errText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('Response body is not readable');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        
        // Keep the last partial line in the buffer
        buffer = lines.pop() || '';

        for (const line of lines) {
          const cleaned = line.trim();
          if (!cleaned || cleaned === 'data: [DONE]') continue;
          if (cleaned.startsWith('data: ')) {
            try {
              const parsed = JSON.parse(cleaned.substring(6));
              const text = parsed.choices?.[0]?.delta?.content || '';
              if (text) {
                yield { text, isFinished: false };
              }
            } catch (e) {
              // Ignore line parse error
            }
          }
        }
      }
      yield { text: '', isFinished: true };
    } catch (err: any) {
      yield { text: `\n[Error calling OpenAI API: ${err.message}]`, isFinished: true };
    }
  }

  async generateText(input: ChatInput): Promise<string> {
    let result = '';
    for await (const chunk of this.streamChat(input)) {
      result += chunk.text;
    }
    return result;
  }

  async generateJSON<T>(input: ChatInput, schema: z.ZodSchema<T>): Promise<T> {
    const text = await this.generateText({
      ...input,
      systemPrompt: (input.systemPrompt || '') + '\nIMPORTANT: You must return ONLY raw valid JSON conforming to the requested schema. No markdown formatting.'
    });
    try {
      const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
      return schema.parse(parsed);
    } catch (e) {
      throw new Error(`Failed to parse JSON response from LLM: ${e}`);
    }
  }
}

// -------------------------------------------------------------
// Anthropic Provider (REST API Stream Implementation)
// -------------------------------------------------------------
export class AnthropicProvider implements LLMProvider {
  name = 'Anthropic';

  constructor(private apiKey?: string) {}

  async *streamChat(input: ChatInput): AsyncIterable<ChatChunk> {
    const key = this.apiKey || process.env.ANTHROPIC_API_KEY;
    
    if (!key) {
      yield* streamMockResponse(this.name, 'กรุณาตั้งค่า ANTHROPIC_API_KEY ในไฟล์ .env เพื่อคุยกับผมแบบสดๆ!');
      return;
    }

    const url = 'https://api.anthropic.com/v1/messages';
    const messages = input.messages.map(msg => ({
      role: msg.role === 'system' ? 'user' : msg.role, // Anthropic has separate system param
      content: msg.content
    }));

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-3-5-haiku-latest',
          messages,
          system: input.systemPrompt,
          max_tokens: 4096,
          stream: true
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Anthropic API error: ${response.status} - ${errText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('Response body is not readable');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        
        buffer = lines.pop() || '';

        for (const line of lines) {
          const cleaned = line.trim();
          if (!cleaned) continue;

          if (cleaned.startsWith('data: ')) {
            try {
              const parsed = JSON.parse(cleaned.substring(6));
              if (parsed.type === 'content_block_delta') {
                const text = parsed.delta?.text || '';
                yield { text, isFinished: false };
              }
            } catch (e) {
              // Ignore line parse error
            }
          }
        }
      }
      yield { text: '', isFinished: true };
    } catch (err: any) {
      yield { text: `\n[Error calling Anthropic API: ${err.message}]`, isFinished: true };
    }
  }

  async generateText(input: ChatInput): Promise<string> {
    let result = '';
    for await (const chunk of this.streamChat(input)) {
      result += chunk.text;
    }
    return result;
  }

  async generateJSON<T>(input: ChatInput, schema: z.ZodSchema<T>): Promise<T> {
    const text = await this.generateText({
      ...input,
      systemPrompt: (input.systemPrompt || '') + '\nIMPORTANT: You must return ONLY raw valid JSON conforming to the requested schema. No markdown formatting.'
    });
    try {
      const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
      return schema.parse(parsed);
    } catch (e) {
      throw new Error(`Failed to parse JSON response from LLM: ${e}`);
    }
  }
}

// -------------------------------------------------------------
// Ollama Provider (REST API Stream Implementation)
// -------------------------------------------------------------
export class OllamaProvider implements LLMProvider {
  name = 'Ollama';

  constructor(private host?: string, private model?: string) {}

  async *streamChat(input: ChatInput): AsyncIterable<ChatChunk> {
    const ollamaHost = this.host || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
    const ollamaModel = this.model || process.env.OLLAMA_MODEL || 'llama3';
    const url = `${ollamaHost}/api/chat`;

    const messages = [];
    if (input.systemPrompt) {
      messages.push({ role: 'system', content: input.systemPrompt });
    }
    messages.push(...input.messages.map(msg => ({
      role: msg.role,
      content: msg.content
    })));

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: ollamaModel,
          messages,
          stream: true
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Ollama API error: ${response.status} - ${errText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('Response body is not readable');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        
        buffer = lines.pop() || '';

        for (const line of lines) {
          const cleaned = line.trim();
          if (!cleaned) continue;

          try {
            const parsed = JSON.parse(cleaned);
            const text = parsed.message?.content || '';
            if (text) {
              yield { text, isFinished: false };
            }
          } catch (e) {
            // Ignore line parse error
          }
        }
      }
      yield { text: '', isFinished: true };
    } catch (err: any) {
      yield { 
        text: `\n[ไม่สามารถเชื่อมต่อกับ Ollama ได้: ${err.message}]\nกรุณาตรวจสอบว่าคุณได้:\n1. เปิด Ollama ในเครื่องแล้ว (รันอยู่ที่ ${ollamaHost})\n2. ดึงโมเดลเรียบร้อยแล้ว เช่น รันคำสั่ง \`ollama run ${ollamaModel}\` ใน Command Prompt ของคุณ`, 
        isFinished: true 
      };
    }
  }

  async generateText(input: ChatInput): Promise<string> {
    let result = '';
    for await (const chunk of this.streamChat(input)) {
      result += chunk.text;
    }
    return result;
  }

  async generateJSON<T>(input: ChatInput, schema: z.ZodSchema<T>): Promise<T> {
    const text = await this.generateText({
      ...input,
      systemPrompt: (input.systemPrompt || '') + '\nIMPORTANT: You must return ONLY raw valid JSON conforming to the requested schema. No markdown formatting.'
    });
    try {
      const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
      return schema.parse(parsed);
    } catch (e) {
      throw new Error(`Failed to parse JSON response from LLM: ${e}`);
    }
  }
}

// -------------------------------------------------------------
// Helper to stream a mock response character-by-character
// -------------------------------------------------------------
async function* streamMockResponse(providerName: string, configMessage: string): AsyncIterable<ChatChunk> {
  const reply = `สวัสดีครับเพื่อน! ผมคือระบบจำลองของ ${providerName} (Mock Mode)\n\n${configMessage}\n\nแต่ไม่ต้องกังวลครับ ในโหมดจำลองนี้ผมก็พร้อมคุยกับเพื่อนเพื่อทดสอบฟลูของ UI และระบบ Approval Gate ต่างๆ ได้ทันทีเลย! ลองพิมพ์บอกให้ผมสร้างไฟล์หรือทำอะไรดูสิครับ!`;
  
  const chunks = reply.split(' ');
  for (let i = 0; i < chunks.length; i++) {
    yield {
      text: chunks[i] + (i === chunks.length - 1 ? '' : ' '),
      isFinished: i === chunks.length - 1
    };
    await new Promise(resolve => setTimeout(resolve, 30));
  }
}
