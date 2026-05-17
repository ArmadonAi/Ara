import type { PermissionRule } from './types';

export const defaultDenyRules: PermissionRule[] = [
  // 1. Secret/Credential Paths
  {
    id: 'deny-env-file',
    effect: 'deny',
    pathGlob: '**/.env',
    reason: 'Access to environment credential files (.env) is blocked for security.',
  },
  {
    id: 'deny-env-wildcard',
    effect: 'deny',
    pathGlob: '**/.env.*',
    reason: 'Access to wildcard environment credential files (.env.*) is blocked.',
  },
  {
    id: 'deny-ssh-directory',
    effect: 'deny',
    pathGlob: '**/.ssh/**',
    reason: 'Access to local SSH configuration files and keys (~/.ssh) is strictly prohibited.',
  },
  {
    id: 'deny-aws-directory',
    effect: 'deny',
    pathGlob: '**/.aws/**',
    reason: 'Access to AWS credentials and configurations (~/.aws) is strictly prohibited.',
  },
  {
    id: 'deny-gcloud-directory',
    effect: 'deny',
    pathGlob: '**/.config/gcloud/**',
    reason: 'Access to Google Cloud SDK credential directories (~/.config/gcloud) is prohibited.',
  },
  {
    id: 'deny-pem-keys',
    effect: 'deny',
    pathGlob: '**/*.pem',
    reason: 'Reading or writing SSL/SSH private keys (.pem) is blocked.',
  },
  {
    id: 'deny-key-keys',
    effect: 'deny',
    pathGlob: '**/*.key',
    reason: 'Access to private key configuration stores (.key) is blocked.',
  },
  {
    id: 'deny-id-rsa',
    effect: 'deny',
    pathGlob: '**/id_rsa',
    reason: 'Access to private identity SSH keys (id_rsa) is strictly blocked.',
  },
  {
    id: 'deny-id-dsa',
    effect: 'deny',
    pathGlob: '**/id_dsa',
    reason: 'Access to private identity keys (id_dsa) is strictly blocked.',
  },
  {
    id: 'deny-id-ecdsa',
    effect: 'deny',
    pathGlob: '**/id_ecdsa',
    reason: 'Access to private identity keys (id_ecdsa) is strictly blocked.',
  },
  {
    id: 'deny-id-ed25519',
    effect: 'deny',
    pathGlob: '**/id_ed25519',
    reason: 'Access to private identity keys (id_ed25519) is strictly blocked.',
  },

  // 2. Dangerous Shell Command Patterns
  {
    id: 'deny-shell-rm',
    effect: 'deny',
    commandPattern: 'rm\\s+-rf',
    reason: 'Recursive forced directory removal (rm -rf) is blocked to prevent workspace destruction.',
  },
  {
    id: 'deny-shell-sudo',
    effect: 'deny',
    commandPattern: 'sudo\\s+',
    reason: 'Superuser command escalation (sudo) is prohibited to safeguard system binaries.',
  },
  {
    id: 'deny-shell-curl-sh',
    effect: 'deny',
    commandPattern: 'curl.*\\|\\s*(bash|sh)',
    reason: 'Downloading and piping remote scripts directly into a shell (curl | sh) is blocked.',
  },
  {
    id: 'deny-shell-wget-sh',
    effect: 'deny',
    commandPattern: 'wget.*\\|\\s*(bash|sh)',
    reason: 'Downloading and piping remote scripts directly into a shell (wget | sh) is blocked.',
  },
  {
    id: 'deny-shell-drop-table',
    effect: 'deny',
    commandPattern: 'DROP\\s+TABLE',
    reason: 'Database truncation and dropping operations (DROP TABLE) are blocked.',
  },
  {
    id: 'deny-shell-printenv',
    effect: 'deny',
    commandPattern: '(printenv|\\benv\\b)',
    reason: 'Dumping environment configuration variables is blocked to protect session secrets.',
  },

  // 3. Network Exfiltration & Reverse Shell Patterns
  {
    id: 'deny-net-exfil-curl',
    effect: 'deny',
    commandPattern: 'curl.*-F\\s+',
    reason: 'File upload exfiltration via curl form parameters is prohibited.',
  },
  {
    id: 'deny-net-exfil-post',
    effect: 'deny',
    commandPattern: 'wget.*--post-file',
    reason: 'File exfiltration post actions via wget are prohibited.',
  },
  {
    id: 'deny-net-exfil-nc',
    effect: 'deny',
    commandPattern: '\\bnc\\b.*\\d+',
    reason: 'Raw socket netcat listeners and pipes are prohibited.',
  },
  {
    id: 'deny-reverse-shell',
    effect: 'deny',
    commandPattern: '/dev/tcp/',
    reason: 'TCP socket redirect reverse shells are strictly prohibited.',
  },
];
