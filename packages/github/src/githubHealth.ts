import type { GitHubConfig, GitHubHealthStatus } from './types';

export function getGitHubHealth(config: GitHubConfig, tokenPresent: boolean): GitHubHealthStatus {
  return {
    configured: config.enabled,
    tokenPresent,
    tokenEnv: config.tokenEnv,
    defaultOwner: config.defaultOwner,
    defaultRepo: config.defaultRepo,
    readOnly: config.readOnly,
    allowedRepos: config.allowedRepos,
    permissionMode: config.permissionMode,
  };
}
