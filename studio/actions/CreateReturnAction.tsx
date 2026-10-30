import { useState } from 'react';
import { useToast } from '@sanity/ui';
import { useClient, type DocumentActionComponent } from 'sanity';
import { useRouter } from 'sanity/router';
import { bandFor, isNonPhysical } from '../../netlify/functions/_shared/parcel-bands.mjs';

/**
 * "Create return (free label)", on an order.
 *
 * For a faulty, damaged or wrong item: the refund policy asks the customer to
 * contact us first, so Alan raises the return himself once he has agreed it.
 * It starts with every physical line on the order (remove what is not coming
 * back), ticked as a free label, and opens it. Approving it then sends the
 * label exactly as a customer's request does, with no postage deducted.
 *
 * Created at returnRequest.<ref>, a dotted id like every customer document:
 * the Studio's own "new document" would make a random public id, which is why
 * that is switched off for this type in sanity.config.ts.
 */
const randomRef = () => {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return `ret-${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
};

export const CreateReturnAction: DocumentActionComponent = (props) => {
  const client = useClient({ apiVersion: '2026-04-11' });
  const toast = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const order = props.published as any;

  if (!order) return null;

  return {
    label: busy ? 'Creating return…' : 'Create return (free label)',
    title: 'For a faulty, damaged or wrong item: a return request with a free label, for you to check and approve.',
    disabled: busy,
    onHandle: async () => {
      setBusy(true);
      try {
        const lines = (order.lineItems || []).filter((l: any) => !isNonPhysical(l)).map((l: any) => ({
          _key: l._key, _type: 'returnLine', lineKey: l._key, productTitle: l.productTitle, format: l.format, size: l.size,
          formatKey: l.formatKey, sizeKey: l.sizeKey, quantity: Math.max(1, Math.floor(Number(l.quantity) || 1)),
          unitPrice: Number(l.unitPrice) || 0,
        }));
        const count = await client.fetch('count(*[_type == "returnRequest" && orderId == $id])', { id: order._id });
        const ref = randomRef();
        const single = lines.length === 1 && lines[0].quantity === 1;
        const band = single ? bandFor(lines[0].formatKey, lines[0].sizeKey) : null;
        const doc = {
          _id: `returnRequest.${ref}`,
          _type: 'returnRequest',
          returnRef: ref,
          returnNumber: `${order.orderNumber}-R${count + 1}`,
          source: 'studio',
          order: { _type: 'reference', _ref: order._id, _weak: true },
          orderId: order._id,
          orderNumber: order.orderNumber,
          customerName: order.customerName || '',
          customerEmail: order.customerEmail,
          lines,
          reason: 'faulty_or_wrong',
          reasonLabel: 'Faulty, damaged or wrong item (raised by us)',
          status: 'requested',
          freeLabel: true,
          ...(band ? { band } : {}),
          ...(order.shipment?.deliveredAt ? { deliveredAt: order.shipment.deliveredAt } : {}),
          deliveryDateUnknown: false,
          requestedAt: new Date().toISOString(),
        };
        await client.create(doc);
        toast.push({ status: 'success', title: `Return ${doc.returnNumber} created`, description: 'Check the items and band, then approve it.' });
        props.onComplete();
        router.navigateIntent('edit', { id: doc._id, type: 'returnRequest' });
      } catch (err: any) {
        toast.push({ status: 'error', title: 'Return not created', description: err?.message || String(err) });
      } finally {
        setBusy(false);
      }
    },
  };
};
