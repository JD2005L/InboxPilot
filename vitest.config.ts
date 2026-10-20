import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __GMC_CONFIG__: JSON.stringify({
      authBase: 'https://auth.openai.com',
      chatgptBase: 'https://chatgpt.com/backend-api/codex',
      googleAuthBase: 'https://accounts.google.com',
      gmailBase: 'https://gmail.googleapis.com',
      clientVersion: '0.163.0',
      version: '0.0.0-test',
      googleClientId: '',
    }),
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
  },
});
