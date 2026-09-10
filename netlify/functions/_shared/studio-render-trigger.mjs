/**
 * Start studio-render-background, and wait to be told the job was accepted.
 *
 * Two things call this -- studio-save after a save, and studio-rerender when
 * somebody repairs one by hand -- and they must do it identically, because the
 * shape of this call is what the bug was.
 *
 * THE RULE: await it. A serverless function's execution environment is frozen
 * the instant it returns its response, so an outbound request that has not
 * completed is suspended mid-flight and never resumes -- the job is simply
 * never started, and nothing anywhere reports a failure. studio-save fired this
 * and returned, which worked in every local test because `netlify dev` is one
 * long-lived process that is never frozen, and never once worked in production.
 *
 * The /api/ alias rather than /.netlify/functions/<name>-background is
 * deliberate and is what the working triggers use (personalise-save and
 * personalisation-style to /api/style-photo; webhook and personalisation-action
 * to /api/render-personalisation): netlify.toml maps the alias to the real
 * function name, so the -background suffix stays an implementation detail of
 * the renderer rather than something four callers have to know.
 *
 * Awaiting costs almost nothing. A background function answers 202 as soon as
 * the platform has taken the job, not when the render finishes.
 *
 * @returns {{ok: boolean, status: number, url: string, error: string|null}}
 *          Never throws: the caller decides what a failed trigger means.
 */
export async function startRender({ origin, id, docId, title, printWidth, replacing }) {
  const url = `${origin}/api/studio-render`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, docId, title, printWidth, replacing }),
    });
    return { ok: res.ok, status: res.status, url, error: null };
  } catch (err) {
    return { ok: false, status: 0, url, error: err.message };
  }
}
