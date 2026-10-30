import React from 'react';
import { Box, Button, Card, Flex, Stack, Text } from '@sanity/ui';
import { useFormValue } from 'sanity';

/**
 * The parcels on an order, each with its "Print label" link.
 *
 * The link goes to /admin/shipping/label/<labelId> on the site, behind the
 * admin Basic Auth, which proxies the PDF from the shipping service with a
 * signed request -- the Studio never holds the shipping secret. Stores
 * nothing; drawn from shipment.parcels, which only the server writes.
 */
const ADMIN_ORIGIN = 'https://comicstripcanvas.co.uk';

type Parcel = {
  _key?: string; parcelRef?: string; band?: string; carrier?: string; option?: string;
  quotedPrice?: number; trackingNumber?: string; trackingUrl?: string; labelId?: string;
  status?: string; statusText?: string; test?: boolean;
};

const STATUS: Record<string, string> = {
  label_created: 'Label created',
  pre_transit: 'Label created',
  in_transit: 'In transit',
  ready_to_collect: 'Awaiting pickup',
  delivered: 'Delivered',
  exception: '⚠ Exception',
  returned_to_sender: '⚠ Returned to sender',
};

export default function ShipmentPanel() {
  const shipment = (useFormValue(['shipment']) as any) || {};
  const parcels: Parcel[] = Array.isArray(shipment.parcels) ? shipment.parcels : [];

  return (
    <Stack space={3}>
      {shipment.planProblem ? (
        <Card padding={3} radius={2} tone="caution">
          <Text size={1} style={{ whiteSpace: 'pre-wrap' }}>
            Parcel plan needs a decision: {shipment.planProblem}
          </Text>
        </Card>
      ) : null}
      {shipment.error ? (
        <Card padding={3} radius={2} tone="critical">
          <Text size={1} style={{ whiteSpace: 'pre-wrap' }}>{shipment.error}</Text>
        </Card>
      ) : null}
      {parcels.length === 0 ? (
        <Card padding={3} radius={2} tone="transparent">
          <Text size={1} muted>
            No labels yet. Check the parcel plan below, then set Shipment status to “Ready to ship”.
          </Text>
        </Card>
      ) : parcels.map((p, i) => (
        <Card key={p._key || i} padding={3} radius={2} shadow={1}>
          <Flex align="center" gap={3} wrap="wrap">
            <Box flex={1}>
              <Text size={2} weight="semibold">
                Parcel {p.parcelRef} · {p.band}{p.test ? ' · TEST' : ''}
              </Text>
              <Box marginTop={2}>
                <Text size={1} muted>
                  {[p.carrier, p.option, p.quotedPrice != null ? `£${Number(p.quotedPrice).toFixed(2)}` : null,
                    STATUS[p.status || ''] || p.statusText || p.status].filter(Boolean).join(' · ')}
                </Text>
              </Box>
              {p.trackingNumber || p.trackingUrl ? (
                <Box marginTop={2}>
                  <Text size={1}>
                    {p.trackingUrl
                      ? <a href={p.trackingUrl} target="_blank" rel="noreferrer">{p.trackingNumber || 'Tracking'}</a>
                      : p.trackingNumber}
                  </Text>
                </Box>
              ) : null}
            </Box>
            {p.labelId ? (
              <Button
                as="a"
                href={`${ADMIN_ORIGIN}/admin/shipping/label/${encodeURIComponent(p.labelId)}`}
                target="_blank"
                rel="noreferrer"
                text="Print label"
                tone="primary"
                fontSize={1}
                padding={3}
              />
            ) : null}
          </Flex>
        </Card>
      ))}
    </Stack>
  );
}
