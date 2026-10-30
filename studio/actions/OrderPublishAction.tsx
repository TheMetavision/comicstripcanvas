import { useState } from 'react';
import { useToast } from '@sanity/ui';
import { useClient, type DocumentActionComponent } from 'sanity';
import { guardedPublish, OPERATOR_FIELDS_BY_TYPE } from '../lib/guarded-publish.mjs';

/**
 * Publish, for orders and return requests: the draft's operator fields
 * (status, tracking, carrier, notes, the shipment status and parcel plan; on a
 * return, the decision, band and notes); the published document's everything
 * else. The rule and its reasons are in ../lib/guarded-publish.mjs -- this is
 * only the button.
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
        const { taken } = await guardedPublish({
          client, publishedId: props.id, fields: OPERATOR_FIELDS_BY_TYPE[props.type],
        });
        toast.push({
          status: 'success',
          title: 'Published',
          description: taken.length
            ? `Saved your change to ${taken.join(', ')}. Everything else is as it already was.`
            : 'Nothing in this draft differed from the published version, so the draft has been cleared.',
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
