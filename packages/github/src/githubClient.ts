import type { GitHubConfig } from './types';
import { getGitHubToken } from './githubConfig';
import { redactGitHubSecret } from './githubRedaction';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface GitHubApiResponse<T = any> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
  headers?: Record<string, string>;
  rateLimit?: { remaining: number; limit: number; reset: number };
}

export class GitHubClient {
  private token: string | null;
  private config: GitHubConfig;
  private lastRateLimit: { remaining: number; limit: number; reset: number } | null = null;

  constructor(config: GitHubConfig) {
    this.config = config;
    this.token = getGitHubToken(config);
  }

  getTokenPresent(): boolean {
    return this.token !== null;
  }

  getLastRateLimit(): { remaining: number; limit: number; reset: number } | null {
    return this.lastRateLimit;
  }

  getConfig(): GitHubConfig {
    return this.config;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Ara-AI-v0.1',
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    return headers;
  }

  private parseRateLimit(headers: Headers): { remaining: number; limit: number; reset: number } {
    return {
      remaining: parseInt(headers.get('x-ratelimit-remaining') || '0', 10),
      limit: parseInt(headers.get('x-ratelimit-limit') || '0', 10),
      reset: parseInt(headers.get('x-ratelimit-reset') || '0', 10),
    };
  }

  async request<T = any>(
    method: HttpMethod,
    path: string,
    body?: Record<string, unknown>
  ): Promise<GitHubApiResponse<T>> {
    const baseUrl = (this.config.apiBaseUrl || 'https://api.github.com').replace(/\/$/, '');
    const url = `${baseUrl}${path.startsWith('/') ? path : '/' + path}`;
    const headers = this.buildHeaders();

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      this.lastRateLimit = this.parseRateLimit(res.headers);

      // Handle rate limiting
      if (res.status === 403 && this.lastRateLimit.remaining === 0) {
        return {
          ok: false,
          status: 403,
          error: `GitHub API rate limit exceeded. Resets at ${new Date((this.lastRateLimit.reset || 0) * 1000).toISOString()}`,
          rateLimit: this.lastRateLimit,
        };
      }

      // Handle 401/403 auth errors
      if (res.status === 401) {
        return { ok: false, status: 401, error: 'GitHub API authentication failed — check your token', rateLimit: this.lastRateLimit };
      }

      // Handle 404
      if (res.status === 404) {
        return { ok: false, status: 404, error: `GitHub resource not found: ${method} ${path}`, rateLimit: this.lastRateLimit };
      }

      // Parse response body
      let data: T | undefined;
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        try {
          data = await res.json() as T;
        } catch {
          return { ok: false, status: res.status, error: 'Invalid JSON response from GitHub API', rateLimit: this.lastRateLimit };
        }
      } else if (method === 'GET' && path.includes('/pulls/') && path.endsWith('/diff')) {
        const text = await res.text();
        data = { diff: text } as T;
      }

      if (!res.ok) {
        const ghErr = data ? (data as any).message : undefined;
        return {
          ok: false,
          status: res.status,
          error: ghErr ? `GitHub API error: ${ghErr}` : `GitHub API returned ${res.status}`,
          data,
          rateLimit: this.lastRateLimit,
        };
      }

      return { ok: true, status: res.status, data, rateLimit: this.lastRateLimit };
    } catch (e: any) {
      const msg = e.message?.includes('fetch') ? `Network error: ${e.message}` : `GitHub request failed: ${e.message}`;
      return { ok: false, status: 0, error: redactGitHubSecret(msg), rateLimit: this.lastRateLimit };
    }
  }

  // --- API methods ---

  async getCurrentUser(): Promise<GitHubApiResponse<any>> {
    return this.request('GET', '/user');
  }

  async getRepo(owner: string, repo: string): Promise<GitHubApiResponse<any>> {
    return this.request('GET', `/repos/${owner}/${repo}`);
  }

  async listIssues(owner: string, repo: string, state: string = 'open', perPage?: number, page?: number): Promise<GitHubApiResponse<any[]>> {
    const pp = Math.min(Math.max(perPage || 30, 1), 100);
    const p = Math.max(page || 1, 1);
    return this.request('GET', `/repos/${owner}/${repo}/issues?state=${state}&per_page=${pp}&page=${p}`);
  }

  async getIssue(owner: string, repo: string, issueNumber: number): Promise<GitHubApiResponse<any>> {
    return this.request('GET', `/repos/${owner}/${repo}/issues/${issueNumber}`);
  }

  async createIssue(owner: string, repo: string, title: string, body?: string, labels?: string[]): Promise<GitHubApiResponse<any>> {
    const payload: Record<string, unknown> = { title };
    if (body) payload.body = body;
    if (labels) payload.labels = labels;
    return this.request('POST', `/repos/${owner}/${repo}/issues`, payload);
  }

  async commentIssue(owner: string, repo: string, issueNumber: number, body: string): Promise<GitHubApiResponse<any>> {
    return this.request('POST', `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { body });
  }

  async listPullRequests(owner: string, repo: string, state: string = 'open', perPage?: number, page?: number): Promise<GitHubApiResponse<any[]>> {
    const pp = Math.min(Math.max(perPage || 30, 1), 100);
    const p = Math.max(page || 1, 1);
    return this.request('GET', `/repos/${owner}/${repo}/pulls?state=${state}&per_page=${pp}&page=${p}`);
  }

  async getPullRequest(owner: string, repo: string, pullNumber: number): Promise<GitHubApiResponse<any>> {
    return this.request('GET', `/repos/${owner}/${repo}/pulls/${pullNumber}`);
  }

  async getPullRequestFiles(owner: string, repo: string, pullNumber: number): Promise<GitHubApiResponse<any[]>> {
    return this.request('GET', `/repos/${owner}/${repo}/pulls/${pullNumber}/files`);
  }

  async getPullRequestDiff(owner: string, repo: string, pullNumber: number): Promise<GitHubApiResponse<{ diff: string }>> {
    const headers = this.buildHeaders();
    headers['Accept'] = 'application/vnd.github.v3.diff';
    const baseUrl = (this.config.apiBaseUrl || 'https://api.github.com').replace(/\/$/, '');
    const url = `${baseUrl}/repos/${owner}/${repo}/pulls/${pullNumber}`;
    try {
      const res = await fetch(url, { method: 'GET', headers });
      if (!res.ok) {
        return { ok: false, status: res.status, error: `GitHub API returned ${res.status}` };
      }
      const diff = await res.text();
      return { ok: true, status: res.status, data: { diff } };
    } catch (e: any) {
      return { ok: false, status: 0, error: redactGitHubSecret(e.message) };
    }
  }

  async createPullRequestReview(owner: string, repo: string, pullNumber: number, body: string, event: string = 'COMMENT'): Promise<GitHubApiResponse<any>> {
    return this.request('POST', `/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`, { body, event });
  }

  async listCheckRuns(owner: string, repo: string, ref: string, perPage?: number, page?: number): Promise<GitHubApiResponse<any>> {
    const pp = Math.min(Math.max(perPage || 30, 1), 100);
    const p = Math.max(page || 1, 1);
    return this.request('GET', `/repos/${owner}/${repo}/commits/${ref}/check-runs?per_page=${pp}&page=${p}`);
  }

  async listWorkflowRuns(owner: string, repo: string, perPage?: number, page?: number): Promise<GitHubApiResponse<any>> {
    const pp = Math.min(Math.max(perPage || 30, 1), 100);
    const p = Math.max(page || 1, 1);
    return this.request('GET', `/repos/${owner}/${repo}/actions/runs?per_page=${pp}&page=${p}`);
  }

  async getWorkflowRun(owner: string, repo: string, runId: number): Promise<GitHubApiResponse<any>> {
    return this.request('GET', `/repos/${owner}/${repo}/actions/runs/${runId}`);
  }
}
