/**
 * Enough of resend to run the handlers. Records sends instead of making them,
 * so "was the team told, and exactly once" is something a test can assert.
 */

export const sent = [];
export function reset() { sent.length = 0; }

export class Resend {
  constructor(key) { this.key = key; }

  get emails() {
    return {
      send: async (payload) => {
        sent.push(payload);
        return { data: { id: `stub-${sent.length}` }, error: null };
      },
    };
  }
}

export default { Resend };
