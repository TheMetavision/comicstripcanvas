import { useState } from 'react';
import { useToast } from '@sanity/ui';
import { useClient, type DocumentActionComponent } from 'sanity';
import { guardedPublish } from '../lib/guarded-publish.mjs';

/**
 * Publish, for orders: the draft's status, tracking, carrier and notes; the
 * published order's everything else. The rule and its reasons are in
 * ../lib/guarded-publish.mjs -- this is only the button.
 *
 * A refusal is shown in a dialog rather than a toast, because it asks the
 * person to do something (discard and redo) and a toast is gone before it has
 * been read.
 */
export const OrderPublishAction: DocumentActionComponent = (props) => {
  const client = useClient({ apiVersion: '2026-04-11' });
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  if (!props.draft) {
    return { label: 'Publish', disabled: true, title: 'No unpublished changes' };
  }

  return {
    label: busy ? 'Publishing…' : 'Publish',
    tone: 'positive',
    disabled: busy,
    onHandle: async () => {
      setBusy(true);
      try {
        const { taken } = await guardedPublish({ client, publishedId: props.id });
        toast.push({
          status: 'success',
          title: 'Published',
          description: taken.length
            ? `Saved your change to ${taken.join(', ')}. Everything else is as the order already was.`
            : 'Nothing in this draft differed from the order, so the draft has been cleared.',
        });
        props.onComplete();
      } catch (err: any) {
        setRefusal(err?.message || String(err));
      } finally {
        setBusy(false);
      }
    },
    dialog: refusal
      ? {
        type: 'dialog',
        header: 'Not published',
        content: refusal,
        onClose: () => {
          setRefusal(null);
          props.onComplete();
        },
      }
      : null,
  };
};
