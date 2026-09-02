import { describe, expect, it } from 'vitest';

import { createApplicationServer } from '../../src/server/index';

describe('application foundation', () => {
  it('creates the backend server without opening a network connection', () => {
    const server = createApplicationServer();

    expect(server.listening).toBe(false);
    server.close();
  });
});
