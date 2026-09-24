import React from 'react';
import { Box, Button, Card, Flex, Stack, Text } from '@sanity/ui';
import { useFormValue } from 'sanity';

/**
 * "Download print file" for every line on this order.
 *
 * WHY A PANEL RATHER THAN A FIELD ON EACH LINE
 * --------------------------------------------
 * The file is made per line, so the obvious place for the link is inside the
 * line. But an order's lineItems is an array of anonymous objects, and a field
 * component inside one of them cannot see the order's own _id -- which is half
 * of what the link needs. Reading both from the document once, at the top, is
 * shorter than threading the id down into every row.
 *
 * It also puts every line's file in one place, which is what somebody standing
 * at a printer actually wants: the whole order, in order.
 *
 * NO SECRET IN HERE. The Studio bundle is public, so anything pasted into this
 * file is published. The link goes to /admin/print-file/..., behind the Basic
 * Auth edge function, and the page starts the render itself.
 *
 * The MASTER link stays alongside it, unchanged and separately labelled: it is
 * the file the product carries, at whatever size the design was built at, and
 * is still the right thing to reach for when somebody wants the original rather
 * than this order's sheet.
 */

type Line = {
  _key?: string;
  productTitle?: string;
  size?: string;
  format?: string;
  quantity?: number;
  printFile?: string;
  buildKind?: string;
  artworkStyleLabel?: string;
};

const ADMIN_ORIGIN = 'https://comicstripcanvas.co.uk';

export default function PrintFileLinks() {
  const id = useFormValue(['_id']) as string | undefined;
  const orderNumber = useFormValue(['orderNumber']) as string | undefined;
  const lines = (useFormValue(['lineItems']) as Line[] | undefined) || [];

  /* A draft carries a drafts. prefix; the renderer reads the published order,
     and the two ids differ by exactly that. */
  const orderId = (id || '').replace(/^drafts\./, '');

  if (!orderId || lines.length === 0) {
    return (
      <Card padding={3} radius={2} tone="transparent">
        <Text size={1} muted>No lines on this order yet.</Text>
      </Card>
    );
  }

  return (
    <Stack space={3}>
      <Text size={1} muted>
        Made for the size and finish each line was ordered at, including the canvas
        wrap. The first build of a line takes up to half a minute; after that it is
        kept until the product’s artwork changes.
      </Text>

      {lines.map((line, i) => {
        const key = line._key || String(i);
        const built = Boolean(line.buildKind);
        const href = `${ADMIN_ORIGIN}/admin/print-file/${encodeURIComponent(orderId)}/${encodeURIComponent(key)}`;
        const detail = [line.artworkStyleLabel, line.format, line.size]
          .filter(Boolean).join(' · ');

        return (
          <Card key={key} padding={3} radius={2} shadow={1} tone={built ? 'transparent' : 'default'}>
            <Flex align="center" gap={3} wrap="wrap">
              <Box flex={1}>
                <Text size={2} weight="semibold">
                  {line.productTitle || 'Line'}{line.quantity && line.quantity > 1 ? ` × ${line.quantity}` : ''}
                </Text>
                <Box marginTop={1}>
                  <Text size={1} muted>{detail || '—'}</Text>
                </Box>
              </Box>

              {built ? (
                <Text size={1} muted>
                  Built by the customer — printed from the proof on its Personalisations entry.
                </Text>
              ) : (
                <Flex gap={2} align="center">
                  <Button
                    as="a"
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    text="Download print file"
                    tone="primary"
                    fontSize={1}
                    padding={3}
                  />
                  {line.printFile ? (
                    <Button
                      as="a"
                      href={line.printFile}
                      target="_blank"
                      rel="noreferrer"
                      text="Master (16×24)"
                      mode="ghost"
                      fontSize={1}
                      padding={3}
                    />
                  ) : (
                    <Text size={1} style={{ color: '#f03e2f' }}>No master on this product</Text>
                  )}
                </Flex>
              )}
            </Flex>
          </Card>
        );
      })}

      {orderNumber ? (
        <Text size={1} muted>{orderNumber}</Text>
      ) : null}
    </Stack>
  );
}
