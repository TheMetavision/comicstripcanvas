import React, { useState } from 'react';
import type { DocumentActionComponent, DocumentActionProps } from 'sanity';

/**
 * Approve / Hold / Re-render for pendingPersonalisation.
 *
 * Anything with a consequence outside Sanity — sending the customer their proof,
 * starting a render — happens in netlify/functions/personalisation-action.mjs,
 * not here. The Studio only asks.
 *
 * NOTE ON THE SECRET: SANITY_STUDIO_* values are inlined into the Studio bundle
 * at build time, and that bundle is public. This shared secret therefore keeps
 * out casual traffic, not a determined reader of the JavaScript. See the note in
 * netlify.toml.
 */

const SITE =
  (import.meta as any).env?.SANITY_STUDIO_SITE_URL || 'https://comicstripcanvas.co.uk';
const SECRET =
  (import.meta as any).env?.SANITY_STUDIO_PERSONALISATION_ACTION_SECRET || '';

async function callAction(action: string, id: string, extra: Record<string, unknown> = {}) {
  const res = await fetch(`${SITE}/api/personalisation-action`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSC-Action-Secret': SECRET,
    },
    body: JSON.stringify({ action, id, ...extra }),
  });
  let body: any = {};
  try { body = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok || body.ok === false) {
    throw new Error(body.error || `${action} failed (${res.status})`);
  }
  return body;
}

const statusOf = (props: DocumentActionProps) =>
  ((props.draft || props.published) as any)?.status as string | undefined;

/* ---------------------------------------------------------------- approve --- */
export const ApproveAction: DocumentActionComponent = (props) => {
  const [busy, setBusy] = useState(false);
  const status = statusOf(props);
  if (status !== 'rendered') return null;   // only a rendered proof can be approved

  return {
    label: busy ? 'Approving…' : 'Approve',
    tone: 'positive',
    disabled: busy,
    onHandle: async () => {
      setBusy(true);
      try {
        const r = await callAction('approve', props.id);
        props.onComplete();
        if (r.emailed === false) {
          window.alert(
            'Approved, but the proof email did not send:\n\n' +
            (r.emailError || 'unknown reason') +
            '\n\nThe customer has not been told. Re-send once that is fixed.'
          );
        }
      } catch (err: any) {
        window.alert('Could not approve:\n\n' + err.message);
      } finally {
        setBusy(false);
      }
    },
  };
};

/* ------------------------------------------------------------------- hold --- */
export const HoldAction: DocumentActionComponent = (props) => {
  const [busy, setBusy] = useState(false);

  return {
    label: busy ? 'Holding…' : 'Hold',
    tone: 'critical',
    disabled: busy,
    onHandle: async () => {
      // Deliberately a prompt: a hold always wants a reason, and the reason is
      // the whole point of the action.
      const note = window.prompt('Why is this going on hold?');
      if (note === null) return;                 // cancelled
      if (!note.trim()) {
        window.alert('A hold needs a note saying why.');
        return;
      }
      setBusy(true);
      try {
        await callAction('hold', props.id, { note: note.trim() });
        props.onComplete();
      } catch (err: any) {
        window.alert('Could not put on hold:\n\n' + err.message);
      } finally {
        setBusy(false);
      }
    },
  };
};

/* -------------------------------------------------------------- re-render --- */
export const RerenderAction: DocumentActionComponent = (props) => {
  const [busy, setBusy] = useState(false);
  const status = statusOf(props);
  if (status !== 'rendered' && status !== 'on_hold') return null;

  return {
    label: busy ? 'Starting…' : 'Re-render',
    tone: 'caution',
    disabled: busy,
    onHandle: async () => {
      setBusy(true);
      try {
        await callAction('rerender', props.id);
        props.onComplete();
      } catch (err: any) {
        window.alert('Could not start a re-render:\n\n' + err.message);
      } finally {
        setBusy(false);
      }
    },
  };
};

/** Added alongside the standard actions, never replacing them. */
export const personalisationActions = (prev: DocumentActionComponent[], context: any) =>
  context.schemaType === 'pendingPersonalisation'
    ? [...prev, ApproveAction, HoldAction, RerenderAction]
    : prev;
