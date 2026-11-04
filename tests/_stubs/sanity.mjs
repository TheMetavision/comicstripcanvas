/**
 * The handler-test Sanity stub, plus canned answers for queries it does not
 * know (it throws on those, deliberately). `answers` is [RegExp, (params) => value].
 */
import * as base from '../../tools/builder/_stubs/sanity-client.mjs';

export * from '../../tools/builder/_stubs/sanity-client.mjs';

export const answers = [];

export function createClient(...args) {
  const client = base.createClient(...args);
  const fetch = client.fetch;
  client.fetch = async function (query, params = {}) {
    for (const [re, answer] of answers) if (re.test(query)) return answer(params);
    return fetch.call(this, query, params);
  };
  return client;
}

export default { createClient };
