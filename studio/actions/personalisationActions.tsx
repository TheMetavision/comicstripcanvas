import type { DocumentActionComponent, DocumentActionProps } from 'sanity';

/**
 * Approve / Hold / Re-render for pendingPersonalisation.
 *
 * THERE IS NO SECRET IN THIS FILE, AND THERE CANNOT BE ONE.
 *
 * These buttons used to POST to /api/personalisation-action with a shared
 * secret read from SANITY_STUDIO_PERSONALISATION_ACTION_SECRET. Vite inlines
 * SANITY_STUDIO_* values at build time and the Studio bundle is served to
 * anyone who asks, so that secret was public -- not in principle, in fact: the
 * 40-character value was in comicstripcanvas.sanity.studio/static/sanity-*.js,
 * six megabytes, no login, and the same secret also guarded studio-save,
 * studio-upload and the renderers.
 *
 * A browser cannot keep a shared secret, so the fix is not a better secret. The
 * work moved behind /admin, where the Basic Auth edge function challenges for a
 * credential the operator types -- and these buttons now do the one thing a
 * public bundle may safely do: open a URL.
 *
 * WHY OPEN A PAGE RATHER THAN FETCH
 *
 * The Studio is served from sanity.studio and the site from
 * comicstripcanvas.co.uk. A cross-origin fetch does not carry Basic Auth, and a
 * 401 on a cross-origin XHR does not prompt anybody for anything -- it just
 * fails. Opening the page makes it a top-level navigation, which is exactly the
 * case browsers DO challenge on. The page then calls the function same-origin,
 * with the credentials the browser is already holding.
 *
 * The cost is that the Studio no longer sees the outcome, so it no longer
 * claims one: the page reports what happened, and these buttons say only that
 * it was opened.
 */

const SITE =
  (import.meta as any).env?.SANITY_STUDIO_SITE_URL || 'https://comicstripcanvas.co.uk';

const open = (id: string, action: string) => {
  const url = `${SITE}/admin/personalisation/${encodeURIComponent(id)}?action=${action}`;
  window.open(url, '_blank', 'noopener,noreferrer');
};

const statusOf = (props: DocumentActionProps) =>
  ((props.draft || props.published) as any)?.status as string | undefined;

/* ---------------------------------------------------------------- approve --- */
export const ApproveAction: DocumentActionComponent = (props) => {
  const status = statusOf(props);
  if (status !== 'rendered') return null;   // only a rendered proof can be approved

  return {
    label: 'Approve…',
    tone: 'positive',
    onHandle: () => {
      open(props.id, 'approve');
      props.onComplete();
    },
  };
};

/* ------------------------------------------------------------------- hold --- */
export const HoldAction: DocumentActionComponent = (props) => ({
  label: 'Hold…',
  tone: 'critical',
  onHandle: () => {
    /* The note is asked for on the page, not here. A hold always wants a
       reason, and the page is where the reason can be typed, checked and shown
       back -- a window.prompt in the Studio could only hand it to a request
       this file is no longer allowed to make. */
    open(props.id, 'hold');
    props.onComplete();
  },
});

/* -------------------------------------------------------------- re-render --- */
export const RerenderAction: DocumentActionComponent = (props) => {
  const status = statusOf(props);
  if (status !== 'rendered' && status !== 'on_hold') return null;

  return {
    label: 'Re-render…',
    tone: 'caution',
    onHandle: () => {
      open(props.id, 'rerender');
      props.onComplete();
    },
  };
};

/** Added alongside the standard actions, never replacing them. */
export const personalisationActions = (prev: DocumentActionComponent[], context: any) =>
  context.schemaType === 'pendingPersonalisation'
    ? [...prev, ApproveAction, HoldAction, RerenderAction]
    : prev;
